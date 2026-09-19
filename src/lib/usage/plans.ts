export type UsageDecisionState = "allowed" | "limited" | "queued";
export type UsagePlanId = "free" | "pro" | "studio";
export type UsageLedgerStatus = UsageDecisionState | "started" | "succeeded" | "failed";
export type UsageEntitlementStatus =
  | "inactive"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"
  | "not_subscribed"
  | "unknown";

export type UsageMethod =
  | "anvil_agent"
  | "protected_method"
  | "method_directive"
  | "media_image"
  | "media_video"
  | "media_audio"
  | "unknown";

export type UsagePlanLimits = {
  monthlyEvents: number;
  monthlyTokens: number;
  monthlyCostUsd: number;
  concurrency: number;
  claimTtlSeconds: number;
  queueRetryAfterSeconds: number;
};

const DEFAULT_LIMITS: Record<UsagePlanId, UsagePlanLimits> = {
  free: {
    monthlyEvents: 50,
    monthlyTokens: 200_000,
    monthlyCostUsd: 3,
    concurrency: 1,
    claimTtlSeconds: 300,
    queueRetryAfterSeconds: 60,
  },
  pro: {
    monthlyEvents: 300,
    monthlyTokens: 1_000_000,
    monthlyCostUsd: 8,
    concurrency: 1,
    claimTtlSeconds: 600,
    queueRetryAfterSeconds: 30,
  },
  studio: {
    monthlyEvents: 2_000,
    monthlyTokens: 10_000_000,
    monthlyCostUsd: 60,
    concurrency: 3,
    claimTtlSeconds: 900,
    queueRetryAfterSeconds: 20,
  },
};

const DEFAULT_TRIAL_LIMITS: UsagePlanLimits = {
  monthlyEvents: 50,
  monthlyTokens: 150_000,
  monthlyCostUsd: 1.5,
  concurrency: 1,
  claimTtlSeconds: 600,
  queueRetryAfterSeconds: 30,
};

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function parsedLimitOverrides() {
  const raw = process.env.ANVIL_USAGE_LIMITS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<Record<UsagePlanId, Partial<UsagePlanLimits>>>;
  } catch {
    return {};
  }
}

function parsedTrialLimitOverride() {
  const raw = process.env.ANVIL_TRIAL_USAGE_LIMITS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<UsagePlanLimits>;
  } catch {
    return {};
  }
}

export function normalizeUsagePlan(value: unknown, fallback: UsagePlanId = "free"): UsagePlanId {
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

export function normalizeUsageMethod(value: unknown): UsageMethod {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "anvil_agent") return "anvil_agent";
  if (text === "protected_method") return "protected_method";
  if (text === "method_directive") return "method_directive";
  if (text === "media_image") return "media_image";
  if (text === "media_video") return "media_video";
  if (text === "media_audio") return "media_audio";
  return "unknown";
}

export function usagePlanLimits(plan: UsagePlanId, status?: UsageEntitlementStatus | null): UsagePlanLimits {
  const isTrial = plan === "pro" && status === "trialing";
  const base = isTrial ? DEFAULT_TRIAL_LIMITS : DEFAULT_LIMITS[plan];
  const override = isTrial ? parsedTrialLimitOverride() : parsedLimitOverrides()[plan] || {};
  return {
    monthlyEvents: positiveNumber(override.monthlyEvents, base.monthlyEvents),
    monthlyTokens: positiveNumber(override.monthlyTokens, base.monthlyTokens),
    monthlyCostUsd: positiveNumber(override.monthlyCostUsd, base.monthlyCostUsd),
    concurrency: positiveNumber(override.concurrency, base.concurrency),
    claimTtlSeconds: positiveNumber(override.claimTtlSeconds, base.claimTtlSeconds),
    queueRetryAfterSeconds: positiveNumber(override.queueRetryAfterSeconds, base.queueRetryAfterSeconds),
  };
}

export function defaultUsagePlanForServer(ownerId?: string | null): UsagePlanId {
  const configured = normalizeUsagePlan(process.env.ANVIL_USAGE_DEFAULT_PLAN, "free");
  if (process.env.ANVIL_USAGE_DEFAULT_PLAN) return configured;
  if (!ownerId && process.env.NODE_ENV !== "production") return "studio";
  return "free";
}
