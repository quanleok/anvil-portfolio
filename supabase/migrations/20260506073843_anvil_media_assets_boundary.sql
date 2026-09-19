create table if not exists public.anvil_media_assets (
  id text primary key,
  owner_id uuid references auth.users(id) on delete set null,
  project_id text references public.anvil_projects(id) on delete set null,
  job_id text references public.anvil_agent_jobs(id) on delete set null,
  kind text not null check (kind in (
    'image',
    'video',
    'audio',
    'other'
  )),
  status text not null check (status in (
    'pending_upload',
    'uploaded',
    'processing',
    'ready',
    'failed',
    'deleted'
  )),
  storage_provider text not null check (storage_provider in (
    'bunny'
  )),
  storage_zone text,
  object_key text not null,
  file_name text not null,
  content_type text not null,
  byte_size bigint not null default 0,
  checksum_sha256 text,
  source text not null default 'upload' check (source in (
    'upload',
    'agent',
    'generated',
    'import',
    'system'
  )),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_media_assets_file_name_length
    check (char_length(file_name) between 1 and 240),
  constraint anvil_media_assets_content_type_length
    check (char_length(content_type) between 1 and 160),
  constraint anvil_media_assets_object_key_length
    check (char_length(object_key) between 1 and 900),
  constraint anvil_media_assets_byte_size
    check (byte_size >= 0 and byte_size <= 53687091200),
  constraint anvil_media_assets_checksum
    check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists anvil_media_assets_owner_updated_idx
  on public.anvil_media_assets (owner_id, updated_at desc);

create index if not exists anvil_media_assets_project_updated_idx
  on public.anvil_media_assets (project_id, updated_at desc);

create index if not exists anvil_media_assets_job_updated_idx
  on public.anvil_media_assets (job_id, updated_at desc);

create index if not exists anvil_media_assets_owner_kind_idx
  on public.anvil_media_assets (owner_id, kind, updated_at desc);

create index if not exists anvil_media_assets_owner_status_idx
  on public.anvil_media_assets (owner_id, status, updated_at desc);

create unique index if not exists anvil_media_assets_provider_key_idx
  on public.anvil_media_assets (storage_provider, object_key);

alter table public.anvil_media_assets enable row level security;

revoke all on table public.anvil_media_assets from anon;
revoke all on table public.anvil_media_assets from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_media_assets'
      and policyname = 'anvil_media_assets_owner_select'
  ) then
    create policy "anvil_media_assets_owner_select"
      on public.anvil_media_assets
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_media_assets'
      and policyname = 'anvil_media_assets_owner_insert'
  ) then
    create policy "anvil_media_assets_owner_insert"
      on public.anvil_media_assets
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
      and tablename = 'anvil_media_assets'
      and policyname = 'anvil_media_assets_owner_update'
  ) then
    create policy "anvil_media_assets_owner_update"
      on public.anvil_media_assets
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_media_assets'
      and policyname = 'anvil_media_assets_owner_delete'
  ) then
    create policy "anvil_media_assets_owner_delete"
      on public.anvil_media_assets
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
