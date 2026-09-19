import { createClient } from "@supabase/supabase-js";
import { isDesktopToken, verifyDesktopToken } from "@/lib/desktop-tokens/server";
import { hasSupabasePublicConfig, supabasePublicConfig } from "@/lib/supabase/config";
import { getWorkspaceUser } from "@/lib/workspace-auth";

export type AnvilAgentAuthResult =
  | {
      ok: true;
      authKind: "cookie" | "desktop_token" | "dev" | "server_token" | "supabase_bearer";
      ownerId?: string;
      email?: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
    };

function cleanText(value: unknown, max = 8000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return cleanText(match?.[1]);
}

function staticServerTokens() {
  return [
    process.env.ANVIL_AGENT_SERVER_TOKEN,
    process.env.ANVIL_API_TOKEN,
    process.env.ANVIL_SERVER_API_TOKEN,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean);
}

function tokenOwnerId() {
  const ownerId = cleanText(process.env.ANVIL_AGENT_TOKEN_OWNER_ID, 120);
  return isUuid(ownerId) ? ownerId : undefined;
}

async function authenticateSupabaseBearer(token: string): Promise<AnvilAgentAuthResult> {
  if (!hasSupabasePublicConfig()) {
    return {
      ok: false,
      status: 503,
      error: "auth_not_configured",
      message:
        "Supabase Auth requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    };
  }

  const { url, anonKey } = supabasePublicConfig();
  const supabase = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const { data, error } = await supabase.auth.getUser(token);
  const user = data?.user;
  if (error || !user?.id) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "A valid signed-in Anvil access token is required.",
    };
  }

  return {
    ok: true,
    authKind: "supabase_bearer",
    ownerId: isUuid(user.id) ? user.id : undefined,
    email: typeof user.email === "string" ? user.email : undefined,
  };
}

async function authenticateDesktopToken(token: string): Promise<AnvilAgentAuthResult> {
  const verified = await verifyDesktopToken(token);
  if (!verified.ok) {
    return {
      ok: false,
      status: verified.reason === "unconfigured" ? 503 : 401,
      error: verified.reason === "unconfigured" ? "desktop_tokens_unconfigured" : "unauthorized",
      message:
        verified.reason === "expired"
          ? "This Anvil desktop token has expired. Create a new token from your Anvil account page."
          : verified.reason === "revoked"
            ? "This Anvil desktop token has been revoked. Create a new token from your Anvil account page."
            : verified.reason === "unconfigured"
              ? "Desktop token verification requires Supabase service-role configuration."
              : "A valid Anvil desktop token is required.",
    };
  }
  return {
    ok: true,
    authKind: "desktop_token",
    ownerId: verified.ownerId,
  };
}

export async function authenticateAnvilAgentRequest(request: Request): Promise<AnvilAgentAuthResult> {
  const bearer = bearerToken(request);
  if (bearer) {
    if (staticServerTokens().includes(bearer)) {
      return {
        ok: true,
        authKind: "server_token",
        ownerId: tokenOwnerId(),
      };
    }
    if (isDesktopToken(bearer)) {
      return authenticateDesktopToken(bearer);
    }
    return authenticateSupabaseBearer(bearer);
  }

  const auth = await getWorkspaceUser(request);
  if (!auth.ok) {
    return auth;
  }

  return {
    ok: true,
    authKind: auth.user.id === "dev-user" ? "dev" : "cookie",
    ownerId: isUuid(auth.user.id) ? auth.user.id : undefined,
    email: auth.user.email,
  };
}
