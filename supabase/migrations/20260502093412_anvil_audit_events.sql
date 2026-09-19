create table if not exists public.anvil_audit_events (
  id text primary key,
  owner_id uuid references auth.users(id) on delete set null,
  project_id text references public.anvil_projects(id) on delete set null,
  type text not null,
  actor jsonb not null default '{}'::jsonb,
  permissions text[] not null default '{}'::text[],
  risk text not null default 'low' check (risk in ('low', 'medium', 'high')),
  summary text not null,
  target jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists anvil_audit_events_owner_created_idx
  on public.anvil_audit_events (owner_id, created_at desc);

create index if not exists anvil_audit_events_project_created_idx
  on public.anvil_audit_events (project_id, created_at desc);

create index if not exists anvil_audit_events_type_created_idx
  on public.anvil_audit_events (type, created_at desc);

alter table public.anvil_audit_events enable row level security;

revoke all on table public.anvil_audit_events from anon;
revoke all on table public.anvil_audit_events from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_audit_events'
      and policyname = 'anvil_audit_events_owner_select'
  ) then
    create policy "anvil_audit_events_owner_select"
      on public.anvil_audit_events
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
