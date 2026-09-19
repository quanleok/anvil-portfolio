const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomicWriteFile } = require("./atomic-write.cjs");

const MAGIC_DIR = path.join(".forge", "magic");
const ASSET_CONTEXT_DIR = path.join(".forge", "asset-context");
const ASSET_CONTEXT_GUIDE_FILE = path.join(ASSET_CONTEXT_DIR, "guide.md");
const ASSET_CONTEXT_REFERENCES_DIR = path.join(ASSET_CONTEXT_DIR, "references");
const LEGACY_MAGIC_GUIDE_DIR = path.join(".forge", "magic-guides");
const LEGACY_ASSET_GUIDE_NAMES = ["Character Bible", "Location Atlas"];
const LEGACY_ASSET_MAGIC_DOC_NAMES = new Set(LEGACY_ASSET_GUIDE_NAMES);
const MAX_SOURCE_CHARS = 40_000;
const MAX_BODY_CHARS = 24_000;
const NEVER_SYNTHESIZED_PLACEHOLDER = "(Not yet generated — call update_magic_doc.)";
const ASSET_CONTEXT_REFERENCE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
  ".heic",
  ".tiff",
]);

const VALID_KINDS = new Set(["bible", "atlas", "grammar", "map", "digest", "custom"]);

const MAGIC_DOC_DEFAULTS = [
  {
    name: "Asset Library",
    kind: "digest",
    description: "Compact lookup of project assets and their continuity-sensitive reference notes.",
    scope: ["project:characters", "project:locations", "project:props", "project:keyframes", "project:audio"],
    instruction:
      "Build one compact, scannable asset library reference. Group characters, locations, props, keyframes, and audio. Focus on visual identity, continuity constraints, reusable reference details, and attached media filenames. Each source is one AssetEntry from the project — do not invent details absent from the title, context, or media paths.",
  },
];

function slugify(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "magic-doc"
  );
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function resolveInside(projectDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new Error("Relative path is required.");
  if (path.isAbsolute(normalized)) throw new Error("Absolute paths are not allowed.");
  const candidate = path.resolve(projectDir, normalized);
  const root = path.resolve(projectDir);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the current project.");
  }
  return candidate;
}

function magicDir(projectDir) {
  return path.join(projectDir, MAGIC_DIR);
}

function magicFile(projectDir, name) {
  return path.join(magicDir(projectDir), `${slugify(name)}.md`);
}

function magicRelative(name) {
  return `${MAGIC_DIR.replace(/\\/g, "/")}/${slugify(name)}.md`;
}

function assetContextDir(projectDir) {
  return path.join(projectDir, ASSET_CONTEXT_DIR);
}

function assetContextGuideFile(projectDir) {
  return path.join(projectDir, ASSET_CONTEXT_GUIDE_FILE);
}

function assetContextGuideRelative() {
  return ASSET_CONTEXT_GUIDE_FILE.replace(/\\/g, "/");
}

function assetContextReferenceDir(projectDir) {
  return path.join(projectDir, ASSET_CONTEXT_REFERENCES_DIR);
}

function assetContextReferenceRelative(fileName) {
  return `${ASSET_CONTEXT_REFERENCES_DIR.replace(/\\/g, "/")}/${String(fileName || "").trim()}`;
}

function legacyMagicGuideFile(projectDir, name) {
  return path.join(projectDir, LEGACY_MAGIC_GUIDE_DIR, `${slugify(name)}.md`);
}

function legacyMagicGuideReferenceDir(projectDir, name) {
  return path.join(projectDir, LEGACY_MAGIC_GUIDE_DIR, slugify(name));
}

// Limit close-fence search to the first 2 KB so a body that legitimately
// uses `\n---\n` as a markdown horizontal rule can't get eaten into the
// frontmatter. Magic-doc frontmatter never exceeds ~500 bytes — 2 KB is a
// safe headroom multiple. Audit M3 (2026-04-20).
const FRONTMATTER_SCAN_LIMIT = 2048;

function parseFrontmatter(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const window = text.slice(0, FRONTMATTER_SCAN_LIMIT);
  const end = window.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: text };
  const metaBlock = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta = {};
  for (const line of metaBlock.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body };
}

function parseList(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s || "").trim()).filter(Boolean);
    } catch {}
  }
  return raw.split(";").map((s) => s.trim()).filter(Boolean);
}

function serializeList(items) {
  const clean = Array.isArray(items) ? items.map((s) => String(s || "").trim()).filter(Boolean) : [];
  return JSON.stringify(clean);
}

function parseBoolean(text) {
  const value = String(text || "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function truncateText(text, maxChars = 12000) {
  const value = typeof text === "string" ? text : String(text || "");
  if (value.length <= maxChars) {
    return { content: value, truncated: false };
  }
  const keepHead = Math.max(0, Math.floor(maxChars * 0.75));
  const keepTail = Math.max(0, maxChars - keepHead);
  return {
    content: `${value.slice(0, keepHead).trimEnd()}\n\n[truncated]\n\n${value.slice(-keepTail).trimStart()}`,
    truncated: true,
  };
}

function hashStrings(values) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) return "";
  const hasher = createHash("sha256");
  for (const value of list) hasher.update(String(value || ""));
  return hasher.digest("hex").slice(0, 16);
}

function hashBody(body) {
  return hashStrings([String(body || "")]);
}

function normalizeKind(rawKind) {
  const value = String(rawKind || "").trim().toLowerCase();
  return VALID_KINDS.has(value) ? value : "custom";
}

function isPlaceholderBody(body) {
  return String(body || "").trim() === NEVER_SYNTHESIZED_PLACEHOLDER;
}

function isNeverSynthesized(doc) {
  return !doc.updatedAt || !doc.synthesizedBodyHash || !String(doc.body || "").trim() || isPlaceholderBody(doc.body);
}

function buildPromptInstructions(kind) {
  switch (normalizeKind(kind)) {
    case "bible":
      return [
        "Synthesize the sources into a canonical reference document.",
        "Organize by subject using clear markdown headings.",
        "Focus on stable facts, visual markers, roles, and continuity-sensitive details.",
      ];
    case "atlas":
      return [
        "Synthesize the sources into a compact lookup document.",
        "Prefer dense, scannable formatting over long prose.",
        "Keep recurring attributes consistent entry-to-entry.",
      ];
    case "grammar":
      return [
        "Synthesize the sources into a rules-and-examples directing guide.",
        "Lead with practical rules the project should follow.",
        "Distill principles, not generic style adjectives.",
      ];
    case "map":
      return [
        "Synthesize the sources into an ordered structural map.",
        "Preserve progression and sequence.",
        "Keep each beat concise and operational.",
      ];
    case "digest":
      return [
        "Synthesize the sources into a compressed summary.",
        "Lead with the most important current facts.",
        "Prefer short sections and direct language.",
      ];
    case "custom":
    default:
      return [
        "Synthesize the sources into a clean, deduplicated markdown document.",
        "Organize the material so it is easy to consult quickly.",
      ];
  }
}

function buildSynthesisPrompt(doc, sources) {
  const sourceBlock = sources
    .map((source) => `### ${source.path}\n\n${source.content.trim()}`)
    .join("\n\n---\n\n");
  return [
    "You maintain a single magic doc for a film project.",
    ...buildPromptInstructions(doc.kind),
    "Do not invent facts; only use what appears in the sources.",
    "Keep the document concise and decision-ready.",
    "Return ONLY the markdown body — no frontmatter, no code fences.",
    "",
    `Doc name: ${doc.name}`,
    `Kind: ${doc.kind}`,
    `Description: ${doc.description}`,
    `Instruction: ${doc.instruction}`,
    "",
    "Sources:",
    "",
    sourceBlock || "(no source content found in scope)",
  ].join("\n");
}

async function ensureMagicDir(projectDir) {
  await fs.mkdir(magicDir(projectDir), { recursive: true });
}

async function ensureAssetContextDir(projectDir) {
  await fs.mkdir(assetContextDir(projectDir), { recursive: true });
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function nextMigratedAssetContextReference(projectDir, guideName, fileName, usedNames) {
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  const baseSlug = `${slugify(guideName)}-${slugify(baseName || "reference")}`;
  const normalizedExt = ext || ".bin";
  let index = 0;

  while (true) {
    const candidateName = index === 0
      ? `${baseSlug}${normalizedExt}`
      : `${baseSlug}-${index + 1}${normalizedExt}`;
    const candidatePath = path.join(assetContextReferenceDir(projectDir), candidateName);
    if (!usedNames.has(candidateName) && !(await fileExists(candidatePath))) {
      usedNames.add(candidateName);
      return { name: candidateName, absolutePath: candidatePath };
    }
    index += 1;
  }
}

async function migrateLegacyAssetContextGuide(projectDir) {
  const sections = [];
  const copiedReferenceNames = new Set();
  let copiedAnyReference = false;

  for (const guideName of LEGACY_ASSET_GUIDE_NAMES) {
    try {
      const raw = await fs.readFile(legacyMagicGuideFile(projectDir, guideName), "utf8");
      const trimmed = raw.trim();
      if (trimmed) {
        sections.push(`## ${guideName} Guide\n\n${trimmed}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    let entries = [];
    try {
      entries = await fs.readdir(legacyMagicGuideReferenceDir(projectDir, guideName), { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      entries = [];
    }

    const imageFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((fileName) => ASSET_CONTEXT_REFERENCE_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
      .sort((left, right) => left.localeCompare(right));

    if (imageFiles.length > 0) {
      await fs.mkdir(assetContextReferenceDir(projectDir), { recursive: true });
    }
    for (const fileName of imageFiles) {
      const sourcePath = path.join(legacyMagicGuideReferenceDir(projectDir, guideName), fileName);
      const target = await nextMigratedAssetContextReference(projectDir, guideName, fileName, copiedReferenceNames);
      await fs.copyFile(sourcePath, target.absolutePath);
      copiedAnyReference = true;
    }
  }

  if (sections.length === 0) {
    return copiedAnyReference
      ? "# Asset Context\n\nImported legacy reference images from per-document asset guides.\n"
      : "";
  }

  return [
    "# Asset Context",
    "",
    "Imported from legacy per-document asset guides. Edit this shared file going forward.",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

async function readMagicDocFile(projectDir, name) {
  try {
    const raw = await fs.readFile(magicFile(projectDir, name), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const normalizedName = meta.name || String(name || "").trim() || slugify(name);
    return {
      content: body.replace(/\s+$/, ""),
      id: `magic:${slugify(normalizedName)}`,
      name: normalizedName,
      description: meta.description || "",
      kind: normalizeKind(meta.kind),
      scope: parseList(meta.scope),
      instruction: meta.instruction || "",
      updatedAt: meta.updatedAt || "",
      sourcesHash: meta.sourcesHash || "",
      synthesizedBodyHash: meta.synthesizedBodyHash || "",
      allowEmptyScope: parseBoolean(meta.allowEmptyScope || meta.allowEmpty),
      body: body.replace(/\s+$/, ""),
      path: magicRelative(normalizedName),
      slug: slugify(normalizedName),
      title: normalizedName,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeMagicDocFile(projectDir, doc) {
  await ensureMagicDir(projectDir);
  const front = [
    "---",
    `name: ${doc.name}`,
    `description: ${String(doc.description || "").replace(/\n+/g, " ")}`,
    `kind: ${normalizeKind(doc.kind)}`,
    `scope: ${serializeList(doc.scope)}`,
    `instruction: ${String(doc.instruction || "").replace(/\n+/g, " ")}`,
    `updatedAt: ${doc.updatedAt || ""}`,
    `sourcesHash: ${doc.sourcesHash || ""}`,
    `synthesizedBodyHash: ${doc.synthesizedBodyHash || ""}`,
    `allowEmptyScope: ${doc.allowEmptyScope ? "true" : "false"}`,
    "---",
    "",
    String(doc.body ?? doc.content ?? "").trim(),
    "",
  ].join("\n");
  await atomicWriteFile(magicFile(projectDir, doc.name), front);
  return { path: magicRelative(doc.name), bytes: front.length };
}

async function readAssetContextGuide(projectDir) {
  await ensureAssetContextDir(projectDir);

  const targetFile = assetContextGuideFile(projectDir);
  let content = "";
  try {
    content = await fs.readFile(targetFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    content = await migrateLegacyAssetContextGuide(projectDir);
    await atomicWriteFile(targetFile, content);
  }

  const referenceDir = assetContextReferenceDir(projectDir);
  let references = [];
  try {
    const entries = await fs.readdir(referenceDir, { withFileTypes: true });
    references = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((fileName) => ASSET_CONTEXT_REFERENCE_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
      .sort((left, right) => left.localeCompare(right))
      .map((fileName) => ({
        label: fileName,
        path: assetContextReferenceRelative(fileName),
      }));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  return {
    content,
    name: "Asset Context",
    path: assetContextGuideRelative(),
    references,
  };
}

async function writeAssetContextGuide(projectDir, text) {
  await ensureAssetContextDir(projectDir);
  const content = typeof text === "string" ? text : String(text || "");
  await atomicWriteFile(assetContextGuideFile(projectDir), content);
  return { path: assetContextGuideRelative(), bytes: content.length };
}

async function collectScopeSources(projectDir, scope) {
  const results = [];
  const scopeErrors = [];
  const resolvedSourcePaths = [];
  let scopeResolvedCount = 0;
  let totalChars = 0;
  let sourcesTruncated = false;

  async function pushSource(sourcePath, absolutePath, maxChars) {
    if (totalChars >= MAX_SOURCE_CHARS) {
      sourcesTruncated = true;
      return;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    const slice = truncateText(content, maxChars);
    const remaining = MAX_SOURCE_CHARS - totalChars;
    const capped = truncateText(slice.content, remaining);
    results.push({
      path: sourcePath,
      content: capped.content,
      truncated: slice.truncated || capped.truncated,
    });
    resolvedSourcePaths.push(sourcePath);
    scopeResolvedCount += 1;
    totalChars += capped.content.length;
    if (slice.truncated || capped.truncated) {
      sourcesTruncated = true;
    }
  }

  async function walkDirectory(projectDir, basePath, absoluteDir) {
    let matched = 0;
    const walk = async (currentDir, relDir) => {
      if (totalChars >= MAX_SOURCE_CHARS) {
        sourcesTruncated = true;
        return;
      }
      let entries = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const nextAbs = path.join(currentDir, entry.name);
        const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(nextAbs, nextRel);
          continue;
        }
        if (!entry.isFile() || !/\.(md|mdx|txt)$/i.test(entry.name)) continue;
        matched += 1;
        await pushSource(`${basePath}/${nextRel}`, nextAbs, 4000);
      }
    };
    await walk(absoluteDir, "");
    return matched;
  }

  // Handle `project:<section>` pseudo-scopes — pull entries out of
  // `.forge/project.json` instead of scanning the filesystem. Asset
  // entries (characters, locations, props, keyframes, audio) are
  // represented in project metadata and mirrored to bound markdown files.
  // This branch still synthesizes one stable text "source" per entry so the
  // generated Asset Library can include media paths and tolerate old projects.
  async function pushProjectSection(rawPattern, section) {
    const allowed = new Set(["characters", "locations", "props", "keyframes", "audio"]);
    if (!allowed.has(section)) {
      scopeErrors.push(
        `Unknown project: scope section '${section}'. Expected one of ${Array.from(allowed).join(", ")}.`,
      );
      return;
    }
    const projectJsonPath = path.join(projectDir, ".forge", "project.json");
    let metadata;
    try {
      const raw = await fs.readFile(projectJsonPath, "utf8");
      metadata = JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") {
        scopeErrors.push(`Scope '${rawPattern}': .forge/project.json not found.`);
        return;
      }
      scopeErrors.push(`Scope '${rawPattern}': failed to read project.json (${error?.message || error}).`);
      return;
    }
    const entries = Array.isArray(metadata?.[section]) ? metadata[section] : [];
    for (const entry of entries) {
      if (totalChars >= MAX_SOURCE_CHARS) {
        sourcesTruncated = true;
        return;
      }
      const title = String(entry?.title || entry?.name || "").trim() || "(untitled)";
      // Include the entry id so two assets sharing the same title don't
      // collapse into one entity in the synthesized doc. Audit M2 (2026-04-20).
      const entryId = String(entry?.id || "").trim();
      const nameLine = entryId ? `Name: ${title} (id: ${entryId})` : `Name: ${title}`;
      const description = String(entry?.content || "").trim();
      const media = Array.isArray(entry?.media)
        ? entry.media.map((m) => String(m?.path || m?.label || "").trim()).filter(Boolean)
        : [];
      const lines = [
        nameLine,
        media.length ? `Media: ${media.join(", ")}` : null,
        "",
        description || "(no description — user has not written one yet)",
      ].filter((line) => line !== null);
      const content = lines.join("\n");
      const remaining = MAX_SOURCE_CHARS - totalChars;
      const capped = truncateText(content, Math.min(remaining, 4000));
      // Use the entry id (when present) for the source path so two assets
      // with the same title don't share the same `project:section/slug`.
      const pathSlug = entryId ? `${slugify(title)}-${entryId.slice(-8)}` : slugify(title);
      const entryPath = `project:${section}/${pathSlug}`;
      results.push({
        path: entryPath,
        content: capped.content,
        truncated: capped.truncated,
      });
      resolvedSourcePaths.push(entryPath);
      scopeResolvedCount += 1;
      totalChars += capped.content.length;
      if (capped.truncated) sourcesTruncated = true;
    }
  }

  for (const rawPattern of Array.isArray(scope) ? scope : []) {
    const asString = String(rawPattern || "").trim();
    if (asString.startsWith("project:")) {
      const section = asString.slice("project:".length).trim();
      await pushProjectSection(asString, section);
      continue;
    }
    const normalized = normalizeRelativePath(rawPattern);
    if (!normalized) continue;

    if (/[*?[\]{}]/.test(normalized) && !normalized.endsWith("/**")) {
      scopeErrors.push(`Unsupported scope pattern '${rawPattern}'. Use a literal file path, dir/**, or project:<section>.`);
      continue;
    }

    const dirGlob = normalized.endsWith("/**");
    const basePath = dirGlob ? normalized.slice(0, -3) : normalized;

    let absolute;
    try {
      absolute = resolveInside(projectDir, basePath);
    } catch (error) {
      scopeErrors.push(`Invalid scope '${rawPattern}': ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile()) {
        if (dirGlob) {
          scopeErrors.push(`Scope '${rawPattern}' expects a directory, but '${basePath}' is a file.`);
          continue;
        }
        await pushSource(basePath, absolute, 8000);
        continue;
      }

      if (!stat.isDirectory()) {
        scopeErrors.push(`Scope '${rawPattern}' did not resolve to a readable file or directory.`);
        continue;
      }

      await walkDirectory(projectDir, basePath, absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (!dirGlob) {
          scopeErrors.push(`Scope path '${basePath}' does not exist.`);
        }
        continue;
      }
      scopeErrors.push(`Failed to read scope '${rawPattern}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const currentSourcesHash = hashStrings(results.map((source) => `${source.path}\n${source.content}`));
  return {
    currentSourcesHash,
    resolvedSourcePaths,
    scopeErrors,
    scopeResolvedCount,
    sourceCount: results.length,
    sources: results,
    sourcesTruncated,
  };
}

function deriveMagicDocStatus(doc, scopeInfo) {
  const bodyDigest = hashBody(doc.body);
  const neverSynthesized = isNeverSynthesized(doc);
  const handEdited = Boolean(doc.synthesizedBodyHash) && Boolean(doc.body.trim()) && doc.synthesizedBodyHash !== bodyDigest;
  const isStale =
    !neverSynthesized &&
    Boolean(doc.sourcesHash || scopeInfo.currentSourcesHash) &&
    doc.sourcesHash !== scopeInfo.currentSourcesHash;
  // Seed docs declare allowEmptyScope:true so a bare project does not
  // chronically flag source-empty generated references as unsynced.
  // Treat 0-source + allowEmptyScope as fresh.
  const emptyScopeAllowed =
    scopeInfo.scopeResolvedCount === 0 &&
    scopeInfo.scopeErrors.length === 0 &&
    Boolean(doc.allowEmptyScope);
  let status = "fresh";
  if (scopeInfo.scopeErrors.length > 0) {
    status = "broken";
  } else if (emptyScopeAllowed) {
    status = "fresh";
  } else if (neverSynthesized) {
    status = "never-synced";
  } else if (handEdited) {
    status = "hand-edited";
  } else if (isStale) {
    status = "stale";
  }
  return {
    bodyHash: bodyDigest,
    handEdited,
    isStale: emptyScopeAllowed ? false : isStale,
    neverSynthesized: emptyScopeAllowed ? false : neverSynthesized,
    status,
  };
}

async function describeMagicDoc(projectDir, name) {
  const doc = await readMagicDocFile(projectDir, name);
  if (!doc) return null;
  const scopeInfo = await collectScopeSources(projectDir, doc.scope);
  const status = deriveMagicDocStatus(doc, scopeInfo);
  return {
    ...doc,
    ...status,
    currentSourcesHash: scopeInfo.currentSourcesHash,
    resolvedSources: scopeInfo.resolvedSourcePaths,
    scopeErrors: scopeInfo.scopeErrors,
    scopeResolvedCount: scopeInfo.scopeResolvedCount,
    sourceCount: scopeInfo.sourceCount,
    sourcesTruncated: scopeInfo.sourcesTruncated,
  };
}

async function listMagicDocs(projectDir) {
  try {
    const entries = await fs.readdir(magicDir(projectDir));
    const docs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".md"))
        .sort((left, right) => left.localeCompare(right))
        .map((entry) => describeMagicDoc(projectDir, entry.replace(/\.md$/i, ""))),
    );
    const visibleDocs = docs.filter(Boolean);
    const hasCombinedAssetLibrary = visibleDocs.some((doc) => doc.name === "Asset Library");
    if (!hasCombinedAssetLibrary) return visibleDocs;
    return visibleDocs.filter((doc) => !LEGACY_ASSET_MAGIC_DOC_NAMES.has(doc.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

// Legacy scope values that pre-date the project:<section> pseudo-scope.
// Map them to the new form on load so existing projects pick up the
// fix without user intervention. Keep this block tiny and specific —
// we don't want to touch user-customised scopes.
const LEGACY_SCOPE_MIGRATION = {
  "characters/**": "project:characters",
  "locations/**": "project:locations",
};

async function ensureDefaultMagicDocs(projectDir) {
  await ensureMagicDir(projectDir);
  for (const template of MAGIC_DOC_DEFAULTS) {
    const existing = await readMagicDocFile(projectDir, template.name);
    if (!existing) {
      await writeMagicDocFile(projectDir, {
        ...template,
        allowEmptyScope: true,
        updatedAt: "",
        sourcesHash: "",
        synthesizedBodyHash: "",
        body: "",
      });
      continue;
    }
    // Migration: rewrite legacy scope values if found. Only touches the
    // scope field; preserves hand-edited body + description.
    const migratedScope = existing.scope.map((value) =>
      LEGACY_SCOPE_MIGRATION[String(value)] || value,
    );
    const changed = migratedScope.some((value, i) => value !== existing.scope[i]);
    if (changed) {
      await writeMagicDocFile(projectDir, {
        ...existing,
        scope: migratedScope,
        // Description may still reference the broken legacy scope; if
        // the template has a new description, take it. Otherwise keep
        // what's on disk (might be user-customised).
        description: template.description || existing.description,
        instruction: template.instruction || existing.instruction,
        // Clear sourcesHash so the doc re-registers as needing sync
        // under the new scope, not "fresh" against a stale hash.
        sourcesHash: "",
      });
    }
  }
}

async function updateMagicDoc(projectDir, name, options = {}) {
  const doc = await describeMagicDoc(projectDir, name);
  if (!doc) {
    throw new Error(`update_magic_doc: '${name}' not found — register with create_magic_doc first.`);
  }

  if (doc.handEdited && !options.force) {
    throw new Error(
      `update_magic_doc: '${doc.name}' has hand-edited content. Pass force:true to regenerate over manual edits.`,
    );
  }

  if (!options.force && !doc.neverSynthesized && !doc.isStale) {
    return {
      ...doc,
      skipped: true,
      reason: "sources unchanged since last update",
    };
  }

  const scopeInfo = await collectScopeSources(projectDir, doc.scope);
  if (!scopeInfo.scopeResolvedCount) {
    return {
      ...doc,
      currentSourcesHash: scopeInfo.currentSourcesHash,
      resolvedSources: scopeInfo.resolvedSourcePaths,
      scopeErrors: scopeInfo.scopeErrors,
      scopeResolvedCount: scopeInfo.scopeResolvedCount,
      sourceCount: scopeInfo.sourceCount,
      sourcesTruncated: scopeInfo.sourcesTruncated,
      skipped: true,
      reason: "no source content resolved from scope",
    };
  }

  if (scopeInfo.scopeErrors.length > 0) {
    throw new Error(
      `update_magic_doc: '${doc.name}' has invalid scope entries: ${scopeInfo.scopeErrors.join(" | ")}`,
    );
  }

  if (typeof options.callModel !== "function") {
    throw new Error("update_magic_doc: callModel is required.");
  }

  const prompt = buildSynthesisPrompt(doc, scopeInfo.sources);
  const raw = await options.callModel({
    prompt,
    sessionKey:
      options.sessionKey ||
      `hook:shotforge:magic:${slugify(doc.name)}`,
    settings: options.settings,
    signal: options.signal,
  });
  const body = String(raw || "").trim().slice(0, MAX_BODY_CHARS);
  // Guard against the model returning empty / near-empty content (overload
  // fallback, parse failure that swallowed the body, etc.). Without this we
  // would cache an empty body, hash it as fresh, and the agent would read
  // nothing on the next turn instead of retrying. Audit H2 (2026-04-20).
  // Threshold of 50 chars is conservative — every legitimate magic-doc
  // synthesis comes back with hundreds to thousands of characters.
  if (body.length < 50) {
    throw new Error(
      `update_magic_doc: synthesis returned ${body.length} chars (expected ≥50) — not caching. Retry or check the model.`,
    );
  }
  const now = new Date().toISOString();
  const synthesizedBodyHash = hashBody(body);
  await writeMagicDocFile(projectDir, {
    ...doc,
    body,
    updatedAt: now,
    sourcesHash: scopeInfo.currentSourcesHash,
    synthesizedBodyHash,
  });
  return describeMagicDoc(projectDir, doc.name);
}

module.exports = {
  ASSET_CONTEXT_DIR,
  ASSET_CONTEXT_GUIDE_FILE,
  ASSET_CONTEXT_REFERENCE_EXTENSIONS,
  ASSET_CONTEXT_REFERENCES_DIR,
  MAGIC_DIR,
  MAGIC_DOC_DEFAULTS,
  MAX_BODY_CHARS,
  MAX_SOURCE_CHARS,
  NEVER_SYNTHESIZED_PLACEHOLDER,
  assetContextDir,
  assetContextGuideFile,
  assetContextGuideRelative,
  assetContextReferenceDir,
  assetContextReferenceRelative,
  collectScopeSources,
  describeMagicDoc,
  ensureDefaultMagicDocs,
  hashBody,
  listMagicDocs,
  magicDir,
  magicFile,
  magicRelative,
  parseList,
  readAssetContextGuide,
  readMagicDocFile,
  resolveInside,
  serializeList,
  slugify,
  updateMagicDoc,
  writeAssetContextGuide,
  writeMagicDocFile,
};
