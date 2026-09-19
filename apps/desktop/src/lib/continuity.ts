import type { PromptEntry } from "../types";

// Helpers shrunk on 2026-05-04 — the older ContinuityKind list and
// buildMotionContinuity factory were dropped along with the structured
// `continuity?` field. promptContinuityPrevId stays as a tiny accessor
// so callers don't have to know the field name; it also tolerates the
// legacy `continuousFrom` field on prompts in projects that haven't
// been re-saved since the migration.
export function promptContinuityPrevId(
  prompt: Pick<PromptEntry, "prevPromptId"> & {
    continuity?: { prevId?: string | null } | null;
    continuousFrom?: string | null;
  },
): string | null {
  const direct = typeof prompt.prevPromptId === "string" ? prompt.prevPromptId.trim() : "";
  if (direct) return direct;
  const legacyStruct = typeof prompt.continuity?.prevId === "string"
    ? prompt.continuity.prevId.trim()
    : "";
  if (legacyStruct) return legacyStruct;
  const legacyFlat = typeof prompt.continuousFrom === "string" ? prompt.continuousFrom.trim() : "";
  return legacyFlat || null;
}
