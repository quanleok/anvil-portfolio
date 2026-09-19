create table if not exists public.anvil_projects (
  id text primary key,
  owner_id uuid references auth.users(id) on delete set null,
  name text not null,
  privacy text not null check (privacy in ('private', 'team', 'public-draft')),
  project jsonb not null check (jsonb_typeof(project) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists anvil_projects_owner_updated_idx
  on public.anvil_projects (owner_id, updated_at desc);

create index if not exists anvil_projects_project_gin_idx
  on public.anvil_projects using gin (project jsonb_path_ops);

alter table public.anvil_projects enable row level security;

revoke all on table public.anvil_projects from anon;
revoke all on table public.anvil_projects from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_projects'
      and policyname = 'anvil_projects_owner_select'
  ) then
    create policy "anvil_projects_owner_select"
      on public.anvil_projects
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_projects'
      and policyname = 'anvil_projects_owner_insert'
  ) then
    create policy "anvil_projects_owner_insert"
      on public.anvil_projects
      for insert
      to authenticated
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_projects'
      and policyname = 'anvil_projects_owner_update'
  ) then
    create policy "anvil_projects_owner_update"
      on public.anvil_projects
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_projects'
      and policyname = 'anvil_projects_owner_delete'
  ) then
    create policy "anvil_projects_owner_delete"
      on public.anvil_projects
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
