import { createHash } from "node:crypto";

export type MediaKind = "image" | "video" | "audio" | "other";

export type BunnyStorageConfig = {
  configured: boolean;
  zone: string;
  accessKey: string;
  region: string;
  storageHost: string;
  cdnBaseUrl: string;
  cdnTokenKey: string;
};

export type BunnyDownloadUrl = {
  url: string;
  signed: boolean;
  expiresAt: string | null;
};

const KIND_MAX_BYTES: Record<MediaKind, number> = {
  image: 50 * 1024 * 1024,
  video: 50 * 1024 * 1024 * 1024,
  audio: 2 * 1024 * 1024 * 1024,
  other: 500 * 1024 * 1024,
};

const KIND_EXTENSIONS: Record<Exclude<MediaKind, "other">, ReadonlySet<string>> = {
  image: new Set(["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]),
  video: new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"]),
  audio: new Set(["aac", "aif", "aiff", "flac", "m4a", "mp3", "ogg", "opus", "wav", "weba"]),
};

function cleanText(value: unknown, max = 1000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function positiveEnvBytes(name: string, fallback: number) {
  const megabytes = Number(process.env[name] || 0);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return fallback;
  return Math.floor(megabytes * 1024 * 1024);
}

export function maxUploadBytesForKind(kind: MediaKind) {
  if (kind === "image") return positiveEnvBytes("ANVIL_MEDIA_IMAGE_MAX_MB", KIND_MAX_BYTES.image);
  if (kind === "video") return positiveEnvBytes("ANVIL_MEDIA_VIDEO_MAX_MB", KIND_MAX_BYTES.video);
  if (kind === "audio") return positiveEnvBytes("ANVIL_MEDIA_AUDIO_MAX_MB", KIND_MAX_BYTES.audio);
  return positiveEnvBytes("ANVIL_MEDIA_OTHER_MAX_MB", KIND_MAX_BYTES.other);
}

function storageHost(region: string) {
  if (!region) return "storage.bunnycdn.com";
  if (region.includes(".")) return region;
  return `${region}.storage.bunnycdn.com`;
}

function storageHostFromEndpoint(value: unknown) {
  const endpoint = cleanText(value, 2000).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return endpoint || "";
}

function cdnBaseUrlFromHost(value: unknown) {
  const host = cleanText(value, 2000).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return host ? `https://${host}` : "";
}

export function bunnyStorageConfig(): BunnyStorageConfig {
  const zone = cleanText(
    process.env.BUNNY_STORAGE_ZONE || process.env.BUNNY_STORAGE_ZONE_NAME,
    200,
  );
  const accessKey = cleanText(
    process.env.BUNNY_STORAGE_ACCESS_KEY || process.env.BUNNY_ACCESS_KEY,
    4000,
  );
  const region = cleanText(process.env.BUNNY_STORAGE_REGION, 80).toLowerCase();
  const explicitStorageHost =
    storageHostFromEndpoint(process.env.BUNNY_STORAGE_ENDPOINT) ||
    storageHostFromEndpoint(process.env.BUNNY_STORAGE_HOST);
  const cdnBaseUrl = cleanText(
    process.env.BUNNY_CDN_BASE_URL ||
      process.env.BUNNY_PULL_ZONE_URL ||
      cdnBaseUrlFromHost(process.env.BUNNY_CDN_HOSTNAME || process.env.NEXT_PUBLIC_BUNNY_CDN_HOSTNAME),
    2000,
  ).replace(/\/+$/, "");
  const cdnTokenKey = cleanText(
    process.env.BUNNY_CDN_TOKEN_AUTH_KEY || process.env.BUNNY_TOKEN_AUTH_KEY,
    4000,
  );

  return {
    configured: Boolean(zone && accessKey),
    zone,
    accessKey,
    region,
    storageHost: explicitStorageHost || storageHost(region),
    cdnBaseUrl,
    cdnTokenKey,
  };
}

export function normalizeMediaKind(value: unknown): MediaKind {
  const text = cleanText(value, 40).toLowerCase();
  if (text === "image" || text === "video" || text === "audio") return text;
  return "other";
}

export function normalizeMediaContentType(value: unknown, kind: MediaKind): string | null {
  const text = cleanText(value, 160).toLowerCase();
  if (!text) return "application/octet-stream";
  const contentType = text.split(";")[0].trim();
  const allowed =
    contentType === "application/octet-stream" ||
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/");
  if (!allowed) return null;
  if (
    kind !== "other" &&
    contentType !== "application/octet-stream" &&
    !contentType.startsWith(`${kind}/`)
  ) {
    return null;
  }
  return contentType;
}

export function mediaFileNameMatchesKind(fileName: string, kind: MediaKind) {
  if (kind === "other") return true;
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  if (!extension || extension === fileName.toLowerCase()) return true;
  return KIND_EXTENSIONS[kind].has(extension);
}

export function safeFileName(value: unknown, fallback = "media") {
  const cleaned = cleanText(value, 240)
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

function safePathSegment(value: unknown, fallback: string) {
  const cleaned = cleanText(value, 160)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

export function sanitizeObjectKey(value: unknown) {
  const key = cleanText(value, 1000)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => safePathSegment(segment, "x"))
    .join("/")
    .replace(/\/+/g, "/");

  if (!key || key.includes("..") || key.endsWith("/")) {
    throw new Error("invalid_object_key");
  }
  return key;
}

export function mediaObjectKey({
  ownerId,
  projectId,
  kind,
  assetId,
  fileName,
}: {
  ownerId: string;
  projectId?: string | null;
  kind: MediaKind;
  assetId: string;
  fileName: string;
}) {
  return sanitizeObjectKey(
    [
      "users",
      safePathSegment(ownerId, "unknown-user"),
      "projects",
      safePathSegment(projectId || "unscoped", "unscoped"),
      kind,
      `${safePathSegment(assetId, "asset")}-${safeFileName(fileName)}`,
    ].join("/"),
  );
}

export function storageUrlForObjectKey(objectKey: string) {
  const config = bunnyStorageConfig();
  const key = sanitizeObjectKey(objectKey);
  return `https://${config.storageHost}/${encodeURIComponent(config.zone)}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export async function uploadToBunnyStorage({
  objectKey,
  body,
  contentType,
  checksumSha256,
  byteSize,
}: {
  objectKey: string;
  body: BodyInit;
  contentType: string;
  checksumSha256?: string | null;
  byteSize?: number | null;
}) {
  const config = bunnyStorageConfig();
  if (!config.configured) throw new Error("bunny_storage_not_configured");

  const headers: Record<string, string> = {
    AccessKey: config.accessKey,
    "content-type": cleanText(contentType, 160) || "application/octet-stream",
  };
  if (checksumSha256) headers.Checksum = checksumSha256.toUpperCase();
  if (Number.isFinite(byteSize) && Number(byteSize) > 0) {
    headers["content-length"] = String(Math.floor(Number(byteSize)));
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: "PUT",
    headers,
    body,
    duplex: "half",
  };
  const response = await fetch(storageUrlForObjectKey(objectKey), init);
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error("bunny_upload_failed");
    Object.assign(error, {
      status: response.status,
      providerError: errorText.slice(0, 2000),
    });
    throw error;
  }
}

export async function deleteFromBunnyStorage({ objectKey }: { objectKey: string }) {
  const config = bunnyStorageConfig();
  if (!config.configured) throw new Error("bunny_storage_not_configured");

  const response = await fetch(storageUrlForObjectKey(objectKey), {
    method: "DELETE",
    headers: {
      AccessKey: config.accessKey,
    },
  });
  if (response.ok || response.status === 404) {
    return {
      deleted: response.ok,
      missing: response.status === 404,
    };
  }

  const errorText = await response.text().catch(() => "");
  const error = new Error("bunny_delete_failed");
  Object.assign(error, {
    status: response.status,
    providerError: errorText.slice(0, 2000),
  });
  throw error;
}

function base64Url(buffer: Buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function bunnyDownloadUrlForObjectKey(
  objectKey: string,
  options: { expiresInSeconds?: number } = {},
): BunnyDownloadUrl | null {
  const config = bunnyStorageConfig();
  if (!config.cdnBaseUrl) return null;

  const expiresInSeconds = Math.max(60, Math.min(24 * 60 * 60, options.expiresInSeconds || 24 * 60 * 60));
  const key = sanitizeObjectKey(objectKey);
  const url = new URL(
    key
      .split("/")
      .map(encodeURIComponent)
      .join("/"),
    `${config.cdnBaseUrl}/`,
  );

  if (!config.cdnTokenKey) {
    return { url: url.toString(), signed: false, expiresAt: null };
  }

  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const tokenPath = decodeURIComponent(url.pathname);
  const token = base64Url(
    createHash("sha256")
      .update(`${config.cdnTokenKey}${tokenPath}${expires}`)
      .digest(),
  );
  url.searchParams.set("token", token);
  url.searchParams.set("expires", String(expires));

  return {
    url: url.toString(),
    signed: true,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}
