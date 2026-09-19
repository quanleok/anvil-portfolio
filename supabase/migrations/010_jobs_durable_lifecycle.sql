alter table public.jobs
  add column if not exists dedupe_key text,
  add column if not exists step text,
  add column if not exists progress integer not null default 0,
  add column if not exists status_message text,
  add column if not exists steps jsonb not null default '[]'::jsonb,
  add column if not exists error_code text,
  add column if not exists error_details jsonb not null default '{}'::jsonb,
  add column if not exists started_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.jobs
  drop constraint if exists jobs_status_check;
update public.jobs
set status = 'queued'
where status = 'pending';
update public.jobs
set status = 'succeeded'
where status = 'completed';
alter table public.jobs
  add constraint jobs_status_check
  check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled'));
alter table public.jobs
  drop constraint if exists jobs_progress_check;
alter table public.jobs
  add constraint jobs_progress_check
  check (progress >= 0 and progress <= 100);
create index if not exists idx_jobs_project_created_at
  on public.jobs (project_id, created_at desc);
create unique index if not exists idx_jobs_active_dedupe
  on public.jobs (project_id, job_type, dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');
drop trigger if exists trg_jobs_updated on public.jobs;
create trigger trg_jobs_updated
before update on public.jobs
for each row
execute function public.set_updated_at();
