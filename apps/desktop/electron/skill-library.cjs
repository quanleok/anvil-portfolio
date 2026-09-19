const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteFile } = require("./atomic-write.cjs");

const APP_FOLDER = ".forge";
const SKILLS_DIR = path.join(APP_FOLDER, "skills");
const DEFAULT_SKILLS_DIR = path.join(__dirname, "defaults", "skills");

const SKILL_GROUPS = [
  {
    id: "cinematic",
    label: "Anvil Skills",
    kind: "addon",
    defaultEnabled: true,
    description: "Default Anvil film skills: asset-reference generation, camera, light, color, motion, performance, and sound references.",
  },
  {
    id: "story",
    label: "Story & Directing",
    kind: "addon",
    description: "Optional directing, emotion, archetype, culture, film-canon, and extended scene references.",
  },
  {
    id: "commercial",
    label: "Commercial & Platform",
    kind: "addon",
    description: "Optional ad, product, format, aspect-ratio, and platform delivery references.",
  },
  {
    id: "finishing",
    label: "Post & Finishing",
    kind: "addon",
    description: "Optional editing, VFX, score, and AI postprocessing references.",
  },
  {
    id: "custom",
    label: "Custom",
    kind: "addon",
    description: "Project-specific skill docs imported or written by the user.",
  },
];

const GROUP_BY_ID = new Map(SKILL_GROUPS.map((group) => [group.id, group]));
const ADDON_GROUP_IDS = SKILL_GROUPS.filter((group) => group.kind === "addon").map((group) => group.id);
const DEFAULT_ENABLED_SKILL_ADDONS = ["cinematic"];

// Built-in default skills ship in defaults/skills/ and are all grouped into
// user-visible add-ons. Anvil Skills is default-on; every visible skill can
// still be disabled individually from the library UI. Provider-specific
// recipes and protected automation runners live on the Anvil server.
const CORE_SKILLS = new Set();

const SYSTEM_PROTOCOL_SKILLS = new Set([
  "intake-protocol",
  "prompt-protocol",
]);

const INTERNAL_SKILLS = new Set([
  "agent-manual",
]);

// These used to live in `.forge/skills/` in older projects. They are useful,
// but too heavy/provider-specific for the always-on local skill lane. They now
// belong to protected Anvil server methods instead of readable desktop files.
const PREMIUM_ONLY_SKILLS = new Set([
  "automation-quality-gates",
  "continuity",
  "film-blueprint-director",
  "film-render-runner",
  "seedance-drift-catalog",
  "seedance-prompting",
  "visual-continuity-lab",
]);

const ADDON_SKILL_GROUPS = {
  cinematic: [
    "image-generation",
    "media-routing",
    "camera",
    "composition",
    "motion",
    "style",
    "mood-atmosphere",
    "palette-language",
    "color-grading",
    "talent-direction",
    "sound-design",
    "continuity-types",
    "shot-composition",
    "shot",
  ],
  story: [
    "film-directing",
    "emotional-weight",
    "scene-craft-extended",
    "archetypes",
    "cultural-reference",
    "visual-canon-film",
    "art-history",
    "era-pastiche",
  ],
  commercial: [
    "ad-structure",
    "ad-and-promo",
    "product-shot",
    "aspect-ratio",
    "platform-format",
  ],
  finishing: [
    "video-editing-craft",
    "ai-video-postprocessing",
    "vfx",
    "music-and-score",
  ],
};

const ADDON_GROUP_BY_SKILL = new Map();
for (const [groupId, slugs] of Object.entries(ADDON_SKILL_GROUPS)) {
  for (const slug of slugs) {
    ADDON_GROUP_BY_SKILL.set(slug, groupId);
  }
}

function normalizeSkillSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFrontmatter(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: text };
  const block = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta = {};
  for (const line of block.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) meta[key] = value;
  }
  for (const key of ["triggers", "crossRefs"]) {
    if (!meta[key]) continue;
    try {
      meta[key] = JSON.parse(meta[key]);
    } catch {
      meta[key] = meta[key].split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(meta[key])) meta[key] = [];
  }
  return { meta, body };
}

function safeFrontmatterValue(value, fallback = "") {
  return String(value || fallback || "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function wordCount(text) {
  const matches = String(text || "").trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function normalizeEnabledSkillAddons(value) {
  const allowed = new Set(ADDON_GROUP_IDS);
  const selected = new Set(DEFAULT_ENABLED_SKILL_ADDONS.filter((entry) => allowed.has(entry)));
  if (Array.isArray(value)) {
    for (const entry of value) {
      const groupId = String(entry || "").trim();
      if (allowed.has(groupId)) selected.add(groupId);
    }
  }
  return [...selected];
}

function normalizeDisabledSkills(value) {
  if (!Array.isArray(value)) return [];
  const out = new Set();
  for (const entry of value) {
    const slug = normalizeSkillSlug(entry);
    if (slug && !isSkillSystemProtocol(slug)) out.add(slug);
  }
  return [...out];
}

async function readProjectSkillSettings(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, APP_FOLDER, "project.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabledSkillAddons: normalizeEnabledSkillAddons(parsed?.settings?.enabledSkillAddons),
      disabledSkills: normalizeDisabledSkills(parsed?.settings?.disabledSkills),
    };
  } catch {
    return { enabledSkillAddons: normalizeEnabledSkillAddons([]), disabledSkills: [] };
  }
}

function skillGroupForSlug(slug, meta = {}) {
  const declaredGroup = normalizeSkillSlug(meta.group || meta.addon || "");
  if (declaredGroup && GROUP_BY_ID.has(declaredGroup)) return GROUP_BY_ID.get(declaredGroup);
  const addonGroupId = ADDON_GROUP_BY_SKILL.get(slug);
  if (addonGroupId) return GROUP_BY_ID.get(addonGroupId) || GROUP_BY_ID.get("custom");
  return GROUP_BY_ID.get("custom");
}

function isSkillInternal(slug) {
  return INTERNAL_SKILLS.has(slug);
}

function isSkillSystemProtocol(slug) {
  return SYSTEM_PROTOCOL_SKILLS.has(slug);
}

function isSkillPremiumOnly(slug) {
  return PREMIUM_ONLY_SKILLS.has(slug);
}

function isSkillEnabled(slug, settings = {}, meta = {}) {
  if (isSkillSystemProtocol(slug)) return true;
  if (isSkillInternal(slug)) return false;
  if (isSkillPremiumOnly(slug)) return false;
  if (normalizeDisabledSkills(settings.disabledSkills).includes(slug)) return false;
  const group = skillGroupForSlug(slug, meta);
  if (!group) return false;
  if (group.defaultEnabled) return true;
  return normalizeEnabledSkillAddons(settings.enabledSkillAddons).includes(group.id);
}

function decorateSkillDoc(entry, raw, settings = {}) {
  const slug = normalizeSkillSlug(entry.replace(/\.md$/i, ""));
  const { meta, body } = parseFrontmatter(raw);
  const group = skillGroupForSlug(slug, meta);
  const systemProtocol = isSkillSystemProtocol(slug);
  const internal = isSkillInternal(slug);
  const premiumOnly = isSkillPremiumOnly(slug);
  const enabled = isSkillEnabled(slug, settings, meta);
  return {
    name: meta.name || slug,
    slug,
    summary: meta.summary || "",
    version: meta.version || "1",
    triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
    crossRefs: Array.isArray(meta.crossRefs) ? meta.crossRefs : [],
    words: wordCount(body),
    path: path.join(SKILLS_DIR, `${slug}.md`),
    groupId: group.id,
    groupLabel: group.label,
    core: false,
    addon: group.kind === "addon",
    custom: group.id === "custom",
    disabled: normalizeDisabledSkills(settings.disabledSkills).includes(slug),
    enabled,
    systemProtocol,
    internal,
    premiumOnly,
    content: body.trim(),
  };
}

async function listSkillDocs(projectDir, options = {}) {
  const settings = options.settings || await readProjectSkillSettings(projectDir);
  const dirPath = path.join(projectDir, SKILLS_DIR);
  try {
    const entries = (await fs.readdir(dirPath)).sort((a, b) => a.localeCompare(b));
    const docs = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(dirPath, entry), "utf8");
      const doc = decorateSkillDoc(entry, raw, settings);
      if (doc.systemProtocol && !options.includeSystemProtocols) continue;
      if (doc.internal && !options.includeInternal) continue;
      if (doc.premiumOnly && !options.includePremiumOnly) continue;
      if (options.enabledOnly && !doc.enabled) continue;
      docs.push(options.includeContent ? doc : omitContent(doc));
    }
    return docs;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readSkillDoc(projectDir, name, options = {}) {
  const slug = normalizeSkillSlug(name);
  if (!slug) return null;
  if (isSkillSystemProtocol(slug) && !options.includeSystemProtocols) {
    throw new Error(`read_skill: '${name}' is an internal Anvil protocol and is hidden from the user skill library.`);
  }
  const filePath = isSkillSystemProtocol(slug)
    ? path.join(DEFAULT_SKILLS_DIR, `${slug}.md`)
    : path.join(projectDir, SKILLS_DIR, `${slug}.md`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const settings = options.settings || await readProjectSkillSettings(projectDir);
    const doc = decorateSkillDoc(`${slug}.md`, raw, settings);
    if (doc.internal && !options.includeInternal) {
      throw new Error(`read_skill: '${name}' is an internal bootstrap note and is hidden from the agent skill library.`);
    }
    if (doc.premiumOnly && !options.includePremiumOnly) {
      throw new Error(
        `read_skill: '${name}' moved to protected Anvil server methods and is not readable from desktop files.`,
      );
    }
    if (!options.includeDisabled && !doc.enabled) {
      if (doc.disabled) {
        throw new Error(
          `read_skill: '${name}' is disabled in ${doc.groupLabel}. Re-enable that individual skill in Anvil Skills before using it.`,
        );
      }
      throw new Error(
        `read_skill: '${name}' is disabled in the ${doc.groupLabel} add-on group. Enable that add-on in Anvil Skills before using it.`,
      );
    }
    return doc;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function omitContent(doc) {
  const { content: _content, ...rest } = doc;
  return rest;
}

async function listSkillLibrary(projectDir, options = {}) {
  const settings = options.settings || await readProjectSkillSettings(projectDir);
  const enabledSkillAddons = normalizeEnabledSkillAddons(settings.enabledSkillAddons);
  const disabledSkills = normalizeDisabledSkills(settings.disabledSkills);
  const skills = await listSkillDocs(projectDir, {
    ...options,
    settings: { enabledSkillAddons, disabledSkills },
    enabledOnly: false,
    includeInternal: false,
    includeContent: false,
  });
  const groups = SKILL_GROUPS.map((group) => {
    const groupSkills = skills.filter((skill) => skill.groupId === group.id);
    return {
      ...group,
      enabled: Boolean(group.defaultEnabled) || enabledSkillAddons.includes(group.id),
      skillCount: groupSkills.length,
      enabledSkillCount: groupSkills.filter((skill) => skill.enabled).length,
      skills: groupSkills,
    };
  });
  return {
    enabledSkillAddons,
    disabledSkills,
    groups,
    skills,
  };
}

function resolveProjectSkillPath(projectDir, name) {
  const slug = normalizeSkillSlug(name);
  if (!slug) throw new Error("Skill name is required.");
  const filePath = path.join(projectDir, SKILLS_DIR, `${slug}.md`);
  const root = path.resolve(projectDir, SKILLS_DIR);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Skill path escapes the project.");
  }
  return { slug, filePath };
}

async function readSkillMarkdown(projectDir, name) {
  const { slug, filePath } = resolveProjectSkillPath(projectDir, name);
  if (isSkillSystemProtocol(slug)) {
    throw new Error(`'${slug}' is an internal Anvil protocol and cannot be edited or exported here.`);
  }
  const content = await fs.readFile(filePath, "utf8");
  return { slug, path: path.join(SKILLS_DIR, `${slug}.md`), content };
}

async function writeSkillMarkdown(projectDir, name, content) {
  const { slug, filePath } = resolveProjectSkillPath(projectDir, name);
  if (isSkillSystemProtocol(slug)) {
    throw new Error(`'${slug}' is an internal Anvil protocol and cannot be edited here.`);
  }
  const nextContent = String(content || "").replace(/\s+$/u, "") + "\n";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, nextContent);
  return { slug, path: path.join(SKILLS_DIR, `${slug}.md`), bytes: Buffer.byteLength(nextContent, "utf8") };
}

async function resetSkillMarkdown(projectDir, name) {
  const { slug, filePath } = resolveProjectSkillPath(projectDir, name);
  if (isSkillSystemProtocol(slug)) {
    throw new Error(`'${slug}' is an internal Anvil protocol and cannot be reset here.`);
  }
  const defaultPath = path.join(DEFAULT_SKILLS_DIR, `${slug}.md`);
  let content = "";
  try {
    content = await fs.readFile(defaultPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`No built-in default exists for '${slug}'. Custom skills cannot be reset.`);
    }
    throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, content);
  return { slug, path: path.join(SKILLS_DIR, `${slug}.md`), content };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniqueSkillSlug(projectDir, baseSlug) {
  const root = path.join(projectDir, SKILLS_DIR);
  const cleanBase = normalizeSkillSlug(baseSlug) || "custom-skill";
  let slug = cleanBase;
  let index = 2;
  while (isSkillSystemProtocol(slug) || await fileExists(path.join(root, `${slug}.md`))) {
    slug = `${cleanBase}-${index}`;
    index += 1;
  }
  return slug;
}

function customSkillTitleForBase(baseName) {
  const title = safeFrontmatterValue(baseName, "Custom Skill") || "Custom Skill";
  return isSkillSystemProtocol(normalizeSkillSlug(title)) ? `${title} Custom` : title;
}

function ensureCustomSkillFrontmatter(raw, fallbackName) {
  const text = String(raw || "").replace(/\s+$/u, "");
  const title = customSkillTitleForBase(fallbackName);
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      const block = text.slice(4, end).trimEnd();
      const body = text.slice(end + 5).replace(/^\n+/, "");
      const lines = block ? block.split("\n") : [];
      const keys = new Set();
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const sep = line.indexOf(":");
        if (sep <= 0) continue;
        const key = line.slice(0, sep).trim().toLowerCase();
        keys.add(key);
        if (key === "name" && isSkillSystemProtocol(normalizeSkillSlug(line.slice(sep + 1)))) {
          lines[index] = `name: ${title}`;
        }
      }
      if (!keys.has("name")) lines.unshift(`name: ${title}`);
      if (!keys.has("summary")) lines.push("summary: Custom project skill.");
      if (!keys.has("group")) lines.push("group: custom");
      if (!keys.has("version")) lines.push("version: 1");
      const nextBody = body.trim() ? body : `# ${title}\n\nDescribe when and how the agent should use this skill.`;
      return `---\n${lines.join("\n")}\n---\n\n${nextBody.replace(/\s+$/u, "")}\n`;
    }
  }
  const body = text.trim() ? text : `# ${title}\n\nDescribe when and how the agent should use this skill.`;
  return [
    "---",
    `name: ${title}`,
    "summary: Custom project skill.",
    "group: custom",
    "version: 1",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function customSkillTemplate(name) {
  return ensureCustomSkillFrontmatter("", name);
}

async function createCustomSkill(projectDir, name) {
  const title = customSkillTitleForBase(name);
  const slug = await uniqueSkillSlug(projectDir, title);
  const filePath = path.join(projectDir, SKILLS_DIR, `${slug}.md`);
  const content = customSkillTemplate(title);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, content);
  return { slug, path: path.join(SKILLS_DIR, `${slug}.md`), content };
}

async function importSkillMarkdown(projectDir, sourcePath) {
  const fileName = path.basename(String(sourcePath || ""));
  if (!fileName || !fileName.toLowerCase().endsWith(".md")) {
    throw new Error("Only markdown skill files (.md) can be imported.");
  }
  const raw = await fs.readFile(sourcePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const fallbackName = customSkillTitleForBase(
    safeFrontmatterValue(parsed.meta.name, path.basename(fileName, path.extname(fileName))),
  );
  const slug = await uniqueSkillSlug(projectDir, fallbackName);
  const content = ensureCustomSkillFrontmatter(raw, fallbackName);
  const filePath = path.join(projectDir, SKILLS_DIR, `${slug}.md`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, content);
  return {
    slug,
    path: path.join(SKILLS_DIR, `${slug}.md`),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

module.exports = {
  ADDON_GROUP_IDS,
  CORE_SKILLS,
  DEFAULT_SKILLS_DIR,
  DEFAULT_ENABLED_SKILL_ADDONS,
  INTERNAL_SKILLS,
  SYSTEM_PROTOCOL_SKILLS,
  PREMIUM_ONLY_SKILLS,
  SKILLS_DIR,
  SKILL_GROUPS,
  isSkillEnabled,
  isSkillInternal,
  isSkillSystemProtocol,
  isSkillPremiumOnly,
  listSkillDocs,
  listSkillLibrary,
  normalizeDisabledSkills,
  normalizeEnabledSkillAddons,
  normalizeSkillSlug,
  parseFrontmatter,
  readProjectSkillSettings,
  readSkillDoc,
  readSkillMarkdown,
  resetSkillMarkdown,
  skillGroupForSlug,
  wordCount,
  createCustomSkill,
  customSkillTemplate,
  ensureCustomSkillFrontmatter,
  importSkillMarkdown,
  writeSkillMarkdown,
};
