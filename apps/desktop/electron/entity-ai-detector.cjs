const { callAgentModel } = require("./agent-runtime.cjs");

const ASSET_SECTIONS = ["characters", "locations", "props", "keyframes", "audio"];

function normalizeAgentProvider(provider) {
  return String(provider || "").trim().toLowerCase() === "hermes" ? "hermes" : "openclaw";
}

function collectExistingAssets(project) {
  const bySection = {};
  for (const section of ASSET_SECTIONS) {
    const items = Array.isArray(project?.[section]) ? project[section] : [];
    bySection[section] = items
      .map((a) => ({
        id: String(a?.id || "").trim(),
        name: String(a?.name || a?.title || "").trim(),
      }))
      .filter((x) => x.id && x.name);
  }
  return bySection;
}

function collectEntryBodies(project) {
  const out = [];
  const scenes = Array.isArray(project?.script) ? project.script : [];
  for (const s of scenes) {
    if (s?.content || s?.title) {
      out.push({ kind: "scene", title: s.title || "Untitled", body: s.content || "" });
    }
  }
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  for (const s of shots) {
    if (s?.content || s?.title) {
      out.push({ kind: "shot", title: s.title || "Untitled", body: s.content || "" });
    }
  }
  const prompts = Array.isArray(project?.prompts) ? project.prompts : [];
  for (const p of prompts) {
    if (p?.content || p?.title) {
      out.push({ kind: "prompt", title: p.title || "Untitled", body: p.content || "" });
    }
  }
  return out;
}

function buildDetectionPrompt(project) {
  const existing = collectExistingAssets(project);
  const entries = collectEntryBodies(project);

  // One block with full IDs — AI copies these directly into aliasLinks.assetId.
  const existingBlock = ASSET_SECTIONS.map((section) => {
    const items = existing[section] || [];
    if (!items.length) return `- ${section}: (none)`;
    const formatted = items.map((a) => `${a.name} [id=${a.id}]`).join(", ");
    return `- ${section}: ${formatted}`;
  }).join("\n");

  // Cap total body length to keep prompts tight. Include titles to catch
  // entities that only appear in headings (e.g., scene named "The Seer").
  const MAX_CHARS = 16_000;
  let budget = MAX_CHARS;
  const bodyBlocks = [];
  const sorted = [
    ...entries.filter((e) => e.kind === "prompt"),
    ...entries.filter((e) => e.kind === "shot"),
    ...entries.filter((e) => e.kind === "scene"),
  ];
  for (const entry of sorted) {
    const block = `[${entry.kind}] ${entry.title}\n${String(entry.body || "").trim()}\n`;
    if (block.length > budget) break;
    bodyBlocks.push(block);
    budget -= block.length;
  }

  const bodiesText = bodyBlocks.join("\n---\n") || "(no content yet)";

  return [
    "You are analyzing a film project to keep script entities in sync with asset entries.",
    "",
    "Existing assets (DO NOT propose these as new placeholders):",
    existingBlock,
    "",
    "Scene, shot, and prompt content (titles included):",
    "",
    bodiesText,
    "",
    "Return a JSON object with TWO arrays:",
    "",
    "1. `candidates` — named entities mentioned in the content that are NOT already an asset. These become placeholder assets the user will upload media to.",
    "",
    "   - Only include proper-noun entities that are clearly part of this story world (e.g., 'Mountain Castle', 'The Seer', 'Ashen Blade').",
    "   - SKIP prose nouns, numbers, and film vocabulary (Wide, Close, Static, Tracking, OTS, Pan, Tilt, Three, Second, Both, Over, etc.).",
    "   - SKIP scene/shot title echoes that are just descriptive phrases.",
    "   - SKIP common descriptors (armor, sword, warrior, knight, hero) unless they appear as a named entity.",
    "   - Prefer multi-word proper names over single words.",
    "   - Bucket into: characters, locations, or props.",
    "",
    "2. `aliasLinks` — alias/nickname phrases in the prose that refer to an EXISTING asset but aren't the asset's exact name. These produce link suggestions the user can approve to tag the entry with the asset ref.",
    "",
    "   - Examples: 'the hero' → Aki, 'the dark blade' → Ashen Blade, 'that corridor' → Dread Corridor.",
    "   - Only include confident matches with clear context.",
    "   - Use the full asset ID from the lookup above in `assetId`.",
    "   - Skip cases where the exact asset name already appears — those don't need alias help.",
    "",
    "Respond with ONLY a JSON object (no prose, no code fences) in this exact shape:",
    '{"candidates":[{"name":"<entity name>","section":"characters|locations|props","mentions":<int>}],',
    ' "aliasLinks":[{"alias":"<phrase in prose>","assetId":"<full asset id>","section":"characters|locations|props|keyframes|audio","mentions":<int>}]}',
    "",
    "If there are no suggestions, return {\"candidates\":[], \"aliasLinks\":[]}.",
  ].join("\n");
}

function extractJsonBlock(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseDetectionResponse(text) {
  const block = extractJsonBlock(text);
  if (!block) return { candidates: [], aliasLinks: [] };
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { candidates: [], aliasLinks: [] };
  }

  const candidates = [];
  const seenCandidates = new Set();
  for (const item of Array.isArray(parsed?.candidates) ? parsed.candidates : []) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "").trim();
    const section = String(item.section || "").trim().toLowerCase();
    if (!name || !["characters", "locations", "props"].includes(section)) continue;
    const key = `${section}:${name.toLowerCase()}`;
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    const mentions = Number(item.mentions);
    candidates.push({
      name,
      section,
      mentions: Number.isFinite(mentions) && mentions > 0 ? Math.round(mentions) : 1,
    });
  }

  const aliasLinks = [];
  const seenAliases = new Set();
  for (const item of Array.isArray(parsed?.aliasLinks) ? parsed.aliasLinks : []) {
    if (!item || typeof item !== "object") continue;
    const alias = String(item.alias || "").trim();
    const assetId = String(item.assetId || "").trim();
    const section = String(item.section || "").trim().toLowerCase();
    if (!alias || !assetId || !ASSET_SECTIONS.includes(section)) continue;
    const key = `${section}:${assetId}:${alias.toLowerCase()}`;
    if (seenAliases.has(key)) continue;
    seenAliases.add(key);
    const mentions = Number(item.mentions);
    aliasLinks.push({
      alias,
      assetId,
      section,
      mentions: Number.isFinite(mentions) && mentions > 0 ? Math.round(mentions) : 1,
    });
  }

  return { candidates, aliasLinks };
}

async function detectEntityPlaceholders({ project, settings = {}, signal } = {}) {
  if (!project) return { candidates: [], aliasLinks: [] };
  const prompt = buildDetectionPrompt(project);
  const response = await callAgentModel({
    provider: normalizeAgentProvider(settings.agentProvider),
    binPath: settings.agentBinPath || "",
    prompt,
    signal,
  });
  return parseDetectionResponse(response);
}

module.exports = {
  buildDetectionPrompt,
  parseDetectionResponse,
  detectEntityPlaceholders,
};
