create table if not exists public.anvil_project_files (
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null references public.anvil_projects(id) on delete cascade,
  path text not null,
  title text not null,
  kind text not null default 'markdown' check (kind in (
    'markdown',
    'media-note',
    'system'
  )),
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, path),
  constraint anvil_project_files_path_length
    check (char_length(path) between 4 and 900),
  constraint anvil_project_files_safe_path
    check (
      path ~ '^(story|script|scenes|shots|prompts|assets|custom)/[A-Za-z0-9._/ -]+[.]md$'
      and path not like '/%'
      and path not like '%..%'
      and path not like '%//%'
    ),
  constraint anvil_project_files_title_length
    check (char_length(title) between 1 and 160),
  constraint anvil_project_files_content_length
    check (char_length(content) <= 240000)
);

create index if not exists anvil_project_files_owner_project_idx
  on public.anvil_project_files (owner_id, project_id, updated_at desc);

create index if not exists anvil_project_files_project_updated_idx
  on public.anvil_project_files (project_id, updated_at desc);

create index if not exists anvil_project_files_owner_path_idx
  on public.anvil_project_files (owner_id, path);

alter table public.anvil_project_files enable row level security;

revoke all on table public.anvil_project_files from anon;
revoke all on table public.anvil_project_files from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_files'
      and policyname = 'anvil_project_files_owner_select'
  ) then
    create policy "anvil_project_files_owner_select"
      on public.anvil_project_files
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_files'
      and policyname = 'anvil_project_files_owner_insert'
  ) then
    create policy "anvil_project_files_owner_insert"
      on public.anvil_project_files
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
      and tablename = 'anvil_project_files'
      and policyname = 'anvil_project_files_owner_update'
  ) then
    create policy "anvil_project_files_owner_update"
      on public.anvil_project_files
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_files'
      and policyname = 'anvil_project_files_owner_delete'
  ) then
    create policy "anvil_project_files_owner_delete"
      on public.anvil_project_files
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;

insert into public.anvil_project_files (
  owner_id,
  project_id,
  path,
  title,
  kind,
  content,
  created_at,
  updated_at
)
select
  project.owner_id,
  project.id,
  file_entry.key,
  coalesce(nullif(file_entry.value->>'title', ''), regexp_replace(regexp_replace(file_entry.key, '^.*/', ''), '[.]md$', '')),
  case
    when file_entry.value->>'kind' in ('markdown', 'media-note', 'system') then file_entry.value->>'kind'
    else 'markdown'
  end,
  left(coalesce(file_entry.value->>'content', ''), 240000),
  coalesce(nullif(file_entry.value->>'createdAt', '')::timestamptz, project.created_at),
  coalesce(nullif(file_entry.value->>'updatedAt', '')::timestamptz, project.updated_at)
from public.anvil_projects project
cross join lateral jsonb_each(
  case
    when jsonb_typeof(project.project->'files') = 'object' then project.project->'files'
    else '{}'::jsonb
  end
) as file_entry(key, value)
where project.owner_id is not null
  and file_entry.key ~ '^(story|script|scenes|shots|prompts|assets|custom)/[A-Za-z0-9._/ -]+[.]md$'
  and file_entry.key not like '/%'
  and file_entry.key not like '%..%'
  and file_entry.key not like '%//%'
on conflict (project_id, path) do nothing;
