update public.anvil_billing_entitlements
set plan = 'pro',
    updated_at = now()
where plan = 'creator';

alter table public.anvil_billing_entitlements
  drop constraint if exists anvil_billing_entitlements_plan;

alter table public.anvil_billing_entitlements
  add constraint anvil_billing_entitlements_plan
  check (plan in ('free', 'pro', 'studio'));

alter table public.anvil_usage_events
  drop constraint if exists anvil_usage_events_plan;

alter table public.anvil_usage_events
  add constraint anvil_usage_events_plan
  check (plan in ('free', 'pro', 'studio'));
