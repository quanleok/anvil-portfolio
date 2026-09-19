import { NextResponse, type NextRequest } from "next/server";
import { parseAnvilTurnRequest, type AnvilTurnRequest } from "@/shared/anvil-api";
import { runProtectedAnvilTurn } from "@/server/anvil/turn";
import { checkFixedWindowRateLimit } from "@/lib/rate-limit/memory";
import { isProviderRateLimitError, providerLimitedPayload } from "@/lib/rate-limit/provider";
import {
  evaluateUsageGate,
  finalizeUsageGate,
  resolveUsagePlanForOwner,
  usageGateResponse,
} from "@/lib/usage/server";
import { normalizeUsagePlan } from "@/lib/usage/plans";
import { readSmallJson } from "@/server/media/http";

export const runtime = "nodejs";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

function protectedMethodsEnabled() {
  return String(process.env.ANVIL_ENABLE_PROTECTED_METHODS || "").trim() === "1" || process.env.NODE_ENV !== "production";
}

function requestKey(request: NextRequest, installId?: string) {
  if (installId) return `install:${installId}`;
  const forwarded = request.headers.get("x-forwarded-for") || "";
  const ip = forwarded.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `ip:${ip}`;
}

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function isAuthorized(request: NextRequest) {
  const expected = process.env.ANVIL_SERVER_API_TOKEN?.trim();
  if (expected) return bearerToken(request) === expected;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

function badJsonResponse(error: unknown) {
  const tooLarge = error instanceof Error && error.message === "json_body_too_large";
  return NextResponse.json(
    {
      error: tooLarge ? "request_too_large" : "bad_request",
      message: tooLarge ? "Protected Anvil requests must be 2MB or smaller." : "Invalid protected Anvil request.",
    },
    { status: tooLarge ? 413 : 400 },
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function tokenOwnerId() {
  const ownerId = process.env.ANVIL_AGENT_TOKEN_OWNER_ID?.trim();
  return isUuid(ownerId) ? ownerId : "";
}

function usageOwnerId(request: NextRequest) {
  const configuredOwnerId = tokenOwnerId();
  if (configuredOwnerId) return configuredOwnerId;
  if (process.env.NODE_ENV !== "production") {
    return request.headers.get("x-anvil-owner-id")?.trim() || "";
  }
  return "";
}

async function usagePlan(request: NextRequest, ownerId: string) {
  if (process.env.NODE_ENV !== "production") {
    const devPlan = request.headers.get("x-anvil-plan");
    if (devPlan) return normalizeUsagePlan(devPlan);
  }
  return resolveUsagePlanForOwner(ownerId);
}

export async function GET() {
  const authConfigured = Boolean(process.env.ANVIL_SERVER_API_TOKEN);
  return NextResponse.json({
    ok: true,
    service: "anvil-protected-turn",
    enabled: protectedMethodsEnabled(),
    auth: authConfigured ? "configured" : "missing",
  });
}

export async function POST(request: NextRequest) {
  if (!protectedMethodsEnabled()) {
    return NextResponse.json(
      {
        error: "protected_methods_disabled",
        message:
          "Protected Anvil methods are disabled on this deployment. Set ANVIL_ENABLE_PROTECTED_METHODS=1 on the server.",
      },
      { status: 410 },
    );
  }

  if (!isAuthorized(request)) {
    return NextResponse.json(
      {
        error: "unauthorized",
        message:
          "This protected Anvil endpoint requires a valid bearer token.",
      },
      { status: 401 },
    );
  }

  let parsed: AnvilTurnRequest;
  try {
    parsed = parseAnvilTurnRequest(await readSmallJson<Record<string, unknown>>(request, 2 * 1024 * 1024));
  } catch (error) {
    return badJsonResponse(error);
  }

  const rate = checkFixedWindowRateLimit({
    key: requestKey(request, parsed.installId),
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        state: "limited",
        error: "rate_limited",
        message: "Too many protected Anvil requests. Try again shortly.",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      { status: 429 },
    );
  }

  const ownerId = usageOwnerId(request);
  const gate = await evaluateUsageGate({
    ownerId,
    plan: await usagePlan(request, ownerId),
    method: "protected_method",
    phase: parsed.phase,
    installId: parsed.installId,
    projectId: parsed.projectId,
    requestId: request.headers.get("x-anvil-request-id"),
    provider: process.env.ANVIL_SERVER_LLM_PROVIDER,
    model: process.env.ANVIL_SERVER_LLM_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL,
    metadata: { route: "/api/anvil/turn" },
  });
  if (gate.state !== "allowed") {
    return NextResponse.json(
      {
        error: gate.state === "queued" ? "queued" : "usage_limited",
        message: gate.state === "queued"
          ? "This Anvil request is queued because another request is already running or the usage ledger is temporarily unavailable."
          : "This Anvil plan has reached its current usage limit.",
        ...usageGateResponse(gate),
      },
      { status: gate.state === "queued" ? 202 : 429 },
    );
  }

  try {
    const result = await runProtectedAnvilTurn(parsed);
    await finalizeUsageGate({
      gate,
      status: "succeeded",
      provider: typeof result.meta?.provider === "string" ? result.meta.provider : undefined,
      model: typeof result.meta?.model === "string" ? result.meta.model : undefined,
      providerUsage: result.meta?.usage,
      metadata: { route: "/api/anvil/turn", warnings: result.warnings || [] },
    });
    return NextResponse.json({
      ...usageGateResponse(gate),
      ...result,
      state: "allowed",
    });
  } catch (error) {
    if (isProviderRateLimitError(error)) {
      await finalizeUsageGate({
        gate,
        status: "limited",
        providerStatus: error.providerStatus,
        provider: error.provider,
        model: error.model,
        errorCode: "provider_rate_limited",
        metadata: { route: "/api/anvil/turn" },
      });
      return NextResponse.json(
        {
          ...usageGateResponse(gate),
          ...providerLimitedPayload(error),
        },
        { status: 429 },
      );
    }
    await finalizeUsageGate({
      gate,
      status: "failed",
      errorCode: "provider_error",
      metadata: { route: "/api/anvil/turn" },
    });
    return NextResponse.json(
      {
        ...usageGateResponse(gate),
        state: "limited",
        error: "provider_error",
        message: error instanceof Error ? error.message : "Protected Anvil provider request failed.",
      },
      { status: 502 },
    );
  }
}
