create table if not exists public.anvil_project_file_revisions (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null references public.anvil_projects(id) on delete cascade,
  path text not null,
  title text not null,
  kind text not null default 'markdown' check (kind in (
    'markdown',
    'media-note',
    'system'
  )),
  operation text not null check (operation in (
    'create',
    'update',
    'append',
    'delete',
    'action',
    'import',
    'system'
  )),
  content text not null default '',
  previous_content text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  constraint anvil_project_file_revisions_path_length
    check (char_length(path) between 4 and 900),
  constraint anvil_project_file_revisions_safe_path
    check (
      path ~ '^(story|script|scenes|shots|prompts|assets|custom)/[A-Za-z0-9._/ -]+[.]md$'
      and path not like '/%'
      and path not like '%..%'
      and path not like '%//%'
    ),
  constraint anvil_project_file_revisions_title_length
    check (char_length(title) between 1 and 160),
  constraint anvil_project_file_revisions_content_length
    check (char_length(content) <= 240000),
  constraint anvil_project_file_revisions_previous_content_length
    check (previous_content is null or char_length(previous_content) <= 240000)
);

create index if not exists anvil_project_file_revisions_owner_project_idx
  on public.anvil_project_file_revisions (owner_id, project_id, created_at desc);

create index if not exists anvil_project_file_revisions_file_idx
  on public.anvil_project_file_revisions (project_id, path, created_at desc);

create index if not exists anvil_project_file_revisions_owner_file_idx
  on public.anvil_project_file_revisions (owner_id, project_id, path, created_at desc);

alter table public.anvil_project_file_revisions enable row level security;

revoke all on table public.anvil_project_file_revisions from anon;
revoke all on table public.anvil_project_file_revisions from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_file_revisions'
      and policyname = 'anvil_project_file_revisions_owner_select'
  ) then
    create policy "anvil_project_file_revisions_owner_select"
      on public.anvil_project_file_revisions
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_file_revisions'
      and policyname = 'anvil_project_file_revisions_owner_insert'
  ) then
    create policy "anvil_project_file_revisions_owner_insert"
      on public.anvil_project_file_revisions
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
      and tablename = 'anvil_project_file_revisions'
      and policyname = 'anvil_project_file_revisions_owner_delete'
  ) then
    create policy "anvil_project_file_revisions_owner_delete"
      on public.anvil_project_file_revisions
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;

insert into public.anvil_project_file_revisions (
  id,
  owner_id,
  project_id,
  path,
  title,
  kind,
  operation,
  content,
  created_at
)
select
  'revision_' || replace(gen_random_uuid()::text, '-', ''),
  file.owner_id,
  file.project_id,
  file.path,
  file.title,
  file.kind,
  'import',
  file.content,
  file.updated_at
from public.anvil_project_files file
where not exists (
  select 1
  from public.anvil_project_file_revisions revision
  where revision.project_id = file.project_id
    and revision.path = file.path
);
