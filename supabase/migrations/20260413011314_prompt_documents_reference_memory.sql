alter table public.entities
add column if not exists aliases text[] not null default '{}';
create table public.prompt_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid references public.story_units (id) on delete cascade,
  shot_id uuid references public.shot_plans (id) on delete cascade,
  title text not null default '',
  prompt_text text not null default '',
  resolved_prompt_text text,
  copy_bundle_text text,
  notes text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scene_id is not null) <> (shot_id is not null))
);
create unique index if not exists idx_prompt_documents_scene_unique
on public.prompt_documents (project_id, scene_id)
where scene_id is not null;
create unique index if not exists idx_prompt_documents_shot_unique
on public.prompt_documents (project_id, shot_id)
where shot_id is not null;
create index if not exists idx_prompt_documents_project on public.prompt_documents (project_id);
create table public.prompt_asset_refs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  prompt_document_id uuid not null references public.prompt_documents (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  entity_media_id uuid references public.entity_media (id) on delete set null,
  family text not null,
  token text not null,
  position integer not null default 0,
  first_match_index integer,
  matched_text text,
  pinned boolean not null default false,
  source text not null default 'auto_text_match',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_prompt_asset_refs_prompt_entity_unique
on public.prompt_asset_refs (prompt_document_id, entity_id);
create index if not exists idx_prompt_asset_refs_project on public.prompt_asset_refs (project_id);
create index if not exists idx_prompt_asset_refs_prompt on public.prompt_asset_refs (prompt_document_id);
create index if not exists idx_prompt_asset_refs_entity on public.prompt_asset_refs (entity_id);
alter table public.prompt_documents enable row level security;
alter table public.prompt_asset_refs enable row level security;
create policy "Users access own prompt documents"
on public.prompt_documents
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own prompt asset refs"
on public.prompt_asset_refs
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create trigger trg_prompt_documents_updated
before update on public.prompt_documents
for each row
execute function public.set_updated_at();
create trigger trg_prompt_asset_refs_updated
before update on public.prompt_asset_refs
for each row
execute function public.set_updated_at();
