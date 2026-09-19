import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  createBrowserProjectAssetForOwner,
  listBrowserProjectAssetsForOwner,
  ProjectAssetNotFoundError,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";
import { readSmallJson } from "@/server/media/http";

// Phase D, slice D2: Asset Cards CRUD. List + create.
// Per-asset PATCH/DELETE live in `./[assetId]/route.ts`.

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
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

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId } = await context.params;
    const section = request.nextUrl.searchParams.get("section");
    const assets = await listBrowserProjectAssetsForOwner(auth.user.id, projectId, { section });
    return NextResponse.json({ assets });
  } catch (error) {
    return storeError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId } = await context.params;
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return jsonError("invalid_request", "Asset creation requires small valid JSON.", 400);
    }
    const asset = await createBrowserProjectAssetForOwner(auth.user.id, projectId, body);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return storeError(error);
  }
}
