export type BillingPlanId = "free" | "pro" | "studio";
export type PaidBillingPlanId = Exclude<BillingPlanId, "free">;

export type BillingPlan = {
  id: BillingPlanId;
  label: string;
  priceLabel: string;
  priceDetail: string;
  annualUsd: number;
  trialDays?: number;
  backendAccess: boolean;
  features: string[];
  legacy?: boolean;
};

function positiveIntegerFromEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export const MEMBERSHIP_TRIAL_DAYS = positiveIntegerFromEnv("ANVIL_MEMBERSHIP_TRIAL_DAYS", 7);

export const BILLING_PLANS: BillingPlan[] = [
  {
    id: "free",
    label: "Free",
    priceLabel: "$0",
    priceDetail: "per month",
    annualUsd: 0,
    backendAccess: false,
    features: [
      "Browser workspace + cloud project drive",
      "Limited monthly agent turns",
      "Sampler image / video / audio credits",
    ],
  },
  {
    id: "pro",
    label: "Pro",
    priceLabel: "$25",
    priceDetail: "per month",
    annualUsd: 300,
    trialDays: MEMBERSHIP_TRIAL_DAYS,
    backendAccess: true,
    features: [
      "Hosted Anvil Agent",
      "Included image generation credits",
      "Included video generation credits",
      "Included voice + SFX generation credits",
      "Protected Anvil workflow methods",
    ],
  },
  {
    id: "studio",
    label: "Studio",
    priceLabel: "$60",
    priceDetail: "per month",
    annualUsd: 720,
    backendAccess: true,
    features: [
      "Higher hosted Anvil Agent limits",
      "Expanded image generation credits",
      "Expanded video generation credits",
      "Expanded voice + SFX generation credits",
      "Priority protected workflow methods",
    ],
  },
];

const PLAN_ENV: Record<PaidBillingPlanId, { priceId: string[]; paymentLink: string[] }> = {
  pro: {
    priceId: ["ANVIL_STRIPE_MEMBERSHIP_PRICE_ID", "ANVIL_STRIPE_PRO_PRICE_ID"],
    paymentLink: ["ANVIL_STRIPE_MEMBERSHIP_PAYMENT_LINK", "ANVIL_STRIPE_PRO_PAYMENT_LINK"],
  },
  studio: {
    priceId: ["ANVIL_STRIPE_STUDIO_PRICE_ID"],
    paymentLink: ["ANVIL_STRIPE_STUDIO_PAYMENT_LINK"],
  },
};

function firstConfiguredEnv(names: string[]) {
  for (const name of names) {
    const value = (process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

export function normalizeBillingPlan(value: unknown, fallback: BillingPlanId = "free"): BillingPlanId {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "studio") return "studio";
  if (
    text === "pro" ||
    text === "creator" ||
    text === "member" ||
    text === "membership" ||
    text === "annual" ||
    text === "yearly"
  ) {
    return "pro";
  }
  if (text === "free") return "free";
  return fallback;
}

export function normalizePaidBillingPlan(value: unknown, fallback: PaidBillingPlanId = "pro"): PaidBillingPlanId {
  const plan = normalizeBillingPlan(value, fallback);
  return plan === "studio" ? "studio" : "pro";
}

export function stripePriceIdForPlan(plan: PaidBillingPlanId) {
  return firstConfiguredEnv(PLAN_ENV[plan].priceId);
}

export function stripePriceIdEnvForPlan(plan: PaidBillingPlanId) {
  return PLAN_ENV[plan].priceId.join(" or ");
}

export function stripePaymentLinkForPlan(plan: PaidBillingPlanId) {
  return firstConfiguredEnv(PLAN_ENV[plan].paymentLink);
}

export function billingPlanForStripePriceId(priceId: unknown): PaidBillingPlanId | null {
  const id = typeof priceId === "string" ? priceId.trim() : "";
  if (!id) return null;
  if (id === stripePriceIdForPlan("pro")) return "pro";
  if (id === stripePriceIdForPlan("studio")) return "studio";
  return null;
}

export function stripeCheckoutConfigured() {
  return Boolean(
    (process.env.STRIPE_SECRET_KEY || "").trim() &&
      (stripePriceIdForPlan("pro") || stripePriceIdForPlan("studio")),
  );
}

export function stripePaymentLinksConfigured() {
  return Boolean(stripePaymentLinkForPlan("pro") || stripePaymentLinkForPlan("studio"));
}

export function stripeWebhookConfigured() {
  return Boolean((process.env.STRIPE_SECRET_KEY || "").trim() && (process.env.STRIPE_WEBHOOK_SECRET || "").trim());
}

export function trialDaysForBillingPlan(plan: PaidBillingPlanId) {
  return plan === "pro" ? MEMBERSHIP_TRIAL_DAYS : 0;
}
