import { NextResponse } from "next/server";
import { bunnyStorageConfig, deleteFromBunnyStorage } from "@/lib/storage/bunny";
import {
  hardDeleteMediaAssetForCleanup,
  listDeletedMediaAssetsForCleanup,
  mediaDatabaseConfigured,
  pruneAgentRunPayloadsForCleanup,
} from "@/server/media/db";
import { boundedNumber, cleanText, jsonError } from "@/server/media/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DELETED_MEDIA_RETENTION_DAYS = 30;
const DEFAULT_AGENT_RUN_PAYLOAD_RETENTION_DAYS = 30;
const DEFAULT_CLEANUP_LIMIT = 100;
const DEFAULT_AGENT_RUN_PRUNE_LIMIT = 500;

function bearerToken(request: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  return match?.[1]?.trim() || "";
}

function configuredCleanupTokens() {
  return [
    process.env.ANVIL_MEDIA_CLEANUP_TOKEN,
    process.env.CRON_SECRET,
    process.env.ANVIL_SERVER_API_TOKEN,
    process.env.ANVIL_AGENT_SERVER_TOKEN,
  ]
    .map((value) => cleanText(value, 4000))
    .filter(Boolean);
}

function isAuthorizedCleanupRequest(request: Request) {
  const tokens = configuredCleanupTokens();
  if (!tokens.length && process.env.NODE_ENV !== "production") return true;
  const token = bearerToken(request);
  return Boolean(token && tokens.includes(token));
}

export async function GET(request: Request) {
  if (!isAuthorizedCleanupRequest(request)) {
    return jsonError("unauthorized_cleanup", "Media cleanup requires a configured bearer token.", 401);
  }
  if (!mediaDatabaseConfigured()) {
    return jsonError("media_store_not_configured", "Media cleanup requires Supabase media metadata storage.", 503);
  }

  const url = new URL(request.url);
  const days = boundedNumber(
    url.searchParams.get("days"),
    DEFAULT_DELETED_MEDIA_RETENTION_DAYS,
    1,
    365,
  );
  const limit = boundedNumber(url.searchParams.get("limit"), DEFAULT_CLEANUP_LIMIT, 1, 500);
  const runDays = boundedNumber(
    url.searchParams.get("runDays"),
    DEFAULT_AGENT_RUN_PAYLOAD_RETENTION_DAYS,
    1,
    365,
  );
  const runLimit = boundedNumber(url.searchParams.get("runLimit"), DEFAULT_AGENT_RUN_PRUNE_LIMIT, 1, 5000);
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
  const olderThan = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const runsOlderThan = new Date(Date.now() - runDays * 24 * 60 * 60 * 1000);
  const candidates = await listDeletedMediaAssetsForCleanup({ olderThan, limit });
  const storage = bunnyStorageConfig();

  if (!dryRun && !storage.configured && candidates.length) {
    return jsonError(
      "storage_not_configured",
      "Bunny storage is not configured, so deleted media bytes cannot be cleaned safely.",
      503,
    );
  }

  const results: Array<{
    id: string;
    objectKey: string;
    storageDeleted?: boolean;
    storageMissing?: boolean;
    rowDeleted?: boolean;
    error?: string;
  }> = [];

  for (const asset of candidates) {
    if (dryRun) {
      results.push({ id: asset.id, objectKey: asset.objectKey });
      continue;
    }
    try {
      const storageDelete = await deleteFromBunnyStorage({ objectKey: asset.objectKey });
      const rowDeleted = await hardDeleteMediaAssetForCleanup(asset.id);
      results.push({
        id: asset.id,
        objectKey: asset.objectKey,
        storageDeleted: storageDelete.deleted,
        storageMissing: storageDelete.missing,
        rowDeleted,
      });
    } catch (error) {
      results.push({
        id: asset.id,
        objectKey: asset.objectKey,
        error: error instanceof Error ? error.message : "cleanup_failed",
      });
    }
  }

  const agentRunPayloadsPruned = dryRun
    ? null
    : await pruneAgentRunPayloadsForCleanup({ olderThan: runsOlderThan, limit: runLimit });

  return NextResponse.json({
    ok: true,
    dryRun,
    retentionDays: days,
    agentRunPayloadRetentionDays: runDays,
    limit,
    runLimit,
    candidates: candidates.length,
    cleaned: results.filter((result) => result.rowDeleted).length,
    failed: results.filter((result) => result.error).length,
    agentRunPayloadsPruned,
    results,
  });
}
