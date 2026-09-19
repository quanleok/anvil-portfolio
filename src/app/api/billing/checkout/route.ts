import Stripe from "stripe";
import { NextResponse } from "next/server";
import {
  normalizePaidBillingPlan,
  stripePaymentLinkForPlan,
  stripePriceIdEnvForPlan,
  stripePriceIdForPlan,
} from "@/lib/billing/plans";
import { getBillingCustomerForOwner } from "@/lib/billing/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import { readSmallJson } from "@/server/media/http";

function envFlag(name: string) {
  return String(process.env[name] || "").trim() === "1";
}

function safeReturnPath(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.includes("\0")) return "/app";
  try {
    const url = new URL(text, "https://anvil.local");
    return `${url.pathname}${url.search}${url.hash}` || "/app";
  } catch {
    return "/app";
  }
}

function appendParams(path: string, params: string) {
  const hashIndex = path.indexOf("#");
  const base = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  return `${base}${base.includes("?") ? "&" : "?"}${params}${hash}`;
}

async function readRequestJson(request: Request) {
  return readSmallJson<Record<string, unknown>>(request, 32_000);
}

export async function POST(request: Request) {
  if (!envFlag("ANVIL_ENABLE_BILLING_API")) {
    return NextResponse.json(
      {
        error: "billing_paused",
        message: "Billing is disabled on this deployment. Set ANVIL_ENABLE_BILLING_API=1.",
      },
      { status: 410 },
    );
  }

  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  let body: Record<string, unknown>;
  try {
    body = await readRequestJson(request);
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Checkout requires small valid JSON." },
      { status: 400 },
    );
  }
  const planId = normalizePaidBillingPlan(body.planId);
  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  const priceId = stripePriceIdForPlan(planId);
  const priceIdEnv = stripePriceIdEnvForPlan(planId);
  const paymentLink = stripePaymentLinkForPlan(planId);

  if ((!secretKey || !priceId || auth.user.id === "dev-user") && paymentLink) {
    return NextResponse.json({
      id: null,
      plan: planId,
      mode: "payment_link",
      url: paymentLink,
      message: `Using Stripe Payment Link fallback for the ${planId} plan.`,
    });
  }

  if (!secretKey || !priceId || auth.user.id === "dev-user") {
    return NextResponse.json(
      {
        error: "checkout_not_configured",
        message:
          auth.user.id === "dev-user"
            ? "Checkout is disabled for the local dev placeholder user. Configure Supabase Auth to test a real subscription."
            : `Set STRIPE_SECRET_KEY and ${priceIdEnv} to enable ${planId} checkout.`,
      },
      { status: 501 },
    );
  }

  const baseUrl =
    (process.env.ANVIL_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin)
      .replace(/\/+$/, "");
  const returnPath = safeReturnPath((body as { returnUrl?: unknown }).returnUrl);

  const stripe = new Stripe(secretKey);
  const existingCustomer = await getBillingCustomerForOwner(auth.user.id);
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    client_reference_id: auth.user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}${appendParams(returnPath, "billing=success&session_id={CHECKOUT_SESSION_ID}")}`,
    cancel_url: `${baseUrl}${appendParams(returnPath, "billing=cancelled")}`,
    allow_promotion_codes: true,
    metadata: {
      anvilOwnerId: auth.user.id,
      anvilOwnerEmail: auth.user.email,
      plan: planId,
    },
    subscription_data: {
      metadata: {
        anvilOwnerId: auth.user.id,
        anvilOwnerEmail: auth.user.email,
        plan: planId,
      },
    },
  };

  if (existingCustomer?.stripe_customer_id) {
    sessionParams.customer = existingCustomer.stripe_customer_id;
  } else {
    sessionParams.customer_email = auth.user.email;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);

    return NextResponse.json({ id: session.id, plan: planId, mode: "checkout_session", url: session.url });
  } catch (error) {
    return NextResponse.json(
      {
        error: "checkout_failed",
        message: error instanceof Error ? error.message : "Stripe Checkout could not be created.",
      },
      { status: 502 },
    );
  }
}
