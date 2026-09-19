grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;
alter table public.projects enable row level security;
alter table public.project_settings enable row level security;
alter table public.story_units enable row level security;
alter table public.dialogue enable row level security;
alter table public.prompts enable row level security;
alter table public.entities enable row level security;
alter table public.entity_media enable row level security;
alter table public.local_overrides enable row level security;
alter table public.scene_entities enable row level security;
alter table public.evidence enable row level security;
alter table public.evidence_analysis enable row level security;
alter table public.constraints enable row level security;
alter table public.context_cache enable row level security;
alter table public.versions enable row level security;
alter table public.operation_log enable row level security;
alter table public.jobs enable row level security;
alter table public.drawing_pool enable row level security;
create policy "Users own projects"
on public.projects
for all
using (user_id = auth.uid())
with check (user_id = auth.uid());
create policy "Users access own project settings"
on public.project_settings
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own story units"
on public.story_units
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own dialogue"
on public.dialogue
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own prompts"
on public.prompts
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own entities"
on public.entities
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own media"
on public.entity_media
for all
using (
  entity_id in (
    select id
    from public.entities
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
)
with check (
  entity_id in (
    select id
    from public.entities
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
);
create policy "Users access own local overrides"
on public.local_overrides
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own scene entities"
on public.scene_entities
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users read own evidence"
on public.evidence
for select
using (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users insert own evidence"
on public.evidence
for insert
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users delete own evidence"
on public.evidence
for delete
using (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Evidence immutable"
on public.evidence
for update
using (false)
with check (false);
create policy "Users access own evidence analysis"
on public.evidence_analysis
for all
using (
  evidence_id in (
    select id
    from public.evidence
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
)
with check (
  evidence_id in (
    select id
    from public.evidence
    where project_id in (select id from public.projects where user_id = auth.uid())
  )
);
create policy "Users access own constraints"
on public.constraints
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own context cache"
on public.context_cache
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own versions"
on public.versions
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own operation log"
on public.operation_log
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own jobs"
on public.jobs
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
create policy "Users access own drawing pool"
on public.drawing_pool
for all
using (project_id in (select id from public.projects where user_id = auth.uid()))
with check (project_id in (select id from public.projects where user_id = auth.uid()));
