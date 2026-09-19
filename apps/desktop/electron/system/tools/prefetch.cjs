// prefetch_context — one-call bundle loader keyed by classifier intent.
//
// The renderer runs `classifyIntent` before it dispatches a chat message
// and attaches the result to the IPC payload. Agent-loop then surfaces
// the intent in the dynamic frame with a hint pointing here.
//
// Each bundle composes existing tools (read_scene_bundle, read_skill,
// etc.) via api.runTool — no new fs logic, no reimplementation. A
// missing skill returns a placeholder instead of throwing so a
// fresh project without defaults still gets a usable envelope.

const skillLibrary = require("../../skill-library.cjs");

// Canonical list of intent IDs that have a BUNDLES entry. Kept at module
// scope so the intent-coverage test can assert classifier/bundle parity
// without instantiating the register function. BUNDLES inside
// registerPrefetchTools captures api.runTool and can't be hoisted; we
// validate this list against Object.keys(BUNDLES) at registration time
// so the two can't drift silently.
const BUNDLE_INTENT_IDS = [
  "write-prompt",
  "refine-prompt",
  "continue-prompt",
  "validate-prompt",
  "write-scene",
  "refine-scene",
  "validate-scene",
  "decompose-scene",
  "write-dialogue",
  "refine-dialogue",
  "refine-story-doc",
  "sync-canon-down",
  "sync-canon-up",
  "refine-project-context",
  "describe-asset",
  "link-asset-refs",
  "find-asset-usage",
  "find-asset-duplicates",
  "full-audit",
  "audit-durations",
];

function registerPrefetchTools(api) {
  const { registerTool, runTool } = api;

  async function safeRun(name, args, projectDir) {
    try {
      return await runTool(name, args || {}, { projectDir });
    } catch (err) {
      return { tool: name, missing: true, reason: err?.message || "unavailable" };
    }
  }

  async function loadSkill(name, projectDir) {
    if (skillLibrary.isSkillSystemProtocol(name)) {
      try {
        return await skillLibrary.readSkillDoc(projectDir, name, { includeSystemProtocols: true });
      } catch (err) {
        return { tool: "read_skill", missing: true, reason: err?.message || "unavailable" };
      }
    }
    return safeRun("read_skill", { name }, projectDir);
  }

  async function loadSkills(names, projectDir) {
    return Promise.all(names.map((name) => loadSkill(name, projectDir)));
  }

  // Resolve an asset id into a bundle by trying each asset section.
  // Parallel — read all 5 sections at once and pick the first hit. Pre-fix:
  // 5 sequential awaits, slowest case (audio) cost 5× a single read. Audit
  // R1 (2026-04-20).
  async function readAssetAnySection(assetId, projectDir) {
    const sections = ["characters", "locations", "props", "keyframes", "audio"];
    const bundles = await Promise.all(
      sections.map((section) => safeRun("read_asset_bundle", { section, assetId }, projectDir)),
    );
    const hit = bundles.find((b) => b && !b.missing);
    return hit || { missing: true, reason: `asset '${assetId}' not found in any section` };
  }

  const BUNDLES = {
    // ================= Prompts =================

    "write-prompt": async (entityId, projectDir) => {
      // entityId is usually a sceneId (new prompt under a scene) or a
      // promptId (refine an existing prompt).
      const [asScene, asPrompt, skills] = await Promise.all([
        entityId ? safeRun("read_scene_bundle", { sceneId: entityId }, projectDir) : null,
        entityId ? safeRun("read_prompt_bundle", { promptId: entityId }, projectDir) : null,
        loadSkills([], projectDir),
      ]);
      let target = null;
      if (entityId) {
        target = asScene && !asScene.missing
          ? { kind: "scene", ...asScene }
          : { kind: "prompt", ...asPrompt };
      }
      return {
        intent: "write-prompt",
        target,
        skills,
        guidance: "Use create_prompt when the user requests a new prompt, or edit_file for an existing prompt. Preserve the selected scene and existing metadata. Follow the user's content and provider settings.",
      };
    },

    "refine-prompt": async (entityId, projectDir) => {
      const [target, skills] = await Promise.all([
        entityId ? safeRun("read_prompt_bundle", { promptId: entityId }, projectDir) : null,
        loadSkills([], projectDir),
      ]);
      return {
        intent: "refine-prompt",
        target,
        skills,
        guidance: "Edit the requested prompt with edit_file. Preserve metadata and references unless the user asks to change them. Report the changed path.",
      };
    },

    "continue-prompt": async (entityId, projectDir) => {
      const [target, skills] = await Promise.all([
        entityId ? safeRun("read_prompt_bundle", { promptId: entityId }, projectDir) : null,
        loadSkills([], projectDir),
      ]);
      return {
        intent: "continue-prompt",
        target,
        skills,
        guidance: "Use create_prompt for the requested additional prompt. It creates a default prevPromptId link within the scene; inspect that metadata and use set_prompt_continuity if the user requests a different link.",
      };
    },

    "validate-prompt": async (entityId, projectDir) => {
      const [target, skills] = await Promise.all([
        entityId ? safeRun("read_prompt_bundle", { promptId: entityId }, projectDir) : null,
        loadSkills([], projectDir),
      ]);
      return {
        intent: "validate-prompt",
        target,
        skills,
        guidance: "Read-only review of the requested prompt. Report missing references, unsupported provider settings, and questions that need user clarification. Do not edit.",
      };
    },

    // ================= Dialogue =================

    "write-dialogue": async (entityId, projectDir) => {
      // entityId is the parent scene id — bundle pulls scene + shots +
      // existing dialogue so the agent can place new lines coherently.
      const [target, skills] = await Promise.all([
        entityId ? safeRun("read_scene_bundle", { sceneId: entityId }, projectDir) : null,
        loadSkills([], projectDir),
      ]);
      return {
        intent: "write-dialogue",
        target,
        skills,
        guidance:
          "Write or extend dialogue with edit_file on dialogue/<scene>.md (or create the file). Frontmatter must carry sceneId (and shotId when scoped). Existing dialogue is in target.dialogue[].",
      };
    },

    "refine-dialogue": async (entityId, projectDir) => {
      const [target, skills] = await Promise.all([
        entityId ? safeRun("read_scene_bundle", { sceneId: entityId }, projectDir) : null,
        loadSkills([], projectDir),
      ]);
      return {
        intent: "refine-dialogue",
        target,
        skills,
        guidance:
          "Tighten dialogue with edit_file. Existing lines + scene structure are in target.dialogue[] and target.shots[]. Keep character voice consistent across scenes.",
      };
    },

    // ================= Scenes =================

    "write-scene": async (entityId, projectDir) => {
      const [target, story, skills] = await Promise.all([
        entityId ? safeRun("read_scene_bundle", { sceneId: entityId }, projectDir) : null,
        safeRun("read_story_bundle", {}, projectDir),
        loadSkills([], projectDir),
      ]);
      return {
        intent: "write-scene",
        target,
        story,
        skills,
        guidance: "Use create_scene for a requested new scene or edit_file for an existing scene. Use the supplied files as context and preserve unrelated work. Do not create additional documents unless requested.",
      };
    },

    "refine-scene": async (entityId, projectDir) => {
      const [target, story, skills] = await Promise.all([
        entityId ? safeRun("read_scene_bundle", { sceneId: entityId }, projectDir) : null,
        safeRun("read_story_bundle", {}, projectDir),
        loadSkills([], projectDir),
      ]);
      return {
        intent: "refine-scene",
        target,
        story,
        skills,
        guidance: "Edit the scene or script named in the request. Preserve existing organization, metadata, and linked files unless the requested change requires updating them.",
      };
    },

    "validate-scene": async (entityId, projectDir) => {
      const [target, story] = await Promise.all([
        entityId ? safeRun("read_scene_bundle", { sceneId: entityId }, projectDir) : null,
        safeRun("read_story_bundle", {}, projectDir),
      ]);
      return {
        intent: "validate-scene",
        target,
        story,
        guidance: "Read-only review against the user's stated requirements and existing project references. Report inconsistencies without changing files.",
      };
    },

    "decompose-scene": async (entityId, projectDir) => {
      const [target, skills] = await Promise.all([
        entityId ? safeRun("read_scene_bundle", { sceneId: entityId }, projectDir) : null,
        loadSkills([], projectDir),
      ]);
      return {
        intent: "decompose-scene",
        target,
        skills,
        guidance: "Use the requested organization and level of detail. Read the supplied scene, propose or create only the requested supporting files, and preserve existing work.",
      };
    },

    // ================= Story / canon =================

    "refine-story-doc": async (entityId, projectDir) => {
      const [story, projectContext] = await Promise.all([
        safeRun("read_story_bundle", {}, projectDir),
        safeRun("read_project_context", {}, projectDir),
      ]);
      return {
        intent: "refine-story-doc",
        targetDocId: entityId,
        story,
        projectContext,
        guidance: "Edit the document identified by the user or targetDocId, using the supplied context. Ask for clarification if the target is ambiguous. Use edit_file for a small change or write_file for an authorized rewrite, then report the changed path.",
      };
    },

    "sync-canon-down": async (_entityId, projectDir) => {
      const [story, projectContext] = await Promise.all([
        safeRun("read_story_bundle", {}, projectDir),
        safeRun("read_project_context", {}, projectDir),
      ]);
      return {
        intent: "sync-canon-down",
        story,
        projectContext,
        scope: "project-wide",
        guidance: "Review the supplied project notes and related writing for the consistency update the user requested. Modify only affected files and report the changed paths.",
      };
    },

    "sync-canon-up": async (_entityId, projectDir) => {
      const [story, projectContext] = await Promise.all([
        safeRun("read_story_bundle", {}, projectDir),
        safeRun("read_project_context", {}, projectDir),
      ]);
      return {
        intent: "sync-canon-up",
        story,
        projectContext,
        scope: "project-wide",
        guidance: "Update the project notes the user requested using the current writing. Preserve existing structure and distinguish documented facts from assumptions.",
      };
    },

    "refine-project-context": async (_entityId, projectDir) => {
      const [projectContext, story] = await Promise.all([
        safeRun("read_project_context", {}, projectDir),
        safeRun("read_story_bundle", {}, projectDir),
      ]);
      return {
        intent: "refine-project-context",
        projectContext,
        story,
        guidance: "ANVIL.md contains workspace operating notes. Edit it only when that is the user's intended target. Other project notes remain in the user's chosen story/ or custom/ documents.",
      };
    },

    // ================= Assets =================

    "describe-asset": async (entityId, projectDir) => {
      if (!entityId) {
        return { intent: "describe-asset", note: "pass assetId as entityId" };
      }
      const [target, projectContext] = await Promise.all([
        readAssetAnySection(entityId, projectDir),
        safeRun("read_project_context", {}, projectDir),
      ]);
      return {
        intent: "describe-asset",
        target,
        projectContext,
        guidance:
          "Use update_asset_entry({ section, assetId, name?, content?, audioKind?, folder? }) to write back changes — DO NOT delete + recreate, that breaks inbound entityRefs. For cross-section moves use move_asset_entry. To compare candidate images use compare_images on the bundle's media.path values. The bundle's `usedBy[]` lists every scene/shot/prompt/dialogue that references this asset; `mediaRefs[]` lists other assets sharing each media file.",
      };
    },

    "link-asset-refs": async (entityId, projectDir) => {
      const [target, refs] = await Promise.all([
        entityId ? readAssetAnySection(entityId, projectDir) : null,
        entityId ? safeRun("get_media_refs", { assetId: entityId }, projectDir) : null,
      ]);
      return {
        intent: "link-asset-refs",
        target,
        refs,
        scope: "project-wide",
        guidance:
          "Search for the asset's name with `search`, then edit_file on each scene/shot/prompt to update frontmatter entityRefs. Confirm paths before write.",
      };
    },

    "find-asset-usage": async (entityId, projectDir) => {
      if (!entityId) {
        return { intent: "find-asset-usage", note: "pass assetId as entityId" };
      }
      const [target, refs] = await Promise.all([
        readAssetAnySection(entityId, projectDir),
        safeRun("get_media_refs", { assetId: entityId }, projectDir),
      ]);
      return {
        intent: "find-asset-usage",
        target,
        refs,
        guidance:
          "Read-only. The asset bundle's `usedBy[]` already lists every scene/shot/prompt/dialogue reference with role and the role-count summary. `mediaRefs[]` shows which other assets share each bound media file. No edits.",
      };
    },

    "find-asset-duplicates": async (_entityId, projectDir) => {
      // Project-wide duplicate scan — entityId isn't meaningful for this
      // intent. Bundle ships find_duplicate_media output for both image
      // and audio kinds so the agent can survey both at once.
      const [imageGroups, audioGroups] = await Promise.all([
        safeRun("find_duplicate_media", { kind: "image" }, projectDir),
        safeRun("find_duplicate_media", { kind: "audio" }, projectDir),
      ]);
      return {
        intent: "find-asset-duplicates",
        imageGroups,
        audioGroups,
        guidance:
          "Read-only audit. For each duplicate group decide: keep the most-referenced copy (already first in `items`), then either ask the user before calling delete_media on the others, or surface the list and let them pick. Do NOT auto-delete — duplicates often exist on purpose (alt versions, library copies for licensing).",
      };
    },

    // The `critique-generation` bundle was retired with the
    // background-jobs system — it used `check_job` to fetch the
    // source generation, which doesn't exist anymore. The shot-
    // critique skill + rubric are still loadable directly if a
    // future critique surface comes back.

    // ================= Audit =================

    "full-audit": async (_entityId, projectDir) => {
      const [story, projectContext] = await Promise.all([
        safeRun("read_story_bundle", {}, projectDir),
        safeRun("read_project_context", {}, projectDir),
      ]);
      return {
        intent: "full-audit",
        story,
        projectContext,
        scope: "project-wide",
        guidance: "Audit the workflow files, Master Script/prompts, asset bindings, and media references. Fix safely-fixable items; surface ambiguous ones to the user.",
      };
    },

    "audit-durations": async (_entityId, projectDir) => {
      return {
        intent: "audit-durations",
        guidance: "Compare master/scene targets vs prompt duration sums via list_scenes / list_prompts. Report mismatches.",
      };
    },
  };

  // Drift check: BUNDLE_INTENT_IDS is the source of truth consumed by the
  // coverage test. If a new bundle lands without being added to the list
  // (or vice versa), fail loudly at registration instead of silently
  // returning "No prefetch bundle" at runtime.
  const actualKeys = Object.keys(BUNDLES).sort();
  const declaredKeys = [...BUNDLE_INTENT_IDS].sort();
  if (actualKeys.join("|") !== declaredKeys.join("|")) {
    const extraInBundles = actualKeys.filter((k) => !declaredKeys.includes(k));
    const extraInList = declaredKeys.filter((k) => !actualKeys.includes(k));
    throw new Error(
      `prefetch.cjs: BUNDLE_INTENT_IDS drift — bundles without list entry: [${extraInBundles.join(", ")}]; list entries without bundle: [${extraInList.join(", ")}]`,
    );
  }

  registerTool("prefetch_context", {
    tier: "core",
    description:
      "Fetch the full working context for a named intent in one call — replaces 3-6 individual read/list/skill calls. When the dynamic frame shows an 'Intent hint', call this FIRST. Pass `intent` (classifier output) and `entityId` (the primary scene/shot/prompt/asset the intent operates on, if any).",
    args: {
      intent:
        "one of: write-prompt | refine-prompt | continue-prompt | validate-prompt | write-scene | refine-scene | validate-scene | decompose-scene | write-dialogue | refine-dialogue | refine-story-doc | sync-canon-down | sync-canon-up | refine-project-context | describe-asset | link-asset-refs | find-asset-usage | find-asset-duplicates | full-audit | audit-durations",
      entityId: "primary entity id (scene/shot/prompt/asset); optional when the intent is project-wide",
    },
    async run({ intent, entityId }, ctx) {
      const normalized = String(intent || "").trim();
      const bundle = BUNDLES[normalized];
      if (!bundle) {
        return {
          intent: normalized,
          note: `No prefetch bundle for '${normalized}'. Fall back to individual read_* / list_* calls.`,
          availableIntents: Object.keys(BUNDLES).sort(),
        };
      }
      const eid = entityId ? String(entityId) : null;
      return bundle(eid, ctx.projectDir);
    },
  });
}

module.exports = registerPrefetchTools;
module.exports.BUNDLE_INTENT_IDS = BUNDLE_INTENT_IDS;
