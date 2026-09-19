import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabasePublicConfig } from "./config";

export async function createSupabaseServerClient() {
  const { url, anonKey } = supabasePublicConfig();
  if (!url || !anonKey) {
    throw new Error("Supabase server auth is not configured.");
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot always write refreshed cookies.
          // Route handlers and middleware can refresh them before render.
        }
      },
    },
  });
}
