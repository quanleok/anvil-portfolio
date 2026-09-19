-- Queued usage claims are concurrency back-pressure, not consumed work.
-- Keep allowed/started as defensive in-flight states, and succeeded/failed
-- as finalized provider attempts. Excluding queued prevents double-submit
-- or concurrency pressure from eating monthly quota.

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
    and status in ('allowed', 'started', 'succeeded', 'failed');
$$;

revoke all on function public.anvil_monthly_usage_summary(uuid, timestamptz) from public;
revoke all on function public.anvil_monthly_usage_summary(uuid, timestamptz) from anon;
revoke all on function public.anvil_monthly_usage_summary(uuid, timestamptz) from authenticated;
grant execute on function public.anvil_monthly_usage_summary(uuid, timestamptz) to service_role;
