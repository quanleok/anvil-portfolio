import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  listBrowserProjectFileRevisionsForOwner,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

function storeError(error: unknown) {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectStoreUnavailableError) {
    return jsonError(error.name, error.message, error.status);
  }
  if (error instanceof Error) {
    return jsonError("invalid_project_file_revision", error.message, 400);
  }
  return jsonError("project_file_revision_error", "Could not read file revisions.", 500);
}

function boundedLimit(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  const filePath = request.nextUrl.searchParams.get("path") || "";
  const limit = boundedLimit(request.nextUrl.searchParams.get("limit"), 30, 1, 100);

  try {
    const revisions = await listBrowserProjectFileRevisionsForOwner(auth.user.id, projectId, filePath, limit);
    return NextResponse.json({ revisions });
  } catch (error) {
    return storeError(error);
  }
}
