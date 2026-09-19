import { NextResponse, type NextRequest } from "next/server";
import {
  createDesktopToken,
  listDesktopTokens,
  revokeDesktopToken,
} from "@/lib/desktop-tokens/server";
import { readBillingStateForUser } from "@/lib/billing/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import { readSmallJson } from "@/server/media/http";

export const runtime = "nodejs";

function json(data: Record<string, unknown>, status = 200) {
  return NextResponse.json(data, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 32_000);
}

function agentEndpoint(request: NextRequest) {
  const origin = request.nextUrl.origin.replace(/\/+$/, "");
  return `${origin}/api/anvil-agent/turn`;
}

export async function GET(request: NextRequest) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);
  await readBillingStateForUser(auth.user.id);
  const tokens = await listDesktopTokens(auth.user.id);
  return json({
    ok: true,
    endpoint: agentEndpoint(request),
    tokens,
  });
}

export async function POST(request: NextRequest) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);
  await readBillingStateForUser(auth.user.id);
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "invalid_request", message: "Desktop token creation requires small valid JSON." }, 400);
  }
  const result = await createDesktopToken(auth.user.id, body.label);
  if (!result.ok) {
    return json({ error: result.error, message: result.message }, 503);
  }
  return json({
    ok: true,
    endpoint: agentEndpoint(request),
    token: result.token,
    desktopToken: result.desktopToken,
    message: "Copy this token now. Anvil only shows it once.",
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "invalid_request", message: "Desktop token revoke requires small valid JSON." }, 400);
  }
  const tokenId =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : request.nextUrl.searchParams.get("id") || "";
  if (!tokenId) {
    return json({ error: "bad_request", message: "Token id is required." }, 400);
  }
  const ok = await revokeDesktopToken(auth.user.id, tokenId);
  return json({ ok });
}
