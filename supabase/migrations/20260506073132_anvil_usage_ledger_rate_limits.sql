create table if not exists public.anvil_usage_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete set null,
  request_id text not null,
  install_id text,
  project_id text,
  plan text not null default 'free',
  method text not null,
  phase text,
  provider text,
  model text,
  status text not null default 'allowed',
  limit_reason text,
  provider_status integer,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  cost_estimate_usd numeric(12, 6) not null default 0,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint anvil_usage_events_request_length
    check (char_length(request_id) between 8 and 160),
  constraint anvil_usage_events_install_length
    check (install_id is null or char_length(install_id) between 3 and 160),
  constraint anvil_usage_events_project_length
    check (project_id is null or char_length(project_id) between 1 and 160),
  constraint anvil_usage_events_plan
    check (plan in ('free', 'pro', 'studio')),
  constraint anvil_usage_events_method_length
    check (char_length(method) between 1 and 80),
  constraint anvil_usage_events_status
    check (status in ('allowed', 'queued', 'limited', 'started', 'succeeded', 'failed')),
  constraint anvil_usage_events_provider_status
    check (provider_status is null or (provider_status >= 100 and provider_status <= 599)),
  constraint anvil_usage_events_token_counts
    check (input_tokens >= 0 and output_tokens >= 0 and total_tokens >= 0),
  constraint anvil_usage_events_cost_nonnegative
    check (cost_estimate_usd >= 0)
);

create unique index if not exists anvil_usage_events_request_idx
  on public.anvil_usage_events (request_id);

create index if not exists anvil_usage_events_owner_created_idx
  on public.anvil_usage_events (owner_id, created_at desc);

create index if not exists anvil_usage_events_owner_month_idx
  on public.anvil_usage_events (owner_id, created_at, status);

create index if not exists anvil_usage_events_owner_method_created_idx
  on public.anvil_usage_events (owner_id, method, created_at desc);

create index if not exists anvil_usage_events_status_created_idx
  on public.anvil_usage_events (status, created_at desc);

create table if not exists public.anvil_usage_claims (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  method text not null,
  status text not null default 'active',
  expires_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  constraint anvil_usage_claims_request_length
    check (char_length(request_id) between 8 and 160),
  constraint anvil_usage_claims_method_length
    check (char_length(method) between 1 and 80),
  constraint anvil_usage_claims_status
    check (status in ('active', 'released', 'expired'))
);

create unique index if not exists anvil_usage_claims_request_idx
  on public.anvil_usage_claims (request_id);

create index if not exists anvil_usage_claims_owner_method_active_idx
  on public.anvil_usage_claims (owner_id, method, expires_at)
  where released_at is null and status = 'active';

create index if not exists anvil_usage_claims_expires_idx
  on public.anvil_usage_claims (expires_at)
  where released_at is null and status = 'active';

alter table public.anvil_usage_events enable row level security;
alter table public.anvil_usage_claims enable row level security;

revoke all on table public.anvil_usage_events from anon;
revoke all on table public.anvil_usage_events from authenticated;
revoke all on table public.anvil_usage_claims from anon;
revoke all on table public.anvil_usage_claims from authenticated;
grant select on table public.anvil_usage_events to authenticated;
grant select on table public.anvil_usage_claims to authenticated;
grant select, insert, update on table public.anvil_usage_events to service_role;
grant select, insert, update on table public.anvil_usage_claims to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_usage_events'
      and policyname = 'anvil_usage_events_owner_select'
  ) then
    create policy "anvil_usage_events_owner_select"
      on public.anvil_usage_events
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_usage_claims'
      and policyname = 'anvil_usage_claims_owner_select'
  ) then
    create policy "anvil_usage_claims_owner_select"
      on public.anvil_usage_claims
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;

create or replace function public.anvil_monthly_usage_summary(
  p_owner_id uuid,
  p_period_start timestamptz
)
returns table (
  total_events integer,
  total_tokens bigint,
  total_cost_estimate_usd numeric
)
language sql
stable
set search_path = public
as $$
  select
    count(*)::integer as total_events,
    coalesce(sum(total_tokens), 0)::bigint as total_tokens,
    coalesce(sum(cost_estimate_usd), 0)::numeric as total_cost_estimate_usd
  from public.anvil_usage_events
  where owner_id = p_owner_id
    and created_at >= p_period_start
    and status in ('allowed', 'queued', 'started', 'succeeded', 'failed');
$$;

create or replace function public.anvil_claim_usage_slot(
  p_owner_id uuid,
  p_request_id text,
  p_method text,
  p_limit integer,
  p_ttl_seconds integer default 600
)
returns table (
  claim_id uuid,
  active_count integer,
  allowed boolean
)
language plpgsql
set search_path = public
as $$
declare
  v_active_count integer;
  v_claim_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_method, 0));

  update public.anvil_usage_claims
  set status = 'expired',
      released_at = now()
  where owner_id = p_owner_id
    and method = p_method
    and status = 'active'
    and released_at is null
    and expires_at <= now();

  select count(*)::integer
  into v_active_count
  from public.anvil_usage_claims
  where owner_id = p_owner_id
    and method = p_method
    and status = 'active'
    and released_at is null
    and expires_at > now();

  if p_limit <= 0 or v_active_count >= p_limit then
    return query select null::uuid, v_active_count, false;
    return;
  end if;

  insert into public.anvil_usage_claims (
    owner_id,
    request_id,
    method,
    expires_at
  )
  values (
    p_owner_id,
    p_request_id,
    p_method,
    now() + make_interval(secs => greatest(30, least(3600, p_ttl_seconds)))
  )
  on conflict (request_id) do update
    set expires_at = excluded.expires_at,
        status = 'active',
        released_at = null
  returning id into v_claim_id;

  return query select v_claim_id, v_active_count + 1, true;
end;
$$;

revoke all on function public.anvil_monthly_usage_summary(uuid, timestamptz) from public;
revoke all on function public.anvil_monthly_usage_summary(uuid, timestamptz) from anon;
revoke all on function public.anvil_monthly_usage_summary(uuid, timestamptz) from authenticated;
grant execute on function public.anvil_monthly_usage_summary(uuid, timestamptz) to service_role;

revoke all on function public.anvil_claim_usage_slot(uuid, text, text, integer, integer) from public;
revoke all on function public.anvil_claim_usage_slot(uuid, text, text, integer, integer) from anon;
revoke all on function public.anvil_claim_usage_slot(uuid, text, text, integer, integer) from authenticated;
grant execute on function public.anvil_claim_usage_slot(uuid, text, text, integer, integer) to service_role;
