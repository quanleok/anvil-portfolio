import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  ownerHasDurableStore,
  insertAgentJob,
  listAgentJobsForOwner,
  projectOwnedBy,
  type AgentJobRecord,
} from "@/server/media/db";
import { boundedNumber, cleanOptionalText, cleanText, jsonError, readSmallJson } from "@/server/media/http";

export const runtime = "nodejs";

type CreateJobBody = {
  projectId?: unknown;
  role?: unknown;
  executionMode?: unknown;
  input?: unknown;
};

function jobRole(value: unknown): AgentJobRecord["role"] {
  const text = cleanText(value, 40);
  if (
    text === "project" ||
    text === "code" ||
    text === "creative" ||
    text === "context" ||
    text === "workflow" ||
    text === "tool"
  ) {
    return text;
  }
  return "media";
}

function executionMode(value: unknown): AgentJobRecord["executionMode"] {
  const text = cleanText(value, 40);
  if (text === "local" || text === "bridge" || text === "hybrid") return text;
  return "cloud";
}

function inputObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fallbackJob(
  draft: Omit<AgentJobRecord, "createdAt" | "updatedAt" | "persisted" | "output" | "progress" | "error">,
): AgentJobRecord {
  const now = new Date().toISOString();
  return {
    ...draft,
    output: null,
    progress: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    persisted: false,
  };
}

export async function GET(request: Request) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  const url = new URL(request.url);
  const role = url.searchParams.has("role") ? jobRole(url.searchParams.get("role")) : null;
  const projectId = cleanOptionalText(url.searchParams.get("projectId"), 160);
  const limit = boundedNumber(url.searchParams.get("limit"), 50, 1, 100);

  if (!ownerHasDurableStore(auth.user.id)) {
    return NextResponse.json({
      jobs: [],
      persisted: false,
      message: "Job storage is not configured for this workspace session.",
    });
  }

  try {
    const jobs = await listAgentJobsForOwner(auth.user.id, { projectId, role, limit });
    return NextResponse.json({ jobs, persisted: true });
  } catch {
    return jsonError("job_store_error", "Could not read jobs.", 500);
  }
}

export async function POST(request: Request) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  let body: CreateJobBody;
  try {
    body = await readSmallJson<CreateJobBody>(request);
  } catch {
    return jsonError("invalid_request", "Job requests must be small JSON metadata.", 400);
  }

  const persisted = ownerHasDurableStore(auth.user.id);
  if (process.env.NODE_ENV === "production" && !persisted) {
    return jsonError(
      "job_store_not_configured",
      "Job storage requires Supabase service-role configuration.",
      503,
    );
  }

  const draft = {
    id: `job_${randomUUID()}`,
    ownerId: persisted ? auth.user.id : null,
    projectId: cleanOptionalText(body.projectId, 160),
    role: jobRole(body.role),
    status: "queued" as const,
    executionMode: executionMode(body.executionMode),
    input: inputObject(body.input),
  };

  try {
    if (persisted && draft.projectId && !(await projectOwnedBy(auth.user.id, draft.projectId))) {
      return jsonError("project_not_found", "Project was not found for this account.", 404);
    }
    const job = (persisted ? await insertAgentJob(draft) : null) || fallbackJob(draft);
    return NextResponse.json(
      {
        job,
        state: "queued",
        message: "Job accepted. A worker can claim this shape for image/video generation.",
      },
      { status: 202 },
    );
  } catch {
    return jsonError("job_store_error", "Could not create the queued job.", 500);
  }
}
