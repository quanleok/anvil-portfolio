create table if not exists public.anvil_agent_threads (
  id text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  project_id text not null references public.anvil_projects(id) on delete cascade,
  title text not null default 'Anvil Agent',
  status text not null default 'active' check (status in (
    'active',
    'archived',
    'deleted'
  )),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_agent_threads_title_length
    check (char_length(title) between 1 and 160)
);

create table if not exists public.anvil_agent_messages (
  id text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  project_id text not null references public.anvil_projects(id) on delete cascade,
  thread_id text not null references public.anvil_agent_threads(id) on delete cascade,
  role text not null check (role in (
    'user',
    'assistant',
    'system',
    'tool'
  )),
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  constraint anvil_agent_messages_content_length
    check (char_length(content) <= 120000)
);

create table if not exists public.anvil_agent_runs (
  id text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  project_id text not null references public.anvil_projects(id) on delete cascade,
  thread_id text not null references public.anvil_agent_threads(id) on delete cascade,
  status text not null check (status in (
    'queued',
    'running',
    'succeeded',
    'failed',
    'limited',
    'cancelled'
  )),
  provider text,
  model text,
  request jsonb not null default '{}'::jsonb check (jsonb_typeof(request) = 'object'),
  response jsonb check (response is null or jsonb_typeof(response) = 'object'),
  action_count integer not null default 0 check (action_count >= 0),
  applied_action_count integer not null default 0 check (applied_action_count >= 0),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists anvil_agent_threads_owner_project_idx
  on public.anvil_agent_threads (owner_id, project_id, updated_at desc);

create index if not exists anvil_agent_messages_thread_created_idx
  on public.anvil_agent_messages (thread_id, created_at asc);

create index if not exists anvil_agent_messages_owner_project_idx
  on public.anvil_agent_messages (owner_id, project_id, created_at desc);

create index if not exists anvil_agent_runs_owner_project_idx
  on public.anvil_agent_runs (owner_id, project_id, created_at desc);

create index if not exists anvil_agent_runs_thread_created_idx
  on public.anvil_agent_runs (thread_id, created_at desc);

alter table public.anvil_agent_threads enable row level security;
alter table public.anvil_agent_messages enable row level security;
alter table public.anvil_agent_runs enable row level security;

revoke all on table public.anvil_agent_threads from anon;
revoke all on table public.anvil_agent_messages from anon;
revoke all on table public.anvil_agent_runs from anon;
revoke all on table public.anvil_agent_threads from authenticated;
revoke all on table public.anvil_agent_messages from authenticated;
revoke all on table public.anvil_agent_runs from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_threads'
      and policyname = 'anvil_agent_threads_owner_select'
  ) then
    create policy "anvil_agent_threads_owner_select"
      on public.anvil_agent_threads
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_threads'
      and policyname = 'anvil_agent_threads_owner_insert'
  ) then
    create policy "anvil_agent_threads_owner_insert"
      on public.anvil_agent_threads
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
      and tablename = 'anvil_agent_threads'
      and policyname = 'anvil_agent_threads_owner_update'
  ) then
    create policy "anvil_agent_threads_owner_update"
      on public.anvil_agent_threads
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_threads'
      and policyname = 'anvil_agent_threads_owner_delete'
  ) then
    create policy "anvil_agent_threads_owner_delete"
      on public.anvil_agent_threads
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_messages'
      and policyname = 'anvil_agent_messages_owner_select'
  ) then
    create policy "anvil_agent_messages_owner_select"
      on public.anvil_agent_messages
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_messages'
      and policyname = 'anvil_agent_messages_owner_insert'
  ) then
    create policy "anvil_agent_messages_owner_insert"
      on public.anvil_agent_messages
      for insert
      to authenticated
      with check (
        owner_id = (select auth.uid())
        and exists (
          select 1
          from public.anvil_agent_threads thread
          where thread.id = thread_id
            and thread.owner_id = (select auth.uid())
            and thread.project_id = project_id
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_messages'
      and policyname = 'anvil_agent_messages_owner_delete'
  ) then
    create policy "anvil_agent_messages_owner_delete"
      on public.anvil_agent_messages
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_runs'
      and policyname = 'anvil_agent_runs_owner_select'
  ) then
    create policy "anvil_agent_runs_owner_select"
      on public.anvil_agent_runs
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_runs'
      and policyname = 'anvil_agent_runs_owner_insert'
  ) then
    create policy "anvil_agent_runs_owner_insert"
      on public.anvil_agent_runs
      for insert
      to authenticated
      with check (
        owner_id = (select auth.uid())
        and exists (
          select 1
          from public.anvil_agent_threads thread
          where thread.id = thread_id
            and thread.owner_id = (select auth.uid())
            and thread.project_id = project_id
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_runs'
      and policyname = 'anvil_agent_runs_owner_update'
  ) then
    create policy "anvil_agent_runs_owner_update"
      on public.anvil_agent_runs
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_agent_runs'
      and policyname = 'anvil_agent_runs_owner_delete'
  ) then
    create policy "anvil_agent_runs_owner_delete"
      on public.anvil_agent_runs
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
