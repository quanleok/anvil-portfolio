// Continuity helpers shrunk on 2026-05-04 — the old structured
// `continuity` record (kind/prevId/carryOver/intent) plus the legacy
// `continuousFrom` flat field have been replaced by a single
// `prevPromptId: string | null` on PromptEntry. These helpers read +
// write that field while still tolerating projects that haven't been
// re-saved since the migration.

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Read the predecessor id from a prompt's frontmatter meta object or
// any object that may carry the legacy fields. Honors `prevPromptId`
// first, then the legacy flat `continuousFrom`, then a structured
// `continuity?.prevId` from older projects.
function readPromptPrevId(input) {
  if (!input || typeof input !== "object") return null;
  const direct = trim(input.prevPromptId);
  if (direct) return direct;
  const commonAlias =
    trim(input.previousPromptId) ||
    trim(input.previousPrompt) ||
    trim(input.prevPrompt) ||
    trim(input.continuesFrom) ||
    trim(input.afterPromptId);
  if (commonAlias) return commonAlias;
  const legacyFlat = trim(input.continuousFrom);
  if (legacyFlat) return legacyFlat;
  const struct =
    input.continuity && typeof input.continuity === "object"
      ? trim(input.continuity.prevId) || trim(input.continuity.continuityPrevId)
      : "";
  if (struct) return struct;
  const metaStruct = trim(input.continuityPrevId);
  return metaStruct || null;
}

// Render prevPromptId into a frontmatter-friendly meta fragment. We
// always emit a `prevPromptId` key (empty string when null) so older
// values left over from migration get overwritten, and a deprecated
// `continuousFrom: ""` so any stale legacy field on disk is cleared.
function prevIdToMeta(prevId) {
  const id = trim(prevId);
  return {
    prevPromptId: id,
    continuousFrom: "",
  };
}

function sortPromptsForContinuity(prompts) {
  return [...(Array.isArray(prompts) ? prompts : [])].sort((a, b) => {
    const segmentIndexA = Number(a?.segmentIndex);
    const segmentIndexB = Number(b?.segmentIndex);
    if (
      Number.isFinite(segmentIndexA) &&
      Number.isFinite(segmentIndexB) &&
      segmentIndexA !== segmentIndexB
    ) {
      return segmentIndexA - segmentIndexB;
    }
    const startA = Number(a?.segmentStartSec);
    const startB = Number(b?.segmentStartSec);
    if (
      Number.isFinite(startA) &&
      Number.isFinite(startB) &&
      startA !== startB
    ) {
      return startA - startB;
    }
    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
}

module.exports = {
  readPromptPrevId,
  prevIdToMeta,
  sortPromptsForContinuity,
};
