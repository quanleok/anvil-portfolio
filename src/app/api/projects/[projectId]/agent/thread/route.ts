import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import { boundedNumber } from "@/server/media/http";
import {
  AgentThreadStoreUnavailableError,
  ensureAgentThreadForProject,
  listAgentMessagesForThread,
} from "@/server/agent/threads";
import {
  getBrowserProjectForOwner,
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

function routeError(error: unknown) {
  if (
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectStoreUnavailableError ||
    error instanceof AgentThreadStoreUnavailableError
  ) {
    return jsonError(error.name, error.message, error.status);
  }
  return jsonError("agent_thread_error", "Could not load the Anvil Agent thread.", 500);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const { projectId } = await context.params;
  const threadId = request.nextUrl.searchParams.get("threadId") || undefined;
  const limit = boundedNumber(request.nextUrl.searchParams.get("limit"), 80, 1, 200);

  try {
    await getBrowserProjectForOwner(auth.user.id, projectId);
    const thread = await ensureAgentThreadForProject(auth.user.id, projectId, { threadId });
    const messages = await listAgentMessagesForThread(auth.user.id, projectId, thread.id, limit);
    return NextResponse.json({ thread, messages });
  } catch (error) {
    return routeError(error);
  }
}
