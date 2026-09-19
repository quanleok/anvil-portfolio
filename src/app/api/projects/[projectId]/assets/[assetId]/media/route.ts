import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  attachMediaToProjectAssetForOwner,
  ProjectAssetMediaError,
  ProjectAssetNotFoundError,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";
import { readSmallJson } from "@/server/media/http";

// Phase D, slice D3: attach an existing media row to an asset card.
// Per-media detach lives in `./[mediaId]/route.ts`.

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string; assetId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 32_000);
}

function storeError(error: unknown) {
  if (
    error instanceof ProjectAssetMediaError ||
    error instanceof ProjectAssetNotFoundError ||
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectStoreUnavailableError
  ) {
    return jsonError(error.name, error.message, error.status);
  }
  if (error instanceof Error) {
    return jsonError("invalid_project_asset_media", error.message, 400);
  }
  return jsonError("project_asset_media_error", "Could not attach media to asset.", 500);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId, assetId } = await context.params;
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return jsonError("invalid_request", "Media attach requires small valid JSON.", 400);
    }
    const media = await attachMediaToProjectAssetForOwner(
      auth.user.id,
      projectId,
      assetId,
      body.mediaId,
    );
    return NextResponse.json({ media });
  } catch (error) {
    return storeError(error);
  }
}
