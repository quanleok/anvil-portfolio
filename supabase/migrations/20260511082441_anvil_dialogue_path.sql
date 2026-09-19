-- Browser parity Phase B: allow `dialogue/...md` paths on
-- anvil_project_files + anvil_project_file_revisions so the cloud
-- workspace can persist `dialogue/dialogue.md` and similar
-- dialogue child docs. Mirrors desktop's DIALOGUE_DOC_PATH
-- ("dialogue/dialogue.md") in apps/desktop/src/lib/dialogue.ts.

alter table public.anvil_project_files
  drop constraint if exists anvil_project_files_safe_path;

alter table public.anvil_project_files
  add constraint anvil_project_files_safe_path
    check (
      path ~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
      and path not like '/%'
      and path not like '%..%'
      and path not like '%//%'
    );

alter table public.anvil_project_file_revisions
  drop constraint if exists anvil_project_file_revisions_safe_path;

alter table public.anvil_project_file_revisions
  add constraint anvil_project_file_revisions_safe_path
    check (
      path ~ '^(story|script|scenes|shots|prompts|assets|custom|dialogue)/[A-Za-z0-9._/ -]+[.]md$'
      and path not like '/%'
      and path not like '%..%'
      and path not like '%//%'
    );
