// Builds the actual prompt string sent to a video-gen model from a
// prompt's prose body + its resolved typed fields. Used by:
//   - The renderer's live preview (form's "what gets sent" panel)
//   - The render-manifest snapshot at generation time
//   - The agent's eventual `simulate_generation` tool
//
// Template lives on the model spec (`modelSpec.promptAssembly.template`).
// Mustache-lite — only `{{ token }}` substitutions, no logic. Tokens are
// resolved field values; `{{ promptBody }}` is the prose body.
//
// PURE FUNCTION. No I/O, no async. Safe to call on every render.

"use strict";

// Default fallback template used when the model spec doesn't define one.
// Append a brief technical sidecar after the prose. Tokens that resolve
// to null are omitted so we don't ship "[Auto, Auto, Auto motion]".
const FALLBACK_TEMPLATE = "{{ promptBody }}\n\n{{ technicalSidecar }}";

// Format a value for inline insertion. null → omit. Booleans → "on/off".
function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return String(value);
  return String(value);
}

// Build the technical sidecar shown when a model template uses
// {{ technicalSidecar }} OR when no template is provided. Skips fields
// that resolved to null so we don't ship empty placeholders.
function buildTechnicalSidecar(resolved) {
  const parts = [];
  if (resolved.lens && resolved.lens.value !== null) {
    parts.push(formatValue(resolved.lens.value));
  }
  if (resolved.cameraMovement && resolved.cameraMovement.value !== null) {
    parts.push(formatValue(resolved.cameraMovement.value));
  }
  if (resolved.motionIntensity && resolved.motionIntensity.value !== null) {
    parts.push(`${formatValue(resolved.motionIntensity.value)} motion`);
  }
  if (resolved.mood && resolved.mood.value !== null) {
    parts.push(formatValue(resolved.mood.value));
  }
  if (parts.length === 0) return "";
  return `[${parts.join(", ")}]`;
}

function applyTemplate(template, resolved, promptBody) {
  // Tokens we substitute. Each maps to a string (potentially empty).
  const tokens = {
    promptBody: String(promptBody || "").trim(),
    technicalSidecar: buildTechnicalSidecar(resolved),
    model: formatValue(resolved.model && resolved.model.value),
    durationSec: formatValue(resolved.durationSec && resolved.durationSec.value),
    aspectRatio: formatValue(resolved.aspectRatio && resolved.aspectRatio.value),
    resolution: formatValue(resolved.resolution && resolved.resolution.value),
    fps: formatValue(resolved.fps && resolved.fps.value),
    lens: formatValue(resolved.lens && resolved.lens.value),
    cameraMovement: formatValue(resolved.cameraMovement && resolved.cameraMovement.value),
    motionIntensity: formatValue(resolved.motionIntensity && resolved.motionIntensity.value),
    mood: formatValue(resolved.mood && resolved.mood.value),
    soundFlag: formatValue(resolved.soundFlag && resolved.soundFlag.value),
  };

  // Replace {{ token }} (with optional whitespace inside braces).
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(tokens, name)) {
      return tokens[name];
    }
    // Unknown token — leave the literal match in so the user can debug
    // their template. Better than silently dropping content.
    return match;
  });
}

function assemblePromptText(resolved, modelSpec, promptBody) {
  const template = (modelSpec && modelSpec.promptAssembly && modelSpec.promptAssembly.template)
    || FALLBACK_TEMPLATE;
  const rendered = applyTemplate(template, resolved, promptBody);
  // Collapse a trailing empty sidecar block — `\n\n[]` happens when
  // every technical field is null.
  return rendered
    .replace(/\n+\[\]\s*$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  FALLBACK_TEMPLATE,
  buildTechnicalSidecar,
  applyTemplate,
  assemblePromptText,
};
