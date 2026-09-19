create table public.entities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  family text not null,
  name text not null,
  description text,
  prompt_desc text,
  details jsonb not null default '{}'::jsonb,
  lifecycle text not null default 'missing' check (lifecycle in ('missing', 'proposed', 'active', 'locked')),
  protection text not null default 'live' check (protection in ('live', 'frozen')),
  freshness text not null default 'current' check (freshness in ('current', 'stale')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.entity_media (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  media_type text not null check (media_type in ('text', 'image', 'video', 'audio')),
  label text,
  url text,
  content text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.local_overrides (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  scene_id uuid not null references public.story_units (id) on delete cascade,
  override_desc text,
  override_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, scene_id)
);
create table public.scene_entities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid not null references public.story_units (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  role text,
  created_at timestamptz not null default now(),
  unique (scene_id, entity_id)
);
alter table public.dialogue
add constraint dialogue_entity_id_fkey
foreign key (entity_id) references public.entities (id) on delete set null;
