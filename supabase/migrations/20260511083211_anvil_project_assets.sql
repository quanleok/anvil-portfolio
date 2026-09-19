-- Browser parity Phase D, slice D1: Asset Cards foundation.
--
-- Mirrors desktop's AssetEntry model (apps/desktop/src/types.ts):
-- each card is its own entity with name + folder + notes + variants,
-- and media variants attach back to the card via a new nullable
-- `asset_id` column on `anvil_media_assets`. Detached uploads still
-- work (asset_id null) so legacy projects keep loading.

create table if not exists public.anvil_project_assets (
  asset_id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null references public.anvil_projects(id) on delete cascade,
  section text not null check (section in (
    'characters',
    'locations',
    'props',
    'keyframes',
    'audio'
  )),
  name text not null,
  folder text,
  content text not null default '',
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_project_assets_name_length
    check (char_length(name) between 1 and 240),
  constraint anvil_project_assets_folder_length
    check (folder is null or char_length(folder) between 1 and 240),
  constraint anvil_project_assets_content_length
    check (char_length(content) <= 240000)
);

create index if not exists anvil_project_assets_owner_project_idx
  on public.anvil_project_assets (owner_id, project_id, section, updated_at desc);

-- Add nullable asset_id to anvil_media_assets so media can attach to a
-- card. `on delete set null` preserves the media in the bin if the
-- card is deleted (matches desktop's detach semantics).
alter table public.anvil_media_assets
  add column if not exists asset_id text
    references public.anvil_project_assets(asset_id) on delete set null;

create index if not exists anvil_media_assets_asset_id_idx
  on public.anvil_media_assets (asset_id);

alter table public.anvil_project_assets enable row level security;

revoke all on table public.anvil_project_assets from anon;
revoke all on table public.anvil_project_assets from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_assets'
      and policyname = 'anvil_project_assets_owner_select'
  ) then
    create policy "anvil_project_assets_owner_select"
      on public.anvil_project_assets
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_assets'
      and policyname = 'anvil_project_assets_owner_insert'
  ) then
    create policy "anvil_project_assets_owner_insert"
      on public.anvil_project_assets
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
      and tablename = 'anvil_project_assets'
      and policyname = 'anvil_project_assets_owner_update'
  ) then
    create policy "anvil_project_assets_owner_update"
      on public.anvil_project_assets
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_project_assets'
      and policyname = 'anvil_project_assets_owner_delete'
  ) then
    create policy "anvil_project_assets_owner_delete"
      on public.anvil_project_assets
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
