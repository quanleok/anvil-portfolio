import { NextResponse, type NextRequest } from "next/server";
import { authenticateAnvilAgentRequest } from "@/server/anvil/auth";
import {
  hostedAnvilAgentDisabledResult,
  hostedAnvilAgentEnabled,
  hostedAnvilAgentStatus,
  runHostedAnvilAgentTurn,
  type HostedAnvilTurnResult,
} from "@/server/anvil/hosted-turn";
import {
  agentRateLimitPayload,
  checkAgentIpRateLimit,
  checkAgentOwnerRateLimit,
} from "@/lib/usage/rate-limit";
import { createRequestLogger } from "@/lib/usage/logging";
import { readSmallJson } from "@/server/media/http";

export const runtime = "nodejs";

function json(result: HostedAnvilTurnResult) {
  return NextResponse.json(result.body, { status: result.status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 2 * 1024 * 1024);
}

function authErrorResponse(auth: Exclude<Awaited<ReturnType<typeof authenticateAnvilAgentRequest>>, { ok: true }>) {
  return NextResponse.json({ error: auth.error, message: auth.message }, { status: auth.status });
}

function badJsonResponse(error: unknown) {
  const tooLarge = error instanceof Error && error.message === "json_body_too_large";
  return NextResponse.json(
    {
      error: tooLarge ? "request_too_large" : "bad_request",
      message: tooLarge ? "Anvil agent requests must be 2MB or smaller." : "Anvil agent requests require valid JSON.",
    },
    { status: tooLarge ? 413 : 400 },
  );
}

export async function GET(request: NextRequest) {
  if (!hostedAnvilAgentEnabled()) {
    return json(hostedAnvilAgentDisabledResult());
  }

  const auth = await authenticateAnvilAgentRequest(request);
  if (!auth.ok) return authErrorResponse(auth);

  return json(await hostedAnvilAgentStatus(auth));
}

export async function POST(request: NextRequest) {
  const requestLog = createRequestLogger(request, "/api/anvil-agent/turn");

  if (!hostedAnvilAgentEnabled()) {
    requestLog.complete(410, { outcome: "agent_disabled" });
    return json(hostedAnvilAgentDisabledResult());
  }

  const ipRate = checkAgentIpRateLimit(request, "/api/anvil-agent/turn");
  if (!ipRate.allowed) {
    requestLog.complete(429, { outcome: "ip_rate_limited" });
    return NextResponse.json(agentRateLimitPayload(ipRate), { status: 429 });
  }

  const auth = await authenticateAnvilAgentRequest(request);
  if (!auth.ok) {
    requestLog.complete(auth.status, { outcome: "auth_failed", authError: auth.error });
    return authErrorResponse(auth);
  }

  const ownerRate = checkAgentOwnerRateLimit(auth.ownerId, "/api/anvil-agent/turn");
  if (!ownerRate.allowed) {
    requestLog.complete(429, { outcome: "owner_rate_limited", ownerId: auth.ownerId || null });
    return NextResponse.json(agentRateLimitPayload(ownerRate), { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch (error) {
    requestLog.complete(error instanceof Error && error.message === "json_body_too_large" ? 413 : 400, {
      outcome: "bad_json",
      ownerId: auth.ownerId || null,
    });
    return badJsonResponse(error);
  }

  const result = await runHostedAnvilAgentTurn({
    auth,
    body,
  });
  requestLog.complete(result.status, {
    outcome: result.body?.error ? "agent_error" : "agent_turn",
    ownerId: auth.ownerId || null,
    state: typeof result.body?.state === "string" ? result.body.state : null,
  });
  return json(result);
}
