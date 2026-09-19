-- Browser workspace consistency hardening:
-- - transactional project JSONB + dedicated file-row sync
-- - dialogue path backfill into dedicated file rows
-- - revision cleanup / cascade for deleted files

alter table public.anvil_project_files
  drop constraint if exists anvil_project_files_safe_path;

alter table public.anvil_project_files
  add constraint anvil_project_files_safe_path
    check (
      path ~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
      and path not like '/%'
      and path not like '%..%'
      and path not like '%//%'
    );

alter table public.anvil_project_file_revisions
  drop constraint if exists anvil_project_file_revisions_safe_path;

alter table public.anvil_project_file_revisions
  add constraint anvil_project_file_revisions_safe_path
    check (
      path ~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
      and path not like '/%'
      and path not like '%..%'
      and path not like '%//%'
    );

insert into public.anvil_project_files (
  owner_id,
  project_id,
  path,
  title,
  kind,
  content,
  metadata,
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
  case
    when nullif(file_entry.value->>'contextGroup', '') is not null
      then jsonb_build_object('contextGroup', file_entry.value->>'contextGroup')
    else '{}'::jsonb
  end,
  case
    when coalesce(file_entry.value->>'createdAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
      then (file_entry.value->>'createdAt')::timestamptz
    else project.created_at
  end,
  case
    when coalesce(file_entry.value->>'updatedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
      then (file_entry.value->>'updatedAt')::timestamptz
    else project.updated_at
  end
from public.anvil_projects project
cross join lateral jsonb_each(
  case
    when jsonb_typeof(project.project->'files') = 'object' then project.project->'files'
    else '{}'::jsonb
  end
) as file_entry(key, value)
where project.owner_id is not null
  and file_entry.key ~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
  and file_entry.key not like '/%'
  and file_entry.key not like '%..%'
  and file_entry.key not like '%//%'
on conflict (project_id, path) do update
set
  owner_id = excluded.owner_id,
  title = excluded.title,
  kind = excluded.kind,
  content = excluded.content,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at;

delete from public.anvil_project_file_revisions revision
where not exists (
  select 1
  from public.anvil_project_files file
  where file.project_id = revision.project_id
    and file.path = revision.path
);

alter table public.anvil_project_file_revisions
  drop constraint if exists anvil_project_file_revisions_file_fk;

alter table public.anvil_project_file_revisions
  add constraint anvil_project_file_revisions_file_fk
  foreign key (project_id, path)
  references public.anvil_project_files (project_id, path)
  on delete cascade;

create or replace function public.anvil_update_project_document_and_files(
  p_owner_id uuid,
  p_project_id text,
  p_project jsonb,
  p_updated_at timestamptz
)
returns public.anvil_projects
language plpgsql
set search_path = public
as $$
declare
  updated_project public.anvil_projects%rowtype;
begin
  update public.anvil_projects
  set
    project = p_project,
    updated_at = p_updated_at
  where id = p_project_id
    and owner_id = p_owner_id
  returning * into updated_project;

  if not found then
    raise exception 'Project was not found for this account.'
      using errcode = 'P0002';
  end if;

  delete from public.anvil_project_files file
  where file.owner_id = p_owner_id
    and file.project_id = p_project_id
    and not exists (
      select 1
      from jsonb_object_keys(
        case
          when jsonb_typeof(p_project->'files') = 'object' then p_project->'files'
          else '{}'::jsonb
        end
      ) as incoming(path)
      where incoming.path = file.path
    );

  insert into public.anvil_project_files (
    owner_id,
    project_id,
    path,
    title,
    kind,
    content,
    metadata,
    created_at,
    updated_at
  )
  select
    p_owner_id,
    p_project_id,
    file_entry.key,
    coalesce(nullif(file_entry.value->>'title', ''), regexp_replace(regexp_replace(file_entry.key, '^.*/', ''), '[.]md$', '')),
    case
      when file_entry.value->>'kind' in ('markdown', 'media-note', 'system') then file_entry.value->>'kind'
      else 'markdown'
    end,
    left(coalesce(file_entry.value->>'content', ''), 240000),
    case
      when nullif(file_entry.value->>'contextGroup', '') is not null
        then jsonb_build_object('contextGroup', file_entry.value->>'contextGroup')
      else '{}'::jsonb
    end,
    case
      when coalesce(file_entry.value->>'createdAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        then (file_entry.value->>'createdAt')::timestamptz
      else updated_project.created_at
    end,
    case
      when coalesce(file_entry.value->>'updatedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        then (file_entry.value->>'updatedAt')::timestamptz
      else p_updated_at
    end
  from jsonb_each(
    case
      when jsonb_typeof(p_project->'files') = 'object' then p_project->'files'
      else '{}'::jsonb
    end
  ) as file_entry(key, value)
  where file_entry.key ~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
    and file_entry.key not like '/%'
    and file_entry.key not like '%..%'
    and file_entry.key not like '%//%'
  on conflict (project_id, path) do update
  set
    owner_id = excluded.owner_id,
    title = excluded.title,
    kind = excluded.kind,
    content = excluded.content,
    metadata = excluded.metadata,
    updated_at = excluded.updated_at;

  return updated_project;
end;
$$;

revoke all on function public.anvil_update_project_document_and_files(uuid, text, jsonb, timestamptz) from public;
revoke all on function public.anvil_update_project_document_and_files(uuid, text, jsonb, timestamptz) from anon;
revoke all on function public.anvil_update_project_document_and_files(uuid, text, jsonb, timestamptz) from authenticated;
grant execute on function public.anvil_update_project_document_and_files(uuid, text, jsonb, timestamptz) to service_role;
