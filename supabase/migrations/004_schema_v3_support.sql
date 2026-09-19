create table public.context_cache (
  project_id uuid primary key references public.projects (id) on delete cascade,
  summary jsonb,
  entity_index jsonb,
  scene_index jsonb,
  constraint_index jsonb,
  rebuilt_at timestamptz not null default now()
);
create table public.versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  version_num integer not null,
  data jsonb not null,
  operation text,
  label text,
  is_snapshot boolean not null default false,
  created_at timestamptz not null default now(),
  unique (target_type, target_id, version_num)
);
create table public.operation_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  operation text not null,
  target_type text,
  target_id uuid,
  actor text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  job_type text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create table public.drawing_pool (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  target_family text,
  label text,
  description text,
  media_url text,
  source_entity_id uuid references public.entities (id) on delete set null,
  status text not null default 'in_pool' check (status in ('in_pool', 'placed', 'discarded')),
  created_at timestamptz not null default now()
);
