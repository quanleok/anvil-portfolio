const fs = require("node:fs/promises");
const path = require("node:path");

const crypto = require("node:crypto");
const { atomicWriteFile, withWriteLock } = require("./atomic-write.cjs");

const MEMORY_DIR = path.join(".forge", "memory");
const TOPICS_DIRNAME = "topics";
const INDEX_FILE = "MEMORY.md";
const PINBOARD_FILE = "pinboard.json";
const CHATS_DIR = path.join(".forge", "chats");
const MAX_TOPIC_CHARS = 16_000;
const MAX_CHAT_HITS = 50;

function memoryRoot(projectDir) {
  return path.join(projectDir, MEMORY_DIR);
}
function indexPath(projectDir) {
  return path.join(memoryRoot(projectDir), INDEX_FILE);
}
function topicsDir(projectDir) {
  return path.join(memoryRoot(projectDir), TOPICS_DIRNAME);
}
function topicFilePath(projectDir, name) {
  return path.join(topicsDir(projectDir), `${slugifyTopic(name)}.md`);
}
function pinboardPath(projectDir) {
  return path.join(memoryRoot(projectDir), PINBOARD_FILE);
}
function chatsRoot(projectDir) {
  return path.join(projectDir, CHATS_DIR);
}

function slugifyTopic(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

async function ensureMemoryDirs(projectDir) {
  await fs.mkdir(topicsDir(projectDir), { recursive: true });
}

async function readIndex(projectDir) {
  try {
    return await fs.readFile(indexPath(projectDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function appendToIndex(projectDir, text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    throw new Error("remember: text is required");
  }
  const entry = {
    id: crypto.randomUUID(),
    text: cleaned,
    category: "fact",
    scope: "project",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmed: false, // agent-proposed, needs user confirmation
  };
  return addPinboardEntry(projectDir, entry);
}

// ---------------------------------------------------------------------------
// Pinboard — structured JSON memory
// ---------------------------------------------------------------------------

async function readPinboard(projectDir) {
  let raw;
  try {
    raw = await fs.readFile(pinboardPath(projectDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new SyntaxError(`pinboard.json root must be an array, got ${typeof parsed}`);
    }
    return parsed;
  } catch (parseError) {
    // Corrupt pinboard.json (mid-write crash, manual edit, fs corruption).
    // Rotate to .corrupt-<ts> next to it and return [] so the agent's
    // memory tools degrade gracefully instead of crashing every call. Same
    // recovery shape as project.json's .bak rotation. Audit H6 (2026-04-20).
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const corrupt = pinboardPath(projectDir) + `.corrupt-${stamp}`;
    try {
      await fs.rename(pinboardPath(projectDir), corrupt);
      console.warn(
        `[memory] pinboard.json was unparseable (${parseError.message}); rotated to ${corrupt}`,
      );
    } catch {}
    return [];
  }
}

async function writePinboard(projectDir, entries) {
  await ensureMemoryDirs(projectDir);
  await atomicWriteFile(pinboardPath(projectDir), JSON.stringify(entries, null, 2));
}

// Mutators serialize via withWriteLock so the read→modify→write window
// can't interleave between concurrent callers. Without this, parallel
// addPinboardEntry calls (which fire whenever the agent emits multiple
// remember/update_pinboard/remove_pinboard tool calls in one turn — see
// agent-loop.cjs Promise.all dispatch) drop entries or crash on .tmp
// rename. Reproduced 7/8 loss in the 2026-04-20 audit (C1).
function pinboardLockKey(projectDir) {
  return `pinboard:${projectDir}`;
}

async function addPinboardEntry(projectDir, entry) {
  return withWriteLock(pinboardLockKey(projectDir), async () => {
    const entries = await readPinboard(projectDir);
    entries.push(entry);
    await writePinboard(projectDir, entries);
    await syncPinboardToIndex(projectDir, entries);
    return entry;
  });
}

async function updatePinboardEntry(projectDir, id, patch) {
  return withWriteLock(pinboardLockKey(projectDir), async () => {
    const entries = await readPinboard(projectDir);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`Pinboard entry ${id} not found`);
    entries[idx] = { ...entries[idx], ...patch, updatedAt: new Date().toISOString() };
    await writePinboard(projectDir, entries);
    await syncPinboardToIndex(projectDir, entries);
    return entries[idx];
  });
}

async function removePinboardEntry(projectDir, id) {
  return withWriteLock(pinboardLockKey(projectDir), async () => {
    const entries = await readPinboard(projectDir);
    const filtered = entries.filter((e) => e.id !== id);
    if (filtered.length === entries.length) return { removed: false };
    await writePinboard(projectDir, filtered);
    await syncPinboardToIndex(projectDir, filtered);
    return { removed: true };
  });
}

async function syncPinboardToIndex(projectDir, entries) {
  // Only confirmed entries flow into MEMORY.md — the injected prompt context
  // is authoritative, so unconfirmed proposals stay in pinboard.json (and
  // surface to the agent only via explicit list_pinboard calls).
  // Accepts boolean true OR stringified "true" (some legacy / hand-edited
  // pinboard.json files stored confirmed as a string).
  const isConfirmed = (v) => v === true || v === "true";
  const confirmed = entries.filter((e) => e && isConfirmed(e.confirmed));
  const unconfirmedCount = entries.length - confirmed.length;
  const lines = [
    "# Project pinboard",
    "",
    "> Structured memory — managed via pinboard UI and agent tools.",
    "",
  ];
  if (unconfirmedCount > 0) {
    lines.push(
      `> ${unconfirmedCount} proposal${unconfirmedCount === 1 ? "" : "s"} pending — use list_pinboard({ confirmed: false }) to review.`,
      "",
    );
  }
  for (const entry of confirmed) {
    const date = entry.createdAt.slice(0, 10);
    const cat = entry.category ? `[${entry.category}] ` : "";
    lines.push(`- [${date}] ${cat}${entry.text}`);
  }
  const text = lines.join("\n") + "\n";
  await ensureMemoryDirs(projectDir);
  await atomicWriteFile(indexPath(projectDir), text);
}

async function clearAllMemory(projectDir) {
  try {
    await fs.rm(memoryRoot(projectDir), { recursive: true, force: true });
  } catch {}
  return { cleared: true };
}

// Read just enough of a topic file to parse its frontmatter and report
// the on-disk size, without slurping the whole 16k body. listTopics
// previously read full content per file (8 MB for 500 topics) just to
// pull out name/description. Audit M1 (2026-04-20).
async function readTopicHeader(fullPath) {
  const handle = await fs.open(fullPath, "r");
  try {
    const stat = await handle.stat();
    const headerBytes = Math.min(stat.size, 1024);
    const buf = Buffer.alloc(headerBytes);
    await handle.read(buf, 0, headerBytes, 0);
    return { header: buf.toString("utf8"), size: stat.size };
  } finally {
    await handle.close();
  }
}

async function listTopics(projectDir) {
  let entries;
  try {
    entries = await fs.readdir(topicsDir(projectDir));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  // Read headers in parallel — bounded fan-out is fine for tens-to-low-
  // hundreds of files and dramatically faster than the previous serial loop.
  const topics = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map(async (entry) => {
        const fullPath = path.join(topicsDir(projectDir), entry);
        try {
          const { header, size } = await readTopicHeader(fullPath);
          const meta = parseTopicMeta(header);
          return {
            name: meta.name || entry.replace(/\.md$/, ""),
            description: meta.description || "",
            slug: entry.replace(/\.md$/, ""),
            path: path.join(MEMORY_DIR, TOPICS_DIRNAME, entry),
            size,
          };
        } catch {
          return null;
        }
      }),
  );
  return topics.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function parseTopicMeta(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const block = text.slice(4, end);
  const meta = {};
  for (const line of block.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) meta[key] = value;
  }
  return meta;
}

async function readTopic(projectDir, name) {
  try {
    return await fs.readFile(topicFilePath(projectDir, name), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeTopic(projectDir, name, content, description = "", options = {}) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("write_topic: 'name' is required.");
  const cleanContent = String(content || "").slice(0, MAX_TOPIC_CHARS);
  await ensureMemoryDirs(projectDir);
  const slug = slugifyTopic(cleanName);
  const file = topicFilePath(projectDir, cleanName);
  // Refuse silent overwrite of an existing topic unless force:true. Pre-fix
  // the agent would blow away user-edited topic notes on re-add with the
  // same slug. Audit context-M4 (2026-04-20). force:true bypasses the
  // guard for intentional regeneration flows.
  if (!options.force) {
    try {
      const existing = await fs.stat(file);
      if (existing.isFile()) {
        throw new Error(
          `write_topic: topic '${cleanName}' already exists at ${path.join(MEMORY_DIR, TOPICS_DIRNAME, `${slug}.md`)}. Pass force:true to overwrite, or call delete_memory_topic first.`,
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // ENOENT = topic doesn't exist → fall through to write normally.
    }
  }
  const cleanDesc = String(description || "").trim().replace(/\n+/g, " ").slice(0, 200);
  const front = ["---", `name: ${cleanName}`];
  if (cleanDesc) front.push(`description: ${cleanDesc}`);
  front.push("---", "", cleanContent.trim(), "");
  await atomicWriteFile(file, front.join("\n"));
  return {
    name: cleanName,
    slug,
    path: path.join(MEMORY_DIR, TOPICS_DIRNAME, `${slug}.md`),
    bytes: cleanContent.length,
    overwritten: Boolean(options.force),
  };
}

async function deleteTopic(projectDir, name) {
  try {
    await fs.rm(topicFilePath(projectDir, name));
    return { name, deleted: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { name, deleted: false };
    throw error;
  }
}

// In-process LRU cache for parsed chat-session messages. searchChats
// reads + parses every chat .json on every call; for long-lived projects
// (200 sessions × 500 msgs) that's 50-100MB of disk + parse work per
// search. Cache keyed by (absolute path, mtimeMs) so a re-saved chat
// invalidates its own entry. Bounded LRU prevents unbounded memory
// growth on huge histories. Audit context-H3 (2026-04-20).
const CHAT_CACHE_MAX = 50;
const chatCache = new Map(); // key: `${path}|${mtimeMs}` → messages[]

function chatCacheGet(key) {
  if (!chatCache.has(key)) return null;
  const value = chatCache.get(key);
  // Refresh LRU position by deleting + re-inserting.
  chatCache.delete(key);
  chatCache.set(key, value);
  return value;
}

function chatCacheSet(key, messages) {
  if (chatCache.has(key)) chatCache.delete(key);
  chatCache.set(key, messages);
  while (chatCache.size > CHAT_CACHE_MAX) {
    const oldestKey = chatCache.keys().next().value;
    chatCache.delete(oldestKey);
  }
}

async function loadChatMessages(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  const cacheKey = `${filePath}|${stat.mtimeMs}`;
  const cached = chatCacheGet(cacheKey);
  if (cached) return cached;
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let messages;
  try {
    messages = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) return null;
  chatCacheSet(cacheKey, messages);
  return messages;
}

async function searchChats(projectDir, query, maxHits = MAX_CHAT_HITS) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) throw new Error("search_chats: 'query' is required.");
  const lowerQuery = cleanQuery.toLowerCase();
  const limit = Math.max(1, Math.min(Number(maxHits) || MAX_CHAT_HITS, 200));
  let entries;
  try {
    entries = await fs.readdir(chatsRoot(projectDir));
  } catch (error) {
    if (error?.code === "ENOENT") return { query: cleanQuery, hits: [] };
    throw error;
  }
  const hits = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (hits.length >= limit) break;
    const file = path.join(chatsRoot(projectDir), entry);
    const messages = await loadChatMessages(file);
    if (!messages) continue;
    for (const message of messages) {
      if (hits.length >= limit) break;
      const text = String(message?.text || "");
      if (!text) continue;
      if (!text.toLowerCase().includes(lowerQuery)) continue;
      const idx = text.toLowerCase().indexOf(lowerQuery);
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + lowerQuery.length + 60);
      const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
      hits.push({
        session: entry.replace(/\.json$/, ""),
        role: message?.role || "?",
        timestamp: message?.timestamp || "",
        snippet,
      });
    }
  }
  return { query: cleanQuery, hits };
}

module.exports = {
  // paths
  MEMORY_DIR,
  TOPICS_DIRNAME,
  INDEX_FILE,
  PINBOARD_FILE,
  CHATS_DIR,
  // index API
  readIndex,
  appendToIndex,
  clearAllMemory,
  // pinboard API
  readPinboard,
  writePinboard,
  addPinboardEntry,
  updatePinboardEntry,
  removePinboardEntry,
  syncPinboardToIndex,
  // topic API
  listTopics,
  readTopic,
  writeTopic,
  deleteTopic,
  // chat search
  searchChats,
  // helpers
  slugifyTopic,
};
