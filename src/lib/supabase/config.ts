export function supabasePublicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

  return {
    url: url.replace(/\/+$/, ""),
    anonKey,
  };
}

export function hasSupabasePublicConfig() {
  const config = supabasePublicConfig();
  return Boolean(config.url && config.anonKey);
}
