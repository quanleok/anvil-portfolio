const path = require("node:path");

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRelativePath(value) {
  return trimString(value).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readMetaString(meta, keys) {
  if (!meta || typeof meta !== "object") return "";
  for (const key of keys) {
    const value = trimString(meta[key]);
    if (value) return value;
  }
  return "";
}

function readPositiveNumberFromMeta(meta, keys) {
  if (!meta || typeof meta !== "object") return null;
  for (const key of keys) {
    const parsed = parsePositiveNumber(meta[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readDurationSec(meta) {
  return readPositiveNumberFromMeta(meta, [
    "durationSec",
    "durationSeconds",
    "duration_seconds",
    "runtimeSec",
    "runtimeSeconds",
    "runtime_seconds",
    "seconds",
    "duration",
  ]);
}

function stripMarkdownExtension(value) {
  return String(value || "").replace(/\.(md|markdown)$/i, "");
}

function stripScenePrefix(value) {
  return String(value || "")
    .replace(/^scene[-_\s]*\d+[-_\s]*/i, "")
    .replace(/^\d+[\s._-]+/, "");
}

function lookupKey(value) {
  return stripScenePrefix(stripMarkdownExtension(value))
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sceneFolderFromRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/");
  return parts.length > 2 && ["beats", "shots", "prompts", "dialogue"].includes(parts[0]) ? parts[1] : "";
}

function addSceneLookup(map, key, scene) {
  if (!key || !scene || typeof scene !== "object") return;
  if (!map.has(key)) map.set(key, scene);
}

function buildSceneLookup(scenes) {
  const map = new Map();
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (!scene || typeof scene !== "object") continue;
    const id = trimString(scene.id);
    const scenePath = normalizeRelativePath(scene.path);
    const title = trimString(scene.title);
    if (id) addSceneLookup(map, `id:${id}`, scene);
    if (scenePath) {
      addSceneLookup(map, `path:${scenePath}`, scene);
      const stem = path.posix.basename(scenePath, path.posix.extname(scenePath));
      addSceneLookup(map, `key:${lookupKey(stem)}`, scene);
      addSceneLookup(map, `key:${lookupKey(stripScenePrefix(stem))}`, scene);
    }
    if (title) addSceneLookup(map, `key:${lookupKey(title)}`, scene);
  }
  return map;
}

function linkFromScene(scene) {
  if (!scene || typeof scene !== "object") return null;
  const id = trimString(scene.id);
  if (!id) return null;
  return {
    sceneId: id,
    scenePath: normalizeRelativePath(scene.path) || null,
  };
}

function resolveSceneLink(meta, relativePath, scenes, fallbackScene) {
  const lookup = buildSceneLookup(scenes);
  const directId = readMetaString(meta, ["sceneId", "scene_id", "parentSceneId", "parent_scene_id"]);
  const directPath = readMetaString(meta, ["scenePath", "scene_path", "parentScenePath", "parent_scene_path"]);

  if (directId) {
    const matched = lookup.get(`id:${directId}`);
    return {
      sceneId: matched?.id || directId,
      scenePath: normalizeRelativePath(matched?.path || directPath || fallbackScene?.path) || null,
    };
  }

  const pathCandidates = [directPath].filter(Boolean);
  for (const candidate of pathCandidates) {
    const normalized = normalizeRelativePath(candidate);
    const matched =
      lookup.get(`path:${normalized}`) ||
      lookup.get(`path:scenes/${normalized}`) ||
      lookup.get(`key:${lookupKey(normalized)}`);
    if (matched) return linkFromScene(matched);
  }

  const nameCandidates = [
    readMetaString(meta, ["scene", "sceneName", "scene_name", "sceneTitle", "scene_title", "parentScene", "parent_scene", "sceneSlug", "scene_slug"]),
    sceneFolderFromRelativePath(relativePath),
  ].filter(Boolean);

  for (const candidate of nameCandidates) {
    const matched = lookup.get(`id:${candidate}`) || lookup.get(`key:${lookupKey(candidate)}`);
    if (matched) return linkFromScene(matched);
  }

  const fallback = linkFromScene(fallbackScene);
  if (fallback) return fallback;

  return {
    sceneId: null,
    scenePath: directPath ? normalizeRelativePath(directPath) : null,
  };
}

module.exports = {
  readDurationSec,
  readMetaString,
  readPositiveNumberFromMeta,
  resolveSceneLink,
};
