import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import { readSmallJson } from "@/server/media/http";
import {
  deleteBrowserProjectFileForOwner,
  getBrowserProjectForOwner,
  ProjectFileConflictError,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
  putBrowserProjectFileForOwner,
  sanitizeBrowserProjectFilePath,
} from "@/server/projects/store";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string; filePath: string[] }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 320_000);
}

function storeError(error: unknown) {
  if (error instanceof ProjectFileConflictError) {
    return NextResponse.json(
      {
        error: error.name,
        message: error.message,
        file: error.file,
      },
      { status: error.status },
    );
  }
  if (error instanceof ProjectNotFoundError || error instanceof ProjectStoreUnavailableError) {
    return jsonError(error.name, error.message, error.status);
  }
  if (error instanceof Error) {
    return jsonError("invalid_project_file", error.message, 400);
  }
  return jsonError("project_file_error", "Could not complete the file request.", 500);
}

async function routePath(context: RouteContext) {
  const { projectId, filePath } = await context.params;
  return {
    projectId,
    filePath: sanitizeBrowserProjectFilePath((filePath || []).join("/")),
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId, filePath } = await routePath(context);
    const project = await getBrowserProjectForOwner(auth.user.id, projectId);
    const file = project.project.files[filePath];
    if (!file) return jsonError("file_not_found", "Project file was not found.", 404);
    return NextResponse.json({ file });
  } catch (error) {
    return storeError(error);
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId, filePath } = await routePath(context);
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return jsonError("invalid_request", "Project file saves require valid JSON.", 400);
    }
    const file = await putBrowserProjectFileForOwner(auth.user.id, projectId, filePath, body.content, {
      expectedUpdatedAt: body.expectedUpdatedAt,
      force: body.force,
      contextGroup: body.contextGroup,
    });
    return NextResponse.json({ file });
  } catch (error) {
    return storeError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  try {
    const { projectId, filePath } = await routePath(context);
    const deleted = await deleteBrowserProjectFileForOwner(auth.user.id, projectId, filePath);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return storeError(error);
  }
}
