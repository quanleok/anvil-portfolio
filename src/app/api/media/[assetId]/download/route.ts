import { NextResponse } from "next/server";
import { bunnyDownloadUrlForObjectKey } from "@/lib/storage/bunny";
import { getWorkspaceUser, workspaceAuthErrorResponse } from "@/lib/workspace-auth";
import { requestCanBeServed, getMediaAssetForOwner } from "@/server/media/db";
import { jsonError } from "@/server/media/http";

export const runtime = "nodejs";

const DEFAULT_DOWNLOAD_REDIRECT_CACHE_SECONDS = 24 * 60 * 60;

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

function redirectCacheSeconds(expiresAt: string | null) {
  if (!expiresAt) return DEFAULT_DOWNLOAD_REDIRECT_CACHE_SECONDS;
  const seconds = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return DEFAULT_DOWNLOAD_REDIRECT_CACHE_SECONDS;
  return Math.max(60, Math.min(DEFAULT_DOWNLOAD_REDIRECT_CACHE_SECONDS, seconds));
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await getWorkspaceUser(request);
  if (!auth.ok) return workspaceAuthErrorResponse(auth);
  if (!requestCanBeServed(auth.user.id)) {
    return jsonError(
      "media_store_not_configured",
      "Media metadata storage is not configured for downloads.",
      503,
    );
  }

  const { assetId } = await context.params;
  try {
    const asset = await getMediaAssetForOwner(auth.user.id, assetId);
    if (!asset) return jsonError("media_not_found", "Media asset was not found.", 404);
    if (asset.status !== "uploaded" && asset.status !== "ready") {
      return jsonError("media_not_ready", "Media asset is not ready for download.", 409, {
        status: asset.status,
      });
    }
    const download = bunnyDownloadUrlForObjectKey(asset.objectKey);
    if (!download) {
      return jsonError(
        "download_not_configured",
        "Set BUNNY_CDN_BASE_URL before issuing media download URLs.",
        503,
      );
    }
    const response = NextResponse.redirect(download.url, 302);
    response.headers.set("Cache-Control", `private, max-age=${redirectCacheSeconds(download.expiresAt)}`);
    if (download.expiresAt) response.headers.set("Expires", download.expiresAt);
    return response;
  } catch (error) {
    console.warn("[media/download] failed", { assetId, ownerId: auth.user.id, error });
    return jsonError("media_store_error", "Could not issue the media download URL.", 500);
  }
}
