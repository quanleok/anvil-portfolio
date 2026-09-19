import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  applyBrowserProjectActionsForOwner,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";
import { readSmallJson } from "@/server/media/http";
import { validateAnvilFileAction, type AnvilFileAction } from "@/shared/anvil-api";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 2 * 1024 * 1024);
}

function parseActions(value: unknown): AnvilFileAction[] {
  const actions = Array.isArray(value) ? value : [];
  return actions
    .map(validateAnvilFileAction)
    .filter((action): action is AnvilFileAction => Boolean(action))
    .slice(0, 50);
}

function storeError(error: unknown) {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectStoreUnavailableError) {
    return jsonError(error.name, error.message, error.status);
  }
  return jsonError("project_actions_error", "Could not apply project actions.", 500);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return jsonError("invalid_request", "Project actions require small valid JSON.", 400);
  }
  const actions = parseActions(body.actions);
  if (!actions.length) {
    return jsonError("no_actions", "No valid file actions were provided.", 400);
  }

  try {
    const result = await applyBrowserProjectActionsForOwner(auth.user.id, projectId, actions);
    return NextResponse.json(result);
  } catch (error) {
    return storeError(error);
  }
}
