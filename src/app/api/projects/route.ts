import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  createBrowserProjectForOwner,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";
import { invalidateProjectsForOwner, listProjectsForOwner } from "@/server/projects/list";
import { readSmallJson } from "@/server/media/http";

export const runtime = "nodejs";

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 64_000);
}

function storeError(error: unknown) {
  if (error instanceof ProjectStoreUnavailableError) {
    return jsonError("project_store_unavailable", error.message, error.status);
  }
  return jsonError("project_store_error", "Could not complete the project request.", 500);
}

export async function GET(request: Request) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const url = new URL(request.url);
    const result = await listProjectsForOwner(auth.user.id, {
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
    });
    return NextResponse.json({
      projects: result.items.map((project) => ({
        ...project,
        // Compatibility for the existing /app bootstrap while the picker UI
        // moves to title/lastUpdatedAt.
        name: project.title,
        updatedAt: project.lastUpdatedAt,
      })),
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    return storeError(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return jsonError("invalid_request", "Project creation requires small valid JSON.", 400);
    }
    const project = await createBrowserProjectForOwner(auth.user.id, body);
    invalidateProjectsForOwner(auth.user.id);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return storeError(error);
  }
}
