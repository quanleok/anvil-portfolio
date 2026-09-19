import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  detachMediaFromProjectAssetForOwner,
  ProjectAssetMediaError,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";

// Phase D, slice D3: detach a media row from an asset card. The card
// stays; the media row's asset_id is cleared so it returns to the
// bin.

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string; assetId: string; mediaId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function storeError(error: unknown) {
  if (
    error instanceof ProjectAssetMediaError ||
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectStoreUnavailableError
  ) {
    return jsonError(error.name, error.message, error.status);
  }
  if (error instanceof Error) {
    return jsonError("invalid_project_asset_media", error.message, 400);
  }
  return jsonError("project_asset_media_error", "Could not detach media from asset.", 500);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId, assetId, mediaId } = await context.params;
    const media = await detachMediaFromProjectAssetForOwner(auth.user.id, projectId, mediaId, assetId);
    return NextResponse.json({ media });
  } catch (error) {
    return storeError(error);
  }
}
