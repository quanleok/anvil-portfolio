import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { hasSupabasePublicConfig } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type WorkspaceUser = {
  id: string;
  email: string;
};

type WorkspaceAuthResult =
  | { ok: true; user: WorkspaceUser }
  | { ok: false; status: number; error: string; message: string };

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

type AuthStatEvent = {
  ts: number;
  outcome: "success" | "rejected";
};

const authStatEvents: AuthStatEvent[] = [];

/**
 * Workspace auth operational guardrails:
 * - Production never permits ANVIL_DISABLE_WORKSPACE_AUTH=1; the process throws
 *   at module load instead of accidentally exposing private workspace APIs.
 * - Production with an empty ANVIL_ALLOWED_EMAILS list is closed by default
 *   unless ANVIL_OPEN_REGISTRATION=1 is explicitly set.
 * - Mutating requests require a same-origin Origin header in production, with
 *   ANVIL_ALLOWED_ORIGINS as the only cross-origin escape hatch.
 * - Missing Supabase public auth config returns 503 rather than silently
 *   falling back to dev-user outside the local auth-bypass mode.
 */

function envFlag(name: string) {
  return String(process.env[name] || "").trim() === "1";
}

function normalizeOrigin(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === "null") return "";
  try {
    return new URL(text).origin;
  } catch {
    return "";
  }
}

function configuredAllowedOrigins(request: Request) {
  const origins = new Set<string>();
  const requestOrigin = normalizeOrigin(request.url);
  if (requestOrigin) origins.add(requestOrigin);
  for (const value of [
    process.env.ANVIL_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "",
    ...(process.env.ANVIL_ALLOWED_ORIGINS || "").split(","),
  ]) {
    const origin = normalizeOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function validateMutationOrigin(request?: Request): WorkspaceAuthResult | null {
  if (!request || SAFE_HTTP_METHODS.has(request.method.toUpperCase())) return null;
  const origin = normalizeOrigin(request.headers.get("origin"));
  const fetchSite = (request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (!origin) {
    if (process.env.NODE_ENV !== "production" || fetchSite === "same-origin" || fetchSite === "same-site") {
      return null;
    }
    return {
      ok: false,
      status: 403,
      error: "invalid_origin",
      message: "Workspace mutation requests require a same-origin Origin header.",
    };
  }
  if (configuredAllowedOrigins(request).has(origin)) return null;
  return {
    ok: false,
    status: 403,
    error: "invalid_origin",
    message: "Workspace mutation request origin is not allowed.",
  };
}

export function assertWorkspaceAuthEnv() {
  if (process.env.NODE_ENV === "production" && envFlag("ANVIL_DISABLE_WORKSPACE_AUTH")) {
    console.error(
      "[workspace-auth] Refusing to start: ANVIL_DISABLE_WORKSPACE_AUTH=1 is unsafe in production.",
    );
    throw new Error("ANVIL_DISABLE_WORKSPACE_AUTH cannot be enabled in production.");
  }
}

assertWorkspaceAuthEnv();

export function configuredAllowedEmails() {
  return (process.env.ANVIL_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().replace(/^["']|["']$/g, "").trim().toLowerCase())
    .filter((email) => email && email !== "\"\"" && email !== "''");
}

export function isEmailAllowed(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  const allowed = configuredAllowedEmails();
  if (allowed.length === 0) {
    if (process.env.NODE_ENV === "production") return envFlag("ANVIL_OPEN_REGISTRATION");
    return true;
  }
  return allowed.includes(normalizedEmail);
}

function pruneAuthStatEvents(now = Date.now()) {
  const cutoff = now - AUTH_STATS_WINDOW_MS;
  while (authStatEvents.length && authStatEvents[0]?.ts < cutoff) {
    authStatEvents.shift();
  }
}

function recordAuthStat(outcome: AuthStatEvent["outcome"]) {
  authStatEvents.push({ ts: Date.now(), outcome });
  pruneAuthStatEvents();
}

export function workspaceAuthConfigStatus() {
  const allowedEmails = configuredAllowedEmails();
  return {
    allowedEmailsConfigured: allowedEmails.length > 0,
    allowedEmailsCount: allowedEmails.length,
    openRegistration: envFlag("ANVIL_OPEN_REGISTRATION"),
    nodeEnv: process.env.NODE_ENV || "",
  };
}

export function workspaceAuthRecentSignInStats(now = Date.now()) {
  pruneAuthStatEvents(now);
  return authStatEvents.reduce(
    (stats, event) => {
      stats.last24h[event.outcome] += 1;
      return stats;
    },
    { last24h: { success: 0, rejected: 0 } },
  );
}

export function workspaceAuthBypassed() {
  if (envFlag("ANVIL_DISABLE_WORKSPACE_AUTH")) return true;
  if (envFlag("ANVIL_REQUIRE_WORKSPACE_AUTH")) return false;
  return process.env.NODE_ENV !== "production";
}

const DEV_WORKSPACE_USER: WorkspaceUser = {
  id: "dev-user",
  email: "dev@anvil.local",
};

export async function getWorkspaceUser(request?: Request): Promise<WorkspaceAuthResult> {
  const originError = validateMutationOrigin(request);
  if (originError) return originError;

  if (workspaceAuthBypassed()) {
    return { ok: true, user: DEV_WORKSPACE_USER };
  }

  if (!hasSupabasePublicConfig()) {
    return {
      ok: false,
      status: 503,
      error: "auth_not_configured",
      message:
        "Supabase Auth requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  const id = typeof claims?.sub === "string" ? claims.sub.trim() : "";
  const email =
    typeof claims?.email === "string" ? claims.email.trim().toLowerCase() : "";

  if (error || !id || !email) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Sign in to Anvil before accessing private project data.",
    };
  }

  if (!isEmailAllowed(email)) {
    recordAuthStat("rejected");
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "Email not on the Anvil early-access list. Request access at hello@myriadanvil.com.",
    };
  }

  recordAuthStat("success");
  return { ok: true, user: { id, email } };
}

export async function requireWorkspaceUser(nextPath = "/app") {
  const auth = await getWorkspaceUser();
  if (auth.ok) return auth.user;

  const params = new URLSearchParams({ next: nextPath });
  if (auth.error === "forbidden") params.set("error", "email_not_allowed");
  redirect(`/app/login?${params.toString()}`);
}

export function workspaceAuthErrorResponse(auth: Exclude<WorkspaceAuthResult, { ok: true }>) {
  return NextResponse.json(
    {
      error: auth.error,
      message: auth.message,
    },
    { status: auth.status },
  );
}
