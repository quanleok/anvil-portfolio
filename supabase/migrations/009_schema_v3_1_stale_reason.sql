alter table public.prompts
  add column if not exists stale_reason jsonb;
create or replace function public.reject_frozen_update()
returns trigger
language plpgsql
as $$
begin
  if old.protection = 'frozen' and new.protection = 'frozen' then
    if tg_table_name = 'prompts'
       and old.id is not distinct from new.id
       and old.project_id is not distinct from new.project_id
       and old.scene_id is not distinct from new.scene_id
       and old.shot_plan_id is not distinct from new.shot_plan_id
       and old.tags is not distinct from new.tags
       and old.compiled_text is not distinct from new.compiled_text
       and old.word_count is not distinct from new.word_count
       and old.lifecycle is not distinct from new.lifecycle
       and old.protection is not distinct from new.protection
       and old.created_at is not distinct from new.created_at then
      return new;
    end if;

    raise exception 'Cannot modify frozen item: % %', tg_table_name, old.id;
  end if;

  return new;
end;
$$;
