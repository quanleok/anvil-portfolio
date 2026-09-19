create table public.scene_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid not null references public.story_units (id) on delete cascade,
  body text,
  dialogue jsonb not null default '[]'::jsonb,
  notes text,
  provenance text not null default 'user_authored'
    check (provenance in ('user', 'ai', 'compiled', 'derived', 'user_authored', 'ai_authored')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.shot_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid not null references public.story_units (id) on delete cascade,
  scene_version_id uuid references public.scene_versions (id) on delete set null,
  order_index integer not null default 0,
  label text,
  summary text,
  coverage_type text,
  camera_hint text,
  duration_hint integer,
  lifecycle text not null default 'proposed'
    check (lifecycle in ('missing', 'proposed', 'active', 'locked')),
  protection text not null default 'live'
    check (protection in ('live', 'frozen')),
  freshness text not null default 'current'
    check (freshness in ('current', 'stale')),
  provenance text not null default 'derived'
    check (provenance in ('user', 'ai', 'compiled', 'derived', 'user_authored', 'ai_authored')),
  version_id uuid references public.versions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scene_id, order_index)
);
alter table public.prompts
  add column shot_plan_id uuid references public.shot_plans (id) on delete cascade;
create unique index idx_prompts_shot_plan_id
  on public.prompts (shot_plan_id)
  where shot_plan_id is not null;
create index idx_scene_versions_project on public.scene_versions (project_id);
create index idx_scene_versions_scene on public.scene_versions (scene_id);
create index idx_shot_plans_project on public.shot_plans (project_id);
create index idx_shot_plans_scene on public.shot_plans (scene_id);
create index idx_shot_plans_scene_version on public.shot_plans (scene_version_id);
grant select, insert, update, delete
  on public.scene_versions, public.shot_plans
  to anon, authenticated, service_role;
alter table public.scene_versions enable row level security;
alter table public.shot_plans enable row level security;
create policy "Users access own scene versions"
on public.scene_versions
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own shot plans"
on public.shot_plans
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create trigger freeze_guard
before update on public.shot_plans
for each row
execute function public.reject_frozen_update();
create trigger trg_scene_versions_updated
before update on public.scene_versions
for each row
execute function public.set_updated_at();
create trigger trg_shot_plans_updated
before update on public.shot_plans
for each row
execute function public.set_updated_at();
