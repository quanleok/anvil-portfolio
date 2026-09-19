import type { PromptEntry, ScriptEntry } from "../types";

export function parseDurationInput(rawValue: string, maxSeconds?: number) {
  const digits = String(rawValue || "").replace(/[^\d]/g, "");
  if (!digits) return { raw: "", value: null };
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || parsed <= 0) return { raw: "", value: null };
  const normalized = typeof maxSeconds === "number" ? Math.min(parsed, maxSeconds) : parsed;
  return { raw: String(Math.round(normalized)), value: Math.round(normalized) };
}

export function formatDurationLabel(durationSec?: number | null) {
  const value = Number(durationSec);
  if (!Number.isFinite(value) || value <= 0) return "";
  const seconds = Math.round(value);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function ordinalFromRelativePath(relativePath: string | null | undefined, prefix: string) {
  const match = String(relativePath || "").match(new RegExp(`${prefix}-(\\d+)`));
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function sceneIdentifierLabel(entry: Pick<ScriptEntry, "path" | "title">) {
  const fromPath = ordinalFromRelativePath(entry.path, "scene");
  if (fromPath) return String(fromPath);
  const fromTitle = String(entry.title || "").match(/^\s*(\d+)\s*[—\-:·]/u);
  if (!fromTitle) return "";
  const parsed = Number(fromTitle[1]);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : "";
}

export function buildPromptSegments(durationSec?: number | null, maxSegmentSec = 15) {
  const total = Number(durationSec);
  if (!Number.isFinite(total) || total <= 0) {
    return [
      {
        durationSec: null,
        segmentCount: null,
        segmentEndSec: null,
        segmentIndex: null,
        segmentStartSec: null,
      },
    ];
  }
  const rounded = Math.round(total);
  const segmentCount = Math.max(1, Math.ceil(rounded / maxSegmentSec));
  return Array.from({ length: segmentCount }, (_, index) => {
    const segmentStartSec = index * maxSegmentSec;
    const duration = Math.min(maxSegmentSec, rounded - segmentStartSec);
    return {
      durationSec: duration,
      segmentCount,
      segmentEndSec: segmentStartSec + duration,
      segmentIndex: index + 1,
      segmentStartSec,
    };
  });
}

export function formatPromptSegmentLabel(
  prompt: Pick<PromptEntry, "segmentCount" | "segmentEndSec" | "segmentIndex" | "segmentStartSec">,
) {
  const segmentCount = Number(prompt.segmentCount);
  const segmentIndex = Number(prompt.segmentIndex);
  const segmentStartSec = Number(prompt.segmentStartSec);
  const segmentEndSec = Number(prompt.segmentEndSec);
  if (!Number.isFinite(segmentCount) || segmentCount <= 1 || !Number.isFinite(segmentIndex) || segmentIndex <= 0) {
    return "";
  }
  const range =
    Number.isFinite(segmentStartSec) && Number.isFinite(segmentEndSec) && segmentEndSec > segmentStartSec
      ? ` · ${segmentStartSec}s-${segmentEndSec}s`
      : "";
  return `Part ${segmentIndex}/${segmentCount}${range}`;
}

export function formatPromptRuntimeWindow(
  prompt: Pick<PromptEntry, "durationSec" | "segmentEndSec" | "segmentStartSec">,
) {
  const segmentStartSec = Number(prompt.segmentStartSec);
  const segmentEndSec = Number(prompt.segmentEndSec);
  if (Number.isFinite(segmentStartSec) && Number.isFinite(segmentEndSec) && segmentEndSec > segmentStartSec) {
    return `${segmentStartSec}-${segmentEndSec}s`;
  }
  return formatDurationLabel(prompt.durationSec);
}

/** Distribute `total` seconds across `n` slots so they sum exactly.
 *  distributeEvenly(100, 3) → [34, 33, 33]. No rounding drift. */
export function distributeEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Scale `values` so they sum to `newTotal`, preserving ratios.
 *  Pinned indices are excluded from scaling; their values stay as-is.
 *  Returns null if pinned values alone exceed newTotal. */
export function scaleProportionally(
  values: number[],
  newTotal: number,
  pinnedIndices: Set<number> = new Set(),
): number[] | null {
  const pinnedSum = values.reduce((s, v, i) => s + (pinnedIndices.has(i) ? v : 0), 0);
  const unpinnedOldSum = values.reduce((s, v, i) => s + (pinnedIndices.has(i) ? 0 : v), 0);
  const remainder = newTotal - pinnedSum;
  if (remainder < 0) return null;
  if (unpinnedOldSum === 0) {
    // All pinned or all zero — distribute remainder evenly across unpinned
    const unpinnedCount = values.filter((_, i) => !pinnedIndices.has(i)).length;
    if (unpinnedCount === 0) return [...values];
    const dist = distributeEvenly(Math.round(remainder), unpinnedCount);
    let ui = 0;
    return values.map((v, i) => (pinnedIndices.has(i) ? v : dist[ui++]));
  }
  const factor = remainder / unpinnedOldSum;
  const scaled = values.map((v, i) => (pinnedIndices.has(i) ? v : Math.round(v * factor)));
  // Fix rounding drift on the last unpinned entry
  const scaledSum = scaled.reduce((s, v) => s + v, 0);
  const drift = newTotal - scaledSum;
  if (drift !== 0) {
    for (let i = scaled.length - 1; i >= 0; i--) {
      if (!pinnedIndices.has(i)) {
        scaled[i] += drift;
        break;
      }
    }
  }
  return scaled;
}

export function moveItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
