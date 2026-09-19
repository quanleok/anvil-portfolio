create table public.asset_folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  parent_id uuid references public.asset_folders (id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.entities
add column if not exists folder_id uuid references public.asset_folders (id) on delete set null;
create index if not exists idx_asset_folders_project on public.asset_folders (project_id);
create index if not exists idx_asset_folders_parent on public.asset_folders (parent_id);
create index if not exists idx_entities_folder on public.entities (folder_id);
create unique index if not exists idx_asset_folders_unique_name
on public.asset_folders (project_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
alter table public.asset_folders enable row level security;
create policy "Users access own asset folders"
on public.asset_folders
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create trigger trg_asset_folders_updated
before update on public.asset_folders
for each row
execute function public.set_updated_at();
