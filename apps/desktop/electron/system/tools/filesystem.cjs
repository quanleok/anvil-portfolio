const fs = require("node:fs/promises");
const path = require("node:path");

const IGNORE_DIRS = new Set([".forge", "node_modules", ".git", ".DS_Store", "release", "dist"]);
const MAX_SUGGEST_ENTRIES = 1500;
const MAX_SUGGESTIONS = 5;

async function collectProjectPaths(projectDir) {
  const out = [];
  async function walk(currentDir, rel) {
    if (out.length >= MAX_SUGGEST_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_SUGGEST_ENTRIES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        out.push({ path: childRel, kind: "dir" });
        await walk(path.join(currentDir, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push({ path: childRel, kind: "file" });
      }
    }
  }
  await walk(projectDir, "");
  return out;
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

function suggestPaths(tried, allPaths, { kind } = {}) {
  const normalized = String(tried || "").toLowerCase();
  const triedBase = path.posix.basename(normalized);
  const scored = [];
  for (const entry of allPaths) {
    if (kind && entry.kind !== kind) continue;
    const lower = entry.path.toLowerCase();
    const base = path.posix.basename(lower);
    let score = Infinity;
    if (lower === normalized) continue;
    if (lower.includes(normalized) || normalized.includes(lower)) score = 1;
    else if (base === triedBase) score = 2;
    else if (base.includes(triedBase) || triedBase.includes(base)) score = 3;
    else {
      const d = levenshtein(base, triedBase);
      if (d <= Math.max(2, Math.floor(triedBase.length / 3))) score = 4 + d;
      else continue;
    }
    scored.push({ path: entry.path, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.path);
}

async function suggestionEnvelope(projectDir, relativePath, kind, errorMessage) {
  try {
    const paths = await collectProjectPaths(projectDir);
    const suggestions = suggestPaths(relativePath, paths, { kind });
    return {
      ok: false,
      path: relativePath,
      error: errorMessage,
      suggestions,
      hint:
        suggestions.length > 0
          ? "Closest matches returned in `suggestions`. Retry with one of those if it fits."
          : "Use get_project_index or list_dir at project root to discover the real layout.",
    };
  } catch {
    return { ok: false, path: relativePath, error: errorMessage, suggestions: [] };
  }
}

function normalizeGenericWritePath(relativePath) {
  return String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function assertGenericWritePath(relativePath, action, { allowAgentNote = true } = {}) {
  const normalized = normalizeGenericWritePath(relativePath);
  if (allowAgentNote && normalized === ".forge/agent-note.md") return;
  if (normalized === ".forge" || normalized.startsWith(".forge/")) {
    const error = new Error(
      `Reserved app state — "${normalized}" is under .forge/. Use dedicated Anvil tools or explicit app-state repair instead of ${action}.`,
    );
    error.code = "RESERVED_APP_STATE";
    error.path = normalized;
    throw error;
  }
}

module.exports = function registerFilesystemTools(api) {
  const {
    registerTool,
    resolveInside,
    normalizeRelativePath,
    readProjectIndex,
    readProjectMetadata,
    writeProjectMetadata,
    refreshProjectIndex,
    searchProjectIndex,
    resolveRgBin,
    searchViaRipgrep,
    candidateSearchFiles,
    assertWritablePath,
  } = api;

  // Guard against the agent reading a huge file into memory. 2 MB is
  // plenty for any markdown/text/JSON file in a typical project; a
  // user who drops a large log or binary here gets a soft-error
  // envelope instead of the tool result being JSON-serialized into an
  // OpenClaw message that may exceed the CLI's buffer.
  const MAX_READ_FILE_BYTES = 2_000_000;
  registerTool("read_file", {
    tier: "core",
    description:
      "Read a single text file inside the current project. Returns { path, content, size } on success, or { ok:false, error, suggestions } when the path doesn't exist or is too large.",
    args: { path: "relative path from project root" },
    async run({ path: relativePath }, ctx) {
      const absolute = resolveInside(ctx.projectDir, relativePath);
      try {
        const stat = await fs.stat(absolute);
        if (stat.isDirectory()) {
          return suggestionEnvelope(
            ctx.projectDir,
            relativePath,
            "file",
            `read_file: ${relativePath} is a directory. Use list_dir instead.`,
          );
        }
        if (stat.size > MAX_READ_FILE_BYTES) {
          return {
            ok: false,
            error: `read_file: ${relativePath} is ${(stat.size / 1_000_000).toFixed(1)} MB — larger than the ${MAX_READ_FILE_BYTES / 1_000_000} MB read cap. Use search or head/tail via run_command if you need a slice.`,
            path: relativePath,
            size: stat.size,
          };
        }
        const content = await fs.readFile(absolute, "utf8");
        return { path: relativePath, content, size: content.length };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        // Attempt auto-correction against the agent's cached snapshot.
        const correction = ctx.agent?.snapshot?.autoCorrect?.(relativePath, "file");
        if (correction) {
          try {
            const correctedAbs = resolveInside(ctx.projectDir, correction.path);
            const stat = await fs.stat(correctedAbs);
            if (stat.size > MAX_READ_FILE_BYTES) {
              return {
                ok: false,
                error: `read_file: autocorrected to ${correction.path} but it is ${(stat.size / 1_000_000).toFixed(1)} MB — larger than the ${MAX_READ_FILE_BYTES / 1_000_000} MB read cap.`,
                path: correction.path,
                size: stat.size,
                correctedFrom: relativePath,
              };
            }
            const content = await fs.readFile(correctedAbs, "utf8");
            return {
              path: correction.path,
              content,
              size: content.length,
              correctedFrom: relativePath,
              correctionReason: correction.reason,
            };
          } catch {
            // Fall through to suggestions
          }
        }
        return suggestionEnvelope(
          ctx.projectDir,
          relativePath,
          "file",
          `read_file: ${relativePath} does not exist.`,
        );
      }
    },
  });

  registerTool("list_dir", {
    tier: "core",
    description:
      "List entries in a project directory. Returns { path, entries } on success, or { ok:false, error, suggestions } when the path doesn't exist.",
    args: { path: "relative directory path" },
    async run({ path: relativePath }, ctx) {
      const effective = relativePath || ".";
      const absolute = resolveInside(ctx.projectDir, effective);
      try {
        const entries = await fs.readdir(absolute, { withFileTypes: true });
        return {
          path: relativePath || ".",
          entries: await Promise.all(
            entries.map(async (entry) => {
              const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
              const child = path.join(absolute, entry.name);
              const size = kind === "file" ? (await fs.stat(child)).size : undefined;
              return { name: entry.name, kind, size };
            }),
          ),
        };
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          const correction = ctx.agent?.snapshot?.autoCorrect?.(effective, "dir");
          if (correction) {
            try {
              const correctedAbs = resolveInside(ctx.projectDir, correction.path);
              const entries = await fs.readdir(correctedAbs, { withFileTypes: true });
              return {
                path: correction.path,
                correctedFrom: effective,
                correctionReason: correction.reason,
                entries: await Promise.all(
                  entries.map(async (entry) => {
                    const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
                    const child = path.join(correctedAbs, entry.name);
                    const size = kind === "file" ? (await fs.stat(child)).size : undefined;
                    return { name: entry.name, kind, size };
                  }),
                ),
              };
            } catch {
              // Fall through to suggestions.
            }
          }
          return suggestionEnvelope(
            ctx.projectDir,
            relativePath || ".",
            "dir",
            `list_dir: ${relativePath || "."} does not exist.`,
          );
        }
        throw error;
      }
    },
  });

  registerTool("search", {
    tier: "core",
    description: "Search project files for a literal substring. Optional glob (e.g. 'scenes/*.md') to scope.",
    args: { query: "literal substring", glob: "optional glob", max: "max results, default 50" },
    async run({ query, glob, max = 50 }, ctx) {
      if (!query || typeof query !== "string") {
        throw new Error("search: 'query' is required.");
      }
      const limit = Math.max(1, Math.min(Number(max) || 50, 200));
      const matches = [];

      try {
        const projectIndex = await readProjectIndex(ctx.projectDir);
        matches.push(...searchProjectIndex(projectIndex, query, limit));
      } catch {}

      if (matches.length >= limit) {
        return { query, glob: glob || null, matches: matches.slice(0, limit), engine: "index" };
      }

      const rgBin = resolveRgBin();
      if (rgBin) {
        try {
          const rgMatches = await searchViaRipgrep(rgBin, ctx.projectDir, query, glob, limit - matches.length);
          const existingIndexPaths = new Set(
            matches.filter((match) => match.kind === "index").map((match) => match.path),
          );
          for (const match of rgMatches) {
            if (existingIndexPaths.has(match.path)) continue;
            matches.push(match);
            if (matches.length >= limit) break;
          }
          return { query, glob: glob || null, matches, engine: "ripgrep" };
        } catch {
          // Fall through to JS scan.
        }
      }

      const files = await candidateSearchFiles(ctx.projectDir, glob);
      for (const relativePath of files) {
        if (matches.some((match) => match.path === relativePath && match.kind === "index")) {
          continue;
        }
        let content;
        try {
          content = await fs.readFile(resolveInside(ctx.projectDir, relativePath), "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].includes(query)) {
            matches.push({ kind: "text", path: relativePath, lineNumber: i + 1, line: lines[i].slice(0, 400) });
            if (matches.length >= limit) break;
          }
        }
        if (matches.length >= limit) break;
      }

      return { query, glob: glob || null, matches, engine: "js" };
    },
  });

  registerTool("write_file", {
    tier: "edit",
    description: "Write a text file inside the project. Creates parent dirs. Overwrites existing.",
    args: { path: "relative path", content: "file content" },
    async run({ path: relativePath, content }, ctx) {
      assertGenericWritePath(relativePath, "write_file");
      await assertWritablePath(ctx.projectDir, relativePath, "writing");
      const absolute = resolveInside(ctx.projectDir, relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const text = typeof content === "string" ? content : "";
      await fs.writeFile(absolute, text, "utf8");
      return { path: relativePath, bytesWritten: Buffer.byteLength(text, "utf8") };
    },
  });

  registerTool("edit_file", {
    tier: "edit",
    description: "Edit a project file by literal find/replace. Use for surgical edits instead of rewriting whole files.",
    args: {
      path: "relative path",
      find: "literal substring to replace (must be unique or set replaceAll=true)",
      replace: "replacement substring",
      replaceAll: "optional boolean, default false",
    },
    async run({ path: relativePath, find, replace, replaceAll = false }, ctx) {
      if (typeof find !== "string" || !find) {
        throw new Error("edit_file: 'find' is required.");
      }
      if (typeof replace !== "string") {
        throw new Error("edit_file: 'replace' is required.");
      }
      assertGenericWritePath(relativePath, "edit_file");
      await assertWritablePath(ctx.projectDir, relativePath, "editing");
      const absolute = resolveInside(ctx.projectDir, relativePath);
      const original = await fs.readFile(absolute, "utf8");
      if (!original.includes(find)) {
        throw new Error(`edit_file: 'find' substring not found in ${relativePath}.`);
      }
      let next;
      let replacements;
      if (replaceAll) {
        next = original.split(find).join(replace);
        replacements = (original.length - original.split(find).join("").length) / find.length;
      } else {
        const index = original.indexOf(find);
        next = original.slice(0, index) + replace + original.slice(index + find.length);
        replacements = 1;
      }
      await fs.writeFile(absolute, next, "utf8");
      return {
        path: relativePath,
        replacements,
        bytesDelta: Buffer.byteLength(next, "utf8") - Buffer.byteLength(original, "utf8"),
      };
    },
  });

  registerTool("rename_paths", {
    tier: "edit",
    description:
      "Batch rename project files. Best for asset media files. Updates Forge media metadata paths and labels, then refreshes the project index.",
    args: {
      items: "array of { from: relative path, to: relative path }",
    },
    async run({ items }, ctx) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("rename_paths: 'items' must be a non-empty array.");
      }

      const metadata = await readProjectMetadata(ctx.projectDir);
      const mediaUpdates = new Map();
      const renames = [];
      const plannedRenames = [];

      for (const item of items) {
        const fromPath = normalizeRelativePath(item?.from);
        const toPath = normalizeRelativePath(item?.to);
        if (!fromPath || !toPath) {
          throw new Error("rename_paths: each item must contain 'from' and 'to'.");
        }
        if (path.posix.extname(fromPath).toLowerCase() === ".md" || path.posix.extname(toPath).toLowerCase() === ".md") {
          throw new Error("rename_paths: markdown file renames are not supported by this tool. Use file-specific project tools instead.");
        }
        assertGenericWritePath(fromPath, "rename_paths", { allowAgentNote: false });
        assertGenericWritePath(toPath, "rename_paths", { allowAgentNote: false });
        await assertWritablePath(ctx.projectDir, fromPath, "renaming");
        await assertWritablePath(ctx.projectDir, toPath, "renaming");
        plannedRenames.push({ from: fromPath, to: toPath });
      }

      for (const { from: fromPath, to: toPath } of plannedRenames) {
        const fromAbsolute = resolveInside(ctx.projectDir, fromPath);
        const toAbsolute = resolveInside(ctx.projectDir, toPath);
        await fs.mkdir(path.dirname(toAbsolute), { recursive: true });
        await fs.rename(fromAbsolute, toAbsolute);
        mediaUpdates.set(fromPath, toPath);
        renames.push({
          from: fromPath,
          to: toPath,
        });
      }

      let metadataChanged = false;
      for (const section of ["characters", "locations", "props", "keyframes", "audio"]) {
        const entries = Array.isArray(metadata?.[section]) ? metadata[section] : [];
        for (const entry of entries) {
          const mediaItems = Array.isArray(entry?.media) ? entry.media : [];
          for (const media of mediaItems) {
            const currentPath = normalizeRelativePath(media?.path);
            const nextPath = mediaUpdates.get(currentPath);
            if (!nextPath) continue;
            media.path = nextPath;
            media.label = path.posix.basename(nextPath);
            metadataChanged = true;
          }
        }
      }

      if (metadataChanged) {
        metadata.project = {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        };
        await writeProjectMetadata(ctx.projectDir, metadata);
      }
      await refreshProjectIndex(ctx.projectDir);

      return {
        count: renames.length,
        renames,
        metadataChanged,
      };
    },
  });
};
