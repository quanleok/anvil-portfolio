import { NextResponse } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import { ownerHasDurableStore, getAgentJobForOwner } from "@/server/media/db";
import { jsonError } from "@/server/media/http";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  if (!ownerHasDurableStore(auth.user.id)) {
    return NextResponse.json({
      job: null,
      persisted: false,
      message: "Job storage is not configured for this workspace session.",
    });
  }

  const { jobId } = await context.params;
  try {
    const job = await getAgentJobForOwner(auth.user.id, jobId);
    if (!job) return jsonError("job_not_found", "Job was not found.", 404);
    return NextResponse.json({ job, persisted: true });
  } catch {
    return jsonError("job_store_error", "Could not read the job.", 500);
  }
}
