import { NextResponse } from "next/server";
import { bunnyDownloadUrlForObjectKey, bunnyStorageConfig, deleteFromBunnyStorage } from "@/lib/storage/bunny";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  requestCanBeServed,
  getMediaAssetForOwner,
  updateMediaAssetForOwner,
  updateMediaAssetStatusForOwner,
} from "@/server/media/db";
import { cleanText, jsonError, readSmallJson } from "@/server/media/http";
import { clearProjectAssetMediaReferenceForOwner } from "@/server/projects/store";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

type PatchMediaBody = {
  fileName?: unknown;
  metadata?: unknown;
};

function cleanMetadataValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return cleanText(value, 4_000);
  if (Array.isArray(value)) {
    if (depth > 1) return [];
    return value.slice(0, 48).map((item) => cleanMetadataValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth > 1) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => /^[a-zA-Z0-9_.:-]{1,80}$/.test(key))
        .slice(0, 80)
        .map(([key, item]) => [key, cleanMetadataValue(item, depth + 1)]),
    );
  }
  return null;
}

function cleanMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return cleanMetadataValue(value) as Record<string, unknown>;
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  if (!requestCanBeServed(auth.user.id)) {
    return NextResponse.json({
      asset: null,
      persisted: false,
      storageConfigured: bunnyStorageConfig().configured,
      message: "Media metadata storage is not configured for this workspace session.",
    });
  }

  const { assetId } = await context.params;
  try {
    const asset = await getMediaAssetForOwner(auth.user.id, assetId);
    if (!asset) return jsonError("media_not_found", "Media asset was not found.", 404);
    const download =
      asset.status === "uploaded" || asset.status === "ready"
        ? bunnyDownloadUrlForObjectKey(asset.objectKey)
        : null;
    return NextResponse.json({
      asset,
      download,
    });
  } catch {
    return jsonError("media_store_error", "Could not read the media asset.", 500);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  if (!requestCanBeServed(auth.user.id)) {
    return jsonError(
      "media_store_not_configured",
      "Media metadata storage is not configured for this workspace session.",
      503,
      { storageConfigured: bunnyStorageConfig().configured },
    );
  }

  let body: PatchMediaBody;
  try {
    body = await readSmallJson<PatchMediaBody>(request);
  } catch {
    return jsonError("invalid_request", "Media update requests must be small JSON metadata.", 400);
  }

  const { assetId } = await context.params;
  try {
    const existing = await getMediaAssetForOwner(auth.user.id, assetId);
    if (!existing) return jsonError("media_not_found", "Media asset was not found.", 404);

    const fileName = cleanText(body.fileName, 240);
    const metadata = cleanMetadata(body.metadata);
    const asset = await updateMediaAssetForOwner(auth.user.id, assetId, {
      ...(fileName ? { fileName } : {}),
      ...(metadata ? { metadata: { ...existing.metadata, ...metadata } } : {}),
    });
    if (!asset) return jsonError("media_store_not_configured", "Media metadata storage is not configured.", 503);

    const download =
      asset.status === "uploaded" || asset.status === "ready"
        ? bunnyDownloadUrlForObjectKey(asset.objectKey)
        : null;
    return NextResponse.json({ asset, download });
  } catch {
    return jsonError("media_store_error", "Could not update the media asset.", 500);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);

  if (!requestCanBeServed(auth.user.id)) {
    return jsonError(
      "media_store_not_configured",
      "Media metadata storage is not configured for this workspace session.",
      503,
      { storageConfigured: bunnyStorageConfig().configured },
    );
  }

  const { assetId } = await context.params;
  try {
    const existing = await getMediaAssetForOwner(auth.user.id, assetId);
    if (!existing) return jsonError("media_not_found", "Media asset was not found.", 404);

    const storageConfig = bunnyStorageConfig();
    let storageDelete: { deleted: boolean; missing: boolean } | null = null;
    if (existing.storageProvider === "bunny" && storageConfig.configured && existing.status !== "pending_upload") {
      try {
        storageDelete = await deleteFromBunnyStorage({ objectKey: existing.objectKey });
      } catch {
        return jsonError("media_storage_delete_failed", "Could not delete the media object from Bunny storage.", 502);
      }
    }

    const asset = await updateMediaAssetStatusForOwner(auth.user.id, assetId, {
      status: "deleted",
      metadata: {
        ...existing.metadata,
        deletedAt: new Date().toISOString(),
        ...(storageDelete
          ? {
              storageDeleted: storageDelete.deleted,
              storageMissing: storageDelete.missing,
            }
          : {}),
      },
    });
    if (!asset) return jsonError("media_store_not_configured", "Media metadata storage is not configured.", 503);

    let clearedAssetCards = 0;
    if (existing.projectId && existing.assetId) {
      try {
        clearedAssetCards = await clearProjectAssetMediaReferenceForOwner(
          auth.user.id,
          existing.projectId,
          assetId,
          existing.assetId,
        );
      } catch (cleanupError) {
        console.warn("[media/delete] could not clear bound asset-card metadata", {
          mediaId: assetId,
          projectId: existing.projectId,
          assetId: existing.assetId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }

    return NextResponse.json({ ok: true, deleted: true, asset, clearedAssetCards });
  } catch {
    return jsonError("media_store_error", "Could not delete the media asset.", 500);
  }
}
