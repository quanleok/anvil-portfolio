import Stripe from "stripe";
import { NextResponse } from "next/server";
import {
  normalizeBillingPlan,
  type PaidBillingPlanId,
} from "@/lib/billing/plans";
import { syncStripeSubscriptionEntitlement, upsertBillingCustomer } from "@/lib/billing/server";
import { createSupabaseAdminClient, hasSupabaseAdminConfig } from "@/lib/supabase/admin";
import { createRequestLogger } from "@/lib/usage/logging";

export const runtime = "nodejs";

type StripeWebhookIdempotencyDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      anvil_begin_stripe_webhook_event: {
        Args: {
          p_event_id: string;
          p_event_type: string;
          p_object_id: string | null;
          p_retry_after_seconds: number;
        };
        Returns: Array<{
          should_process: boolean;
          duplicate: boolean;
          current_status: string;
        }>;
      };
      anvil_finish_stripe_webhook_event: {
        Args: {
          p_event_id: string;
          p_status: "processed" | "failed";
          p_error: string | null;
        };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type StripeWebhookBeginResult =
  | {
      ok: true;
      shouldProcess: boolean;
      duplicate: boolean;
      status: string;
    }
  | {
      ok: false;
      message: string;
    };

let cachedWebhookClient: ReturnType<typeof createSupabaseAdminClient<StripeWebhookIdempotencyDatabase>> | null = null;

function envFlag(name: string) {
  return String(process.env[name] || "").trim() === "1";
}

function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function sessionCustomerId(session: Stripe.Checkout.Session) {
  const customer = session.customer;
  if (typeof customer === "string") return customer;
  return cleanText(customer?.id, 120);
}

function sessionSubscriptionId(session: Stripe.Checkout.Session) {
  const subscription = session.subscription;
  if (typeof subscription === "string") return subscription;
  return cleanText(subscription?.id, 160);
}

function sessionOwnerId(session: Stripe.Checkout.Session) {
  return cleanText(session.client_reference_id || session.metadata?.anvilOwnerId, 120);
}

function sessionEmail(session: Stripe.Checkout.Session) {
  return cleanText(
    session.customer_details?.email || session.customer_email || session.metadata?.anvilOwnerEmail,
    320,
  ).toLowerCase();
}

function sessionPlan(session: Stripe.Checkout.Session): PaidBillingPlanId {
  const plan = normalizeBillingPlan(session.metadata?.plan, "pro");
  return plan === "studio" ? "studio" : "pro";
}

function webhookClient() {
  if (!hasSupabaseAdminConfig()) return null;
  if (!cachedWebhookClient) {
    cachedWebhookClient = createSupabaseAdminClient<StripeWebhookIdempotencyDatabase>();
  }
  return cachedWebhookClient;
}

function eventObjectId(event: Stripe.Event) {
  const object = event.data?.object;
  if (!object || typeof object !== "object") return "";
  return cleanText((object as unknown as Record<string, unknown>).id, 180);
}

async function beginStripeWebhookEvent(event: Stripe.Event): Promise<StripeWebhookBeginResult> {
  const client = webhookClient();
  if (!client) {
    return {
      ok: false,
      message: "Supabase service-role access is required for Stripe webhook idempotency.",
    };
  }

  const { data, error } = await client.rpc("anvil_begin_stripe_webhook_event", {
    p_event_id: event.id,
    p_event_type: event.type,
    p_object_id: eventObjectId(event) || null,
    p_retry_after_seconds: 300,
  });
  if (error) {
    return {
      ok: false,
      message: error.message,
    };
  }

  const row = Array.isArray(data) ? data[0] : null;
  return {
    ok: true,
    shouldProcess: row?.should_process === true,
    duplicate: row?.duplicate === true,
    status: typeof row?.current_status === "string" ? row.current_status : "unknown",
  };
}

async function finishStripeWebhookEvent(
  eventId: string,
  status: "processed" | "failed",
  error?: unknown,
) {
  const client = webhookClient();
  if (!client) return;
  await client.rpc("anvil_finish_stripe_webhook_event", {
    p_event_id: eventId,
    p_status: status,
    p_error: error instanceof Error ? error.message : typeof error === "string" ? error : null,
  });
}

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  if (session.mode !== "subscription") {
    return { handled: false, reason: "non_subscription_checkout" };
  }

  const ownerId = sessionOwnerId(session);
  const customerId = sessionCustomerId(session);
  const email = sessionEmail(session);
  const plan = sessionPlan(session);

  if (ownerId && customerId && email) {
    await upsertBillingCustomer({ ownerId, email, stripeCustomerId: customerId });
  }

  const subscriptionId = sessionSubscriptionId(session);
  if (!subscriptionId) return { handled: false, reason: "subscription_missing" };

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const result = await syncStripeSubscriptionEntitlement({
    stripe,
    subscription,
    fallbackOwnerId: ownerId,
    fallbackEmail: email,
    fallbackPlan: plan,
  });

  return { handled: result.ok, result };
}

async function handleSubscriptionEvent(stripe: Stripe, subscription: Stripe.Subscription) {
  const result = await syncStripeSubscriptionEntitlement({ stripe, subscription });
  return { handled: result.ok, result };
}

export async function POST(request: Request) {
  const requestLog = createRequestLogger(request, "/api/billing/webhook");

  if (!envFlag("ANVIL_ENABLE_BILLING_API")) {
    requestLog.complete(410, { outcome: "billing_paused" });
    return NextResponse.json(
      {
        error: "billing_paused",
        message: "Billing is disabled on this deployment. Set ANVIL_ENABLE_BILLING_API=1.",
      },
      { status: 410 },
    );
  }

  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secretKey || !webhookSecret) {
    requestLog.complete(503, { outcome: "webhook_not_configured" });
    return NextResponse.json(
      {
        error: "webhook_not_configured",
        message: "Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET before enabling Stripe webhooks.",
      },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    requestLog.complete(400, { outcome: "missing_signature" });
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }

  const stripe = new Stripe(secretKey);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await request.text(), signature, webhookSecret);
  } catch (error) {
    requestLog.error("stripe_webhook_invalid_signature", error);
    requestLog.complete(400, { outcome: "invalid_signature" });
    return NextResponse.json(
      {
        error: "invalid_signature",
        message: error instanceof Error ? error.message : "Stripe webhook signature verification failed.",
      },
      { status: 400 },
    );
  }

  try {
    const idempotency = await beginStripeWebhookEvent(event);
    if (!idempotency.ok) {
      requestLog.complete(503, { outcome: "idempotency_unavailable", eventType: event.type });
      return NextResponse.json(
        {
          error: "webhook_idempotency_unavailable",
          message: idempotency.message,
        },
        { status: 503 },
      );
    }
    if (!idempotency.shouldProcess) {
      requestLog.complete(200, {
        outcome: "duplicate",
        stripeEventId: event.id,
        eventType: event.type,
        idempotencyStatus: idempotency.status,
      });
      return NextResponse.json({
        received: true,
        type: event.type,
        duplicate: true,
        status: idempotency.status,
        handled: false,
      });
    }

    let result: Awaited<ReturnType<typeof handleCheckoutCompleted>> | Awaited<ReturnType<typeof handleSubscriptionEvent>> | {
      handled: false;
    };
    if (event.type === "checkout.session.completed") {
      result = await handleCheckoutCompleted(stripe, event.data.object as Stripe.Checkout.Session);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      result = await handleSubscriptionEvent(stripe, event.data.object as Stripe.Subscription);
    } else {
      result = { handled: false };
    }

    await finishStripeWebhookEvent(event.id, "processed");
    requestLog.complete(200, {
      outcome: "processed",
      stripeEventId: event.id,
      eventType: event.type,
      duplicate: idempotency.duplicate,
    });
    return NextResponse.json({ received: true, type: event.type, duplicate: idempotency.duplicate, ...result });
  } catch (error) {
    await finishStripeWebhookEvent(event.id, "failed", error);
    requestLog.error("stripe_webhook_handler_failed", error, {
      stripeEventId: event.id,
      eventType: event.type,
    });
    requestLog.complete(500, { outcome: "handler_failed", eventType: event.type });
    return NextResponse.json(
      {
        error: "webhook_handler_failed",
        message: error instanceof Error ? error.message : "Stripe webhook handling failed.",
      },
      { status: 500 },
    );
  }
}
