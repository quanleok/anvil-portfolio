import { NextResponse } from "next/server";
import {
  bunnyStorageConfig,
  maxUploadBytesForKind,
  normalizeMediaContentType,
  uploadToBunnyStorage,
} from "@/lib/storage/bunny";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import {
  claimPendingMediaUploadForOwner,
  getMediaAssetForOwner,
  requestCanBeServed,
  updateMediaAssetStatusForOwner,
} from "@/server/media/db";
import { jsonError } from "@/server/media/http";
import { mediaSigningConfigured, verifyMediaUploadToken } from "@/server/media/tokens";

export const runtime = "nodejs";

const VERCEL_PROXY_UPLOAD_LIMIT_BYTES = 4_400_000;

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

function errorPayload(error: unknown) {
  if (!error || typeof error !== "object") return {};
  const source = error as Record<string, unknown>;
  return {
    providerStatus: typeof source.status === "number" ? source.status : undefined,
    providerError: typeof source.providerError === "string" ? source.providerError : undefined,
  };
}

function contentLengthFromRequest(request: Request) {
  const value = request.headers.get("content-length");
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

export async function PUT(request: Request, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);
  if (!requestCanBeServed(auth.user.id)) {
    return jsonError(
      "media_store_not_configured",
      "Media metadata storage is not configured for uploads.",
      503,
    );
  }

  const { assetId } = await context.params;
  if (!mediaSigningConfigured()) {
    return jsonError("media_signing_not_configured", "Media upload signing is not configured.", 503);
  }
  const token = verifyMediaUploadToken(new URL(request.url).searchParams.get("token") || "");
  if (!token || token.assetId !== assetId || token.ownerId !== auth.user.id) {
    return jsonError("invalid_upload_token", "The media upload URL is invalid or expired.", 401);
  }

  const config = bunnyStorageConfig();
  if (!config.configured) {
    return jsonError("storage_not_configured", "Bunny storage is not configured.", 503);
  }

  const contentLength = contentLengthFromRequest(request);
  if (contentLength === null) {
    return jsonError("missing_content_length", "Media uploads require a valid Content-Length header.", 411);
  }
  if (process.env.VERCEL === "1" && contentLength > VERCEL_PROXY_UPLOAD_LIMIT_BYTES) {
    return jsonError(
      "direct_upload_required",
      "This deployment cannot proxy media uploads over 4 MB. Configure a direct-upload backend before uploading this file.",
      413,
      {
        maxProxyBytes: VERCEL_PROXY_UPLOAD_LIMIT_BYTES,
        requestedBytes: contentLength,
        directUploadAvailable: false,
      },
    );
  }
  if (token.byteSize > 0 && contentLength > token.byteSize) {
    return jsonError("media_too_large", "Upload body exceeds the signed size boundary.", 413);
  }
  if (!request.body) {
    return jsonError("missing_body", "Upload the media bytes with a PUT request body.", 400);
  }

  // getMediaAssetForOwner now routes through the memory store for
  // dev-user, so we always look up the draft record created by POST
  // /api/media regardless of whether Supabase is configured. This
  // lets dev sessions complete the upload-and-mark-uploaded flow.
  const existing = await getMediaAssetForOwner(auth.user.id, assetId);
  if (!existing) {
    return jsonError("media_not_found", "Media asset was not found or the upload session expired.", 404);
  }
  if (existing.status !== "pending_upload") {
    return jsonError("upload_already_consumed", "This media upload URL has already been used.", 409);
  }
  if (existing && existing.objectKey !== token.objectKey) {
    return jsonError("invalid_upload_token", "The upload URL does not match the media asset.", 401);
  }
  const maxBytes = maxUploadBytesForKind(existing.kind);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return jsonError("media_too_large", "Upload body exceeds the media kind boundary.", 413, {
      maxBytes,
    });
  }

  const requestContentType = request.headers.get("content-type");
  const normalizedRequestContentType = requestContentType
    ? normalizeMediaContentType(requestContentType, existing.kind)
    : null;
  if (requestContentType && !normalizedRequestContentType) {
    return jsonError(
      "unsupported_content_type",
      "Media content type must match the signed media kind.",
      415,
    );
  }
  const contentType = normalizedRequestContentType || existing.contentType || "application/octet-stream";
  const byteSize = Number.isFinite(contentLength) && contentLength > 0 ? Math.floor(contentLength) : token.byteSize;
  const claimed = await claimPendingMediaUploadForOwner(auth.user.id, assetId);
  if (!claimed) {
    return jsonError("upload_already_consumed", "This media upload URL has already been used.", 409);
  }

  try {
    await uploadToBunnyStorage({
      objectKey: token.objectKey,
      body: request.body,
      contentType,
      checksumSha256: claimed.checksumSha256 || null,
      byteSize: byteSize || null,
    });

    // Mark uploaded so the download route accepts it. Works for both
    // Supabase and memory store paths (updateMediaAssetStatusForOwner
    // dispatches internally).
    const asset = await updateMediaAssetStatusForOwner(auth.user.id, assetId, {
      status: "uploaded",
      byteSize,
      checksumSha256: claimed.checksumSha256,
      metadata: claimed.metadata,
    });

    return NextResponse.json({
      asset: asset || claimed,
      storage: {
        provider: "bunny",
        uploaded: true,
      },
    });
  } catch (error) {
    console.warn("[media/upload] Bunny PUT failed", {
      assetId,
      objectKey: token.objectKey,
      error: errorPayload(error),
    });
    await updateMediaAssetStatusForOwner(auth.user.id, assetId, {
      status: "failed",
      metadata: claimed.metadata,
      error: errorPayload(error),
    }).catch(() => null);
    return jsonError(
      "storage_upload_failed",
      "Bunny rejected the media upload.",
      Number((errorPayload(error).providerStatus as number | undefined) || 502),
      errorPayload(error),
    );
  }
}
