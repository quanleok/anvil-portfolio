import Stripe from "stripe";
import { createSupabaseAdminClient, hasSupabaseAdminConfig } from "@/lib/supabase/admin";
import {
  billingPlanForStripePriceId,
  normalizeBillingPlan,
  trialDaysForBillingPlan,
  type BillingPlanId,
  type PaidBillingPlanId,
} from "./plans";

type BillingEntitlementStatus =
  | "inactive"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

type BillingCustomerRow = {
  owner_id: string;
  email: string;
  stripe_customer_id: string;
  created_at: string;
  updated_at: string;
};

type BillingEntitlementRow = {
  owner_id: string;
  plan: string;
  status: BillingEntitlementStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  access_until: string | null;
  created_at: string;
  updated_at: string;
};

type BillingDatabase = {
  public: {
    Tables: {
      anvil_billing_customers: {
        Row: BillingCustomerRow;
        Insert: Partial<BillingCustomerRow> & Pick<BillingCustomerRow, "owner_id" | "email" | "stripe_customer_id">;
        Update: Partial<BillingCustomerRow>;
        Relationships: [];
      };
      anvil_billing_entitlements: {
        Row: BillingEntitlementRow;
        Insert: Partial<BillingEntitlementRow> &
          Pick<BillingEntitlementRow, "owner_id" | "plan" | "status">;
        Update: Partial<BillingEntitlementRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type BillingState = {
  ownerId: string;
  plan: BillingPlanId;
  entitlementPlan: BillingPlanId;
  active: boolean;
  status: BillingEntitlementStatus | "not_subscribed" | "unconfigured";
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  accessUntil: string | null;
  storeConfigured: boolean;
};

type SyncStripeSubscriptionResult =
  | {
      ok: true;
      ownerId: string;
      plan: BillingPlanId;
      status: BillingEntitlementStatus;
    }
  | {
      ok: false;
      reason: "billing_store_not_configured" | "owner_missing" | "upsert_failed";
      message?: string;
    };

let cachedClient: ReturnType<typeof createSupabaseAdminClient<BillingDatabase>> | null = null;

function billingClient() {
  if (!hasSupabaseAdminConfig()) return null;
  if (!cachedClient) cachedClient = createSupabaseAdminClient<BillingDatabase>();
  return cachedClient;
}

export function billingStoreConfigured() {
  return Boolean(billingClient());
}

function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function cleanEmail(value: unknown) {
  return cleanText(value, 320).toLowerCase();
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function knownBillingStatus(value: unknown): BillingEntitlementStatus {
  const text = cleanText(value, 40);
  if (
    text === "inactive" ||
    text === "incomplete" ||
    text === "incomplete_expired" ||
    text === "trialing" ||
    text === "active" ||
    text === "past_due" ||
    text === "canceled" ||
    text === "unpaid" ||
    text === "paused"
  ) {
    return text;
  }
  return "inactive";
}

function isoFromUnixSeconds(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function futureIso(value: string | null | undefined) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}

export function billingStatusHasAccess(
  status: unknown,
  currentPeriodEnd?: string | null,
  accessUntil?: string | null,
) {
  const normalized = knownBillingStatus(status);
  if (normalized === "active") return true;
  if (normalized === "trialing") return futureIso(accessUntil) || futureIso(currentPeriodEnd);
  if (normalized === "past_due") return futureIso(accessUntil) || futureIso(currentPeriodEnd);
  return futureIso(accessUntil);
}

function freeBillingState(ownerId: string, storeConfigured: boolean, status: BillingState["status"]): BillingState {
  return {
    ownerId,
    plan: "free",
    entitlementPlan: "free",
    active: false,
    status,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    accessUntil: null,
    storeConfigured,
  };
}

function autoStartMembershipTrialEnabled() {
  return String(process.env.ANVIL_AUTO_START_MEMBERSHIP_TRIAL || "0").trim() === "1";
}

function addDaysIso(days: number) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  return new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
}

function stateFromRow(ownerId: string, row: BillingEntitlementRow, storeConfigured: boolean): BillingState {
  const entitlementPlan = normalizeBillingPlan(row.plan, "free");
  const active = billingStatusHasAccess(row.status, row.current_period_end, row.access_until);
  return {
    ownerId,
    plan: active ? entitlementPlan : "free",
    entitlementPlan,
    active,
    status: knownBillingStatus(row.status),
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    accessUntil: row.access_until,
    storeConfigured,
  };
}

export async function readBillingStateForUser(ownerId: string): Promise<BillingState> {
  const client = billingClient();
  if (!isUuid(ownerId)) return freeBillingState(ownerId, Boolean(client), "not_subscribed");
  if (!client) return freeBillingState(ownerId, false, "unconfigured");

  const { data, error } = await client
    .from("anvil_billing_entitlements")
    .select(
      "owner_id,plan,status,stripe_customer_id,stripe_subscription_id,stripe_price_id,current_period_end,cancel_at_period_end,access_until,created_at,updated_at",
    )
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) return freeBillingState(ownerId, true, "not_subscribed");
  if (!data) {
    if (!autoStartMembershipTrialEnabled()) {
      return freeBillingState(ownerId, true, "not_subscribed");
    }

    const accessUntil = addDaysIso(trialDaysForBillingPlan("pro"));
    const inserted = await client
      .from("anvil_billing_entitlements")
      .insert({
        owner_id: ownerId,
        plan: "pro",
        status: "trialing",
        access_until: accessUntil,
        current_period_end: accessUntil,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      })
      .select(
        "owner_id,plan,status,stripe_customer_id,stripe_subscription_id,stripe_price_id,current_period_end,cancel_at_period_end,access_until,created_at,updated_at",
      )
      .maybeSingle();

    if (!inserted.error && inserted.data) return stateFromRow(ownerId, inserted.data, true);

    // A concurrent status request may have inserted the one-time trial after
    // our initial read. Re-read once and never reset an existing trial row.
    const retry = await client
      .from("anvil_billing_entitlements")
      .select(
        "owner_id,plan,status,stripe_customer_id,stripe_subscription_id,stripe_price_id,current_period_end,cancel_at_period_end,access_until,created_at,updated_at",
      )
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (!retry.error && retry.data) return stateFromRow(ownerId, retry.data, true);
    return freeBillingState(ownerId, true, "not_subscribed");
  }
  return stateFromRow(ownerId, data, true);
}

export async function getBillingCustomerForOwner(ownerId: string) {
  const client = billingClient();
  if (!client || !isUuid(ownerId)) return null;
  const { data, error } = await client
    .from("anvil_billing_customers")
    .select("owner_id,email,stripe_customer_id,created_at,updated_at")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function findOwnerByStripeCustomerId(stripeCustomerId: string) {
  const client = billingClient();
  if (!client || !stripeCustomerId) return null;

  const customer = await client
    .from("anvil_billing_customers")
    .select("owner_id,email,stripe_customer_id,created_at,updated_at")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  if (!customer.error && customer.data?.owner_id) {
    return {
      ownerId: customer.data.owner_id,
      email: customer.data.email,
    };
  }

  const entitlement = await client
    .from("anvil_billing_entitlements")
    .select("owner_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  if (!entitlement.error && entitlement.data?.owner_id) {
    return {
      ownerId: entitlement.data.owner_id,
      email: null,
    };
  }

  return null;
}

export async function upsertBillingCustomer({
  ownerId,
  email,
  stripeCustomerId,
}: {
  ownerId: string;
  email: string;
  stripeCustomerId: string;
}) {
  const client = billingClient();
  const cleanOwnerId = isUuid(ownerId) ? ownerId : "";
  const cleanStripeCustomerId = cleanText(stripeCustomerId, 120);
  const cleanCustomerEmail = cleanEmail(email);
  if (!client || !cleanOwnerId || !cleanStripeCustomerId || !cleanCustomerEmail) return null;

  const now = new Date().toISOString();
  const { data, error } = await client
    .from("anvil_billing_customers")
    .upsert(
      {
        owner_id: cleanOwnerId,
        email: cleanCustomerEmail,
        stripe_customer_id: cleanStripeCustomerId,
        updated_at: now,
      },
      { onConflict: "owner_id" },
    )
    .select("owner_id,email,stripe_customer_id,created_at,updated_at")
    .single();

  if (error || !data) return null;
  return data;
}

async function retrieveStripeCustomerEmail(stripe: Stripe | null | undefined, stripeCustomerId: string) {
  if (!stripe || !stripeCustomerId) return "";
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if ("deleted" in customer && customer.deleted) return "";
    return cleanEmail(customer.email);
  } catch {
    return "";
  }
}

function subscriptionMetadata(subscription: Stripe.Subscription) {
  return subscription.metadata && typeof subscription.metadata === "object" ? subscription.metadata : {};
}

function subscriptionCustomerId(subscription: Stripe.Subscription) {
  const customer = subscription.customer;
  if (typeof customer === "string") return customer;
  return cleanText(customer?.id, 120);
}

function subscriptionPriceId(subscription: Stripe.Subscription) {
  return cleanText(subscription.items?.data?.[0]?.price?.id, 160);
}

function subscriptionCurrentPeriodEnd(subscription: Stripe.Subscription) {
  const raw = subscription as unknown as Record<string, unknown>;
  return isoFromUnixSeconds(raw.current_period_end);
}

function subscriptionCancelAtPeriodEnd(subscription: Stripe.Subscription) {
  const raw = subscription as unknown as Record<string, unknown>;
  return raw.cancel_at_period_end === true;
}

function subscriptionStatus(subscription: Stripe.Subscription) {
  return knownBillingStatus(subscription.status);
}

function accessUntilForSubscription(status: BillingEntitlementStatus, currentPeriodEnd: string | null) {
  if ((status === "active" || status === "trialing" || status === "past_due") && currentPeriodEnd) {
    return currentPeriodEnd;
  }
  return null;
}

export async function syncStripeSubscriptionEntitlement({
  stripe,
  subscription,
  fallbackOwnerId,
  fallbackEmail,
  fallbackPlan,
}: {
  stripe?: Stripe;
  subscription: Stripe.Subscription;
  fallbackOwnerId?: string | null;
  fallbackEmail?: string | null;
  fallbackPlan?: string | null;
}): Promise<SyncStripeSubscriptionResult> {
  const client = billingClient();
  if (!client) return { ok: false, reason: "billing_store_not_configured" };

  const metadata = subscriptionMetadata(subscription);
  const stripeCustomerId = subscriptionCustomerId(subscription);
  const ownerFromMetadata = isUuid(metadata.anvilOwnerId) ? metadata.anvilOwnerId : "";
  const ownerFromFallback = isUuid(fallbackOwnerId) ? fallbackOwnerId : "";
  const customerOwner = stripeCustomerId ? await findOwnerByStripeCustomerId(stripeCustomerId) : null;
  const ownerId = ownerFromMetadata || ownerFromFallback || customerOwner?.ownerId || "";
  if (!ownerId) return { ok: false, reason: "owner_missing" };

  const priceId = subscriptionPriceId(subscription);
  const paidPlan =
    billingPlanForStripePriceId(priceId) ||
    (normalizeBillingPlan(metadata.plan || fallbackPlan, "free") as PaidBillingPlanId | "free");
  const plan: BillingPlanId = paidPlan === "studio" || paidPlan === "pro" ? paidPlan : "free";
  const status = subscriptionStatus(subscription);
  const currentPeriodEnd = subscriptionCurrentPeriodEnd(subscription);
  const accessUntil = accessUntilForSubscription(status, currentPeriodEnd);
  const now = new Date().toISOString();

  const email =
    cleanEmail(fallbackEmail) ||
    cleanEmail(customerOwner?.email) ||
    (stripeCustomerId ? await retrieveStripeCustomerEmail(stripe, stripeCustomerId) : "");
  if (stripeCustomerId && email) {
    await upsertBillingCustomer({ ownerId, email, stripeCustomerId });
  }

  const { error } = await client.from("anvil_billing_entitlements").upsert(
    {
      owner_id: ownerId,
      plan,
      status,
      stripe_customer_id: stripeCustomerId || null,
      stripe_subscription_id: cleanText(subscription.id, 160) || null,
      stripe_price_id: priceId || null,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: subscriptionCancelAtPeriodEnd(subscription),
      access_until: accessUntil,
      updated_at: now,
    },
    { onConflict: "owner_id" },
  );

  if (error) {
    return { ok: false, reason: "upsert_failed", message: error.message };
  }

  return { ok: true, ownerId, plan, status };
}
