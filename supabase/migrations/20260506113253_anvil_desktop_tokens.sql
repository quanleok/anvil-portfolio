create table if not exists public.anvil_desktop_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'Anvil Desktop',
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null default array[
    'anvil-agent:turn',
    'billing:read',
    'usage:write'
  ]::text[],
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_desktop_tokens_label_length
    check (char_length(label) between 1 and 120),
  constraint anvil_desktop_tokens_hash_format
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint anvil_desktop_tokens_prefix_length
    check (char_length(token_prefix) between 8 and 32)
);

create index if not exists anvil_desktop_tokens_owner_created_idx
  on public.anvil_desktop_tokens (owner_id, created_at desc);

create index if not exists anvil_desktop_tokens_active_hash_idx
  on public.anvil_desktop_tokens (token_hash)
  where revoked_at is null;

alter table public.anvil_desktop_tokens enable row level security;

revoke all on table public.anvil_desktop_tokens from anon;
revoke all on table public.anvil_desktop_tokens from authenticated;
grant select, insert, update on table public.anvil_desktop_tokens to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_desktop_tokens'
      and policyname = 'anvil_desktop_tokens_owner_select'
  ) then
    create policy "anvil_desktop_tokens_owner_select"
      on public.anvil_desktop_tokens
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'set_updated_at'
  ) and not exists (
    select 1
    from pg_trigger
    where tgname = 'trg_anvil_desktop_tokens_updated'
  ) then
    create trigger trg_anvil_desktop_tokens_updated
    before update on public.anvil_desktop_tokens
    for each row
    execute function public.set_updated_at();
  end if;
end $$;
