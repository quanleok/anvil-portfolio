import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient, hasSupabaseAdminConfig } from "@/lib/supabase/admin";

export type AgentThreadRecord = {
  id: string;
  ownerId: string | null;
  projectId: string;
  title: string;
  status: "active" | "archived" | "deleted";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  persisted: boolean;
};

export type AgentMessageRecord = {
  id: string;
  ownerId: string | null;
  projectId: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  persisted: boolean;
};

export type AgentRunRecord = {
  id: string;
  ownerId: string | null;
  projectId: string;
  threadId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "limited" | "cancelled";
  provider: string | null;
  model: string | null;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  actionCount: number;
  appliedActionCount: number;
  error: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  persisted: boolean;
};

type ThreadRow = {
  id: string;
  owner_id: string | null;
  project_id: string;
  title: string;
  status: AgentThreadRecord["status"];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  owner_id: string | null;
  project_id: string;
  thread_id: string;
  role: AgentMessageRecord["role"];
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type RunRow = {
  id: string;
  owner_id: string | null;
  project_id: string;
  thread_id: string;
  status: AgentRunRecord["status"];
  provider: string | null;
  model: string | null;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  action_count: number;
  applied_action_count: number;
  error: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type AgentDatabase = {
  public: {
    Tables: {
      anvil_agent_threads: {
        Row: ThreadRow;
        Insert: Omit<ThreadRow, "created_at" | "updated_at">;
        Update: Partial<Omit<ThreadRow, "id" | "owner_id" | "project_id" | "created_at">>;
        Relationships: [];
      };
      anvil_agent_messages: {
        Row: MessageRow;
        Insert: Omit<MessageRow, "created_at">;
        Update: never;
        Relationships: [];
      };
      anvil_agent_runs: {
        Row: RunRow;
        Insert: Omit<RunRow, "created_at" | "updated_at" | "completed_at" | "response" | "error">;
        Update: Partial<Omit<RunRow, "id" | "owner_id" | "project_id" | "thread_id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type MemoryBundle = {
  threads: AgentThreadRecord[];
  messages: AgentMessageRecord[];
  runs: AgentRunRecord[];
};

const memoryStore = new Map<string, MemoryBundle>();
const MAX_MEMORY_AGENT_PROJECT_BUNDLES = 100;
const MAX_MEMORY_THREADS_PER_PROJECT = 20;
const MAX_MEMORY_MESSAGES_PER_PROJECT = 300;
const MAX_MEMORY_RUNS_PER_PROJECT = 100;

export class AgentThreadStoreUnavailableError extends Error {
  status = 503;

  constructor(message = "Agent thread storage requires Supabase service-role configuration.") {
    super(message);
    this.name = "AgentThreadStoreUnavailableError";
  }
}

function cleanText(value: unknown, max = 4000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function cleanContent(value: unknown, max = 120_000) {
  return typeof value === "string" ? value.replace(/\0/g, "").slice(0, max) : "";
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function ownerHasDurableStore(ownerId: string) {
  return hasSupabaseAdminConfig() && isUuid(ownerId);
}

function boundedLimit(value: unknown, fallback: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function assertStore(ownerId: string) {
  if (ownerHasDurableStore(ownerId)) return;
  if (process.env.NODE_ENV !== "production") return;
  throw new AgentThreadStoreUnavailableError();
}

function memoryKey(ownerId: string, projectId: string) {
  return `${ownerId}:${projectId}`;
}

function memoryBundle(ownerId: string, projectId: string) {
  const key = memoryKey(ownerId, projectId);
  let bundle = memoryStore.get(key);
  if (!bundle) {
    bundle = { threads: [], messages: [], runs: [] };
    memoryStore.set(key, bundle);
    trimMemoryStore(key);
  }
  return bundle;
}

function bundleLastActivity(bundle: MemoryBundle) {
  let lastActivity = 0;
  const remember = (createdAt: string) => {
    const time = Date.parse(createdAt);
    if (Number.isFinite(time)) lastActivity = Math.max(lastActivity, time);
  };
  for (const thread of bundle.threads) remember(thread.updatedAt || thread.createdAt);
  for (const message of bundle.messages) remember(message.createdAt);
  for (const run of bundle.runs) remember(run.updatedAt || run.createdAt);
  return lastActivity;
}

function trimMemoryStore(protectedKey?: string) {
  while (memoryStore.size > MAX_MEMORY_AGENT_PROJECT_BUNDLES) {
    let oldestKey: string | null = null;
    let oldestActivity = Number.POSITIVE_INFINITY;
    for (const [key, bundle] of memoryStore) {
      if (key === protectedKey) continue;
      const activity = bundleLastActivity(bundle);
      if (activity < oldestActivity) {
        oldestActivity = activity;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    memoryStore.delete(oldestKey);
  }
}

function trimOldestByCreatedAt<T extends { createdAt: string }>(items: T[], max: number) {
  if (items.length <= max) return;
  items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  items.splice(0, items.length - max);
}

function trimMemoryBundle(bundle: MemoryBundle) {
  trimOldestByCreatedAt(bundle.threads, MAX_MEMORY_THREADS_PER_PROJECT);
  trimOldestByCreatedAt(bundle.messages, MAX_MEMORY_MESSAGES_PER_PROJECT);
  trimOldestByCreatedAt(bundle.runs, MAX_MEMORY_RUNS_PER_PROJECT);
}

function adminClient() {
  return createSupabaseAdminClient<AgentDatabase>();
}

function isMissingAgentThreadFeature(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /could not find the table ["']?(public[.])?anvil_agent_(threads|messages|runs)["']? in the schema cache/i.test(message) ||
    /relation ["']?(public[.])?anvil_agent_(threads|messages|runs)["']? does not exist/i.test(message)
  );
}

function missingAgentThreadStoreError() {
  return new AgentThreadStoreUnavailableError("Agent thread tables are not provisioned yet.");
}

function coerceThread(row: ThreadRow, persisted = true): AgentThreadRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    metadata: jsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    persisted,
  };
}

function coerceMessage(row: MessageRow, persisted = true): AgentMessageRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    metadata: jsonObject(row.metadata),
    createdAt: row.created_at,
    persisted,
  };
}

function coerceRun(row: RunRow, persisted = true): AgentRunRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    request: jsonObject(row.request),
    response: row.response ? jsonObject(row.response) : null,
    actionCount: row.action_count,
    appliedActionCount: row.applied_action_count,
    error: row.error ? jsonObject(row.error) : null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    persisted,
  };
}

export async function ensureAgentThreadForProject(
  ownerId: string,
  projectId: string,
  input: { threadId?: unknown; title?: unknown } = {},
) {
  assertStore(ownerId);
  const requestedThreadId = cleanText(input.threadId, 120);
  const title = cleanText(input.title, 160) || "Anvil Agent";

  if (!ownerHasDurableStore(ownerId)) {
    const bundle = memoryBundle(ownerId, projectId);
    const existing =
      (requestedThreadId ? bundle.threads.find((thread) => thread.id === requestedThreadId) : null) ||
      bundle.threads.find((thread) => thread.status === "active");
    if (existing) return existing;
    const now = new Date().toISOString();
    const thread: AgentThreadRecord = {
      id: `thread_${randomUUID()}`,
      ownerId: null,
      projectId,
      title,
      status: "active",
      metadata: {},
      createdAt: now,
      updatedAt: now,
      persisted: false,
    };
    bundle.threads.push(thread);
    trimMemoryBundle(bundle);
    return thread;
  }

  if (requestedThreadId) {
    const { data, error } = await adminClient()
      .from("anvil_agent_threads")
      .select("*")
      .eq("id", requestedThreadId)
      .eq("owner_id", ownerId)
      .eq("project_id", projectId)
      .neq("status", "deleted")
      .maybeSingle();
    if (error) {
      if (isMissingAgentThreadFeature(error)) throw missingAgentThreadStoreError();
      throw error;
    }
    if (data) return coerceThread(data);
  }

  const { data: existing, error: existingError } = await adminClient()
    .from("anvil_agent_threads")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) {
    if (isMissingAgentThreadFeature(existingError)) throw missingAgentThreadStoreError();
    throw existingError;
  }
  if (existing) return coerceThread(existing);

  const { data, error } = await adminClient()
    .from("anvil_agent_threads")
    .insert({
      id: `thread_${randomUUID()}`,
      owner_id: ownerId,
      project_id: projectId,
      title,
      status: "active",
      metadata: {},
    })
    .select("*")
    .single();
  if (error) {
    if (isMissingAgentThreadFeature(error)) throw missingAgentThreadStoreError();
    throw error;
  }
  return coerceThread(data);
}

export async function listAgentMessagesForThread(
  ownerId: string,
  projectId: string,
  threadId: string,
  limit = 80,
) {
  assertStore(ownerId);
  const safeLimit = boundedLimit(limit, 80, 200);

  if (!ownerHasDurableStore(ownerId)) {
    return memoryBundle(ownerId, projectId).messages
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-safeLimit);
  }

  const { data, error } = await adminClient()
    .from("anvil_agent_messages")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    if (isMissingAgentThreadFeature(error)) throw missingAgentThreadStoreError();
    throw error;
  }
  return (data || []).map((row) => coerceMessage(row));
}

export async function insertAgentMessageForThread(
  ownerId: string,
  projectId: string,
  threadId: string,
  input: {
    role: AgentMessageRecord["role"];
    content: unknown;
    metadata?: unknown;
  },
) {
  assertStore(ownerId);
  const now = new Date().toISOString();
  const message: AgentMessageRecord = {
    id: `msg_${randomUUID()}`,
    ownerId: ownerHasDurableStore(ownerId) ? ownerId : null,
    projectId,
    threadId,
    role: input.role,
    content: cleanContent(input.content),
    metadata: jsonObject(input.metadata),
    createdAt: now,
    persisted: ownerHasDurableStore(ownerId),
  };

  if (!ownerHasDurableStore(ownerId)) {
    const bundle = memoryBundle(ownerId, projectId);
    bundle.messages.push(message);
    const thread = bundle.threads.find((item) => item.id === threadId);
    if (thread) thread.updatedAt = now;
    trimMemoryBundle(bundle);
    return message;
  }

  const { data, error } = await adminClient()
    .from("anvil_agent_messages")
    .insert({
      id: message.id,
      owner_id: ownerId,
      project_id: projectId,
      thread_id: threadId,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
    })
    .select("*")
    .single();
  if (error) {
    if (isMissingAgentThreadFeature(error)) throw missingAgentThreadStoreError();
    throw error;
  }

  const { error: updateThreadError } = await adminClient()
    .from("anvil_agent_threads")
    .update({ updated_at: now })
    .eq("id", threadId)
    .eq("owner_id", ownerId);
  if (updateThreadError) {
    if (isMissingAgentThreadFeature(updateThreadError)) throw missingAgentThreadStoreError();
    throw updateThreadError;
  }

  return coerceMessage(data);
}

export async function createAgentRunForThread(
  ownerId: string,
  projectId: string,
  threadId: string,
  input: { request?: unknown } = {},
) {
  assertStore(ownerId);
  const now = new Date().toISOString();
  const run: AgentRunRecord = {
    id: `run_${randomUUID()}`,
    ownerId: ownerHasDurableStore(ownerId) ? ownerId : null,
    projectId,
    threadId,
    status: "running",
    provider: null,
    model: null,
    request: jsonObject(input.request),
    response: null,
    actionCount: 0,
    appliedActionCount: 0,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    persisted: ownerHasDurableStore(ownerId),
  };

  if (!ownerHasDurableStore(ownerId)) {
    const bundle = memoryBundle(ownerId, projectId);
    bundle.runs.push(run);
    trimMemoryBundle(bundle);
    return run;
  }

  const { data, error } = await adminClient()
    .from("anvil_agent_runs")
    .insert({
      id: run.id,
      owner_id: ownerId,
      project_id: projectId,
      thread_id: threadId,
      status: run.status,
      provider: null,
      model: null,
      request: run.request,
      action_count: 0,
      applied_action_count: 0,
      started_at: now,
    })
    .select("*")
    .single();
  if (error) {
    if (isMissingAgentThreadFeature(error)) throw missingAgentThreadStoreError();
    throw error;
  }
  return coerceRun(data);
}

export async function finishAgentRunForThread(
  ownerId: string,
  projectId: string,
  runId: string,
  input: {
    status: AgentRunRecord["status"];
    provider?: unknown;
    model?: unknown;
    response?: unknown;
    actionCount?: unknown;
    appliedActionCount?: unknown;
    error?: unknown;
  },
) {
  assertStore(ownerId);
  const now = new Date().toISOString();
  const updates = {
    status: input.status,
    provider: cleanText(input.provider, 120) || null,
    model: cleanText(input.model, 160) || null,
    response: input.response ? jsonObject(input.response) : null,
    action_count: Math.max(0, Math.floor(Number(input.actionCount || 0))),
    applied_action_count: Math.max(0, Math.floor(Number(input.appliedActionCount || 0))),
    error: input.error ? jsonObject(input.error) : null,
    completed_at: now,
    updated_at: now,
  };

  if (!ownerHasDurableStore(ownerId)) {
    const run = memoryBundle(ownerId, projectId).runs.find((item) => item.id === runId);
    if (!run) return null;
    run.status = updates.status;
    run.provider = updates.provider;
    run.model = updates.model;
    run.response = updates.response;
    run.actionCount = updates.action_count;
    run.appliedActionCount = updates.applied_action_count;
    run.error = updates.error;
    run.completedAt = now;
    run.updatedAt = now;
    return run;
  }

  const { data, error } = await adminClient()
    .from("anvil_agent_runs")
    .update(updates)
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .select("*")
    .single();
  if (error) {
    if (isMissingAgentThreadFeature(error)) throw missingAgentThreadStoreError();
    throw error;
  }
  return coerceRun(data);
}
