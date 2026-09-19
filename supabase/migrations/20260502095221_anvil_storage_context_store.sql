create table if not exists public.anvil_storage_units (
  id text primary key,
  owner_id uuid references auth.users(id) on delete set null,
  project_id text references public.anvil_projects(id) on delete set null,
  name text not null,
  summary text not null default 'Reusable AI generation data.',
  icon text not null default 'vault' check (icon in (
    'vault',
    'context',
    'character',
    'location',
    'product',
    'media',
    'spark'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_storage_units_name_length
    check (char_length(name) between 1 and 160)
);

create table if not exists public.anvil_storage_sections (
  id text primary key,
  unit_id text not null references public.anvil_storage_units(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete set null,
  project_id text references public.anvil_projects(id) on delete set null,
  kind text not null check (kind in (
    'context',
    'canon',
    'character',
    'location',
    'product',
    'prop',
    'asset',
    'audio',
    'media',
    'reference',
    'prompt',
    'output',
    'style',
    'workflow',
    'custom'
  )),
  title text not null,
  body text not null default '',
  tags text[] not null default '{}'::text[],
  source text not null default 'user' check (source in (
    'user',
    'agent',
    'import',
    'output',
    'api'
  )),
  version integer not null default 1 check (version > 0),
  relationships text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_storage_sections_title_length
    check (char_length(title) between 1 and 160)
);

create index if not exists anvil_storage_units_owner_updated_idx
  on public.anvil_storage_units (owner_id, updated_at desc);

create index if not exists anvil_storage_units_project_updated_idx
  on public.anvil_storage_units (project_id, updated_at desc);

create index if not exists anvil_storage_sections_unit_updated_idx
  on public.anvil_storage_sections (unit_id, updated_at desc);

create index if not exists anvil_storage_sections_owner_kind_idx
  on public.anvil_storage_sections (owner_id, kind, updated_at desc);

create index if not exists anvil_storage_sections_project_kind_idx
  on public.anvil_storage_sections (project_id, kind, updated_at desc);

alter table public.anvil_storage_units enable row level security;
alter table public.anvil_storage_sections enable row level security;

revoke all on table public.anvil_storage_units from anon;
revoke all on table public.anvil_storage_units from authenticated;
revoke all on table public.anvil_storage_sections from anon;
revoke all on table public.anvil_storage_sections from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_units'
      and policyname = 'anvil_storage_units_owner_select'
  ) then
    create policy "anvil_storage_units_owner_select"
      on public.anvil_storage_units
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_units'
      and policyname = 'anvil_storage_units_owner_insert'
  ) then
    create policy "anvil_storage_units_owner_insert"
      on public.anvil_storage_units
      for insert
      to authenticated
      with check (
        owner_id = (select auth.uid())
        and (
          project_id is null
          or exists (
            select 1
            from public.anvil_projects project
            where project.id = project_id
              and project.owner_id = (select auth.uid())
          )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_units'
      and policyname = 'anvil_storage_units_owner_update'
  ) then
    create policy "anvil_storage_units_owner_update"
      on public.anvil_storage_units
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_units'
      and policyname = 'anvil_storage_units_owner_delete'
  ) then
    create policy "anvil_storage_units_owner_delete"
      on public.anvil_storage_units
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_sections'
      and policyname = 'anvil_storage_sections_owner_select'
  ) then
    create policy "anvil_storage_sections_owner_select"
      on public.anvil_storage_sections
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_sections'
      and policyname = 'anvil_storage_sections_owner_insert'
  ) then
    create policy "anvil_storage_sections_owner_insert"
      on public.anvil_storage_sections
      for insert
      to authenticated
      with check (
        owner_id = (select auth.uid())
        and exists (
          select 1
          from public.anvil_storage_units unit
          where unit.id = unit_id
            and unit.owner_id = (select auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_sections'
      and policyname = 'anvil_storage_sections_owner_update'
  ) then
    create policy "anvil_storage_sections_owner_update"
      on public.anvil_storage_sections
      for update
      to authenticated
      using (owner_id = (select auth.uid()))
      with check (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_storage_sections'
      and policyname = 'anvil_storage_sections_owner_delete'
  ) then
    create policy "anvil_storage_sections_owner_delete"
      on public.anvil_storage_sections
      for delete
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
