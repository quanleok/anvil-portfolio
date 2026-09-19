create table if not exists public.anvil_billing_customers (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_billing_customers_email_length
    check (char_length(email) between 3 and 320),
  constraint anvil_billing_customers_stripe_customer_format
    check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')
);

create table if not exists public.anvil_billing_entitlements (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  status text not null default 'inactive',
  stripe_customer_id text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  access_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anvil_billing_entitlements_plan
    check (plan in ('free', 'pro', 'studio')),
  constraint anvil_billing_entitlements_status
    check (status in (
      'inactive',
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused'
    ))
);

create index if not exists anvil_billing_customers_customer_idx
  on public.anvil_billing_customers (stripe_customer_id);

create index if not exists anvil_billing_entitlements_customer_idx
  on public.anvil_billing_entitlements (stripe_customer_id);

create index if not exists anvil_billing_entitlements_active_idx
  on public.anvil_billing_entitlements (owner_id, plan, status, access_until);

alter table public.anvil_billing_customers enable row level security;
alter table public.anvil_billing_entitlements enable row level security;

revoke all on table public.anvil_billing_customers from anon;
revoke all on table public.anvil_billing_customers from authenticated;
revoke all on table public.anvil_billing_entitlements from anon;
revoke all on table public.anvil_billing_entitlements from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_billing_customers'
      and policyname = 'anvil_billing_customers_owner_select'
  ) then
    create policy "anvil_billing_customers_owner_select"
      on public.anvil_billing_customers
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anvil_billing_entitlements'
      and policyname = 'anvil_billing_entitlements_owner_select'
  ) then
    create policy "anvil_billing_entitlements_owner_select"
      on public.anvil_billing_entitlements
      for select
      to authenticated
      using (owner_id = (select auth.uid()));
  end if;
end $$;
