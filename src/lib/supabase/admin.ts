import { createClient } from "@supabase/supabase-js";

type EmptySupabaseDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export function supabaseAdminConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceRoleKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ""
  ).trim();

  return {
    url,
    serviceRoleKey,
  };
}

export function hasSupabaseAdminConfig() {
  const config = supabaseAdminConfig();
  return Boolean(config.url && config.serviceRoleKey);
}

export function createSupabaseAdminClient<Database = EmptySupabaseDatabase>() {
  const { url, serviceRoleKey } = supabaseAdminConfig();
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase service-role access is not configured.");
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
