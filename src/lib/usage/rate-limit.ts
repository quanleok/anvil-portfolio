import { checkFixedWindowRateLimit } from "@/lib/rate-limit/memory";

export type AgentRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      error: "rate_limited";
      scope: "ip" | "owner";
      retryAfterSeconds: number;
    };

const WINDOW_MS = 60_000;

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

export function requestIpAddress(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

function blocked(scope: "ip" | "owner", retryAfterSeconds?: number): AgentRateLimitResult {
  return {
    allowed: false,
    error: "rate_limited",
    scope,
    retryAfterSeconds: Math.max(1, retryAfterSeconds || Math.ceil(WINDOW_MS / 1000)),
  };
}

export function checkAgentIpRateLimit(request: Request, route: string): AgentRateLimitResult {
  const limit = positiveInteger(process.env.ANVIL_AGENT_IP_RATE_LIMIT_PER_MINUTE, 20);
  const result = checkFixedWindowRateLimit({
    key: `agent-turn:${route}:ip:${requestIpAddress(request)}`,
    limit,
    windowMs: WINDOW_MS,
  });
  return result.allowed ? { allowed: true } : blocked("ip", result.retryAfterSeconds);
}

export function checkAgentOwnerRateLimit(ownerId: string | undefined, route: string): AgentRateLimitResult {
  if (!ownerId) return { allowed: true };
  const limit = positiveInteger(process.env.ANVIL_AGENT_OWNER_RATE_LIMIT_PER_MINUTE, 10);
  const result = checkFixedWindowRateLimit({
    key: `agent-turn:${route}:owner:${ownerId}`,
    limit,
    windowMs: WINDOW_MS,
  });
  return result.allowed ? { allowed: true } : blocked("owner", result.retryAfterSeconds);
}

export function agentRateLimitPayload(result: Extract<AgentRateLimitResult, { allowed: false }>) {
  return {
    ok: false,
    state: "limited",
    error: result.error,
    message:
      result.scope === "owner"
        ? "Too many Anvil agent turns for this account. Try again shortly."
        : "Too many Anvil agent turns from this network. Try again shortly.",
    retryAfterSeconds: result.retryAfterSeconds,
  };
}
