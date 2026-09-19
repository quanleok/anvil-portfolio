const fs = require("node:fs/promises");
const path = require("node:path");

const EVOLINK_BASE_URL = "https://api.evolink.ai";
const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_VIDEO_MODEL = "seedance-2.0-fast-text-to-video";
const DEFAULT_MUSIC_MODEL = "suno-v5-beta";

const IMAGE_MODEL_ALIASES = {
  "nanobanana-pro": "gemini-3-pro-image-preview",
  "nanobanana-2": "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
};

const VIDEO_MODEL_ALIASES = {
  "seedance-2.0": "seedance-2.0-fast-text-to-video",
  "seedance-2.0-text": "seedance-2.0-text-to-video",
  "seedance-2.0-image": "seedance-2.0-image-to-video",
  "seedance-2.0-reference": "seedance-2.0-reference-to-video",
  "seedance-2.0-fast-text": "seedance-2.0-fast-text-to-video",
  "seedance-2.0-fast-image": "seedance-2.0-fast-image-to-video",
  "seedance-2.0-fast-reference": "seedance-2.0-fast-reference-to-video",
  "seedance-2.0-text-to-video": "seedance-2.0-text-to-video",
  "seedance-2.0-image-to-video": "seedance-2.0-image-to-video",
  "seedance-2.0-reference-to-video": "seedance-2.0-reference-to-video",
  "seedance-2.0-fast-text-to-video": "seedance-2.0-fast-text-to-video",
  "seedance-2.0-fast-image-to-video": "seedance-2.0-fast-image-to-video",
  "seedance-2.0-fast-reference-to-video": "seedance-2.0-fast-reference-to-video",
};

const MUSIC_MODEL_ALIASES = {
  "suno-v5": "suno-v5-beta",
  "suno-v5-beta": "suno-v5-beta",
  "suno-v4.5plus": "suno-v4.5plus-beta",
  "suno-v4.5plus-beta": "suno-v4.5plus-beta",
  "suno-v4.5all": "suno-v4.5all-beta",
  "suno-v4.5all-beta": "suno-v4.5all-beta",
  "suno-v4.5": "suno-v4.5-beta",
  "suno-v4.5-beta": "suno-v4.5-beta",
  "suno-v4": "suno-v4-beta",
  "suno-v4-beta": "suno-v4-beta",
};

function requireApiKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("EvoLink API key is not configured. Add it in Forge Copilot Settings first.");
  }
  return apiKey.trim();
}

function normalizeAlias(model, aliases, fallback) {
  const raw = typeof model === "string" ? model.trim() : "";
  if (!raw) {
    return fallback;
  }
  return aliases[raw] || raw;
}

function normalizeImageModel(model) {
  return normalizeAlias(model, IMAGE_MODEL_ALIASES, DEFAULT_IMAGE_MODEL);
}

function normalizeVideoModel(model) {
  return normalizeAlias(model, VIDEO_MODEL_ALIASES, DEFAULT_VIDEO_MODEL);
}

function normalizeMusicModel(model) {
  return normalizeAlias(model, MUSIC_MODEL_ALIASES, DEFAULT_MUSIC_MODEL);
}

function parseResponseText(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Parse a Retry-After header. Spec allows either a delta-seconds integer
// or an HTTP-date. Returns seconds until retry, or null if unparseable.
// Negative delta-seconds is malformed — returns null rather than falling
// through to date parsing (which would otherwise misinterpret "-3" as a
// historical year).
function parseRetryAfter(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.ceil(seconds) : null;
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  const diff = Math.ceil((ms - Date.now()) / 1000);
  return diff > 0 ? diff : 0;
}

// Map an HTTP status to a coarse error kind so the UI can show a CTA
// the user can act on (open settings, manage credits, retry).
function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  if (status >= 400) return "payload";
  return "server";
}

function attachErrorMeta(err, meta) {
  if (!err || typeof err !== "object") return err;
  if (meta.kind && !err.kind) err.kind = meta.kind;
  if (Number.isFinite(meta.status) && err.status === undefined) err.status = meta.status;
  if (meta.provider && !err.provider) err.provider = meta.provider;
  if (Number.isFinite(meta.retryAfterSec) && err.retryAfterSec === undefined) {
    err.retryAfterSec = meta.retryAfterSec;
  }
  return err;
}

function buildError(prefix, status, payload) {
  const message =
    payload?.error?.message ||
    payload?.message ||
    payload?.raw ||
    `HTTP ${status}`;
  const err = new Error(`${prefix} (${status}): ${message}`);
  return attachErrorMeta(err, {
    kind: classifyHttpStatus(status),
    status,
    provider: "evolink",
  });
}

// fetch wrapper with an AbortController-backed timeout. Without this
// a hung HTTP socket would block the agent indefinitely (Node fetch has
// no built-in timeout). All evolink network calls flow through here.
async function evolinkFetch(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      const timeoutErr = new Error(
        `EvoLink request timed out after ${Math.round(timeoutMs / 1000)}s. Check your network or try again.`,
      );
      throw attachErrorMeta(timeoutErr, { kind: "timeout", provider: "evolink" });
    }
    throw attachErrorMeta(err, { kind: "network", provider: "evolink" });
  } finally {
    clearTimeout(timer);
  }
}

async function evolinkRequest(method, route, apiKey, payload, { timeoutMs = 60_000 } = {}) {
  const response = await evolinkFetch(
    `${EVOLINK_BASE_URL}${route}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${requireApiKey(apiKey)}`,
        "Content-Type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : undefined,
    },
    timeoutMs,
  );

  const rawText = await response.text();
  const parsed = parseResponseText(rawText);
  if (!response.ok) {
    const err = buildError(`EvoLink ${method} ${route} failed`, response.status, parsed);
    const retryAfterSec = parseRetryAfter(response.headers.get("retry-after"));
    if (retryAfterSec != null) attachErrorMeta(err, { retryAfterSec });
    throw err;
  }
  return parsed;
}

function looksLikeUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function collectUrls(value, output = []) {
  if (looksLikeUrl(value)) {
    output.push(value.trim());
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectUrls(entry, output));
    return output;
  }

  if (!value || typeof value !== "object") {
    return output;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "image_urls" ||
      normalizedKey === "video_urls"
    ) {
      continue;
    }
    if (
      normalizedKey.includes("result") ||
      normalizedKey.includes("output") ||
      normalizedKey.includes("media") ||
      normalizedKey.includes("file") ||
      normalizedKey.includes("url") ||
      normalizedKey === "data" ||
      normalizedKey === "items"
    ) {
      collectUrls(nested, output);
    }
  }
  return output;
}

function extractResultUrls(task) {
  const candidates = [
    task?.results,
    task?.result,
    task?.output,
    task?.outputs,
    task?.result_data,
    task?.data,
    task?.media,
    task?.files,
  ];

  const urls = [];
  for (const candidate of candidates) {
    collectUrls(candidate, urls);
  }

  return Array.from(new Set(urls)).filter(Boolean);
}

async function getTaskDetail(taskId, apiKey) {
  // Per-poll timeout shorter than the create timeout — a stuck poll
  // shouldn't pin the loop for a full minute when the next poll is
  // due in 5s anyway.
  return evolinkRequest("GET", `/v1/tasks/${encodeURIComponent(taskId)}`, apiKey, undefined, { timeoutMs: 30_000 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTaskFailure(task) {
  return (
    task?.error?.message ||
    task?.message ||
    task?.result_data?.error?.message ||
    "Task failed."
  );
}

async function waitForTask(taskId, apiKey, { intervalMs = 5000, timeoutMs = 8 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  let consecutiveRateLimits = 0;

  while (Date.now() - startedAt < timeoutMs) {
    let task;
    try {
      task = await getTaskDetail(taskId, apiKey);
    } catch (error) {
      // 429 during polling — back off and keep waiting instead of killing
      // the whole task watch. Honors Retry-After when the server sent one;
      // otherwise exponential backoff capped at 60s.
      if (error && error.kind === "rate-limit") {
        consecutiveRateLimits += 1;
        const headerSec = Number(error.retryAfterSec);
        const headerMs = Number.isFinite(headerSec) && headerSec > 0 ? headerSec * 1000 : null;
        const backoffMs =
          headerMs ?? Math.min(60_000, intervalMs * 2 ** Math.min(consecutiveRateLimits, 4));
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await sleep(Math.min(backoffMs, remaining));
        continue;
      }
      throw error;
    }
    consecutiveRateLimits = 0;
    const status = String(task?.status || "").toLowerCase();
    if (status === "completed") {
      return task;
    }
    if (status === "failed" || status === "cancelled") {
      const failureErr = new Error(`EvoLink task ${taskId} ${status}: ${extractTaskFailure(task)}`);
      throw attachErrorMeta(failureErr, { kind: "server", provider: "evolink" });
    }
    await sleep(intervalMs);
  }

  const timeoutErr = new Error(`Timed out waiting for EvoLink task ${taskId}.`);
  throw attachErrorMeta(timeoutErr, { kind: "timeout", provider: "evolink" });
}

function inferUrlExtension(url, fallbackExtension = "") {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = path.extname(pathname);
    if (ext) {
      return ext;
    }
  } catch {}
  return fallbackExtension || ".bin";
}

function inferContentTypeExtension(contentType, fallbackExtension = "") {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("image/jpeg")) return ".jpg";
  if (normalized.includes("image/png")) return ".png";
  if (normalized.includes("image/webp")) return ".webp";
  if (normalized.includes("image/gif")) return ".gif";
  if (normalized.includes("image/avif")) return ".avif";
  if (normalized.includes("audio/mpeg")) return ".mp3";
  if (normalized.includes("audio/wav")) return ".wav";
  if (normalized.includes("video/mp4")) return ".mp4";
  if (normalized.includes("video/quicktime")) return ".mov";
  if (normalized.includes("video/webm")) return ".webm";
  return fallbackExtension || ".bin";
}

async function downloadResult(url, destinationPath, apiKey) {
  const evoHost = (() => {
    try {
      return /(^|\.)evolink\.ai$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  })();

  // 5min download cap — generated videos can be tens of MB on slow links;
  // 30s would false-positive while a real timeout still saves us from
  // a fully-hung CDN.
  const response = await evolinkFetch(
    url,
    {
      headers: evoHost
        ? {
            Authorization: `Bearer ${requireApiKey(apiKey)}`,
          }
        : undefined,
    },
    5 * 60 * 1000,
  );

  if (!response.ok) {
    const dlErr = new Error(`Failed to download generated media (${response.status}) from ${url}`);
    throw attachErrorMeta(dlErr, {
      kind: classifyHttpStatus(response.status),
      status: response.status,
      provider: "evolink",
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, buffer);
  return {
    bytes: buffer.byteLength,
    extension: inferContentTypeExtension(response.headers.get("content-type"), inferUrlExtension(url)),
  };
}

async function createImageTask(payload, apiKey) {
  return evolinkRequest("POST", "/v1/images/generations", apiKey, payload);
}

async function createVideoTask(payload, apiKey) {
  return evolinkRequest("POST", "/v1/videos/generations", apiKey, payload);
}

async function createMusicTask(payload, apiKey) {
  return evolinkRequest("POST", "/v1/audios/generations", apiKey, payload);
}

module.exports = {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  attachErrorMeta,
  classifyHttpStatus,
  createImageTask,
  createMusicTask,
  createVideoTask,
  downloadResult,
  extractResultUrls,
  inferContentTypeExtension,
  inferUrlExtension,
  normalizeImageModel,
  normalizeMusicModel,
  normalizeVideoModel,
  parseRetryAfter,
  waitForTask,
};
