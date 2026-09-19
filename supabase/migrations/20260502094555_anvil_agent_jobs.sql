create table if not exists public.anvil_agent_jobs (
  id text primary key,
  owner_id uuid references auth.users(id) on delete set null,
  project_id text references public.anvil_projects(id) on delete set null,
  role text not null check (role in (
    'project',
    'code',
    'creative',
    'media',
    'context',
    'workflow',
    'tool'
  )),
  status text not null check (status in (
    'queued',
    'running',
    'waiting_for_approval',
    'completed',
    'failed',
    'cancelled',
    'paused'
  )),
  execution_mode text not null check (execution_mode in (
    'local',
    'cloud',
    'bridge',
    'hybrid'
  )),
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  output jsonb check (output is null or jsonb_typeof(output) = 'object'),
  progress integer check (progress is null or (progress >= 0 and progress <= 100)),
  logs text[] not null default '{}'::text[],
  permissions text[] not null default '{}'::text[],
  tool_calls jsonb not null default '[]'::jsonb check (jsonb_typeof(tool_calls) = 'array'),
  cancel_available boolean not null default true,
  retry_available boolean not null default false,
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists anvil_agent_jobs_owner_updated_idx
  on public.anvil_agent_jobs (owner_id, updated_at desc);

create index if not exists anvil_agent_jobs_project_updated_idx
  on public.anvil_agent_jobs (project_id, updated_at desc);

create index if not exists anvil_agent_jobs_status_updated_idx
  on public.anvil_agent_jobs (status, updated_at desc);

create index if not exists anvil_agent_jobs_role_updated_idx
  on public.anvil_agent_jobs (role, updated_at desc);

alter table public.anvil_agent_jobs enable row level security;

revoke all on table public.anvil_agent_jobs from anon;
revoke all on table public.anvil_agent_jobs from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_jobs'
      and policyname = 'anvil_agent_jobs_owner_select'
  ) then
    create policy "anvil_agent_jobs_owner_select"
      on public.anvil_agent_jobs
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_jobs'
      and policyname = 'anvil_agent_jobs_owner_insert'
  ) then
    create policy "anvil_agent_jobs_owner_insert"
      on public.anvil_agent_jobs
      for insert
      to authenticated
      with check (
        owner_id = (select auth.uid())
        and (
          project_id is null
          or exists (
            select 1
            from public.anvil_projects project
            where project.id = project_id
              and project.owner_id = (select auth.uid())
          )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_jobs'
      and policyname = 'anvil_agent_jobs_owner_update'
  ) then
    create policy "anvil_agent_jobs_owner_update"
      on public.anvil_agent_jobs
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_jobs'
      and policyname = 'anvil_agent_jobs_owner_delete'
  ) then
    create policy "anvil_agent_jobs_owner_delete"
      on public.anvil_agent_jobs
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
