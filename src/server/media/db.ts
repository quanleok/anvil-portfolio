import { createClient } from "@supabase/supabase-js";
import type { MediaKind } from "@/lib/storage/bunny";

export type MediaAssetStatus =
  | "pending_upload"
  | "uploaded"
  | "processing"
  | "ready"
  | "failed"
  | "deleted";

export type MediaAssetRecord = {
  id: string;
  ownerId: string | null;
  projectId: string | null;
  jobId: string | null;
  /** Phase D, slice D1: nullable link to a card in
   *  anvil_project_assets. Detached uploads (assetId null) keep
   *  working so legacy projects and bin-only flows are unaffected. */
  assetId: string | null;
  kind: MediaKind;
  status: MediaAssetStatus;
  storageProvider: "bunny";
  storageZone: string | null;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string | null;
  source: "upload" | "agent" | "generated" | "import" | "system";
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  persisted: boolean;
};

export type AgentJobRecord = {
  id: string;
  ownerId: string | null;
  projectId: string | null;
  role: "project" | "code" | "creative" | "media" | "context" | "workflow" | "tool";
  status:
    | "queued"
    | "running"
    | "waiting_for_approval"
    | "completed"
    | "failed"
    | "cancelled"
    | "paused";
  executionMode: "local" | "cloud" | "bridge" | "hybrid";
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  progress: number | null;
  error: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
  persisted: boolean;
};

type JsonObject = Record<string, unknown>;

type MediaAssetRow = {
  id: string;
  owner_id: string | null;
  project_id: string | null;
  job_id: string | null;
  asset_id: string | null;
  kind: MediaKind;
  status: MediaAssetStatus;
  storage_provider: "bunny";
  storage_zone: string | null;
  object_key: string;
  file_name: string;
  content_type: string;
  byte_size: number;
  checksum_sha256: string | null;
  source: MediaAssetRecord["source"];
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
};

type AgentJobRow = {
  id: string;
  owner_id: string | null;
  project_id: string | null;
  role: AgentJobRecord["role"];
  status: AgentJobRecord["status"];
  execution_mode: AgentJobRecord["executionMode"];
  input: JsonObject;
  output: JsonObject | null;
  progress: number | null;
  logs: string[];
  permissions: string[];
  tool_calls: unknown[];
  cancel_available: boolean;
  retry_available: boolean;
  error: JsonObject | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type MediaDatabase = {
  public: {
    Tables: {
      anvil_projects: {
        Row: {
          id: string;
          owner_id: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      anvil_media_assets: {
        Row: MediaAssetRow;
        Insert: Omit<MediaAssetRow, "created_at" | "updated_at">;
        Update: Partial<Omit<MediaAssetRow, "id" | "owner_id" | "created_at">>;
        Relationships: [];
      };
      anvil_agent_jobs: {
        Row: AgentJobRow;
        Insert: Omit<
          AgentJobRow,
          "created_at" | "updated_at" | "started_at" | "completed_at" | "output" | "progress" | "error"
        >;
        Update: Partial<Omit<AgentJobRow, "id" | "owner_id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      anvil_prune_agent_run_payloads: {
        Args: {
          p_before?: string;
          p_limit?: number;
        };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type SupabaseAdminClient = ReturnType<typeof createClient<MediaDatabase>>;

let cachedClient: SupabaseAdminClient | null = null;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function serviceRoleConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ""
  ).trim();
  return { url, serviceKey };
}

export function mediaDatabaseConfigured() {
  const { url, serviceKey } = serviceRoleConfig();
  return Boolean(url && serviceKey);
}

export function ownerHasDurableStore(ownerId: string) {
  // True ↔ this owner's writes land in Supabase. Used by routes that
  // genuinely require durable storage (jobs/* in particular). Media
  // routes should prefer requestCanBeServed so dev-user gets the
  // in-process memory store instead of a 503.
  return mediaDatabaseConfigured() && isUuid(ownerId);
}

function vercelRuntimeRequiresDurableStore() {
  return process.env.VERCEL === "1";
}

// True when a media request can be served safely in the current runtime.
// Local dev can use the in-process memory store. Vercel cannot: POST and
// follow-up PUT/download requests can land on different function instances,
// which turns memory metadata into split-brain state.
export function requestCanBeServed(ownerId: string) {
  if (!ownerId) return false;
  if (vercelRuntimeRequiresDurableStore() && !ownerHasDurableStore(ownerId)) return false;
  return Boolean(ownerId);
}

// In-process media store: lets dev-user (and any non-UUID owner) round-trip
// uploads through the same routes. Resets on server restart — fine for
// local dev / preview deployments without Supabase. Each owner gets its
// own asset-id → record map so list/get/update stay scoped.
const memoryMediaAssets = new Map<string, Map<string, MediaAssetRecord>>();
const MAX_MEMORY_MEDIA_ASSETS_PER_OWNER = 200;

function memoryBucketFor(ownerId: string) {
  let bucket = memoryMediaAssets.get(ownerId);
  if (!bucket) {
    bucket = new Map<string, MediaAssetRecord>();
    memoryMediaAssets.set(ownerId, bucket);
  }
  return bucket;
}

function trimMemoryMediaBucket(bucket: Map<string, MediaAssetRecord>) {
  while (bucket.size > MAX_MEMORY_MEDIA_ASSETS_PER_OWNER) {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, record] of bucket) {
      const time = Date.parse(record.updatedAt || record.createdAt || "");
      const sortableTime = Number.isFinite(time) ? time : 0;
      if (sortableTime < oldestTime) {
        oldestTime = sortableTime;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    bucket.delete(oldestKey);
  }
}

function setMemoryMediaAsset(ownerId: string, record: MediaAssetRecord) {
  const bucket = memoryBucketFor(ownerId);
  bucket.set(record.id, record);
  trimMemoryMediaBucket(bucket);
}

function shouldUseMemoryStore(ownerId: string) {
  if (vercelRuntimeRequiresDurableStore()) return false;
  return !mediaDatabaseConfigured() || !isUuid(ownerId);
}

function boundedLimit(value: unknown, fallback: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function isMissingRpc(error: unknown, functionName: string) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return code === "42883" || code === "PGRST202" || message.includes(functionName);
}

function adminClient() {
  const { url, serviceKey } = serviceRoleConfig();
  if (!url || !serviceKey) return null;
  if (!cachedClient) {
    cachedClient = createClient<MediaDatabase>(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return cachedClient;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function coerceMediaAsset(row: Record<string, unknown>, persisted = true): MediaAssetRecord {
  return {
    id: String(row.id || ""),
    ownerId: typeof row.owner_id === "string" ? row.owner_id : null,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    jobId: typeof row.job_id === "string" ? row.job_id : null,
    assetId: typeof row.asset_id === "string" ? row.asset_id : null,
    kind: (row.kind === "image" || row.kind === "video" || row.kind === "audio" ? row.kind : "other") as MediaKind,
    status: String(row.status || "pending_upload") as MediaAssetStatus,
    storageProvider: "bunny",
    storageZone: typeof row.storage_zone === "string" ? row.storage_zone : null,
    objectKey: String(row.object_key || ""),
    fileName: String(row.file_name || "media"),
    contentType: String(row.content_type || "application/octet-stream"),
    byteSize: Number(row.byte_size || 0),
    checksumSha256: typeof row.checksum_sha256 === "string" ? row.checksum_sha256 : null,
    source: String(row.source || "upload") as MediaAssetRecord["source"],
    metadata: jsonObject(row.metadata),
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    persisted,
  };
}

function coerceAgentJob(row: Record<string, unknown>, persisted = true): AgentJobRecord {
  return {
    id: String(row.id || ""),
    ownerId: typeof row.owner_id === "string" ? row.owner_id : null,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    role: String(row.role || "media") as AgentJobRecord["role"],
    status: String(row.status || "queued") as AgentJobRecord["status"],
    executionMode: String(row.execution_mode || "cloud") as AgentJobRecord["executionMode"],
    input: jsonObject(row.input),
    output: row.output ? jsonObject(row.output) : null,
    progress: typeof row.progress === "number" ? row.progress : null,
    error: row.error ? jsonObject(row.error) : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    persisted,
  };
}

export async function insertMediaAsset(
  record: Omit<MediaAssetRecord, "createdAt" | "updatedAt" | "persisted">,
) {
  const client = adminClient();
  if (!record.ownerId) return null;
  if (shouldUseMemoryStore(record.ownerId)) {
    const now = new Date().toISOString();
    const full: MediaAssetRecord = {
      ...record,
      createdAt: now,
      updatedAt: now,
      persisted: false,
    };
    setMemoryMediaAsset(record.ownerId, full);
    return full;
  }
  if (!client) return null;
  const { data, error } = await client
    .from("anvil_media_assets")
    .insert({
      id: record.id,
      owner_id: record.ownerId,
      project_id: record.projectId,
      job_id: record.jobId,
      asset_id: record.assetId ?? null,
      kind: record.kind,
      status: record.status,
      storage_provider: record.storageProvider,
      storage_zone: record.storageZone,
      object_key: record.objectKey,
      file_name: record.fileName,
      content_type: record.contentType,
      byte_size: record.byteSize,
      checksum_sha256: record.checksumSha256,
      source: record.source,
      metadata: record.metadata,
    })
    .select("*")
    .single();
  if (error) throw error;
  return coerceMediaAsset(data as Record<string, unknown>);
}

export async function projectOwnedBy(ownerId: string, projectId: string) {
  const client = adminClient();
  if (!client || !isUuid(ownerId)) return false;
  const { data, error } = await client
    .from("anvil_projects")
    .select("id")
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

export async function getMediaAssetForOwner(ownerId: string, assetId: string) {
  if (shouldUseMemoryStore(ownerId)) {
    const bucket = memoryMediaAssets.get(ownerId);
    const record = bucket?.get(assetId);
    return record && record.status !== "deleted" ? record : null;
  }
  const client = adminClient();
  if (!client) return null;
  const { data, error } = await client
    .from("anvil_media_assets")
    .select("*")
    .eq("id", assetId)
    .eq("owner_id", ownerId)
    .neq("status", "deleted")
    .maybeSingle();
  if (error) throw error;
  return data ? coerceMediaAsset(data as Record<string, unknown>) : null;
}

export async function claimPendingMediaUploadForOwner(ownerId: string, assetId: string) {
  if (shouldUseMemoryStore(ownerId)) {
    const bucket = memoryMediaAssets.get(ownerId);
    const existing = bucket?.get(assetId);
    if (!existing || existing.status !== "pending_upload") return null;
    const claimed: MediaAssetRecord = {
      ...existing,
      status: "processing",
      updatedAt: new Date().toISOString(),
    };
    setMemoryMediaAsset(ownerId, claimed);
    return claimed;
  }
  const client = adminClient();
  if (!client) return null;
  const { data, error } = await client
    .from("anvil_media_assets")
    .update({
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", assetId)
    .eq("owner_id", ownerId)
    .eq("status", "pending_upload")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? coerceMediaAsset(data as Record<string, unknown>) : null;
}

export async function listMediaAssetsForOwner(
  ownerId: string,
  options: {
    projectId?: string | null;
    kind?: MediaKind | null;
    status?: MediaAssetStatus | null;
    limit?: number;
  } = {},
) {
  const limit = boundedLimit(options.limit, 50, 100);
  if (shouldUseMemoryStore(ownerId)) {
    const bucket = memoryMediaAssets.get(ownerId);
    if (!bucket) return [];
    let records = Array.from(bucket.values()).filter((record) => record.status !== "deleted");
    if (options.projectId) records = records.filter((r) => r.projectId === options.projectId);
    if (options.kind) records = records.filter((r) => r.kind === options.kind);
    if (options.status) records = records.filter((r) => r.status === options.status);
    records.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return records.slice(0, limit);
  }
  const client = adminClient();
  if (!client) return [];
  let query = client
    .from("anvil_media_assets")
    .select("*")
    .eq("owner_id", ownerId)
    .neq("status", "deleted")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (options.projectId) query = query.eq("project_id", options.projectId);
  if (options.kind) query = query.eq("kind", options.kind);
  if (options.status) query = query.eq("status", options.status);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((row) => coerceMediaAsset(row as Record<string, unknown>));
}

export async function listDeletedMediaAssetsForCleanup(
  options: {
    olderThan: Date;
    limit?: number;
  },
) {
  const client = adminClient();
  if (!client) return [];
  const limit = boundedLimit(options.limit, 100, 500);
  const { data, error } = await client
    .from("anvil_media_assets")
    .select("*")
    .eq("status", "deleted")
    .lt("updated_at", options.olderThan.toISOString())
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((row) => coerceMediaAsset(row as Record<string, unknown>));
}

export async function hardDeleteMediaAssetForCleanup(assetId: string) {
  const client = adminClient();
  if (!client) return false;
  const { data, error } = await client
    .from("anvil_media_assets")
    .delete()
    .eq("id", assetId)
    .eq("status", "deleted")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

export async function pruneAgentRunPayloadsForCleanup(
  options: {
    olderThan: Date;
    limit?: number;
  },
) {
  const client = adminClient();
  if (!client) return null;
  const limit = boundedLimit(options.limit, 500, 5000);
  const { data, error } = await client.rpc("anvil_prune_agent_run_payloads", {
    p_before: options.olderThan.toISOString(),
    p_limit: limit,
  });
  if (error) {
    if (isMissingRpc(error, "anvil_prune_agent_run_payloads")) return null;
    throw error;
  }
  const pruned = Number(data);
  return Number.isFinite(pruned) ? pruned : 0;
}

export async function updateMediaAssetStatusForOwner(
  ownerId: string,
  assetId: string,
  updates: {
    status: MediaAssetStatus;
    byteSize?: number;
    checksumSha256?: string | null;
    metadata?: Record<string, unknown>;
    error?: Record<string, unknown>;
  },
) {
  const metadata = updates.error
    ? { ...(updates.metadata || {}), error: updates.error }
    : updates.metadata;
  if (shouldUseMemoryStore(ownerId)) {
    const bucket = memoryMediaAssets.get(ownerId);
    const existing = bucket?.get(assetId);
    if (!existing) return null;
    const merged: MediaAssetRecord = {
      ...existing,
      status: updates.status,
      ...(typeof updates.byteSize === "number" ? { byteSize: updates.byteSize } : {}),
      ...(updates.checksumSha256 !== undefined ? { checksumSha256: updates.checksumSha256 } : {}),
      ...(metadata ? { metadata } : {}),
      updatedAt: new Date().toISOString(),
    };
    setMemoryMediaAsset(ownerId, merged);
    return merged;
  }
  const client = adminClient();
  if (!client) return null;
  const { data, error } = await client
    .from("anvil_media_assets")
    .update({
      status: updates.status,
      ...(typeof updates.byteSize === "number" ? { byte_size: updates.byteSize } : {}),
      ...(updates.checksumSha256 !== undefined ? { checksum_sha256: updates.checksumSha256 } : {}),
      ...(metadata ? { metadata } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", assetId)
    .eq("owner_id", ownerId)
    .select("*")
    .single();
  if (error) throw error;
  return coerceMediaAsset(data as Record<string, unknown>);
}

export async function updateMediaAssetForOwner(
  ownerId: string,
  assetId: string,
  updates: {
    fileName?: string;
    metadata?: Record<string, unknown>;
  },
) {
  if (shouldUseMemoryStore(ownerId)) {
    const bucket = memoryMediaAssets.get(ownerId);
    const existing = bucket?.get(assetId);
    if (!existing) return null;
    const merged: MediaAssetRecord = {
      ...existing,
      ...(updates.fileName?.trim() ? { fileName: updates.fileName.trim() } : {}),
      ...(updates.metadata && typeof updates.metadata === "object" && !Array.isArray(updates.metadata)
        ? { metadata: updates.metadata }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    setMemoryMediaAsset(ownerId, merged);
    return merged;
  }
  const client = adminClient();
  if (!client) return null;

  const patch: MediaDatabase["public"]["Tables"]["anvil_media_assets"]["Update"] = {
    updated_at: new Date().toISOString(),
  };
  if (typeof updates.fileName === "string" && updates.fileName.trim()) {
    patch.file_name = updates.fileName.trim();
  }
  if (updates.metadata && typeof updates.metadata === "object" && !Array.isArray(updates.metadata)) {
    patch.metadata = updates.metadata;
  }

  const { data, error } = await client
    .from("anvil_media_assets")
    .update(patch)
    .eq("id", assetId)
    .eq("owner_id", ownerId)
    .neq("status", "deleted")
    .select("*")
    .single();
  if (error) throw error;
  return coerceMediaAsset(data as Record<string, unknown>);
}

/** Phase D, slice D3: stamp/unstamp the `asset_id` link between a
 *  media row and a project asset card. Pass `cardAssetId: null` to
 *  detach. Caller is responsible for validating that the media row
 *  belongs to the same project as the card and that the media kind
 *  matches the card's section. Returns null when the row is missing
 *  or the client is unavailable. */
export async function setMediaAssetCardForOwner(
  ownerId: string,
  mediaId: string,
  cardAssetId: string | null,
) {
  if (shouldUseMemoryStore(ownerId)) {
    const bucket = memoryMediaAssets.get(ownerId);
    const existing = bucket?.get(mediaId);
    if (!existing || existing.status === "deleted") return null;
    const merged: MediaAssetRecord = {
      ...existing,
      assetId: cardAssetId,
      updatedAt: new Date().toISOString(),
    };
    setMemoryMediaAsset(ownerId, merged);
    return merged;
  }
  const client = adminClient();
  if (!client) return null;
  const { data, error } = await client
    .from("anvil_media_assets")
    .update({
      asset_id: cardAssetId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", mediaId)
    .eq("owner_id", ownerId)
    .neq("status", "deleted")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? coerceMediaAsset(data as Record<string, unknown>) : null;
}

export async function insertAgentJob(
  record: Omit<AgentJobRecord, "createdAt" | "updatedAt" | "persisted" | "output" | "progress" | "error">,
) {
  const client = adminClient();
  if (!client || !record.ownerId || !isUuid(record.ownerId)) return null;
  const { data, error } = await client
    .from("anvil_agent_jobs")
    .insert({
      id: record.id,
      owner_id: record.ownerId,
      project_id: record.projectId,
      role: record.role,
      status: record.status,
      execution_mode: record.executionMode,
      input: record.input,
      logs: [],
      permissions: [],
      tool_calls: [],
      cancel_available: true,
      retry_available: false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return coerceAgentJob(data as Record<string, unknown>);
}

export async function getAgentJobForOwner(ownerId: string, jobId: string) {
  const client = adminClient();
  if (!client || !isUuid(ownerId)) return null;
  const { data, error } = await client
    .from("anvil_agent_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  return data ? coerceAgentJob(data as Record<string, unknown>) : null;
}

export async function listAgentJobsForOwner(
  ownerId: string,
  options: { projectId?: string | null; role?: AgentJobRecord["role"] | null; limit?: number } = {},
) {
  const client = adminClient();
  if (!client || !isUuid(ownerId)) return [];
  const limit = boundedLimit(options.limit, 50, 100);
  let query = client
    .from("anvil_agent_jobs")
    .select("*")
    .eq("owner_id", ownerId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (options.projectId) query = query.eq("project_id", options.projectId);
  if (options.role) query = query.eq("role", options.role);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((row) => coerceAgentJob(row as Record<string, unknown>));
}
