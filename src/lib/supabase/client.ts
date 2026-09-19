"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabasePublicConfig } from "./config";

export function createSupabaseBrowserClient() {
  const { url, anonKey } = supabasePublicConfig();
  if (!url || !anonKey) {
    throw new Error("Supabase browser auth is not configured.");
  }

  return createBrowserClient(url, anonKey);
}
