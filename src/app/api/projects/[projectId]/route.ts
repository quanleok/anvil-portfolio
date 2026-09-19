import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  deleteBrowserProjectForOwner,
  getBrowserProjectForOwner,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
  updateBrowserProjectForOwner,
} from "@/server/projects/store";
import { invalidateProjectsForOwner } from "@/server/projects/list";
import { readSmallJson } from "@/server/media/http";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 64_000);
}

function storeError(error: unknown) {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectStoreUnavailableError) {
    return jsonError(error.name, error.message, error.status);
  }
  return jsonError("project_store_error", "Could not complete the project request.", 500);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  try {
    const project = await getBrowserProjectForOwner(auth.user.id, projectId);
    return NextResponse.json({ project });
  } catch (error) {
    return storeError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return jsonError("invalid_request", "Project updates require small valid JSON.", 400);
    }
    const project = await updateBrowserProjectForOwner(auth.user.id, projectId, body);
    invalidateProjectsForOwner(auth.user.id);
    return NextResponse.json({ project });
  } catch (error) {
    return storeError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  try {
    await deleteBrowserProjectForOwner(auth.user.id, projectId);
    invalidateProjectsForOwner(auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storeError(error);
  }
}
