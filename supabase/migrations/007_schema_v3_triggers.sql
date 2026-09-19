create or replace function public.reject_frozen_update()
returns trigger
language plpgsql
as $$
begin
  if old.protection = 'frozen' and new.protection = 'frozen' then
    raise exception 'Cannot modify frozen item: % %', tg_table_name, old.id;
  end if;
  return new;
end;
$$;
create or replace function public.cascade_lock_children()
returns trigger
language plpgsql
as $$
begin
  if new.protection = 'frozen' and old.protection != 'frozen' then
    update public.story_units
    set protection = 'frozen',
        lifecycle = 'locked'
    where parent_id = new.id
      and protection != 'frozen';

    if new.unit_type = 'scene' then
      update public.dialogue
      set protection = 'frozen',
          lifecycle = 'locked'
      where scene_id = new.id
        and protection != 'frozen';
    end if;
  end if;

  return new;
end;
$$;
create or replace function public.propagate_entity_stale()
returns trigger
language plpgsql
as $$
begin
  if old.prompt_desc is distinct from new.prompt_desc
     or old.description is distinct from new.description then
    update public.prompts
    set freshness = 'stale',
        updated_at = now()
    where scene_id in (
      select scene_id
      from public.scene_entities
      where entity_id = new.id
    )
      and protection != 'frozen';
  end if;

  return new;
end;
$$;
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger freeze_guard
before update on public.story_units
for each row
execute function public.reject_frozen_update();
create trigger freeze_guard
before update on public.entities
for each row
execute function public.reject_frozen_update();
create trigger freeze_guard
before update on public.prompts
for each row
execute function public.reject_frozen_update();
create trigger freeze_guard
before update on public.dialogue
for each row
execute function public.reject_frozen_update();
create trigger lock_cascade
after update on public.story_units
for each row
execute function public.cascade_lock_children();
create trigger stale_propagation
after update on public.entities
for each row
execute function public.propagate_entity_stale();
create trigger trg_projects_updated
before update on public.projects
for each row
execute function public.set_updated_at();
create trigger trg_project_settings_updated
before update on public.project_settings
for each row
execute function public.set_updated_at();
create trigger trg_story_units_updated
before update on public.story_units
for each row
execute function public.set_updated_at();
create trigger trg_dialogue_updated
before update on public.dialogue
for each row
execute function public.set_updated_at();
create trigger trg_prompts_updated
before update on public.prompts
for each row
execute function public.set_updated_at();
create trigger trg_entities_updated
before update on public.entities
for each row
execute function public.set_updated_at();
create trigger trg_local_overrides_updated
before update on public.local_overrides
for each row
execute function public.set_updated_at();
