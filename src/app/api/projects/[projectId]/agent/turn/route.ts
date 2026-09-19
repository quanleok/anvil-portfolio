import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  AgentThreadStoreUnavailableError,
  createAgentRunForThread,
  ensureAgentThreadForProject,
  finishAgentRunForThread,
  insertAgentMessageForThread,
  listAgentMessagesForThread,
} from "@/server/agent/threads";
import {
  type BrowserProjectTimeline,
  getBrowserProjectForOwner,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";
import { listMediaAssetsForOwner } from "@/server/media/db";
import { readSmallJson } from "@/server/media/http";
import {
  hostedAnvilAgentDisabledResult,
  hostedAnvilAgentEnabled,
  runHostedAnvilAgentTurn,
} from "@/server/anvil/hosted-turn";
import {
  agentRateLimitPayload,
  checkAgentIpRateLimit,
  checkAgentOwnerRateLimit,
} from "@/lib/usage/rate-limit";
import { createRequestLogger } from "@/lib/usage/logging";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

function cleanText(value: unknown, max = 4000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function readJson(request: NextRequest) {
  return readSmallJson<Record<string, unknown>>(request, 320_000);
}

function routeError(error: unknown) {
  if (
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectStoreUnavailableError ||
    error instanceof AgentThreadStoreUnavailableError
  ) {
    return jsonError(error.name, error.message, error.status);
  }
  return jsonError("agent_turn_error", "Could not complete the Anvil Agent turn.", 500);
}

function badJsonResponse(error: unknown) {
  const tooLarge = error instanceof Error && error.message === "json_body_too_large";
  return NextResponse.json(
    {
      error: tooLarge ? "request_too_large" : "bad_request",
      message: tooLarge ? "Project agent turns must be 320KB or smaller." : "Project agent turns require valid JSON.",
    },
    { status: tooLarge ? 413 : 400 },
  );
}

function visibleReply(data: Record<string, unknown>) {
  return cleanText(data.reply, 1800) || cleanText(data.message, 1800) || "Anvil Agent did not return a visible reply.";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function statusFromAgentResult(statusCode: number, ok: boolean, data: Record<string, unknown>) {
  if (statusCode === 202 || data.state === "queued") return "queued" as const;
  if (ok) return "succeeded" as const;
  if (statusCode === 402 || statusCode === 410 || statusCode === 429) return "limited" as const;
  if (data.state === "limited") return "limited" as const;
  return "failed" as const;
}

function pathsFromActions(actions: unknown[], limit = 6) {
  return actions
    .map((action) => {
      if (!action || typeof action !== "object") return "";
      const path = (action as Record<string, unknown>).path;
      return typeof path === "string" ? path : "";
    })
    .filter(Boolean)
    .slice(0, limit);
}

function pathsFromCloudWrite(cloudWrite: Record<string, unknown>, actions: unknown[]) {
  const paths = Array.isArray(cloudWrite.appliedPaths)
    ? cloudWrite.appliedPaths.filter((path): path is string => typeof path === "string" && Boolean(path)).slice(0, 6)
    : [];
  return paths.length ? paths : pathsFromActions(actions);
}

function skippedFromCloudWrite(cloudWrite: Record<string, unknown>) {
  return Array.isArray(cloudWrite.skipped)
    ? cloudWrite.skipped
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const source = item as Record<string, unknown>;
          const path = typeof source.path === "string" ? source.path : "";
          const reason = typeof source.reason === "string" ? source.reason : "";
          return path || reason ? { path, reason } : null;
        })
        .filter((item): item is { path: string; reason: string } => Boolean(item))
        .slice(0, 4)
    : [];
}

function recoveredPackageWrite(actions: unknown[], appliedCount: number) {
  if (appliedCount <= actions.length) return false;
  return actions.some((action) => {
    if (!action || typeof action !== "object") return false;
    const path = (action as Record<string, unknown>).path;
    return typeof path === "string" && path.startsWith("custom/");
  });
}

function writeStatusContent(
  appliedCount: number,
  paths: string[],
  skipped: Array<{ path: string; reason: string }>,
  recoveredPackage: boolean,
) {
  const lines: string[] = [];
  if (recoveredPackage) {
    lines.push("Recovered an all-in-one draft package into separate Anvil files.");
  }
  if (appliedCount > 0) {
    const noun = appliedCount === 1 ? "file" : "files";
    const visiblePaths = paths.length ? `: ${paths.join(", ")}` : ".";
    lines.push(`Wrote ${appliedCount} ${noun}${visiblePaths}`);
  }
  if (skipped.length > 0) {
    const noun = skipped.length === 1 ? "file action" : "file actions";
    const visibleSkipped = skipped
      .map((item) => `${item.path || "unknown path"}${item.reason ? ` (${item.reason})` : ""}`)
      .join("; ");
    lines.push(`Skipped ${skipped.length} ${noun}: ${visibleSkipped}`);
  }
  return lines.join("\n");
}

function compactReplyForTranscript(reply: string, appliedCount: number) {
  if (appliedCount <= 0) return cleanText(reply, 900);
  const firstBlock = reply.split(/\n{2,}/)[0]?.replace(/\s+/g, " ").trim();
  return firstBlock && firstBlock.length <= 260 ? firstBlock : "Done. I wrote the project files.";
}

function safeClientContext(value: unknown) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...(source.selection && typeof source.selection === "object"
      ? { selection: source.selection as Record<string, unknown> }
      : {}),
    ...(source.userPreferences && typeof source.userPreferences === "object"
      ? { userPreferences: source.userPreferences as Record<string, unknown> }
      : {}),
  };
}

function mediaMetadataText(value: unknown, max = 320) {
  return typeof value === "string" ? cleanText(value, max) || null : null;
}

async function projectMediaSummary(ownerId: string, projectId: string) {
  try {
    const assets = await listMediaAssetsForOwner(ownerId, { projectId, limit: 40 });
    const counts = assets.reduce<Record<string, number>>((accumulator, asset) => {
      accumulator[asset.kind] = (accumulator[asset.kind] || 0) + 1;
      accumulator[asset.status] = (accumulator[asset.status] || 0) + 1;
      return accumulator;
    }, {});
    return {
      counts,
      assets: assets.slice(0, 24).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        status: asset.status,
        fileName: asset.fileName,
        title: mediaMetadataText(asset.metadata?.title, 160),
        contentType: asset.contentType,
        category: typeof asset.metadata?.category === "string" ? asset.metadata.category : null,
        notes: mediaMetadataText(asset.metadata?.notes, 420),
        source: asset.source,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
      })),
    };
  } catch {
    return null;
  }
}

function projectTimelineSummary(timeline: BrowserProjectTimeline | undefined) {
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : [];
  return {
    clipCount: clips.length,
    durationSec: clips.reduce((max, clip) => Math.max(max, clip.startSec + clip.durationSec), 0),
    tracks: {
      V1: clips.filter((clip) => clip.track === "V1").length,
      A1: clips.filter((clip) => clip.track === "A1").length,
    },
    clips: clips.slice(0, 32).map((clip) => ({
      id: clip.id,
      mediaAssetId: clip.mediaAssetId,
      track: clip.track,
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      title: clip.title,
      fileName: clip.fileName,
      kind: clip.kind,
    })),
    updatedAt: timeline?.updatedAt || null,
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestLog = createRequestLogger(request, "/api/projects/:projectId/agent/turn");

  const ipRate = checkAgentIpRateLimit(request, "/api/projects/:projectId/agent/turn");
  if (!ipRate.allowed) {
    requestLog.complete(429, { outcome: "ip_rate_limited" });
    return NextResponse.json(agentRateLimitPayload(ipRate), { status: 429 });
  }

  const auth = await getWorkspaceUser(request);
  if (!auth.ok) {
    requestLog.complete(auth.status, { outcome: "auth_failed", authError: auth.error });
    return workspaceAuthErrorResponse(auth);
  }

  const ownerRate = checkAgentOwnerRateLimit(auth.user.id, "/api/projects/:projectId/agent/turn");
  if (!ownerRate.allowed) {
    requestLog.complete(429, { outcome: "owner_rate_limited", ownerId: auth.user.id });
    return NextResponse.json(agentRateLimitPayload(ownerRate), { status: 429 });
  }

  if (!hostedAnvilAgentEnabled()) {
    const disabled = hostedAnvilAgentDisabledResult();
    requestLog.complete(disabled.status, { outcome: "agent_disabled", ownerId: auth.user.id });
    return NextResponse.json(disabled.body, { status: disabled.status });
  }

  const { projectId } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch (error) {
    requestLog.complete(error instanceof Error && error.message === "json_body_too_large" ? 413 : 400, {
      outcome: "bad_json",
      ownerId: auth.user.id,
    });
    return badJsonResponse(error);
  }
  const userMessage = cleanText(body.userMessage, 12_000);
  if (!userMessage) {
    requestLog.complete(400, { outcome: "missing_user_message", ownerId: auth.user.id });
    return jsonError("bad_request", "userMessage is required.", 400);
  }
  const phase = cleanText(body.phase, 80) || null;
  const clientContext = safeClientContext(body.context);

  try {
    const project = await getBrowserProjectForOwner(auth.user.id, projectId);
    const mediaSummary = await projectMediaSummary(auth.user.id, projectId);
    const timelineSummary = projectTimelineSummary(project.project.timeline);
    const thread = await ensureAgentThreadForProject(auth.user.id, projectId, {
      threadId: body.threadId,
      title: project.name,
    });

    const user = await insertAgentMessageForThread(auth.user.id, projectId, thread.id, {
      role: "user",
      content: userMessage,
      metadata: {
        phase,
        selectedPath: clientContext.selection || null,
      },
    });

    const run = await createAgentRunForThread(auth.user.id, projectId, thread.id, {
      request: {
        phase,
        methodId: null,
        selectedPath: clientContext.selection || null,
      },
    });

    const agentResult = await runHostedAnvilAgentTurn({
      auth: {
        ok: true,
        authKind: auth.user.id === "dev-user" ? "dev" : "cookie",
        ownerId: isUuid(auth.user.id) ? auth.user.id : undefined,
        email: auth.user.email || undefined,
      },
      projectOwnerIdOverride: auth.user.id,
      applyActionsOverride: true,
      body: {
        installId: cleanText(body.installId, 120) || undefined,
        appVersion: cleanText(body.appVersion, 80) || undefined,
        projectId,
        projectName: project.name,
        userMessage,
        phase: phase || undefined,
        threadId: thread.id,
        applyActions: true,
        context: {
          ...clientContext,
          ...(mediaSummary ? { mediaSummary } : {}),
          timelineSummary,
        },
      },
    });
    const data = agentResult.body;
    const agentOk =
      agentResult.status >= 200 &&
      agentResult.status < 300 &&
      agentResult.status !== 202 &&
      data.ok !== false &&
      !data.error;
    const responseStatus = agentOk || agentResult.status === 202
      ? agentResult.status
      : agentResult.status >= 400
        ? agentResult.status
        : 429;
    const status = statusFromAgentResult(agentResult.status, agentOk, data);
    const actions = Array.isArray(data.actions) ? data.actions : [];
    const cloudWrite = data.cloudWrite && typeof data.cloudWrite === "object"
      ? (data.cloudWrite as Record<string, unknown>)
      : {};
    const appliedActionCount = Number(cloudWrite.appliedCount || 0);
    const appliedPaths = pathsFromCloudWrite(cloudWrite, actions);
    const skippedActions = skippedFromCloudWrite(cloudWrite);
    const recoveredPackage = recoveredPackageWrite(actions, appliedActionCount);
    const reply = compactReplyForTranscript(visibleReply(data), appliedActionCount);

    const assistant = await insertAgentMessageForThread(auth.user.id, projectId, thread.id, {
      role: agentOk ? "assistant" : "system",
      content: reply,
      metadata: {
        status,
        runId: run.id,
        checkpoint: data.checkpoint || null,
        warnings: data.warnings || null,
      },
    });

    const writeStatusMessage =
      appliedActionCount > 0 || skippedActions.length > 0
        ? await insertAgentMessageForThread(auth.user.id, projectId, thread.id, {
            role: "system",
            content: writeStatusContent(appliedActionCount, appliedPaths, skippedActions, recoveredPackage),
            metadata: {
              kind: "file_write_status",
              runId: run.id,
              paths: appliedPaths,
              appliedActionCount,
              skipped: skippedActions,
              recoveredPackage,
            },
          })
        : null;

    const finishedRun = await finishAgentRunForThread(auth.user.id, projectId, run.id, {
      status,
      provider:
        data.meta && typeof data.meta === "object"
          ? (data.meta as Record<string, unknown>).provider
          : null,
      model:
        data.meta && typeof data.meta === "object"
          ? (data.meta as Record<string, unknown>).model
          : null,
      response: data,
      actionCount: actions.length,
      appliedActionCount,
      error: agentOk ? null : { status: agentResult.status, message: reply },
    });

    const messages = await listAgentMessagesForThread(auth.user.id, projectId, thread.id, 120);
    requestLog.complete(responseStatus, {
      outcome: agentOk ? "agent_turn" : "agent_error",
      ownerId: auth.user.id,
      projectId,
      state: typeof data.state === "string" ? data.state : null,
      appliedActionCount,
    });
    return NextResponse.json(
      {
        ...data,
        ok: agentOk,
        reply,
        thread,
        messages,
        persisted: {
          userMessage: user,
          assistantMessage: assistant,
          writeStatusMessage,
          run: finishedRun,
        },
        writeStatus: {
          persisted: Boolean(writeStatusMessage),
          appliedCount: appliedActionCount,
          paths: appliedPaths,
          skipped: skippedActions,
          recoveredPackage,
        },
      },
      { status: responseStatus },
    );
  } catch (error) {
    requestLog.error("project_agent_turn_failed", error, { ownerId: auth.user.id });
    requestLog.complete(500, { outcome: "route_error", ownerId: auth.user.id });
    return routeError(error);
  }
}
