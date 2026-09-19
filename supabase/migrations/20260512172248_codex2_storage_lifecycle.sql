-- Codex-2 storage lifecycle hardening:
-- - transactional browser project file delete/rename helpers
-- - deleted media cleanup scan index
-- - bounded agent-run payload retention helper

create index if not exists anvil_media_assets_deleted_cleanup_idx
  on public.anvil_media_assets (updated_at asc)
  where status = 'deleted';

create index if not exists anvil_agent_runs_payload_retention_idx
  on public.anvil_agent_runs (created_at asc)
  where request <> '{}'::jsonb
     or response is not null
     or error is not null;

create or replace function public.anvil_delete_project_file(
  p_owner_id uuid,
  p_project_id text,
  p_file_path text,
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
  if p_file_path !~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
    or p_file_path like '/%'
    or p_file_path like '%..%'
    or p_file_path like '%//%' then
    raise exception 'Unsafe project file path.'
      using errcode = '22023';
  end if;

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

  delete from public.anvil_project_file_revisions revision
  where revision.owner_id = p_owner_id
    and revision.project_id = p_project_id
    and revision.path = p_file_path;

  delete from public.anvil_project_files file
  where file.owner_id = p_owner_id
    and file.project_id = p_project_id
    and file.path = p_file_path;

  return updated_project;
end;
$$;

create or replace function public.anvil_rename_project_file(
  p_owner_id uuid,
  p_project_id text,
  p_from_path text,
  p_to_path text,
  p_project jsonb,
  p_updated_at timestamptz
)
returns public.anvil_projects
language plpgsql
set search_path = public
as $$
declare
  file_entry jsonb;
  updated_project public.anvil_projects%rowtype;
begin
  if p_from_path !~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
    or p_from_path like '/%'
    or p_from_path like '%..%'
    or p_from_path like '%//%'
    or p_to_path !~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
    or p_to_path like '/%'
    or p_to_path like '%..%'
    or p_to_path like '%//%' then
    raise exception 'Unsafe project file path.'
      using errcode = '22023';
  end if;

  if p_from_path <> p_to_path and exists (
    select 1
    from public.anvil_project_files file
    where file.owner_id = p_owner_id
      and file.project_id = p_project_id
      and file.path = p_to_path
  ) then
    raise exception 'Destination file already exists.'
      using errcode = '23505';
  end if;

  file_entry = case
    when jsonb_typeof(p_project->'files') = 'object' then p_project->'files'->p_to_path
    else null
  end;

  if jsonb_typeof(file_entry) <> 'object' then
    raise exception 'Renamed project file is missing from project document.'
      using errcode = '22023';
  end if;

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
  values (
    p_owner_id,
    p_project_id,
    p_to_path,
    coalesce(nullif(file_entry->>'title', ''), regexp_replace(regexp_replace(p_to_path, '^.*/', ''), '[.]md$', '')),
    case
      when file_entry->>'kind' in ('markdown', 'media-note', 'system') then file_entry->>'kind'
      else 'markdown'
    end,
    left(coalesce(file_entry->>'content', ''), 240000),
    case
      when nullif(file_entry->>'contextGroup', '') is not null
        then jsonb_build_object('contextGroup', file_entry->>'contextGroup')
      else '{}'::jsonb
    end,
    case
      when coalesce(file_entry->>'createdAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        then (file_entry->>'createdAt')::timestamptz
      else updated_project.created_at
    end,
    case
      when coalesce(file_entry->>'updatedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        then (file_entry->>'updatedAt')::timestamptz
      else p_updated_at
    end
  )
  on conflict (project_id, path) do update
  set
    owner_id = excluded.owner_id,
    title = excluded.title,
    kind = excluded.kind,
    content = excluded.content,
    metadata = excluded.metadata,
    updated_at = excluded.updated_at;

  update public.anvil_project_file_revisions revision
  set
    path = p_to_path,
    title = coalesce(nullif(file_entry->>'title', ''), regexp_replace(regexp_replace(p_to_path, '^.*/', ''), '[.]md$', ''))
  where revision.owner_id = p_owner_id
    and revision.project_id = p_project_id
    and revision.path = p_from_path;

  delete from public.anvil_project_files file
  where file.owner_id = p_owner_id
    and file.project_id = p_project_id
    and file.path = p_from_path
    and file.path <> p_to_path;

  return updated_project;
end;
$$;

create or replace function public.anvil_prune_agent_run_payloads(
  p_before timestamptz default now() - interval '30 days',
  p_limit integer default 500
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  pruned integer;
begin
  with targets as (
    select id
    from public.anvil_agent_runs
    where created_at < p_before
      and (
        request <> '{}'::jsonb
        or response is not null
        or error is not null
      )
    order by created_at asc
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  )
  update public.anvil_agent_runs run
  set
    request = '{}'::jsonb,
    response = null,
    error = null,
    updated_at = now()
  from targets
  where run.id = targets.id;

  get diagnostics pruned = row_count;
  return pruned;
end;
$$;

revoke all on function public.anvil_delete_project_file(uuid, text, text, jsonb, timestamptz) from public;
revoke all on function public.anvil_delete_project_file(uuid, text, text, jsonb, timestamptz) from anon;
revoke all on function public.anvil_delete_project_file(uuid, text, text, jsonb, timestamptz) from authenticated;
grant execute on function public.anvil_delete_project_file(uuid, text, text, jsonb, timestamptz) to service_role;

revoke all on function public.anvil_rename_project_file(uuid, text, text, text, jsonb, timestamptz) from public;
revoke all on function public.anvil_rename_project_file(uuid, text, text, text, jsonb, timestamptz) from anon;
revoke all on function public.anvil_rename_project_file(uuid, text, text, text, jsonb, timestamptz) from authenticated;
grant execute on function public.anvil_rename_project_file(uuid, text, text, text, jsonb, timestamptz) to service_role;

revoke all on function public.anvil_prune_agent_run_payloads(timestamptz, integer) from public;
revoke all on function public.anvil_prune_agent_run_payloads(timestamptz, integer) from anon;
revoke all on function public.anvil_prune_agent_run_payloads(timestamptz, integer) from authenticated;
grant execute on function public.anvil_prune_agent_run_payloads(timestamptz, integer) to service_role;
