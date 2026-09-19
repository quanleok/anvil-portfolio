create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  media_type text not null check (media_type in ('text', 'image', 'video', 'audio')),
  file_url text,
  file_name text,
  content_text text,
  created_at timestamptz not null default now()
);
create table public.evidence_analysis (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence (id) on delete cascade,
  entity_id uuid references public.entities (id) on delete set null,
  analysis jsonb,
  description text,
  created_at timestamptz not null default now()
);
create table public.constraints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  entity_id uuid references public.entities (id) on delete cascade,
  source text not null check (source in ('extracted', 'user', 'preset')),
  rule_text text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
