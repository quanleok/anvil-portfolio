import { createHash, randomBytes } from "node:crypto";
import { createSupabaseAdminClient, hasSupabaseAdminConfig } from "@/lib/supabase/admin";

type DesktopTokenRow = {
  id: string;
  owner_id: string;
  label: string;
  token_hash: string;
  token_prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

type DesktopTokenDatabase = {
  public: {
    Tables: {
      anvil_desktop_tokens: {
        Row: DesktopTokenRow;
        Insert: Partial<DesktopTokenRow> & Pick<DesktopTokenRow, "owner_id" | "label" | "token_hash" | "token_prefix">;
        Update: Partial<DesktopTokenRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type DesktopTokenPublic = {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DesktopTokenVerification =
  | {
      ok: true;
      ownerId: string;
      tokenId: string;
      tokenPrefix: string;
    }
  | {
      ok: false;
      reason: "unconfigured" | "missing" | "revoked" | "expired";
    };

const DESKTOP_TOKEN_PREFIX = "avdt_";

function client() {
  if (!hasSupabaseAdminConfig()) return null;
  return createSupabaseAdminClient<DesktopTokenDatabase>();
}

function cleanLabel(value: unknown) {
  const label = typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, 120) : "";
  return label || "Anvil Desktop";
}

export function isDesktopToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith(DESKTOP_TOKEN_PREFIX);
}

export function hashDesktopToken(token: string) {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

function tokenPrefix(token: string) {
  return token.trim().slice(0, 14);
}

function publicToken(row: DesktopTokenRow): DesktopTokenPublic {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listDesktopTokens(ownerId: string): Promise<DesktopTokenPublic[]> {
  const supabase = client();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("anvil_desktop_tokens")
    .select("id,owner_id,label,token_hash,token_prefix,scopes,expires_at,revoked_at,last_used_at,created_at,updated_at")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error || !data) return [];
  return data.map(publicToken);
}

export async function createDesktopToken(ownerId: string, label: unknown) {
  const supabase = client();
  if (!supabase) {
    return {
      ok: false as const,
      error: "desktop_tokens_unconfigured",
      message: "Supabase service-role access is required to create desktop tokens.",
    };
  }
  const token = `${DESKTOP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const { data, error } = await supabase
    .from("anvil_desktop_tokens")
    .insert({
      owner_id: ownerId,
      label: cleanLabel(label),
      token_hash: hashDesktopToken(token),
      token_prefix: tokenPrefix(token),
    })
    .select("id,owner_id,label,token_hash,token_prefix,scopes,expires_at,revoked_at,last_used_at,created_at,updated_at")
    .single();
  if (error || !data) {
    return {
      ok: false as const,
      error: "desktop_token_create_failed",
      message: error?.message || "Could not create desktop token.",
    };
  }
  return {
    ok: true as const,
    token,
    desktopToken: publicToken(data),
  };
}

export async function revokeDesktopToken(ownerId: string, tokenId: string) {
  const supabase = client();
  if (!supabase) return false;
  const { error } = await supabase
    .from("anvil_desktop_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("id", tokenId)
    .is("revoked_at", null);
  return !error;
}

export async function verifyDesktopToken(token: string): Promise<DesktopTokenVerification> {
  const supabase = client();
  if (!supabase) return { ok: false, reason: "unconfigured" };
  const hash = hashDesktopToken(token);
  const { data, error } = await supabase
    .from("anvil_desktop_tokens")
    .select("id,owner_id,label,token_hash,token_prefix,scopes,expires_at,revoked_at,last_used_at,created_at,updated_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "missing" };
  if (data.revoked_at) return { ok: false, reason: "revoked" };
  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  await supabase
    .from("anvil_desktop_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  return {
    ok: true,
    ownerId: data.owner_id,
    tokenId: data.id,
    tokenPrefix: data.token_prefix,
  };
}
