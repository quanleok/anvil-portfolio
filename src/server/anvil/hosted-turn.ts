import { isProviderRateLimitError, providerLimitedPayload } from "@/lib/rate-limit/provider";
import {
  evaluateUsageGate,
  finalizeUsageGate,
  resolveUsageEntitlementForOwner,
  usageGateResponse,
} from "@/lib/usage/server";
import type { AnvilAgentAuthResult } from "@/server/anvil/auth";
import { tokensFromUsage } from "@/server/anvil/pricing";
import { runProtectedAnvilTurnWithUsage } from "@/server/anvil/turn";
import {
  applyBrowserProjectActionsForOwner,
  browserProjectStoreStatus,
  buildBrowserProjectContextFilesForOwner,
  ProjectNotFoundError,
  ProjectStoreUnavailableError,
} from "@/server/projects/store";
import { parseAnvilTurnRequest, type AnvilContextFile, type AnvilTurnRequest } from "@/shared/anvil-api";

type HostedAuth = Extract<AnvilAgentAuthResult, { ok: true }>;

export type HostedAnvilTurnResult = {
  status: number;
  body: Record<string, unknown>;
};

function envFlag(name: string) {
  return String(process.env[name] || "").trim() === "1";
}

export function hostedAnvilAgentEnabled() {
  return envFlag("ANVIL_ENABLE_ANVIL_AGENT") || envFlag("ANVIL_ENABLE_WEB_AGENT_API");
}

function result(body: Record<string, unknown>, status = 200): HostedAnvilTurnResult {
  return { body, status };
}

function hostedOwnerRequired(auth: HostedAuth) {
  return process.env.NODE_ENV === "production" && !auth.ownerId;
}

function ownerRequiredResult() {
  return result(
    {
      ok: false,
      error: "account_required",
      message:
        "Hosted Anvil requires a signed-in account or desktop token tied to an account.",
      actions: [],
    },
    401,
  );
}

function cleanText(value: unknown, max = 4000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function legacyProjectFiles(project: unknown): AnvilContextFile[] {
  if (!project || typeof project !== "object") return [];
  const source = project as Record<string, unknown>;
  const files = Array.isArray(source.files) ? source.files : [];
  return files
    .filter((file): file is Record<string, unknown> => Boolean(file && typeof file === "object"))
    .slice(0, 20)
    .map((file) => ({
      path: cleanText(file.path, 220),
      content: cleanText(file.content, 60_000),
    }))
    .filter((file) => file.path && file.content);
}

function treeSummaryFile(project: unknown): AnvilContextFile | null {
  if (!project || typeof project !== "object") return null;
  const source = project as Record<string, unknown>;
  const tree = Array.isArray(source.tree)
    ? source.tree.map((entry) => cleanText(entry, 240)).filter(Boolean).slice(0, 260)
    : [];
  if (!tree.length) return null;
  return {
    path: "story/project-tree-summary.md",
    title: "Project tree summary",
    kind: "summary",
    content: tree.map((entry) => `- ${entry}`).join("\n"),
  };
}

function latestUserMessage(body: Record<string, unknown>) {
  const direct = cleanText(body.userMessage, 12_000);
  if (direct) return direct;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const source = message as Record<string, unknown>;
    if (source.role !== "user") continue;
    const content = cleanText(source.content, 12_000);
    if (content) return content;
  }
  return "";
}

function dynamicContextFile(body: Record<string, unknown>): AnvilContextFile | null {
  const content = cleanText(body.dynamicContext, 60_000);
  if (!content) return null;
  return {
    path: ".forge/agent-context.md",
    title: "Desktop agent context",
    kind: "desktop-context",
    content,
  };
}

function normalizeTurnBody(body: Record<string, unknown>): AnvilTurnRequest {
  const context =
    body.context && typeof body.context === "object"
      ? (body.context as Record<string, unknown>)
      : {};
  const project =
    body.project && typeof body.project === "object"
      ? (body.project as Record<string, unknown>)
      : {};
  const legacyFiles = legacyProjectFiles(project);
  const treeFile = treeSummaryFile(project);
  const desktopContextFile = dynamicContextFile(body);
  const files = [
    ...(Array.isArray(context.files) ? context.files : []),
    ...legacyFiles,
    ...(treeFile ? [treeFile] : []),
    ...(desktopContextFile ? [desktopContextFile] : []),
  ];

  return parseAnvilTurnRequest({
    installId: body.installId,
    projectId: body.projectId ?? context.projectId,
    projectName: body.projectName ?? context.projectName ?? project.name,
    appVersion:
      body.appVersion ??
      (body.client && typeof body.client === "object"
        ? (body.client as Record<string, unknown>).version
        : undefined),
    userMessage: latestUserMessage(body),
    phase: body.phase ?? context.phase,
    methodId: body.methodId,
    maxActions: body.maxActions,
    context: {
      ...context,
      projectId: context.projectId ?? body.projectId,
      projectName: context.projectName ?? body.projectName ?? project.name,
      projectPath: context.projectPath ?? project.cwd,
      phase: context.phase ?? body.phase,
      files,
    },
  });
}

function shouldApplyCloudActions(body: Record<string, unknown>) {
  return body.applyActions === true || body.applyActions === "true";
}

function mergeContextFiles(parsed: AnvilTurnRequest, cloudFiles: AnvilContextFile[]): AnvilTurnRequest {
  if (!cloudFiles.length) return parsed;
  const filesByPath = new Map<string, AnvilContextFile>();
  for (const file of cloudFiles) filesByPath.set(file.path, file);
  for (const file of parsed.context?.files || []) {
    if (!filesByPath.has(file.path)) filesByPath.set(file.path, file);
  }
  return {
    ...parsed,
    context: {
      ...(parsed.context || {}),
      files: Array.from(filesByPath.values()),
    },
  };
}

function selectedContextPath(parsed: AnvilTurnRequest) {
  const selection = parsed.context?.selection;
  return selection && typeof selection.path === "string" ? selection.path : undefined;
}

function projectErrorPayload(error: unknown): HostedAnvilTurnResult | null {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectStoreUnavailableError) {
    return result(
      {
        error: error.name,
        message: error.message,
      },
      error.status,
    );
  }
  return null;
}

export function hostedAnvilAgentDisabledResult() {
  return result(
    {
      ok: false,
      error: "anvil_agent_disabled",
      message:
        "The hosted Anvil agent is disabled on this deployment. Set ANVIL_ENABLE_ANVIL_AGENT=1.",
    },
    410,
  );
}

function blockedTurnPayload(gate: Awaited<ReturnType<typeof evaluateUsageGate>>) {
  const base = usageGateResponse(gate);
  const free = gate.plan === "free";
  return {
    ...base,
    ok: false,
    agent: "Anvil 1.0",
    reply: free
      ? "Hosted Anvil is temporarily unavailable for this free launch account. Try again shortly."
      : "Hosted Anvil is temporarily unavailable for this plan. Try again shortly.",
    actions: [],
    checkpoint: free ? "Free launch usage is limited to keep the service stable." : null,
    entitlement: {
      plan: gate.plan,
      allowed: false,
    },
  };
}

export async function hostedAnvilAgentStatus(auth: HostedAuth) {
  if (hostedOwnerRequired(auth)) return ownerRequiredResult();

  const { plan, status } = await resolveUsageEntitlementForOwner(auth.ownerId);
  return result({
    ok: true,
    agent: "Anvil 1.0",
    endpoint: "anvil-agent-turn",
    auth: auth.authKind,
    entitlement: {
      plan,
      status,
      allowed: true,
    },
    projectStore: browserProjectStoreStatus(auth.ownerId),
    metering: process.env.ANVIL_USAGE_REQUIRE_LEDGER === "1" ? "required" : "best_effort",
  });
}

export async function runHostedAnvilAgentTurn({
  auth,
  body,
  applyActionsOverride,
  projectOwnerIdOverride,
}: {
  auth: HostedAuth;
  body: Record<string, unknown>;
  applyActionsOverride?: boolean;
  projectOwnerIdOverride?: string;
}): Promise<HostedAnvilTurnResult> {
  if (hostedOwnerRequired(auth)) return ownerRequiredResult();

  const projectOwnerId = projectOwnerIdOverride || auth.ownerId || (auth.authKind === "dev" ? "dev-user" : undefined);
  const applyActions = applyActionsOverride ?? shouldApplyCloudActions(body);

  let parsed: AnvilTurnRequest;
  try {
    parsed = normalizeTurnBody(body);
  } catch (error) {
    return result(
      {
        error: "bad_request",
        message: error instanceof Error ? error.message : "Invalid Anvil turn request.",
      },
      400,
    );
  }

  if (applyActions && !parsed.projectId && !parsed.context?.projectId) {
    return result(
      {
        error: "project_required",
        message: "Cloud Anvil agent writes require projectId and applyActions=true.",
      },
      400,
    );
  }

  const cloudProjectId = parsed.projectId || parsed.context?.projectId;
  if (projectOwnerId && cloudProjectId) {
    try {
      const cloudFiles = await buildBrowserProjectContextFilesForOwner(projectOwnerId, cloudProjectId, {
        selectedPath: selectedContextPath(parsed),
      });
      parsed = mergeContextFiles(parsed, cloudFiles);
    } catch (error) {
      const projectError = projectErrorPayload(error);
      if (projectError) return projectError;
      return result(
        {
          error: "project_context_error",
          message: "Could not load this Anvil Cloud project context.",
        },
        500,
      );
    }
  }

  const { plan, status } = await resolveUsageEntitlementForOwner(auth.ownerId);
  const gate = await evaluateUsageGate({
    ownerId: auth.ownerId,
    installId: parsed.installId,
    projectId: parsed.projectId || parsed.context?.projectId,
    plan,
    entitlementStatus: status,
    method: "anvil_agent",
    phase: typeof parsed.phase === "string" ? parsed.phase : null,
    metadata: {
      authKind: auth.authKind,
      appVersion: parsed.appVersion || null,
      methodId: parsed.methodId || null,
    },
  });

  if (gate.state !== "allowed") {
    return result(blockedTurnPayload(gate), gate.state === "queued" ? 202 : 402);
  }

  try {
    const run = await runProtectedAnvilTurnWithUsage(parsed);
    let cloudWrite:
      | {
          appliedCount: number;
          appliedPaths: string[];
          skipped: Array<{ path: string; reason: string }>;
          updatedAt: string;
          fileCount: number;
        }
      | null = null;

    if (applyActions && projectOwnerId && cloudProjectId && run.response.actions.length > 0) {
      const writeResult = await applyBrowserProjectActionsForOwner(projectOwnerId, cloudProjectId, run.response.actions);
      cloudWrite = {
        appliedCount: writeResult.applied.length,
        appliedPaths: writeResult.applied
          .map((action) => action.path)
          .filter((filePath): filePath is string => typeof filePath === "string" && Boolean(filePath))
          .slice(0, 20),
        skipped: writeResult.skipped,
        updatedAt: writeResult.project.updatedAt,
        fileCount: writeResult.project.fileCount,
      };
    }

    await finalizeUsageGate({
      gate,
      status: "succeeded",
      provider: run.provider,
      model: run.model,
      providerUsage: run.providerUsage,
      metadata: {
        methodVersion: run.response.methodVersion || null,
      },
    });

    const tokens = tokensFromUsage(run.providerUsage, run.model || "", run.provider || "");

    return result({
      ...run.response,
      ok: true,
      state: "allowed",
      entitlement: {
        plan: gate.plan,
        allowed: true,
      },
      usage: usageGateResponse(gate).usage,
      ...(cloudWrite ? { cloudWrite } : {}),
      ...(tokens ? { tokens } : {}),
    });
  } catch (error) {
    const rateLimited = isProviderRateLimitError(error);
    if (!rateLimited) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : null;
      console.error("[anvil-agent/turn] hosted turn failed", {
        message,
        stack,
        projectId: parsed.projectId || parsed.context?.projectId || null,
        phase: parsed.phase || null,
        installId: parsed.installId || null,
      });
    }
    await finalizeUsageGate({
      gate,
      status: rateLimited ? "limited" : "failed",
      providerStatus: rateLimited ? error.providerStatus : null,
      provider: rateLimited ? error.provider : null,
      model: rateLimited ? error.model : null,
      errorCode: rateLimited ? "provider_rate_limited" : "provider_error",
    });

    if (rateLimited) {
      return result(
        {
          ...providerLimitedPayload(error),
          ok: false,
          agent: "Anvil 1.0",
          actions: [],
          entitlement: {
            plan: gate.plan,
            allowed: true,
          },
          usage: usageGateResponse(gate).usage,
        },
        429,
      );
    }

    return result(
      {
        ok: false,
        state: "limited",
        error: "provider_error",
        message: "Anvil could not complete the hosted turn. Try again shortly.",
        actions: [],
        entitlement: {
          plan: gate.plan,
          allowed: true,
        },
        usage: usageGateResponse(gate).usage,
      },
      502,
    );
  }
}
