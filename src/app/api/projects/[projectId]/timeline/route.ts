import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  getBrowserProjectTimelineForOwner,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
  putBrowserProjectTimelineForOwner,
} from "@/server/projects/store";
import { readSmallJson } from "@/server/media/http";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 512_000);
}

function storeError(error: unknown) {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectStoreUnavailableError) {
    return jsonError(error.name, error.message, error.status);
  }
  return jsonError("project_timeline_error", "Could not read or update the project timeline.", 500);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  try {
    const timeline = await getBrowserProjectTimelineForOwner(auth.user.id, projectId);
    return NextResponse.json({ timeline });
  } catch (error) {
    return storeError(error);
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return jsonError("invalid_request", "Timeline updates require small valid JSON.", 400);
  }
  try {
    const timeline = await putBrowserProjectTimelineForOwner(auth.user.id, projectId, body.timeline || body);
    return NextResponse.json({ timeline });
  } catch (error) {
    return storeError(error);
  }
}
