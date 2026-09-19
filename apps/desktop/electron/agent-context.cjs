const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const IGNORE_DIRS = new Set([".forge", "node_modules", ".git", ".DS_Store", "release", "dist"]);
const MAX_SNAPSHOT_ENTRIES = 4000;
// Specific .forge files that the agent should know about even though .forge is otherwise ignored.
const FORGE_VISIBLE_FILES = [
  ".forge/project.json",
  ".forge/index.json",
  ".forge/agent-note.md",
  ".forge/memory/MEMORY.md",
];

const PATH_ALIASES = new Map([
  ["project.json", ".forge/project.json"],
  ["index.json", ".forge/index.json"],
  ["chats", ".forge/chats"],
  ["memory", ".forge/memory"],
  ["agent note", ".forge/agent-note.md"],
  ["agent-note", ".forge/agent-note.md"],
  ["agent_note", ".forge/agent-note.md"],
  ["topics", ".forge/memory/topics"],
  ["MEMORY.md", ".forge/memory/MEMORY.md"],
  ["memory.md", ".forge/memory/MEMORY.md"],
  ["scripts", "scenes"],
  ["shot", "shots"],
  ["prompt", "prompts"],
  ["character", "assets/characters"],
  ["location", "assets/locations"],
  ["prop", "assets/props"],
  ["keyframe", "assets/keyframes"],
  ["audio", "assets/audio"],
]);

async function walkProject(projectDir) {
  const files = [];
  async function walk(currentDir, rel) {
    if (files.length >= MAX_SNAPSHOT_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SNAPSHOT_ENTRIES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        files.push({ path: childRel, kind: "dir" });
        await walk(path.join(currentDir, entry.name), childRel);
      } else if (entry.isFile()) {
        let size = 0;
        let mtimeMs = 0;
        try {
          const stat = await fs.stat(path.join(currentDir, entry.name));
          size = stat.size;
          mtimeMs = stat.mtimeMs;
        } catch {}
        files.push({ path: childRel, kind: "file", size, mtimeMs });
      }
    }
  }
  await walk(projectDir, "");
  // Include specific .forge/* files that the agent should know about.
  for (const visible of FORGE_VISIBLE_FILES) {
    try {
      const stat = await fs.stat(path.join(projectDir, visible));
      if (stat.isFile()) {
        files.push({ path: visible, kind: "file", size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {}
  }
  // Surface memory topic files (they live under .forge/memory/topics/*.md).
  try {
    const topicsDir = path.join(projectDir, ".forge", "memory", "topics");
    const entries = await fs.readdir(topicsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const stat = await fs.stat(path.join(topicsDir, entry.name));
        files.push({
          path: `.forge/memory/topics/${entry.name}`,
          kind: "file",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {}
    }
  } catch {}
  return files;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) row[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function normalize(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function buildSnapshot(files) {
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  const byBasename = new Map();
  const byBaseLower = new Map();
  for (const entry of files) {
    const base = path.posix.basename(entry.path);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(entry);
    const lower = base.toLowerCase();
    if (!byBaseLower.has(lower)) byBaseLower.set(lower, []);
    byBaseLower.get(lower).push(entry);
  }

  const topLevel = files
    .filter((entry) => entry.kind === "dir" && !entry.path.includes("/"))
    .map((entry) => entry.path);

  const outline = summarizeOutline(files);

  function autoCorrect(requestedPath, expectedKind) {
    const target = normalize(requestedPath);
    if (!target) return null;
    if (byPath.has(target)) {
      const entry = byPath.get(target);
      if (!expectedKind || entry.kind === expectedKind) return null;
    }

    // 1. Direct alias
    if (PATH_ALIASES.has(target)) {
      const aliased = PATH_ALIASES.get(target);
      const entry = byPath.get(aliased);
      if (entry && (!expectedKind || entry.kind === expectedKind)) {
        return { path: aliased, reason: "alias", confidence: "high" };
      }
    }

    // 2. Missing .md extension on a markdown file
    if (expectedKind !== "dir" && !path.posix.extname(target)) {
      const withMd = `${target}.md`;
      const entry = byPath.get(withMd);
      if (entry && entry.kind === "file") {
        return { path: withMd, reason: "added .md", confidence: "high" };
      }
    }

    // 3. Missing .forge/ prefix
    if (expectedKind !== "dir") {
      const withForge = `.forge/${target}`;
      const entry = byPath.get(withForge);
      if (entry && entry.kind === "file") {
        return { path: withForge, reason: "added .forge/ prefix", confidence: "high" };
      }
    }

    // 4. Basename match (case-sensitive first, then insensitive)
    const base = path.posix.basename(target);
    const baseMatches = byBasename.get(base) || [];
    for (const entry of baseMatches) {
      if (!expectedKind || entry.kind === expectedKind) {
        return { path: entry.path, reason: "same basename", confidence: "medium" };
      }
    }
    const lowerMatches = byBaseLower.get(base.toLowerCase()) || [];
    for (const entry of lowerMatches) {
      if (!expectedKind || entry.kind === expectedKind) {
        return { path: entry.path, reason: "same basename (case-insensitive)", confidence: "medium" };
      }
    }

    return null;
  }

  function suggest(requestedPath, { kind, max = 5 } = {}) {
    const target = normalize(requestedPath).toLowerCase();
    const triedBase = path.posix.basename(target);
    const scored = [];
    for (const entry of files) {
      if (kind && entry.kind !== kind) continue;
      const lower = entry.path.toLowerCase();
      const base = path.posix.basename(lower);
      if (lower === target) continue;
      let score = Infinity;
      if (lower.includes(target) || (target && target.includes(lower))) score = 1;
      else if (base === triedBase) score = 2;
      else if (base.includes(triedBase) || triedBase.includes(base)) score = 3;
      else {
        const d = levenshtein(base, triedBase);
        const tol = Math.max(2, Math.floor(triedBase.length / 3));
        if (d <= tol) score = 4 + d;
        else continue;
      }
      scored.push({ path: entry.path, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, max).map((entry) => entry.path);
  }

  return {
    files,
    byPath,
    topLevel,
    outline,
    autoCorrect,
    suggest,
    exists: (p) => byPath.has(normalize(p)),
  };
}

function summarizeOutline(files) {
  const byTopDir = new Map();
  for (const entry of files) {
    const top = entry.path.split("/")[0];
    if (!byTopDir.has(top)) byTopDir.set(top, { files: 0, dirs: 0, samples: [] });
    const bucket = byTopDir.get(top);
    if (entry.kind === "file") {
      bucket.files += 1;
      if (bucket.samples.length < 3) bucket.samples.push(entry.path);
    } else {
      bucket.dirs += 1;
    }
  }
  const lines = [];
  const sorted = Array.from(byTopDir.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [top, bucket] of sorted) {
    if (top === "") continue;
    lines.push(`  ${top}/ — ${bucket.files} file${bucket.files === 1 ? "" : "s"}${bucket.dirs ? `, ${bucket.dirs} subdir${bucket.dirs === 1 ? "" : "s"}` : ""}`);
  }
  return lines.join("\n");
}

function makeResultCache() {
  const cache = new Map();
  const pathsCached = new Map();

  function cacheKey(name, args) {
    return `${name}::${JSON.stringify(args ?? {})}`;
  }

  function extractPaths(args) {
    const paths = [];
    if (!args || typeof args !== "object") return paths;
    if (typeof args.path === "string") paths.push(normalize(args.path));
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) if (typeof p === "string") paths.push(normalize(p));
    }
    return paths;
  }

  return {
    get(name, args) {
      return cache.get(cacheKey(name, args));
    },
    set(name, args, value) {
      const key = cacheKey(name, args);
      cache.set(key, value);
      for (const p of extractPaths(args)) {
        if (!pathsCached.has(p)) pathsCached.set(p, new Set());
        pathsCached.get(p).add(key);
      }
    },
    invalidatePath(p) {
      const target = normalize(p);
      if (!target) return 0;
      const keys = pathsCached.get(target);
      if (!keys) return 0;
      for (const k of keys) cache.delete(k);
      pathsCached.delete(target);
      return keys.size;
    },
    invalidateAll() {
      const n = cache.size;
      cache.clear();
      pathsCached.clear();
      return n;
    },
  };
}

async function buildAgentContext(projectDir) {
  const files = await walkProject(projectDir);
  const snapshot = buildSnapshot(files);
  const cache = makeResultCache();
  return {
    snapshot,
    cache,
    projectDir,
  };
}

const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "rename_paths",
  "normalize_asset_media_names",
  "remember",
  "add_memory_topic",
  "delete_memory_topic",
]);

// Tools whose results must NEVER be cached, even though they don't fit
// MUTATING_TOOLS' "rerun-invalidates-the-world" pattern. announce_intent
// is the canonical case: it has a UI side-effect (emits a Workshop NLE
// banner event) that must fire on every call, but it doesn't mutate
// project state, so invalidating other cached reads after it would be
// incorrect.
const NEVER_CACHE_TOOLS = new Set([
  "announce_intent",
]);

function applyPostToolInvalidation(agent, name, args, result) {
  if (!agent) return;
  if (!MUTATING_TOOLS.has(name)) return;
  if (name === "write_file" || name === "edit_file") {
    if (args?.path) agent.cache.invalidatePath(args.path);
  } else if (name === "rename_paths") {
    if (Array.isArray(args?.items)) {
      for (const item of args.items) {
        if (item?.from) agent.cache.invalidatePath(item.from);
        if (item?.to) agent.cache.invalidatePath(item.to);
      }
    }
  } else {
    agent.cache.invalidateAll();
  }
}

const INTAKE_SECTIONS = [
  { key: "scope",   start: "<!-- intake:scope:start -->",   end: "<!-- intake:scope:end -->" },
  { key: "plot",    start: "<!-- intake:plot:start -->",    end: "<!-- intake:plot:end -->" },
  { key: "visuals", start: "<!-- intake:visual:start -->",  end: "<!-- intake:visual:end -->" },
];

const EMPTY_MARKER_PATTERNS = [
  /^\(empty\s+[-—][^\r\n)]*\)$/i,
];

const SKIP_MARKER = /\[skipped\s+[-—]\s+best-guess defaults\]/i;

function classifySection(body) {
  if (!body || !body.trim()) return "none";
  if (SKIP_MARKER.test(body)) return "complete";
  // Strip the heading (## Scope etc.) and check what remains.
  const stripped = body.replace(/^#+\s.*$/gm, "").trim();
  if (!stripped) return "none";
  // Ignore placeholder-only lines, while preserving inline wording in user notes.
  const contentLines = stripped.split("\n").filter((line) => {
    const text = line.trim();
    return text && !EMPTY_MARKER_PATTERNS.some((re) => re.test(text));
  }).length;
  if (!contentLines) return "none";
  // Crude depth check: 3+ non-empty content lines = complete; 1-2 = partial.
  if (contentLines >= 3) return "complete";
  return "partial";
}

function extractSection(body, startMarker, endMarker) {
  const startIdx = body.indexOf(startMarker);
  const endIdx = body.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return "";
  return body.slice(startIdx + startMarker.length, endIdx);
}

function computeIntakeStatus(projectDir) {
  if (typeof projectDir !== "string" || !projectDir) {
    return { scope: "none", plot: "none", visuals: "none" };
  }
  const intakePath = path.join(projectDir, "story", "intake.md");
  let body = "";
  try {
    body = fsSync.readFileSync(intakePath, "utf8");
  } catch {
    return { scope: "none", plot: "none", visuals: "none" };
  }
  const result = {};
  for (const sec of INTAKE_SECTIONS) {
    const content = extractSection(body, sec.start, sec.end);
    result[sec.key] = classifySection(content);
  }
  return result;
}

module.exports = {
  buildAgentContext,
  applyPostToolInvalidation,
  MUTATING_TOOLS,
  NEVER_CACHE_TOOLS,
  computeIntakeStatus,
};
