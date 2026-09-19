import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function safeNextPath(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return "/app";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app";
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const nextPath = safeNextPath(url.searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(nextPath, url.origin));
    }
  }

  const loginUrl = new URL("/app/login", url.origin);
  loginUrl.searchParams.set("error", "auth_callback_failed");
  if (nextPath !== "/app") loginUrl.searchParams.set("next", nextPath);
  return NextResponse.redirect(loginUrl);
}
