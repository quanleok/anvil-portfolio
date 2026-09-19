const path = require("node:path");

const ENTITY_REF_SECTIONS = ["characters", "locations", "props", "keyframes", "audio"];
const ENTITY_REF_ROLES = new Set(["featured", "mentioned", "background"]);

function normalizeEntityRefRole(role) {
  const clean = String(role || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (clean === "primary" || clean === "main" || clean === "foreground") return "featured";
  if (clean === "secondary" || clean === "supporting") return "mentioned";
  if (clean === "bg" || clean === "backdrop") return "background";
  return ENTITY_REF_ROLES.has(clean) ? clean : "featured";
}

function normalizeEntityRefSection(section) {
  const clean = String(section || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = {
    character: "characters",
    characters: "characters",
    char: "characters",
    location: "locations",
    locations: "locations",
    loc: "locations",
    prop: "props",
    props: "props",
    keyframe: "keyframes",
    keyframes: "keyframes",
    referenceframe: "keyframes",
    audio: "audio",
    sound: "audio",
    sounds: "audio",
    music: "audio",
    sfx: "audio",
  };
  return aliases[clean] || "";
}

function parseRefsArray(rawRefs) {
  if (Array.isArray(rawRefs)) return rawRefs;
  if (rawRefs && typeof rawRefs === "object") {
    if (Array.isArray(rawRefs.entityRefs)) return rawRefs.entityRefs;
    if (Array.isArray(rawRefs.refs)) return rawRefs.refs;
    if (Array.isArray(rawRefs.items)) return rawRefs.items;
    return [];
  }
  if (typeof rawRefs !== "string") return [];
  const trimmed = rawRefs.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return parseRefsArray(parsed);
  } catch {
    return [];
  }
}

function readEntityRefSection(item) {
  return normalizeEntityRefSection(
    item?.section ?? item?.assetSection ?? item?.assetType ?? item?.kind ?? item?.type,
  );
}

function readEntityRefId(item) {
  return String(
    item?.entityId ?? item?.assetId ?? item?.asset_id ?? item?.refId ?? item?.ref ?? item?.id ?? "",
  ).trim();
}

function parseListValue(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return trimmed.slice(1, -1).split(",");
  }
  return trimmed.split(/[,;]/);
}

function extractLegacyAssetRefs(meta) {
  const out = {};
  for (const kind of ENTITY_REF_SECTIONS) {
    const items = parseListValue(meta?.[kind])
      .map((value) => String(value || "").trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    if (items.length) {
      out[kind] = items;
    }
  }
  return out;
}

function matchAssetToken(project, section, token) {
  const items = Array.isArray(project?.[section]) ? project[section] : [];
  const raw = String(token || "").trim();
  const norm = raw.toLowerCase();
  if (!norm) return null;

  const byId = items.find((item) => item?.id === raw);
  if (byId) return byId;

  const byName = items.find((item) => String(item?.name || item?.title || "").trim().toLowerCase() === norm);
  if (byName) return byName;

  const slugified = norm.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const bySlug = items.find((item) => {
    const itemSlug = String(item?.name || item?.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return itemSlug === slugified;
  });
  if (bySlug) return bySlug;

  return (
    items.find((item) =>
      String(item?.path || "").toLowerCase().includes(norm) ||
      (Array.isArray(item?.media) &&
        item.media.some((media) => String(media?.path || "").toLowerCase().includes(norm))),
    ) || null
  );
}

function normalizeEntityRefs(rawRefs) {
  const input = parseRefsArray(rawRefs);

  const seen = new Set();
  const refs = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const section = readEntityRefSection(item);
    const entityId = readEntityRefId(item);
    if (!ENTITY_REF_SECTIONS.includes(section) || !entityId) continue;
    const key = `${section}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      entityId,
      section,
      role: normalizeEntityRefRole(item.role),
    });
  }
  return refs;
}

function extractEntityRefs(meta, project) {
  const explicit = normalizeEntityRefs(meta?.entityRefs);
  const refs = [];
  const seen = new Set();

  for (const ref of explicit) {
    const key = `${ref.section}:${ref.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }

  const legacy = extractLegacyAssetRefs(meta);
  for (const section of ENTITY_REF_SECTIONS) {
    const tokens = legacy[section];
    if (!Array.isArray(tokens)) continue;
    for (const token of tokens) {
      const match = matchAssetToken(project, section, token);
      if (!match?.id) continue;
      const key = `${section}:${match.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        entityId: match.id,
        section,
        role: "featured",
      });
    }
  }
  return refs;
}

function serializeEntityRefsMeta(entityRefs, legacyAssetRefs) {
  const explicit = normalizeEntityRefs(entityRefs);
  if (!explicit.length) {
    return serializeLegacyAssetRefsMeta(legacyAssetRefs);
  }

  const bySection = Object.fromEntries(ENTITY_REF_SECTIONS.map((section) => [section, []]));
  for (const ref of explicit) {
    bySection[ref.section].push(ref.entityId);
  }

  const out = {
    entityRefs: JSON.stringify(explicit),
  };
  for (const section of ENTITY_REF_SECTIONS) {
    if (bySection[section].length) {
      out[section] = JSON.stringify(bySection[section]);
    }
  }
  return out;
}

function serializeLegacyAssetRefsMeta(assetRefs) {
  if (!assetRefs || typeof assetRefs !== "object") return {};
  const out = {};
  for (const kind of ENTITY_REF_SECTIONS) {
    const items = Array.isArray(assetRefs[kind]) ? assetRefs[kind].filter(Boolean) : [];
    if (items.length) out[kind] = JSON.stringify(items);
  }
  return out;
}

function normalizeSuppressedRefs(raw) {
  const input = parseRefsArray(raw);
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const section = readEntityRefSection(item);
    const entityId = readEntityRefId(item);
    if (!ENTITY_REF_SECTIONS.includes(section) || !entityId) continue;
    const key = `${section}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entityId, section });
  }
  return out;
}

function serializeSuppressedRefsMeta(suppressedRefs) {
  const normalized = normalizeSuppressedRefs(suppressedRefs);
  if (!normalized.length) return {};
  return { suppressedRefs: JSON.stringify(normalized) };
}

function buildAssetUsageMap(project, entries = []) {
  const usageByKey = new Map();
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.entityRefs) || !entry.entityRefs.length) continue;
    for (const ref of entry.entityRefs) {
      if (!ref?.entityId || !ref?.section) continue;
      const key = `${ref.section}:${ref.entityId}`;
      const list = usageByKey.get(key) || [];
      list.push({
        entryId: entry.id,
        entryPath: entry.path,
        entrySection: entry.entrySection,
        entryTitle: entry.title,
        role: normalizeEntityRefRole(ref.role),
        beatId: entry.beatId || null,
        sceneId: entry.sceneId || null,
        shotId: entry.shotId || null,
      });
      usageByKey.set(key, list);
    }
  }
  for (const list of usageByKey.values()) {
    list.sort((left, right) => {
      if (left.entrySection !== right.entrySection) {
        const order = { script: 0, beats: 1, shots: 2, dialogue: 3, prompts: 4 };
        return (order[left.entrySection] ?? 9) - (order[right.entrySection] ?? 9);
      }
      return String(left.entryPath || "").localeCompare(String(right.entryPath || ""));
    });
  }
  return usageByKey;
}

function attachAssetUsages(project, entries = []) {
  const usageByKey = buildAssetUsageMap(project, entries);
  const attach = (items, section) =>
    Array.isArray(items)
      ? items.map((item) => ({
          ...item,
          usedIn: usageByKey.get(`${section}:${item.id}`) || [],
        }))
      : [];

  return {
    ...project,
    characters: attach(project?.characters, "characters"),
    locations: attach(project?.locations, "locations"),
    props: attach(project?.props, "props"),
    keyframes: attach(project?.keyframes, "keyframes"),
    audio: attach(project?.audio, "audio"),
  };
}

module.exports = {
  ENTITY_REF_SECTIONS,
  extractLegacyAssetRefs,
  matchAssetToken,
  normalizeEntityRefs,
  normalizeSuppressedRefs,
  extractEntityRefs,
  serializeEntityRefsMeta,
  serializeLegacyAssetRefsMeta,
  serializeSuppressedRefsMeta,
  buildAssetUsageMap,
  attachAssetUsages,
};
