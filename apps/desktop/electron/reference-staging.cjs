const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".aiff", ".m4a", ".mp3", ".wav"]);

function isPublicHttps(value) {
  return typeof value === "string" && /^https:\/\//i.test(value.trim());
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function preferredReferenceMode(provider) {
  const normalized = normalizeProvider(provider);
  if (normalized.includes("evolink")) return "url";
  if (normalized.includes("topview")) return "upload";
  return "upload";
}

function normalizeRelativePath(projectDir, inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) throw new Error("reference path is required.");
  if (isPublicHttps(raw)) return raw;

  const projectRoot = path.resolve(projectDir);
  const absolute = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(projectRoot, raw);
  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("Reference media must live inside the current Anvil project.");
  }
  return path.relative(projectRoot, absolute).split(path.sep).join("/");
}

async function readLocalReference(projectDir, inputPath) {
  const relativePath = normalizeRelativePath(projectDir, inputPath);
  if (isPublicHttps(relativePath)) {
    return {
      kind: "url",
      input: inputPath,
      publicUrl: relativePath,
    };
  }

  const absolutePath = path.resolve(projectDir, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Reference media is not a file: ${relativePath}`);
  }
  const ext = path.extname(relativePath).toLowerCase();
  const mediaKind = IMAGE_EXTENSIONS.has(ext)
    ? "image"
    : VIDEO_EXTENSIONS.has(ext)
      ? "video"
      : AUDIO_EXTENSIONS.has(ext)
        ? "audio"
        : "file";
  return {
    kind: "file",
    input: inputPath,
    relativePath,
    absolutePath,
    basename: path.basename(relativePath),
    bytes: stat.size,
    mediaKind,
  };
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".heic":
    case ".heif":
      return "image/heif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".mov":
      return "video/quicktime";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

function slugify(value, fallback = "reference") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function joinUrl(baseUrl, remotePath) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(remotePath || "").replace(/^\/+/, "")}`;
}

function encodeRemotePath(remotePath) {
  return String(remotePath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function configuredPublicMirror(env = process.env) {
  const publicDir = String(env.ANVIL_REFERENCE_PUBLIC_DIR || "").trim();
  const baseUrl = String(env.ANVIL_REFERENCE_BASE_URL || "").trim();
  if (!publicDir || !baseUrl) return null;
  return {
    publicDir,
    baseUrl,
  };
}

function configuredBunny(env = process.env) {
  const storageZone = String(env.BUNNY_STORAGE_ZONE || "").trim();
  const accessKey = String(env.BUNNY_STORAGE_ACCESS_KEY || env.BUNNY_STORAGE_PASSWORD || "").trim();
  const pullZoneUrl = String(env.BUNNY_PULL_ZONE_URL || "").trim();
  if (!storageZone || !accessKey || !pullZoneUrl) return null;
  return {
    storageZone,
    accessKey,
    pullZoneUrl,
    endpoint: String(env.BUNNY_STORAGE_ENDPOINT || "https://storage.bunnycdn.com").trim().replace(/\/+$/, ""),
  };
}

async function buildRemotePath(projectDir, absolutePath, basename, env = process.env) {
  const buffer = await fs.readFile(absolutePath);
  const digest = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const projectSlug = slugify(path.basename(projectDir), "project");
  const ext = path.extname(basename);
  const stem = slugify(path.basename(basename, ext), "reference");
  const prefix = String(env.BUNNY_STORAGE_PATH_PREFIX || env.ANVIL_REFERENCE_PATH_PREFIX || "anvil-reference")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return {
    buffer,
    remotePath: [prefix, projectSlug, `${digest}-${stem}${ext.toLowerCase() || ".bin"}`].filter(Boolean).join("/"),
    sha256: digest,
  };
}

async function publishToPublicMirror({ projectDir, reference, env = process.env }) {
  const mirror = configuredPublicMirror(env);
  if (!mirror) return null;
  const { buffer, remotePath, sha256 } = await buildRemotePath(
    projectDir,
    reference.absolutePath,
    reference.basename,
    env,
  );
  const destination = path.resolve(mirror.publicDir, remotePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, buffer);
  return {
    backend: "public-mirror",
    publicUrl: joinUrl(mirror.baseUrl, encodeRemotePath(remotePath)),
    remotePath,
    sha256,
  };
}

async function publishToBunny({ projectDir, reference, env = process.env }) {
  const bunny = configuredBunny(env);
  if (!bunny) return null;
  const { buffer, remotePath, sha256 } = await buildRemotePath(
    projectDir,
    reference.absolutePath,
    reference.basename,
    env,
  );
  const uploadUrl = `${bunny.endpoint}/${encodeURIComponent(bunny.storageZone)}/${encodeRemotePath(remotePath)}`;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: bunny.accessKey,
      "Content-Type": contentTypeFor(reference.basename),
      Checksum: crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase(),
    },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bunny reference upload failed (${response.status}): ${text || response.statusText}`);
  }
  return {
    backend: "bunny",
    publicUrl: joinUrl(bunny.pullZoneUrl, encodeRemotePath(remotePath)),
    remotePath,
    sha256,
  };
}

async function publishAsUrl({ projectDir, reference, env = process.env }) {
  if (reference.kind === "url") {
    return {
      backend: "existing-url",
      publicUrl: reference.publicUrl,
      remotePath: null,
      sha256: null,
    };
  }
  const mirror = await publishToPublicMirror({ projectDir, reference, env });
  if (mirror) return mirror;
  const bunny = await publishToBunny({ projectDir, reference, env });
  if (bunny) return bunny;
  throw new Error(
    "URL reference staging is not configured. For URL-only providers, set ANVIL_REFERENCE_PUBLIC_DIR + ANVIL_REFERENCE_BASE_URL, or Bunny env vars BUNNY_STORAGE_ZONE, BUNNY_STORAGE_ACCESS_KEY/BUNNY_STORAGE_PASSWORD, and BUNNY_PULL_ZONE_URL.",
  );
}

async function stageReferenceMedia({ projectDir, referencePath, mode = "auto", provider = "" }) {
  const reference = await readLocalReference(projectDir, referencePath);
  const cleanMode = String(mode || "auto").trim().toLowerCase();
  const delivery = cleanMode === "url" || cleanMode === "upload"
    ? cleanMode
    : reference.kind === "url"
      ? "url"
      : preferredReferenceMode(provider);

  if (delivery === "upload") {
    if (reference.kind === "url") {
      return {
        ok: true,
        delivery: "url",
        provider: provider || null,
        publicUrl: reference.publicUrl,
        note: "Input was already a public URL, so no local upload path is needed.",
      };
    }
    return {
      ok: true,
      delivery: "upload",
      provider: provider || null,
      localPath: reference.absolutePath,
      path: reference.relativePath,
      bytes: reference.bytes,
      mediaKind: reference.mediaKind,
    };
  }

  const published = await publishAsUrl({ projectDir, reference });
  return {
    ok: true,
    delivery: "url",
    provider: provider || null,
    publicUrl: published.publicUrl,
    backend: published.backend,
    remotePath: published.remotePath,
    sourcePath: reference.relativePath || null,
    bytes: reference.bytes || null,
    mediaKind: reference.mediaKind || null,
    sha256: published.sha256,
  };
}

module.exports = {
  configuredBunny,
  configuredPublicMirror,
  isPublicHttps,
  preferredReferenceMode,
  stageReferenceMedia,
};
