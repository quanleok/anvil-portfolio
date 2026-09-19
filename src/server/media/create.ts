import { randomUUID } from "node:crypto";
import {
  bunnyStorageConfig,
  maxUploadBytesForKind,
  mediaFileNameMatchesKind,
  mediaObjectKey,
  normalizeMediaContentType,
  normalizeMediaKind,
  safeFileName,
} from "@/lib/storage/bunny";
import {
  ownerHasDurableStore,
  getAgentJobForOwner,
  insertMediaAsset,
  projectOwnedBy,
  type MediaAssetRecord,
} from "@/server/media/db";
import { cleanOptionalText, cleanText } from "@/server/media/http";
import { createMediaUploadToken, mediaSigningConfigured } from "@/server/media/tokens";

export type CreateMediaBody = {
  projectId?: unknown;
  jobId?: unknown;
  kind?: unknown;
  fileName?: unknown;
  contentType?: unknown;
  byteSize?: unknown;
  checksumSha256?: unknown;
  source?: unknown;
  metadata?: unknown;
};

export type CreateMediaUploadResult = {
  status: number;
  body: Record<string, unknown>;
};

const VERCEL_PROXY_UPLOAD_LIMIT_BYTES = 4_400_000;

function response(status: number, body: Record<string, unknown>): CreateMediaUploadResult {
  return { status, body };
}

function errorResponse(
  error: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
): CreateMediaUploadResult {
  return response(status, { error, message, ...extra });
}

function sourceValue(value: unknown): MediaAssetRecord["source"] {
  const text = cleanText(value, 40);
  if (text === "agent" || text === "generated" || text === "import" || text === "system") return text;
  return "upload";
}

function metadataObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function checksumValue(value: unknown) {
  const text = cleanText(value, 80).toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function byteSizeValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function proxyUploadLimitBytes() {
  return process.env.VERCEL === "1" ? VERCEL_PROXY_UPLOAD_LIMIT_BYTES : null;
}

export async function createMediaUploadForOwner({
  ownerId,
  body,
  origin,
  projectId: forcedProjectId,
}: {
  ownerId: string;
  body: CreateMediaBody;
  origin: string;
  projectId?: string | null;
}): Promise<CreateMediaUploadResult> {
  const config = bunnyStorageConfig();
  if (!config.configured) {
    return errorResponse(
      "storage_not_configured",
      "Bunny storage is not configured. Set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_ACCESS_KEY.",
      503,
      { storageConfigured: false },
    );
  }
  try {
    if (!mediaSigningConfigured()) {
      return errorResponse(
        "media_signing_not_configured",
        "Set ANVIL_MEDIA_SIGNING_SECRET before issuing signed media upload URLs.",
        503,
      );
    }
  } catch (error) {
    console.error("[media/create] media signing is not configured", error);
    return errorResponse(
      "media_signing_not_configured",
      "Set ANVIL_MEDIA_SIGNING_SECRET before issuing signed media upload URLs.",
      503,
    );
  }

  const kind = normalizeMediaKind(body.kind);
  const maxBytes = maxUploadBytesForKind(kind);
  const byteSize = byteSizeValue(body.byteSize);
  if (byteSize > maxBytes) {
    return errorResponse("media_too_large", "The requested media upload exceeds the plan boundary.", 413, {
      maxBytes,
    });
  }
  const proxyLimit = proxyUploadLimitBytes();
  if (proxyLimit && byteSize > proxyLimit) {
    return errorResponse(
      "direct_upload_required",
      "This deployment cannot proxy media uploads over 4 MB. Configure a direct-upload backend before uploading this file.",
      413,
      {
        maxProxyBytes: proxyLimit,
        requestedBytes: byteSize,
        directUploadAvailable: false,
      },
    );
  }

  const assetId = `media_${randomUUID()}`;
  const fileName = safeFileName(body.fileName, `${kind}-${assetId}`);
  if (!mediaFileNameMatchesKind(fileName, kind)) {
    return errorResponse(
      "unsupported_media_extension",
      "Media file extension must match the selected media kind.",
      415,
    );
  }
  const contentType = normalizeMediaContentType(body.contentType, kind);
  if (!contentType) {
    return errorResponse(
      "unsupported_content_type",
      "Media content type must be image/*, video/*, audio/*, or application/octet-stream.",
      415,
    );
  }
  const projectId = forcedProjectId ?? cleanOptionalText(body.projectId, 160);
  const jobId = cleanOptionalText(body.jobId, 160);
  let objectKey: string;
  try {
    objectKey = mediaObjectKey({
      ownerId,
      projectId,
      kind,
      assetId,
      fileName,
    });
  } catch {
    return errorResponse(
      "invalid_media_file_name",
      "Media file names cannot contain unsafe path characters.",
      400,
    );
  }
  const checksumSha256 = checksumValue(body.checksumSha256);
  const persisted = ownerHasDurableStore(ownerId);

  if ((process.env.NODE_ENV === "production" || process.env.VERCEL === "1") && !persisted) {
    return errorResponse(
      "media_store_not_configured",
      "Media metadata storage requires Supabase service-role configuration.",
      503,
    );
  }

  const draftAsset: Omit<MediaAssetRecord, "createdAt" | "updatedAt" | "persisted"> = {
    id: assetId,
    ownerId,
    projectId,
    jobId,
    assetId: null,
    kind,
    status: "pending_upload",
    storageProvider: "bunny",
    storageZone: config.zone,
    objectKey,
    fileName,
    contentType,
    byteSize,
    checksumSha256,
    source: sourceValue(body.source),
    metadata: metadataObject(body.metadata),
  };

  try {
    if (persisted && projectId && !(await projectOwnedBy(ownerId, projectId))) {
      return errorResponse("project_not_found", "Project was not found for this account.", 404);
    }
    if (persisted && jobId && !(await getAgentJobForOwner(ownerId, jobId))) {
      return errorResponse("job_not_found", "Job was not found for this account.", 404);
    }

    const asset =
      (await insertMediaAsset(draftAsset)) ||
      ({
        ...draftAsset,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        persisted: false,
      } satisfies MediaAssetRecord);
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const token = createMediaUploadToken({
      assetId,
      ownerId,
      objectKey,
      byteSize,
      expiresAt,
    });

    return response(201, {
      asset,
      upload: {
        method: "PUT",
        url: `${origin}/api/media/${encodeURIComponent(assetId)}/upload?token=${encodeURIComponent(token)}`,
        expiresAt: new Date(expiresAt).toISOString(),
        maxBytes,
        headers: {
          "content-type": contentType,
        },
      },
    });
  } catch {
    return errorResponse("media_store_error", "Could not create the media upload record.", 500);
  }
}
