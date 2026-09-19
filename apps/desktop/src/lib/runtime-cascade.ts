import type { ForgeProjectData, ScriptEntry } from "../types";
import { distributeEvenly } from "./duration.ts";

// Pure-function runtime cascade logic, extracted from App.tsx's
// patchEntryMeta so the policy can be unit-tested and doesn't live in
// the renderer monolith.
//
// Cut #1 (script tier flatten) reduced this to a single helper:
// the only remaining cascade is master → scenes. Beat / shot
// distributions were retired with the tiers.

/**
 * Distribute the master script's runtime target across EMPTY scenes.
 * Scenes with explicit durations stay pinned so manual work isn't
 * clobbered. Returns null when there are no empty scenes, or when the
 * already-set scenes meet/exceed the target.
 */
export function cascadeMasterToScenes(
  project: ForgeProjectData,
  masterId: string,
  patch: Record<string, unknown>,
): { script: ScriptEntry[] } | null {
  const newDur = Number(patch.durationSec);
  if (!Number.isFinite(newDur) || newDur <= 0) return null;

  const scenes = project.script.filter((e) => e.kind === "scene");
  if (scenes.length === 0) return null;

  const totalSec = Math.round(newDur);
  const emptyIds: string[] = [];
  let setSum = 0;
  for (const s of scenes) {
    const v = Number(s.durationSec);
    if (Number.isFinite(v) && v > 0) setSum += Math.round(v);
    else emptyIds.push(s.id);
  }

  const remaining = totalSec - setSum;
  if (emptyIds.length === 0 || remaining <= 0) return null;

  const perEmpty = distributeEvenly(remaining, emptyIds.length);
  if (!perEmpty) return null;

  const script = project.script.map((e) => {
    if (e.id === masterId) return { ...e, ...patch };
    const idx = emptyIds.indexOf(e.id);
    return idx >= 0 ? { ...e, durationSec: perEmpty[idx] } : e;
  });
  return { script };
}
