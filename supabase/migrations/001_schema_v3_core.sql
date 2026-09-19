create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.project_settings (
  project_id uuid primary key references public.projects (id) on delete cascade,
  format text check (format in ('short_video', 'ad_promo', 'short_film', 'feature_film')),
  duration_target integer,
  style text,
  readiness text check (readiness in ('idea_only', 'draft', 'working', 'final')),
  target_profile text not null default 'seedance2',
  updated_at timestamptz not null default now()
);
create table public.story_units (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  unit_type text not null check (unit_type in ('act', 'beat', 'scene')),
  parent_id uuid references public.story_units (id) on delete cascade,
  position integer not null default 0,
  title text,
  content text,
  duration integer,
  lifecycle text not null default 'missing' check (lifecycle in ('missing', 'proposed', 'active', 'locked')),
  protection text not null default 'live' check (protection in ('live', 'frozen')),
  freshness text not null default 'current' check (freshness in ('current', 'stale')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.dialogue (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid not null references public.story_units (id) on delete cascade,
  entity_id uuid,
  position integer not null default 0,
  line_text text not null,
  direction text,
  lifecycle text not null default 'missing' check (lifecycle in ('missing', 'proposed', 'active', 'locked')),
  protection text not null default 'live' check (protection in ('live', 'frozen')),
  freshness text not null default 'current' check (freshness in ('current', 'stale')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid not null unique references public.story_units (id) on delete cascade,
  tags jsonb not null default '[]'::jsonb,
  compiled_text text,
  word_count integer,
  lifecycle text not null default 'missing' check (lifecycle in ('missing', 'proposed', 'active', 'locked')),
  protection text not null default 'live' check (protection in ('live', 'frozen')),
  freshness text not null default 'current' check (freshness in ('current', 'stale')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
