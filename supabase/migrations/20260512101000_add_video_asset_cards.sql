-- Browser asset cards: make Video a first-class card section.
--
-- The UI already exposes an Assets > Video lane. Before this
-- migration, only loose video media could be uploaded there; creating
-- a persistent video card failed because the table check constraint
-- did not include `videos`.

alter table public.anvil_project_assets
  drop constraint if exists anvil_project_assets_section_check;

alter table public.anvil_project_assets
  add constraint anvil_project_assets_section_check
  check (section in (
    'characters',
    'locations',
    'props',
    'keyframes',
    'audio',
    'videos'
  ));
