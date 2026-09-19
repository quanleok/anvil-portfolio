create table if not exists public.anvil_stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  object_id text,
  status text not null default 'processing',
  attempt_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  constraint anvil_stripe_webhook_events_event_id_format
    check (event_id ~ '^evt_[A-Za-z0-9]+$'),
  constraint anvil_stripe_webhook_events_type_length
    check (char_length(event_type) between 3 and 120),
  constraint anvil_stripe_webhook_events_object_length
    check (object_id is null or char_length(object_id) between 3 and 180),
  constraint anvil_stripe_webhook_events_status
    check (status in ('processing', 'processed', 'failed')),
  constraint anvil_stripe_webhook_events_attempt_count
    check (attempt_count >= 1)
);

create index if not exists anvil_stripe_webhook_events_status_seen_idx
  on public.anvil_stripe_webhook_events (status, last_seen_at desc);

alter table public.anvil_stripe_webhook_events enable row level security;

revoke all on table public.anvil_stripe_webhook_events from anon;
revoke all on table public.anvil_stripe_webhook_events from authenticated;
grant select, insert, update on table public.anvil_stripe_webhook_events to service_role;

create or replace function public.anvil_begin_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_object_id text default null,
  p_retry_after_seconds integer default 300
)
returns table (
  should_process boolean,
  duplicate boolean,
  current_status text
)
language plpgsql
set search_path = public
as $$
declare
  v_row public.anvil_stripe_webhook_events%rowtype;
  v_retry_after interval;
begin
  v_retry_after := make_interval(secs => greatest(30, least(3600, coalesce(p_retry_after_seconds, 300))));

  insert into public.anvil_stripe_webhook_events (
    event_id,
    event_type,
    object_id,
    status
  )
  values (
    p_event_id,
    p_event_type,
    nullif(p_object_id, ''),
    'processing'
  )
  on conflict (event_id) do nothing
  returning * into v_row;

  if found then
    return query select true, false, 'processing'::text;
    return;
  end if;

  select *
  into v_row
  from public.anvil_stripe_webhook_events
  where event_id = p_event_id
  for update;

  if not found then
    return query select false, true, 'missing'::text;
    return;
  end if;

  if v_row.status = 'processed' then
    update public.anvil_stripe_webhook_events
    set last_seen_at = now()
    where event_id = p_event_id;

    return query select false, true, v_row.status;
    return;
  end if;

  if v_row.status = 'failed' or (v_row.status = 'processing' and v_row.last_seen_at < now() - v_retry_after) then
    update public.anvil_stripe_webhook_events
    set status = 'processing',
        event_type = p_event_type,
        object_id = nullif(p_object_id, ''),
        attempt_count = attempt_count + 1,
        last_seen_at = now(),
        last_error = null
    where event_id = p_event_id;

    return query select true, true, 'processing'::text;
    return;
  end if;

  update public.anvil_stripe_webhook_events
  set last_seen_at = now()
  where event_id = p_event_id;

  return query select false, true, v_row.status;
end;
$$;

create or replace function public.anvil_finish_stripe_webhook_event(
  p_event_id text,
  p_status text,
  p_error text default null
)
returns void
language sql
set search_path = public
as $$
  update public.anvil_stripe_webhook_events
  set status = case when p_status = 'processed' then 'processed' else 'failed' end,
      processed_at = case when p_status = 'processed' then now() else processed_at end,
      last_seen_at = now(),
      last_error = left(nullif(p_error, ''), 1000)
  where event_id = p_event_id;
$$;

create or replace function public.anvil_sweep_expired_usage_claims()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.anvil_usage_claims
  set status = 'expired',
      released_at = now()
  where status = 'active'
    and released_at is null
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.anvil_begin_stripe_webhook_event(text, text, text, integer) from public;
revoke all on function public.anvil_begin_stripe_webhook_event(text, text, text, integer) from anon;
revoke all on function public.anvil_begin_stripe_webhook_event(text, text, text, integer) from authenticated;
grant execute on function public.anvil_begin_stripe_webhook_event(text, text, text, integer) to service_role;

revoke all on function public.anvil_finish_stripe_webhook_event(text, text, text) from public;
revoke all on function public.anvil_finish_stripe_webhook_event(text, text, text) from anon;
revoke all on function public.anvil_finish_stripe_webhook_event(text, text, text) from authenticated;
grant execute on function public.anvil_finish_stripe_webhook_event(text, text, text) to service_role;

revoke all on function public.anvil_sweep_expired_usage_claims() from public;
revoke all on function public.anvil_sweep_expired_usage_claims() from anon;
revoke all on function public.anvil_sweep_expired_usage_claims() from authenticated;
grant execute on function public.anvil_sweep_expired_usage_claims() to service_role;
