import { NextResponse, type NextRequest } from "next/server";
import { bunnyStorageConfig, normalizeMediaKind } from "@/lib/storage/bunny";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  listMediaAssetsForOwner,
  requestCanBeServed,
  projectOwnedBy,
  type MediaAssetStatus,
} from "@/server/media/db";
import { createMediaUploadForOwner } from "@/server/media/create";
import { boundedNumber, readSmallJson, routeOrigin } from "@/server/media/http";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function assertProjectAccess(ownerId: string, projectId: string) {
  if (process.env.NODE_ENV !== "production" && ownerId === "dev-user") return true;
  return projectOwnedBy(ownerId, projectId);
}

function statusFilter(value: unknown): MediaAssetStatus | null {
  const text = typeof value === "string" ? value.trim().slice(0, 40) : "";
  if (
    text === "pending_upload" ||
    text === "uploaded" ||
    text === "processing" ||
    text === "ready" ||
    text === "failed" ||
    text === "deleted"
  ) {
    return text;
  }
  return null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  if (!(await assertProjectAccess(auth.user.id, projectId))) {
    return jsonError("project_not_found", "Project was not found for this account.", 404);
  }

  if (!requestCanBeServed(auth.user.id)) {
    return NextResponse.json({
      assets: [],
      persisted: false,
      storageConfigured: bunnyStorageConfig().configured,
      message: "Media metadata storage is not configured for this workspace session.",
    });
  }

  const kind = request.nextUrl.searchParams.has("kind")
    ? normalizeMediaKind(request.nextUrl.searchParams.get("kind"))
    : null;
  const status = statusFilter(request.nextUrl.searchParams.get("status"));
  const limit = boundedNumber(request.nextUrl.searchParams.get("limit"), 50, 1, 100);

  try {
    const assets = await listMediaAssetsForOwner(auth.user.id, {
      projectId,
      kind,
      status,
      limit,
    });
    return NextResponse.json({
      assets,
      persisted: true,
      storageConfigured: bunnyStorageConfig().configured,
    });
  } catch {
    return jsonError("media_store_error", "Could not read project media assets.", 500);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  if (!(await assertProjectAccess(auth.user.id, projectId))) {
    return jsonError("project_not_found", "Project was not found for this account.", 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await readSmallJson<Record<string, unknown>>(request);
  } catch {
    return jsonError("invalid_request", "Media upload requests must be small JSON metadata.", 400);
  }
  const result = await createMediaUploadForOwner({
    ownerId: auth.user.id,
    body,
    origin: routeOrigin(request),
    projectId,
  });
  return NextResponse.json(result.body, { status: result.status });
}
