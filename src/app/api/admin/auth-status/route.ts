import { NextResponse } from "next/server";
import {
  workspaceAuthConfigStatus,
  workspaceAuthRecentSignInStats,
} from "@/lib/workspace-auth";

export const runtime = "nodejs";

function adminToken() {
  return String(process.env.ANVIL_ADMIN_TOKEN || "").trim();
}

function requestToken(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  return bearer || request.headers.get("x-anvil-admin-token")?.trim() || "";
}

function requestIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export async function GET(request: Request) {
  const configuredToken = adminToken();
  const providedToken = requestToken(request);

  if (!configuredToken || providedToken !== configuredToken) {
    console.warn("[admin/auth-status] unauthorized status request", {
      ip: requestIp(request),
      configured: Boolean(configuredToken),
    });
    return NextResponse.json({ error: "unauthorized", message: "Admin token required." }, { status: 401 });
  }

  return NextResponse.json({
    ...workspaceAuthConfigStatus(),
    recentSignInStats: workspaceAuthRecentSignInStats(),
  });
}
