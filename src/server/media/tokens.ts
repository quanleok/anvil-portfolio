import { createHmac, timingSafeEqual } from "node:crypto";

export type MediaUploadTokenPayload = {
  purpose: "media-upload";
  assetId: string;
  ownerId: string;
  objectKey: string;
  byteSize: number;
  expiresAt: number;
};

function mediaSigningSecret() {
  const current = (process.env.ANVIL_MEDIA_SIGNING_SECRET_V2 || "").trim();
  if (current) return current;
  const explicit = (process.env.ANVIL_MEDIA_SIGNING_SECRET || "").trim();
  if (explicit) return explicit;
  const legacy = (process.env.ANVIL_MEDIA_SIGNING_SECRET_V1 || "").trim();
  if (legacy) return legacy;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ANVIL_MEDIA_SIGNING_SECRET or ANVIL_MEDIA_SIGNING_SECRET_V2 is required in production.");
  }
  const secret = (process.env.ANVIL_AGENT_SERVER_TOKEN || process.env.NEXTAUTH_SECRET || "").trim();
  if (secret) return secret;
  return "anvil-dev-media-signing-secret";
}

export function mediaSigningConfigured() {
  try {
    return Boolean(mediaSigningSecret());
  } catch {
    return false;
  }
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(value: string) {
  const secret = mediaSigningSecret();
  if (!secret) throw new Error("media_signing_not_configured");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function verificationSecrets() {
  const secrets = [
    process.env.ANVIL_MEDIA_SIGNING_SECRET_V2,
    process.env.ANVIL_MEDIA_SIGNING_SECRET,
    process.env.ANVIL_MEDIA_SIGNING_SECRET_V1,
    process.env.NODE_ENV === "production" ? "" : process.env.ANVIL_AGENT_SERVER_TOKEN,
    process.env.NODE_ENV === "production" ? "" : process.env.NEXTAUTH_SECRET,
    process.env.NODE_ENV === "production" ? "" : "anvil-dev-media-signing-secret",
  ]
    .map((value) => (value || "").trim())
    .filter(Boolean);
  return Array.from(new Set(secrets));
}

function signatureForSecret(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signatureMatches(body: string, suppliedSignature: string) {
  for (const secret of verificationSecrets()) {
    const expected = signatureForSecret(body, secret);
    const expectedBuffer = Buffer.from(expected);
    const suppliedBuffer = Buffer.from(suppliedSignature);
    if (
      expectedBuffer.length === suppliedBuffer.length &&
      timingSafeEqual(expectedBuffer, suppliedBuffer)
    ) {
      return true;
    }
  }
  return false;
}

export function createMediaUploadToken(payload: Omit<MediaUploadTokenPayload, "purpose">) {
  const body = encodeJson({ ...payload, purpose: "media-upload" });
  return `${body}.${sign(body)}`;
}

export function verifyMediaUploadToken(token: string): MediaUploadTokenPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  if (!signatureMatches(body, signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    const source = payload as Record<string, unknown>;
    if (source.purpose !== "media-upload") return null;
    if (typeof source.assetId !== "string" || !source.assetId) return null;
    if (typeof source.ownerId !== "string" || !source.ownerId) return null;
    if (typeof source.objectKey !== "string" || !source.objectKey) return null;
    if (typeof source.expiresAt !== "number" || source.expiresAt <= Date.now()) return null;
    const byteSize = Number(source.byteSize);
    if (!Number.isFinite(byteSize) || byteSize < 0) return null;
    return {
      purpose: "media-upload",
      assetId: source.assetId,
      ownerId: source.ownerId,
      objectKey: source.objectKey,
      byteSize,
      expiresAt: source.expiresAt,
    };
  } catch {
    return null;
  }
}
