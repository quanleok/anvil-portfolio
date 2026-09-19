import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  defaultUsagePlanForServer,
  normalizeUsageMethod,
  normalizeUsagePlan,
  type UsageEntitlementStatus,
  type UsageDecisionState,
  type UsageLedgerStatus,
  type UsageMethod,
  type UsagePlanId,
  type UsagePlanLimits,
  usagePlanLimits,
} from "./plans";
import { estimateUsageCostUsd, extractUsageTokens, type UsageTokenCounts } from "./tokens";

type UsageSummary = {
  totalEvents: number;
  totalTokens: number;
  totalCostEstimateUsd: number;
};

type Json = Record<string, unknown>;

type UsageEventRow = {
  id: string;
  owner_id: string | null;
  request_id: string;
  install_id: string | null;
  project_id: string | null;
  plan: string;
  method: string;
  phase: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  limit_reason: string | null;
  provider_status: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_estimate_usd: number;
  metadata: Json;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type UsageClaimRow = {
  id: string;
  owner_id: string;
  request_id: string;
  method: string;
  status: string;
  expires_at: string;
  released_at: string | null;
  created_at: string;
};

type EntitlementRow = {
  plan: string;
  status: string;
  access_until: string | null;
  current_period_end: string | null;
};

type UsageDatabase = {
  public: {
    Tables: {
      anvil_usage_events: {
        Row: UsageEventRow;
        Insert: Partial<UsageEventRow> & Pick<UsageEventRow, "owner_id" | "request_id" | "plan" | "method" | "status">;
        Update: Partial<UsageEventRow>;
        Relationships: [];
      };
      anvil_usage_claims: {
        Row: UsageClaimRow;
        Insert: Partial<UsageClaimRow> & Pick<UsageClaimRow, "owner_id" | "request_id" | "method" | "expires_at">;
        Update: Partial<UsageClaimRow>;
        Relationships: [];
      };
      anvil_billing_entitlements: {
        Row: EntitlementRow & { owner_id: string };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      anvil_monthly_usage_summary: {
        Args: { p_owner_id: string; p_period_start: string };
        Returns: Array<{
          total_events: number;
          total_tokens: number;
          total_cost_estimate_usd: number;
        }>;
      };
      anvil_claim_usage_slot: {
        Args: {
          p_owner_id: string;
          p_request_id: string;
          p_method: string;
          p_limit: number;
          p_ttl_seconds: number;
        };
        Returns: Array<{
          claim_id: string | null;
          active_count: number;
          allowed: boolean;
        }>;
      };
      anvil_sweep_expired_usage_claims: {
        Args: Record<string, never>;
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type UsageGateInput = {
  ownerId?: string | null;
  installId?: string | null;
  projectId?: string | null;
  requestId?: string | null;
  plan?: string | null;
  entitlementStatus?: UsageEntitlementStatus | null;
  method: UsageMethod | string;
  phase?: string | null;
  provider?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
};

export type UsageGateResult = {
  state: UsageDecisionState;
  requestId: string;
  plan: UsagePlanId;
  method: UsageMethod;
  limits: UsagePlanLimits;
  ledger: "recorded" | "skipped" | "unavailable";
  ownerId?: string;
  claimId?: string;
  eventId?: string;
  reason?: string;
  retryAfterSeconds?: number;
  summary?: UsageSummary;
};

export type UsageFinalizeInput = {
  gate: UsageGateResult;
  status: Extract<UsageLedgerStatus, "succeeded" | "failed" | "limited">;
  providerStatus?: number | null;
  providerUsage?: unknown;
  errorCode?: string | null;
  model?: string | null;
  provider?: string | null;
  metadata?: Record<string, unknown>;
};

type SupabaseAdminClient = ReturnType<typeof createClient<UsageDatabase>>;

let cachedClient: SupabaseAdminClient | null = null;
let lastUsageClaimSweepAt = 0;

function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function cleanDbText(value: unknown, max: number, min = 1) {
  const text = cleanText(value, max);
  return text.length >= min ? text : null;
}

function usageRequestId(value: unknown, ownerId?: string) {
  const raw = cleanText(value, 140);
  const base = raw.length >= 8 ? raw : randomUUID();
  if (!ownerId) return base;
  const hash = createHash("sha256")
    .update(`${ownerId}:${base}`)
    .digest("hex")
    .slice(0, 16);
  return `${base.slice(0, 143)}-${hash}`;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function usageLedgerRequired() {
  return process.env.ANVIL_USAGE_REQUIRE_LEDGER === "1";
}

function serviceRoleConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ""
  ).trim();
  return { url, serviceKey };
}

export function usageLedgerConfigured() {
  const { url, serviceKey } = serviceRoleConfig();
  return Boolean(url && serviceKey);
}

function usageAdminClient() {
  const { url, serviceKey } = serviceRoleConfig();
  if (!url || !serviceKey) return null;
  if (!cachedClient) {
    cachedClient = createClient<UsageDatabase>(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return cachedClient;
}

function monthlyPeriodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function gateBlocked(
  input: {
    state: UsageDecisionState;
    requestId: string;
    plan: UsagePlanId;
    method: UsageMethod;
    limits: UsagePlanLimits;
    ownerId?: string;
    reason: string;
    retryAfterSeconds?: number;
    summary?: UsageSummary;
  },
  ledger: UsageGateResult["ledger"],
  eventId?: string,
): UsageGateResult {
  return {
    state: input.state,
    requestId: input.requestId,
    plan: input.plan,
    method: input.method,
    limits: input.limits,
    ledger,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(eventId ? { eventId } : {}),
    reason: input.reason,
    ...(input.retryAfterSeconds ? { retryAfterSeconds: input.retryAfterSeconds } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
  };
}

async function monthlySummary(ownerId: string) {
  const client = usageAdminClient();
  if (!client) return null;
  const { data, error } = await client.rpc("anvil_monthly_usage_summary", {
    p_owner_id: ownerId,
    p_period_start: monthlyPeriodStart(),
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return { totalEvents: 0, totalTokens: 0, totalCostEstimateUsd: 0 };
  }
  const source = row as Record<string, unknown>;
  return {
    totalEvents: Number(source.total_events || 0),
    totalTokens: Number(source.total_tokens || 0),
    totalCostEstimateUsd: Number(source.total_cost_estimate_usd || 0),
  };
}

async function insertUsageEvent({
  ownerId,
  requestId,
  installId,
  projectId,
  plan,
  method,
  phase,
  provider,
  model,
  status,
  limitReason,
  providerStatus,
  tokens,
  costEstimateUsd,
  metadata,
}: {
  ownerId: string;
  requestId: string;
  installId?: string | null;
  projectId?: string | null;
  plan: UsagePlanId;
  method: UsageMethod;
  phase?: string | null;
  provider?: string | null;
  model?: string | null;
  status: UsageLedgerStatus;
  limitReason?: string | null;
  providerStatus?: number | null;
  tokens?: UsageTokenCounts;
  costEstimateUsd?: number;
  metadata?: Record<string, unknown>;
}) {
  const client = usageAdminClient();
  if (!client) return null;
  const record = {
    owner_id: ownerId,
    request_id: requestId,
    install_id: cleanDbText(installId, 160, 3),
    project_id: cleanDbText(projectId, 160, 1),
    plan,
    method,
    phase: cleanText(phase, 80) || null,
    provider: cleanText(provider, 80) || null,
    model: cleanText(model, 160) || null,
    status,
    limit_reason: cleanText(limitReason, 240) || null,
    provider_status: providerStatus || null,
    input_tokens: tokens?.inputTokens || 0,
    output_tokens: tokens?.outputTokens || 0,
    total_tokens: tokens?.totalTokens || 0,
    cost_estimate_usd: costEstimateUsd || 0,
    metadata: metadata || {},
    started_at: status === "allowed" || status === "started" ? new Date().toISOString() : null,
    finished_at: status === "limited" || status === "queued" || status === "failed" ? new Date().toISOString() : null,
  };
  const { data, error } = await client
    .from("anvil_usage_events")
    .upsert(record, { onConflict: "request_id" })
    .select("id")
    .single();
  if (error) return null;
  const id = data && typeof data === "object" ? (data as { id?: unknown }).id : null;
  return typeof id === "string" ? id : null;
}

async function claimUsageSlot({
  ownerId,
  requestId,
  method,
  limit,
  ttlSeconds,
}: {
  ownerId: string;
  requestId: string;
  method: UsageMethod;
  limit: number;
  ttlSeconds: number;
}) {
  const client = usageAdminClient();
  if (!client) return null;
  const { data, error } = await client.rpc("anvil_claim_usage_slot", {
    p_owner_id: ownerId,
    p_request_id: requestId,
    p_method: method,
    p_limit: limit,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const source = row as Record<string, unknown>;
  return {
    claimId: typeof source.claim_id === "string" ? source.claim_id : undefined,
    activeCount: Number(source.active_count || 0),
    allowed: source.allowed === true,
  };
}

async function updateUsageEvent({
  eventId,
  status,
  providerStatus,
  tokens,
  costEstimateUsd,
  limitReason,
  provider,
  model,
  metadata,
}: {
  eventId: string;
  status: UsageLedgerStatus;
  providerStatus?: number | null;
  tokens?: UsageTokenCounts;
  costEstimateUsd?: number;
  limitReason?: string | null;
  provider?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const client = usageAdminClient();
  if (!client) return;
  await client
    .from("anvil_usage_events")
    .update({
      status,
      provider_status: providerStatus || null,
      input_tokens: tokens?.inputTokens || 0,
      output_tokens: tokens?.outputTokens || 0,
      total_tokens: tokens?.totalTokens || 0,
      cost_estimate_usd: costEstimateUsd || 0,
      limit_reason: cleanText(limitReason, 240) || null,
      provider: cleanText(provider, 80) || undefined,
      model: cleanText(model, 160) || undefined,
      metadata: metadata || undefined,
      finished_at: new Date().toISOString(),
    })
    .eq("id", eventId);
}

async function releaseUsageClaim(claimId: string | undefined) {
  if (!claimId) return;
  const client = usageAdminClient();
  if (!client) return;
  await client
    .from("anvil_usage_claims")
    .update({
      status: "released",
      released_at: new Date().toISOString(),
    })
    .eq("id", claimId)
    .is("released_at", null);
}

async function maybeSweepExpiredUsageClaims() {
  const now = Date.now();
  if (now - lastUsageClaimSweepAt < 60_000) return;
  lastUsageClaimSweepAt = now;
  await sweepExpiredUsageClaims();
}

export async function resolveUsagePlanForOwner(ownerId: string | null | undefined, fallback?: UsagePlanId) {
  const entitlement = await resolveUsageEntitlementForOwner(ownerId, fallback);
  return entitlement.plan;
}

export async function resolveUsageEntitlementForOwner(ownerId: string | null | undefined, fallback?: UsagePlanId) {
  const normalizedFallback = fallback || defaultUsagePlanForServer(ownerId);
  if (!isUuid(ownerId) || !usageLedgerConfigured()) {
    return { plan: normalizedFallback, status: "unknown" as UsageEntitlementStatus };
  }
  const client = usageAdminClient();
  if (!client) return { plan: normalizedFallback, status: "unknown" as UsageEntitlementStatus };
  const { data, error } = await client
    .from("anvil_billing_entitlements")
    .select("plan,status,access_until,current_period_end")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error || !data) return { plan: normalizedFallback, status: "not_subscribed" as UsageEntitlementStatus };
  const row = data as Record<string, unknown>;
  const status = cleanText(row.status, 80) as UsageEntitlementStatus;
  const accessUntil = typeof row.access_until === "string" ? Date.parse(row.access_until) : NaN;
  const periodEnd = typeof row.current_period_end === "string" ? Date.parse(row.current_period_end) : NaN;
  const hasAccessGrace =
    (Number.isFinite(accessUntil) && accessUntil > Date.now()) ||
    (Number.isFinite(periodEnd) && periodEnd > Date.now() && status === "past_due");
  const hasActiveAccess = status === "active" || (status === "trialing" && hasAccessGrace) || hasAccessGrace;
  if (!hasActiveAccess) return { plan: "free" as UsagePlanId, status };
  return { plan: normalizeUsagePlan(row.plan, normalizedFallback), status };
}

export async function evaluateUsageGate(input: UsageGateInput): Promise<UsageGateResult> {
  const ownerId = isUuid(input.ownerId) ? input.ownerId : undefined;
  const plan = normalizeUsagePlan(input.plan, defaultUsagePlanForServer(ownerId));
  const method = normalizeUsageMethod(input.method);
  const limits = usagePlanLimits(plan, input.entitlementStatus);
  const requestId = usageRequestId(input.requestId, ownerId);
  const common = { requestId, plan, method, limits, ownerId };

  if (limits.monthlyEvents <= 0 || limits.concurrency <= 0) {
    const eventId = ownerId && usageLedgerConfigured()
      ? await insertUsageEvent({
          ownerId,
          requestId,
          installId: input.installId,
          projectId: input.projectId,
          plan,
          method,
          phase: input.phase,
          provider: input.provider,
          model: input.model,
          status: "limited",
          limitReason: "plan_not_allowed",
          metadata: input.metadata,
        })
      : null;
    return gateBlocked(
      {
        ...common,
        state: "limited",
        reason: "plan_not_allowed",
      },
      eventId ? "recorded" : "skipped",
      eventId || undefined,
    );
  }

  if (!ownerId || !usageLedgerConfigured()) {
    if (usageLedgerRequired()) {
      return gateBlocked(
        {
          ...common,
          state: "queued",
          reason: "usage_ledger_unavailable",
          retryAfterSeconds: limits.queueRetryAfterSeconds,
        },
        "unavailable",
      );
    }
    return {
      state: "allowed",
      requestId,
      plan,
      method,
      limits,
      ledger: "skipped",
      reason: ownerId ? "usage_ledger_not_configured" : "usage_owner_missing",
    };
  }

  await maybeSweepExpiredUsageClaims();

  const summary = await monthlySummary(ownerId);
  if (!summary) {
    return gateBlocked(
      {
        ...common,
        state: "queued",
        reason: "usage_ledger_unavailable",
        retryAfterSeconds: limits.queueRetryAfterSeconds,
      },
      "unavailable",
    );
  }

  const limitReason =
    summary.totalEvents >= limits.monthlyEvents ? "monthly_turn_limit" :
      summary.totalTokens >= limits.monthlyTokens ? "monthly_token_limit" :
        summary.totalCostEstimateUsd >= limits.monthlyCostUsd ? "monthly_cost_limit" :
          "";
  if (limitReason) {
    const eventId = await insertUsageEvent({
      ownerId,
      requestId,
      installId: input.installId,
      projectId: input.projectId,
      plan,
      method,
      phase: input.phase,
      provider: input.provider,
      model: input.model,
      status: "limited",
      limitReason,
      metadata: input.metadata,
    });
    return gateBlocked(
      {
        ...common,
        state: "limited",
        reason: limitReason,
        summary,
      },
      eventId ? "recorded" : "unavailable",
      eventId || undefined,
    );
  }

  const claim = await claimUsageSlot({
    ownerId,
    requestId,
    method,
    limit: limits.concurrency,
    ttlSeconds: limits.claimTtlSeconds,
  });
  if (!claim) {
    return gateBlocked(
      {
        ...common,
        state: "queued",
        reason: "usage_claim_unavailable",
        retryAfterSeconds: limits.queueRetryAfterSeconds,
        summary,
      },
      "unavailable",
    );
  }
  if (!claim.allowed) {
    const eventId = await insertUsageEvent({
      ownerId,
      requestId,
      installId: input.installId,
      projectId: input.projectId,
      plan,
      method,
      phase: input.phase,
      provider: input.provider,
      model: input.model,
      status: "queued",
      limitReason: "concurrency_limit",
      metadata: {
        ...(input.metadata || {}),
        activeCount: claim.activeCount,
      },
    });
    return gateBlocked(
      {
        ...common,
        state: "queued",
        reason: "concurrency_limit",
        retryAfterSeconds: limits.queueRetryAfterSeconds,
        summary,
      },
      eventId ? "recorded" : "unavailable",
      eventId || undefined,
    );
  }

  const eventId = await insertUsageEvent({
    ownerId,
    requestId,
    installId: input.installId,
    projectId: input.projectId,
    plan,
    method,
    phase: input.phase,
    provider: input.provider,
    model: input.model,
    status: "allowed",
    metadata: input.metadata,
  });
  if (!eventId && usageLedgerRequired()) {
    await releaseUsageClaim(claim.claimId);
    return gateBlocked(
      {
        ...common,
        state: "queued",
        reason: "usage_event_unavailable",
        retryAfterSeconds: limits.queueRetryAfterSeconds,
        summary,
      },
      "unavailable",
    );
  }

  return {
    state: "allowed",
    requestId,
    plan,
    method,
    limits,
    ledger: eventId ? "recorded" : "unavailable",
    ownerId,
    claimId: claim.claimId,
    ...(eventId ? { eventId } : {}),
    summary,
  };
}

export async function finalizeUsageGate(input: UsageFinalizeInput) {
  const tokens = extractUsageTokens(input.providerUsage);
  const model = cleanText(input.model || "", 160) || undefined;
  const costEstimateUsd = estimateUsageCostUsd(model, tokens);
  if (input.gate.eventId) {
    await updateUsageEvent({
      eventId: input.gate.eventId,
      status: input.status,
      providerStatus: input.providerStatus,
      tokens,
      costEstimateUsd,
      limitReason: input.errorCode,
      provider: input.provider,
      model,
      metadata: input.metadata,
    });
  }
  await releaseUsageClaim(input.gate.claimId);
}

export async function sweepExpiredUsageClaims() {
  const client = usageAdminClient();
  if (!client) {
    return {
      ok: false as const,
      swept: 0,
      reason: "usage_ledger_not_configured",
    };
  }
  const { data, error } = await client.rpc("anvil_sweep_expired_usage_claims", {});
  if (error) {
    return {
      ok: false as const,
      swept: 0,
      reason: error.message,
    };
  }
  return {
    ok: true as const,
    swept: Number(data || 0),
  };
}

export function usageGateResponse(gate: UsageGateResult) {
  return {
    state: gate.state,
    plan: gate.plan,
    reason: gate.reason,
    retryAfterSeconds: gate.retryAfterSeconds,
    usage: {
      requestId: gate.requestId,
      ledger: gate.ledger,
      method: gate.method,
      limit: {
        monthlyEvents: gate.limits.monthlyEvents,
        monthlyTokens: gate.limits.monthlyTokens,
        monthlyCostUsd: gate.limits.monthlyCostUsd,
        concurrency: gate.limits.concurrency,
      },
      summary: gate.summary,
    },
  };
}
