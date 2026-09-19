const path = require("node:path");

const DEFAULT_MASTER_SCRIPT_PATH = "script/master-script.md";

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function titleFromRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const base = path.posix.basename(normalized, path.posix.extname(normalized));
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/^\s*(?:scene|sequence|chapter|prompt|clip)\s*\d+(?:\.\d+)*\s*[—\-:.)·]?\s*/i, "")
    .replace(/^\s*\d+(?:\.\d+)*\s*[—\-:.)·]\s*/u, "")
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[`*_#[\](){}"']/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pushUnique(list, seen, value) {
  const key = String(value || "").trim();
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push(key);
}

function isUsefulSceneTitleKey(key) {
  const normalized = String(key || "").trim();
  if (!normalized) return false;
  const generic = new Set([
    "master script",
    "scene file order",
    "runtime allocation",
    "prompt plan",
    "shot plan",
    "story function",
    "runtime estimate",
    "continuity notes",
    "linked assets",
    "characters",
    "locations",
    "props",
    "audio",
    "project context",
    "canon context",
    "asset context",
    "agent context",
  ]);
  return !generic.has(normalized);
}

function cleanSceneTitleCandidate(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text
    .replace(/\[[^\]]+\]\([^)]+\)/g, (match) => {
      const inner = match.match(/^\[([^\]]+)\]/);
      return inner?.[1] || match;
    })
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*(scene\s*)?\d+(?:\.\d+)*\s*[.)—\-:·]?\s*/i, "")
    .replace(/\s+\([^)]*\d+\s*(?:s|sec|second|min|m)\b[^)]*\)\s*$/i, "")
    .replace(/\s+[—-]\s+\d+(?::\d+)?\s*(?:s|sec|second|min|m)?\s*$/i, "")
    .replace(/\s+[—-]\s+\d+\s*prompts?\s*$/i, "")
    .replace(/\s+[—-]\s+\d+\s*beats?\s*$/i, "")
    .replace(/\s*[:：]\s*$/, "")
    .replace(/[.,;]+$/g, "")
    .trim();
  if (!text || text.includes("scenes/") || text.length > 100) return "";
  return text;
}

function cleanSluglineTitleCandidate(value) {
  const line = String(value || "").trim();
  const match = line.match(/^(?:[-*]\s*)?(?:INT|EXT|INT\/EXT|I\/E)\.?\s+(.+)$/i);
  if (!match?.[1]) return "";
  const location = match[1]
    .replace(/\s+(?:[—-]|–)\s*(?:DAY|NIGHT|DAWN|DUSK|MORNING|AFTERNOON|EVENING|SUNRISE|SUNSET|CONTINUOUS|LATER|MOMENTS LATER|SAME TIME|FLASHBACK|PRESENT).*$/i, "")
    .replace(/\s+\((?:DAY|NIGHT|DAWN|DUSK|MORNING|AFTERNOON|EVENING|CONTINUOUS|LATER)[^)]*\)\s*$/i, "")
    .trim();
  return cleanSceneTitleCandidate(location);
}

function extractMasterSceneOrderHints(masterContent) {
  const text = typeof masterContent === "string" ? masterContent : "";
  const paths = [];
  const titles = [];
  const seenPaths = new Set();
  const seenTitles = new Set();
  const pushTitle = (candidate) => {
    const cleaned = cleanSceneTitleCandidate(candidate);
    const normalized = normalizeTitle(cleaned);
    if (isUsefulSceneTitleKey(normalized)) pushUnique(titles, seenTitles, normalized);
  };

  const pathRe = /(?:^|[\s("'`])((?:\.\/)?scenes\/[^\s"'`)]+?\.md)\b/gi;
  for (const match of text.matchAll(pathRe)) {
    pushUnique(paths, seenPaths, normalizeRelativePath(match[1]));
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const explicitPath = line.match(/(?:^|[\s("'`])((?:\.\/)?scenes\/[^\s"'`)]+?\.md)\b/i);
    if (explicitPath?.[1]) {
      pushUnique(paths, seenPaths, normalizeRelativePath(explicitPath[1]));
    }

    const markdownHeading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (markdownHeading?.[1]) pushTitle(markdownHeading[1]);

    const plainSceneHeading =
      line.match(/^\s*(?:[-*]\s*)?(?:scene|sequence|chapter)\s*\d+(?:\.\d+)*\s*[.)—\-:·]?\s+(.+)$/i) ||
      line.match(/^\s*(?:[-*]\s*)?(?:scene|sequence|chapter)\s*[—\-:·]\s+(.+)$/i);
    if (plainSceneHeading?.[1]) pushTitle(plainSceneHeading[1]);

    const numbered =
      line.match(/^\s*(?:[-*]\s*)?\d+(?:\.\d+)*\s*[.)]\s+(.+)$/) ||
      line.match(/^\s*(?:[-*]\s*)?\d+(?:\.\d+)*\s+[—-]\s+(.+)$/) ||
      line.match(/^\s*#{2,4}\s+(?:scene\s*)?\d+(?:\.\d+)*\s*[—\-:.)·]\s*(.+)$/i);
    if (numbered?.[1]) pushTitle(numbered[1]);

    const sluglineTitle = cleanSluglineTitleCandidate(line);
    if (sluglineTitle) pushTitle(sluglineTitle);
  }

  return { paths, titles };
}

function numericOrderFromMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  for (const key of ["order", "sceneOrder", "scene_order", "sceneNumber", "scene_number", "index", "position"]) {
    const value = meta[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function numericOrderFromEntry(scene) {
  const parsed = Number(scene?.sceneOrder);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numericOrderFromPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const base = path.posix.basename(normalized, path.posix.extname(normalized));
  const match = base.match(/^(?:scene[-_])?(\d{1,4})(?:[-_\s]|$)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numericPromptOrderFromPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const base = path.posix.basename(normalized, path.posix.extname(normalized));
  const match = base.match(/^(?:prompt[-_])?(\d{1,4})(?:[-_\s]|$)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numericOrderFromPromptEntry(prompt, contentRankById) {
  const segmentIndex = Number(prompt?.segmentIndex);
  if (Number.isFinite(segmentIndex) && segmentIndex > 0) {
    return { bucket: 0, value: segmentIndex };
  }

  const explicitKeys = ["promptOrder", "prompt_order", "order", "index", "position"];
  for (const key of explicitKeys) {
    const parsed = Number(prompt?.[key] ?? prompt?.meta?.[key]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { bucket: 1, value: parsed };
    }
  }

  const contentRank = prompt?.id ? contentRankById?.get(prompt.id) : null;
  if (Number.isFinite(contentRank)) {
    return { bucket: 2, value: contentRank };
  }

  const pathOrder = numericPromptOrderFromPath(prompt?.path);
  if (Number.isFinite(pathOrder)) {
    return { bucket: 3, value: pathOrder };
  }

  return { bucket: 4, value: 0 };
}

function buildOrderMap(values) {
  const map = new Map();
  values.forEach((value, index) => {
    if (!map.has(value)) map.set(value, index);
  });
  return map;
}

function orderRankForScene(scene, hints) {
  const entryOrder = numericOrderFromEntry(scene);
  if (Number.isFinite(entryOrder)) return { bucket: 0, value: entryOrder };

  const pathKey = normalizeRelativePath(scene?.path);
  const pathOrder = hints.pathOrder.get(pathKey);
  if (Number.isFinite(pathOrder)) return { bucket: 1, value: pathOrder };

  const titleKeys = [
    normalizeTitle(scene?.title),
    normalizeTitle(titleFromRelativePath(pathKey)),
  ].filter(Boolean);
  for (const titleKey of titleKeys) {
    const titleOrder = hints.titleOrder.get(titleKey);
    if (Number.isFinite(titleOrder)) return { bucket: 1, value: titleOrder };
  }

  for (const titleKey of titleKeys) {
    const tokenCount = titleKey.split(/\s+/).filter(Boolean).length;
    if (titleKey.length < 8 && tokenCount < 2) continue;
    const occurrence = typeof hints.normalizedContent === "string"
      ? hints.normalizedContent.indexOf(titleKey)
      : -1;
    if (occurrence >= 0) return { bucket: 2, value: occurrence };
  }

  const metaOrder = numericOrderFromMeta(scene?.meta);
  if (Number.isFinite(metaOrder)) return { bucket: 3, value: metaOrder };

  const pathNumericOrder = numericOrderFromPath(pathKey);
  if (Number.isFinite(pathNumericOrder)) return { bucket: 4, value: pathNumericOrder };

  return { bucket: 5, value: 0 };
}

function buildScriptHintMap(scriptEntries, defaultScriptPath = DEFAULT_MASTER_SCRIPT_PATH) {
  const scripts = Array.isArray(scriptEntries) ? scriptEntries : [];
  const map = new Map();
  for (const script of scripts) {
    const scriptPath = normalizeRelativePath(script?.path || defaultScriptPath);
    const extracted = extractMasterSceneOrderHints(script?.content || "");
    map.set(scriptPath, {
      pathOrder: buildOrderMap(extracted.paths),
      titleOrder: buildOrderMap(extracted.titles),
      normalizedContent: normalizeTitle(script?.content || ""),
    });
  }
  if (!map.has(defaultScriptPath)) {
    map.set(defaultScriptPath, {
      pathOrder: new Map(),
      titleOrder: new Map(),
      normalizedContent: "",
    });
  }
  return map;
}

function sortSceneEntriesByScriptOrder(scenes, scriptEntries = [], options = {}) {
  const defaultScriptPath = normalizeRelativePath(options.defaultScriptPath || DEFAULT_MASTER_SCRIPT_PATH);
  const hintMap = buildScriptHintMap(scriptEntries, defaultScriptPath);
  const defaultHints = hintMap.get(defaultScriptPath) || { pathOrder: new Map(), titleOrder: new Map() };
  return [...(Array.isArray(scenes) ? scenes : [])]
    .map((scene, index) => {
      const parentScriptPath = normalizeRelativePath(scene?.parentScriptPath || defaultScriptPath) || defaultScriptPath;
      const hints = hintMap.get(parentScriptPath) || defaultHints;
      let rank = orderRankForScene(scene, hints);
      if (rank.bucket > 2 && hints !== defaultHints) {
        const fallbackRank = orderRankForScene(scene, defaultHints);
        if (fallbackRank.bucket <= 2) rank = fallbackRank;
      }
      return { scene, index, rank };
    })
    .sort((left, right) => {
      if (left.rank.bucket !== right.rank.bucket) return left.rank.bucket - right.rank.bucket;
      if (left.rank.value !== right.rank.value) return left.rank.value - right.rank.value;
      return left.index - right.index;
    })
    .map((item) => item.scene);
}

function comparePromptBase(left, right, originalIndexById, contentRankById) {
  const leftRank = numericOrderFromPromptEntry(left, contentRankById);
  const rightRank = numericOrderFromPromptEntry(right, contentRankById);
  if (leftRank.bucket !== rightRank.bucket) return leftRank.bucket - rightRank.bucket;
  if (leftRank.value !== rightRank.value) return leftRank.value - rightRank.value;
  return (originalIndexById.get(left?.id) ?? 0) - (originalIndexById.get(right?.id) ?? 0);
}

function orderPromptChain(prompts, originalIndexById, contentRankById) {
  const items = Array.isArray(prompts) ? prompts : [];
  const ids = new Set(items.map((item) => item?.id).filter(Boolean));
  const nextByPrev = new Map();
  const starts = [];

  for (const prompt of items) {
    const prevId = typeof prompt?.prevPromptId === "string" ? prompt.prevPromptId.trim() : "";
    if (prevId && ids.has(prevId) && prevId !== prompt.id) {
      const list = nextByPrev.get(prevId) || [];
      list.push(prompt);
      nextByPrev.set(prevId, list);
    } else {
      starts.push(prompt);
    }
  }

  const compare = (a, b) => comparePromptBase(a, b, originalIndexById, contentRankById);
  starts.sort(compare);
  for (const list of nextByPrev.values()) {
    list.sort(compare);
  }

  const result = [];
  const seen = new Set();
  const visit = (prompt) => {
    if (!prompt?.id || seen.has(prompt.id)) return;
    seen.add(prompt.id);
    result.push(prompt);
    const next = nextByPrev.get(prompt.id) || [];
    for (const item of next) visit(item);
  };

  for (const prompt of starts) visit(prompt);
  for (const prompt of items.slice().sort(compare)) visit(prompt);
  return result;
}

function orderPromptGroup(prompts, originalIndexById, contentRankById) {
  const items = Array.isArray(prompts) ? prompts : [];
  const ids = new Set(items.map((item) => item?.id).filter(Boolean));
  const childrenByParent = new Map();
  const topLevel = [];
  const orphanedChildren = [];

  for (const prompt of items) {
    const parentId = typeof prompt?.parentPromptId === "string" ? prompt.parentPromptId.trim() : "";
    if (parentId && ids.has(parentId) && parentId !== prompt.id) {
      const children = childrenByParent.get(parentId) || [];
      children.push(prompt);
      childrenByParent.set(parentId, children);
    } else if (parentId) {
      orphanedChildren.push(prompt);
    } else {
      topLevel.push(prompt);
    }
  }

  const ordered = [];
  for (const prompt of orderPromptChain(topLevel, originalIndexById, contentRankById)) {
    ordered.push(prompt);
    const children = childrenByParent.get(prompt.id) || [];
    ordered.push(...orderPromptChain(children, originalIndexById, contentRankById));
  }
  ordered.push(...orderPromptChain(orphanedChildren, originalIndexById, contentRankById));
  return ordered;
}

function promptSceneKey(prompt) {
  if (prompt?.sceneId) return `id:${prompt.sceneId}`;
  const scenePath = normalizeRelativePath(prompt?.scenePath);
  if (scenePath) return `path:${scenePath}`;
  const promptPath = normalizeRelativePath(prompt?.path);
  const parts = promptPath.split("/");
  if (parts.length > 2 && parts[0] === "prompts") return `folder:${parts[1]}`;
  return "__unscoped__";
}

function buildPromptSceneRank(scenes) {
  const rank = new Map();
  (Array.isArray(scenes) ? scenes : []).forEach((scene, index) => {
    if (scene?.id) rank.set(`id:${scene.id}`, index);
    const scenePath = normalizeRelativePath(scene?.path);
    if (scenePath) {
      rank.set(`path:${scenePath}`, index);
      rank.set(`folder:${path.posix.basename(scenePath, path.posix.extname(scenePath))}`, index);
    }
  });
  return rank;
}

function buildPromptSceneContentByKey(scenes) {
  const contentByKey = new Map();
  (Array.isArray(scenes) ? scenes : []).forEach((scene) => {
    const content = normalizeTitle(scene?.content || "");
    if (!content) return;
    if (scene?.id) contentByKey.set(`id:${scene.id}`, content);
    const scenePath = normalizeRelativePath(scene?.path);
    if (scenePath) {
      contentByKey.set(`path:${scenePath}`, content);
      contentByKey.set(`folder:${path.posix.basename(scenePath, path.posix.extname(scenePath))}`, content);
    }
  });
  return contentByKey;
}

function promptTitleKeys(prompt) {
  const values = [
    normalizeTitle(prompt?.title),
    normalizeTitle(titleFromRelativePath(prompt?.path)),
  ].filter(Boolean);
  return [...new Set(values)];
}

function buildPromptContentRank(prompts, scenes) {
  const contentBySceneKey = buildPromptSceneContentByKey(scenes);
  const ranks = new Map();
  for (const prompt of Array.isArray(prompts) ? prompts : []) {
    if (!prompt?.id) continue;
    const sceneContent = contentBySceneKey.get(promptSceneKey(prompt));
    if (!sceneContent) continue;
    let best = Number.POSITIVE_INFINITY;
    for (const titleKey of promptTitleKeys(prompt)) {
      const tokenCount = titleKey.split(/\s+/).filter(Boolean).length;
      if (titleKey.length < 8 && tokenCount < 2) continue;
      const index = sceneContent.indexOf(titleKey);
      if (index >= 0 && index < best) best = index;
    }
    if (Number.isFinite(best)) ranks.set(prompt.id, best);
  }
  return ranks;
}

function sortPromptEntriesByStoryOrder(prompts, options = {}) {
  const items = [...(Array.isArray(prompts) ? prompts : [])];
  const originalIndexById = new Map();
  items.forEach((prompt, index) => {
    if (prompt?.id && !originalIndexById.has(prompt.id)) originalIndexById.set(prompt.id, index);
  });

  const sceneRank = buildPromptSceneRank(options.scenes);
  const contentRankById = buildPromptContentRank(items, options.scenes);
  const firstGroupIndex = new Map();
  const groups = new Map();
  items.forEach((prompt, index) => {
    const key = promptSceneKey(prompt);
    if (!firstGroupIndex.has(key)) firstGroupIndex.set(key, index);
    const list = groups.get(key) || [];
    list.push(prompt);
    groups.set(key, list);
  });

  return [...groups.entries()]
    .sort((left, right) => {
      const leftKnown = sceneRank.has(left[0]);
      const rightKnown = sceneRank.has(right[0]);
      if (leftKnown && rightKnown) {
        return (sceneRank.get(left[0]) ?? 0) - (sceneRank.get(right[0]) ?? 0);
      }
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      return (firstGroupIndex.get(left[0]) ?? 0) - (firstGroupIndex.get(right[0]) ?? 0);
    })
    .flatMap(([, group]) => orderPromptGroup(group, originalIndexById, contentRankById));
}

module.exports = {
  DEFAULT_MASTER_SCRIPT_PATH,
  extractMasterSceneOrderHints,
  normalizeRelativePath,
  normalizeTitle,
  sortPromptEntriesByStoryOrder,
  sortSceneEntriesByScriptOrder,
};
