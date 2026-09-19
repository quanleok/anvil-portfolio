import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  deleteBrowserProjectAssetForOwner,
  ProjectAssetNotFoundError,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
  updateBrowserProjectAssetForOwner,
} from "@/server/projects/store";
import { readSmallJson } from "@/server/media/http";

// Phase D, slice D2: Asset Cards CRUD. Per-asset PATCH + DELETE.

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string; assetId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 128_000);
}

function storeError(error: unknown) {
  if (error instanceof ProjectAssetNotFoundError || error instanceof ProjectNotFoundError) {
    return jsonError(error.name, error.message, error.status);
  }
  if (error instanceof ProjectStoreUnavailableError) {
    return jsonError(error.name, error.message, error.status);
  }
  if (error instanceof Error) {
    return jsonError("invalid_project_asset", error.message, 400);
  }
  return jsonError("project_asset_error", "Could not complete the asset request.", 500);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId, assetId } = await context.params;
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return jsonError("invalid_request", "Asset updates require small valid JSON.", 400);
    }
    const asset = await updateBrowserProjectAssetForOwner(auth.user.id, projectId, assetId, body);
    return NextResponse.json({ asset });
  } catch (error) {
    return storeError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId, assetId } = await context.params;
    const deleted = await deleteBrowserProjectAssetForOwner(auth.user.id, projectId, assetId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return storeError(error);
  }
}
