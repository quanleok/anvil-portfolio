create table public.generations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  position integer not null default 0,
  group_key text,
  group_label text,
  label text,
  beat_summary text,
  duration_seconds integer not null default 10,
  compiled_prompt text,
  camera_notes text,
  lighting_notes text,
  audio_notes text,
  constraint_notes text,
  transition_from text,
  transition_to text,
  freshness text not null default 'current'
    check (freshness in ('current', 'stale')),
  lifecycle text not null default 'active'
    check (lifecycle in ('missing', 'proposed', 'active', 'locked')),
  protection text not null default 'live'
    check (protection in ('live', 'frozen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.generation_scenes (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations (id) on delete cascade,
  scene_id uuid not null references public.story_units (id) on delete cascade,
  position integer not null default 0,
  unique (generation_id, scene_id)
);
create table public.generation_entities (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations (id) on delete cascade,
  entity_id uuid not null references public.entities (id) on delete cascade,
  role text not null default 'appears',
  unique (generation_id, entity_id)
);
create table public.generation_shots (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations (id) on delete cascade,
  position integer not null default 0,
  start_second numeric(5,1) not null default 0,
  end_second numeric(5,1) not null default 5,
  description text not null,
  camera_direction text,
  created_at timestamptz not null default now()
);
create index idx_generations_project on public.generations (project_id, position);
create index idx_generation_scenes_generation on public.generation_scenes (generation_id, position);
create index idx_generation_scenes_scene on public.generation_scenes (scene_id);
create index idx_generation_entities_generation on public.generation_entities (generation_id);
create index idx_generation_entities_entity on public.generation_entities (entity_id);
create index idx_generation_shots_generation on public.generation_shots (generation_id, position);
grant select, insert, update, delete
  on public.generations, public.generation_scenes, public.generation_entities, public.generation_shots
  to anon, authenticated, service_role;
alter table public.generations enable row level security;
alter table public.generation_scenes enable row level security;
alter table public.generation_entities enable row level security;
alter table public.generation_shots enable row level security;
create policy "Users access own generations"
on public.generations
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own generation scenes"
on public.generation_scenes
for all
using (
  generation_id in (
    select id
    from public.generations
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
)
with check (
  generation_id in (
    select id
    from public.generations
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
);
create policy "Users access own generation entities"
on public.generation_entities
for all
using (
  generation_id in (
    select id
    from public.generations
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
)
with check (
  generation_id in (
    select id
    from public.generations
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
);
create policy "Users access own generation shots"
on public.generation_shots
for all
using (
  generation_id in (
    select id
    from public.generations
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
)
with check (
  generation_id in (
    select id
    from public.generations
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
);
create trigger freeze_guard
before update on public.generations
for each row
execute function public.reject_frozen_update();
create trigger trg_generations_updated
before update on public.generations
for each row
execute function public.set_updated_at();
