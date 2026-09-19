import { NextResponse } from "next/server";
import {
  bunnyStorageConfig,
  normalizeMediaKind,
} from "@/lib/storage/bunny";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  listMediaAssetsForOwner,
  requestCanBeServed,
  type MediaAssetStatus,
} from "@/server/media/db";
import { createMediaUploadForOwner, type CreateMediaBody } from "@/server/media/create";
import { boundedNumber, cleanOptionalText, cleanText, jsonError, readSmallJson, routeOrigin } from "@/server/media/http";

export const runtime = "nodejs";

function statusFilter(value: unknown): MediaAssetStatus | null {
  const text = cleanText(value, 40);
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

export async function GET(request: Request) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const url = new URL(request.url);
  const kind = url.searchParams.has("kind") ? normalizeMediaKind(url.searchParams.get("kind")) : null;
  const status = statusFilter(url.searchParams.get("status"));
  const projectId = cleanOptionalText(url.searchParams.get("projectId"), 160);
  const limit = boundedNumber(url.searchParams.get("limit"), 50, 1, 100);

  if (!requestCanBeServed(auth.user.id)) {
    return NextResponse.json({
      assets: [],
      persisted: false,
      storageConfigured: bunnyStorageConfig().configured,
      message: "Media metadata storage is not configured for this workspace session.",
    });
  }

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
    return jsonError("media_store_error", "Could not read media assets.", 500);
  }
}

export async function POST(request: Request) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  let body: CreateMediaBody;
  try {
    body = await readSmallJson<CreateMediaBody>(request);
  } catch {
    return jsonError("invalid_request", "Media upload requests must be small JSON metadata.", 400);
  }

  const result = await createMediaUploadForOwner({
    ownerId: auth.user.id,
    body,
    origin: routeOrigin(request),
  });
  return NextResponse.json(result.body, { status: result.status });
}
