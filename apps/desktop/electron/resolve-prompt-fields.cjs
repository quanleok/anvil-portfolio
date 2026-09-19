// Pure cascade resolver for typed prompt fields. Used by:
//   - The renderer's prompt-editor form (chip rendering, live preview)
//   - The main process when the agent calls `resolve_prompt_fields(...)`
//   - The render-manifest snapshot at generation time
//
// Cascade order, from most specific to least:
//   1. Locked on this prompt              → "locked-prompt"
//   2. Locked on the parent shot          → "locked-shot"   (only inheritable fields)
//   3. Locked on the parent scene         → "locked-scene"  (only inheritable fields)
//   4. Project defaults                   → "project-default"
//   5. Model library default (per model)  → "library-default"
//   6. Agent decides at generation time   → "agent-decides" (value: null)
//
// PURE FUNCTION. No I/O. No async. Caller pre-loads everything. Cheap
// enough to call on every chip render.
//
// Mirrored manually to `src/lib/resolve-prompt-fields.ts` for the
// renderer (TypeScript types). Keep both files in sync.

"use strict";

// Which fields inherit through which parent levels. Anything missing
// from a set is shot/scene-private and won't propagate down.
const INHERIT_FROM_SHOT = new Set([
  "model",
  "durationSec",
  "aspectRatio",
  "resolution",
  "fps",
  "lens",          // resolves shot.lensHint as a fallback (handled below)
  "cameraMovement",
  "motionIntensity",
  "mood",
  "soundFlag",
]);

const INHERIT_FROM_SCENE = new Set([
  "model",
  "aspectRatio",
  "resolution",
  "fps",
  "mood",
  "soundFlag",
]);

// Field name on the parent that satisfies the prompt-side request.
// Most fields share names; lens is special (shot-level lensHint).
function shotKeyFor(promptKey) {
  if (promptKey === "lens") return ["lens", "lensHint"];
  return [promptKey];
}

function sceneKeyFor(promptKey) {
  return [promptKey];
}

const PROMPT_FIELDS = [
  "model",
  "durationSec",
  "aspectRatio",
  "resolution",
  "fps",
  "lens",
  "cameraMovement",
  "motionIntensity",
  "mood",
  "soundFlag",
  "seed",
  "modelParams",
];

function isMeaningful(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  // Empty modelParams object counts as "not set" — there's no useful
  // signal in {}; the cascade should fall through.
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    return false;
  }
  return true;
}

function tooltipFor(source) {
  switch (source.kind) {
    case "locked-prompt":
      return "Locked on this prompt.";
    case "locked-shot":
      return source.ownerTitle
        ? `Inherited from shot “${source.ownerTitle}” (locked there).`
        : "Inherited from the parent shot (locked there).";
    case "locked-scene":
      return source.ownerTitle
        ? `Inherited from scene “${source.ownerTitle}” (locked there).`
        : "Inherited from the parent scene (locked there).";
    case "project-default":
      return "Project default. Edit .forge/project-defaults.md to change.";
    case "library-default":
      return source.modelId
        ? `Default for ${source.modelId} from the prompt-protocol library.`
        : "Default from the prompt-protocol library.";
    case "agent-decides":
      return source.rationale
        ? `Agent will pick at generation time: ${source.rationale}`
        : "Agent will pick at generation time based on action + scene context.";
    default:
      return "";
  }
}

function resolveOne(promptField, ctx) {
  const { prompt, shot, scene, projectDefaults, modelSpec } = ctx;

  // 1. Locked on this prompt.
  const promptVal = prompt ? prompt[promptField] : undefined;
  if (isMeaningful(promptVal)) {
    const source = { kind: "locked-prompt" };
    return { value: promptVal, source, tooltip: tooltipFor(source) };
  }

  // 2. Locked on parent shot (if field is shot-inheritable).
  if (INHERIT_FROM_SHOT.has(promptField) && shot) {
    for (const key of shotKeyFor(promptField)) {
      const v = shot[key];
      if (isMeaningful(v)) {
        const source = {
          kind: "locked-shot",
          ownerId: shot.id,
          ownerTitle: shot.title,
        };
        return { value: v, source, tooltip: tooltipFor(source) };
      }
    }
  }

  // 3. Locked on parent scene (if field is scene-inheritable).
  if (INHERIT_FROM_SCENE.has(promptField) && scene) {
    for (const key of sceneKeyFor(promptField)) {
      const v = scene[key];
      if (isMeaningful(v)) {
        const source = {
          kind: "locked-scene",
          ownerId: scene.id,
          ownerTitle: scene.title,
        };
        return { value: v, source, tooltip: tooltipFor(source) };
      }
    }
  }

  // 4. Project defaults (the prompt section of the file).
  const projectDefault = projectDefaults && projectDefaults.prompt
    ? projectDefaults.prompt[promptField]
    : undefined;
  if (isMeaningful(projectDefault)) {
    const source = { kind: "project-default", ownerId: "project" };
    return { value: projectDefault, source, tooltip: tooltipFor(source) };
  }

  // 5. Model library default.
  if (modelSpec && modelSpec.fields && modelSpec.fields[promptField]) {
    const fieldSpec = modelSpec.fields[promptField];
    if (isMeaningful(fieldSpec.default)) {
      const source = {
        kind: "library-default",
        modelId: modelSpec.id,
      };
      return { value: fieldSpec.default, source, tooltip: tooltipFor(source) };
    }
  }

  // 6. Agent decides at generation time.
  const source = { kind: "agent-decides" };
  return { value: null, source, tooltip: tooltipFor(source) };
}

function resolvePromptFields(ctx) {
  const out = {};
  for (const field of PROMPT_FIELDS) {
    out[field] = resolveOne(field, ctx);
  }
  return out;
}

function resolveSingleField(ctx, fieldName) {
  if (!PROMPT_FIELDS.includes(fieldName)) {
    throw new Error(`resolveSingleField: unknown field '${fieldName}'.`);
  }
  return resolveOne(fieldName, ctx);
}

module.exports = {
  PROMPT_FIELDS,
  INHERIT_FROM_SHOT,
  INHERIT_FROM_SCENE,
  resolvePromptFields,
  resolveSingleField,
  // Exported for tests + the TS shim.
  isMeaningful,
  tooltipFor,
};
