create table if not exists public.anvil_agent_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null references public.anvil_projects(id) on delete cascade,
  label text not null default 'Remote agent',
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null default array[
    'project:read',
    'project:write',
    'media:read',
    'media:write'
  ]::text[],
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_agent_tokens_label_length
    check (char_length(label) between 1 and 120),
  constraint anvil_agent_tokens_hash_format
    check (token_hash ~ '^[a-f0-9]{64}$')
);

create index if not exists anvil_agent_tokens_owner_project_idx
  on public.anvil_agent_tokens (owner_id, project_id, created_at desc);

create index if not exists anvil_agent_tokens_active_hash_idx
  on public.anvil_agent_tokens (token_hash)
  where revoked_at is null;

alter table public.anvil_agent_tokens enable row level security;

revoke all on table public.anvil_agent_tokens from anon;
revoke all on table public.anvil_agent_tokens from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_tokens'
      and policyname = 'anvil_agent_tokens_owner_select'
  ) then
    create policy "anvil_agent_tokens_owner_select"
      on public.anvil_agent_tokens
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_tokens'
      and policyname = 'anvil_agent_tokens_owner_insert'
  ) then
    create policy "anvil_agent_tokens_owner_insert"
      on public.anvil_agent_tokens
      for insert
      to authenticated
      with check (
        owner_id = (select auth.uid())
        and exists (
          select 1
          from public.anvil_projects project
          where project.id = project_id
            and project.owner_id = (select auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_tokens'
      and policyname = 'anvil_agent_tokens_owner_update'
  ) then
    create policy "anvil_agent_tokens_owner_update"
      on public.anvil_agent_tokens
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_tokens'
      and policyname = 'anvil_agent_tokens_owner_delete'
  ) then
    create policy "anvil_agent_tokens_owner_delete"
      on public.anvil_agent_tokens
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
