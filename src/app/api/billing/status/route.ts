import { NextResponse } from "next/server";
import {
  BILLING_PLANS,
  stripeCheckoutConfigured,
  stripePaymentLinksConfigured,
  stripeWebhookConfigured,
} from "@/lib/billing/plans";
import { readBillingStateForUser } from "@/lib/billing/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";

function envFlag(name: string) {
  return String(process.env[name] || "").trim() === "1";
}

export async function GET(request: Request) {
  if (!envFlag("ANVIL_ENABLE_BILLING_API")) {
    return NextResponse.json({
      active: false,
      billingConfigured: false,
      checkoutConfigured: false,
      message: "Billing API is disabled on this deployment.",
      plan: "free",
      plans: BILLING_PLANS,
      status: "paused",
    });
  }

  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const checkoutConfigured = stripeCheckoutConfigured();
  const paymentLinksConfigured = stripePaymentLinksConfigured();
  const webhookConfigured = stripeWebhookConfigured();
  const state = await readBillingStateForUser(auth.user.id);

  const setupMessage = !state.storeConfigured
    ? "Supabase billing entitlement storage is not configured."
    : checkoutConfigured && webhookConfigured
      ? null
      : checkoutConfigured
        ? "Checkout Sessions are configured. Add STRIPE_WEBHOOK_SECRET so paid subscriptions can fulfill entitlements."
        : paymentLinksConfigured
          ? "Stripe Payment Links are configured. Add STRIPE_SECRET_KEY and webhooks for account-linked entitlements."
          : "Set Stripe price IDs or payment links to enable subscription checkout.";

  return NextResponse.json({
    active: state.active,
    billingConfigured: checkoutConfigured || paymentLinksConfigured,
    checkoutConfigured,
    entitlementConfigured: state.storeConfigured,
    entitlementPlan: state.entitlementPlan,
    paymentLinksConfigured,
    webhookConfigured,
    message: setupMessage,
    plan: state.plan,
    plans: BILLING_PLANS,
    status: state.status,
    stripeCustomerId: state.stripeCustomerId,
    stripeSubscriptionId: state.stripeSubscriptionId,
    stripePriceId: state.stripePriceId,
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    accessUntil: state.accessUntil,
    user: auth.user,
  });
}
