// Shared asset-name filter — used by both the Sync rule-based linker
// (src/lib/asset-sync.ts) and the Linked Assets body scanner
// (src/components/LinkedAssetRail.tsx).
//
// Names matching this filter are skipped from body-text link matching:
//   - Too short (≤3 chars) — noisy against casual prose
//   - Common English / film vocabulary — risk of false positives
//     (e.g., "black" the adjective matching character "Black")
//
// The filter is one-way: it never prevents an EXPLICIT frontmatter link.
// It only affects implicit name-in-body matching. Users can still create
// a character named "Black" and link it manually via the asset picker or
// agent tool calls.

export const COMMON_ASSET_NAME_BLOCKLIST = new Set<string>([
  // English filler / pronouns / prepositions
  "the", "and", "or", "of", "in", "on", "at", "to", "for", "from", "by", "with",
  "this", "that", "these", "those", "here", "there",
  "over", "under", "into", "across", "through", "between", "behind", "beyond",
  // Prose numbers + quantities
  "one", "two", "three", "four", "five", "both",
  // Film / camera vocab
  "wide", "close", "medium", "long", "extreme", "establishing",
  "static", "tracking", "handheld", "dolly", "crane", "steadicam",
  "pan", "tilt", "push", "pull", "zoom", "rack",
  "shot", "scene", "prompt", "title", "frame", "segment", "part",
  "reveal", "direction", "mood", "atmosphere", "purpose", "tone",
  // Colors (adjectival in prose)
  "black", "white", "red", "blue", "green", "gold", "silver", "gray", "grey",
  // Directions
  "left", "right", "front", "back", "top", "bottom", "above", "below",
  // Generic nouns that often appear as placeholders
  "hero", "heroes", "warrior", "warriors", "bird", "birds",
  "bone", "chamber", "corridor", "stairwell", "perch",
  "ambush", "crossing", "approach", "threshold",
  "hound", "hounds", "crow", "skeleton", "skeletons", "skeletal",
  "note", "notes", "mention", "mentions", "story", "visual", "favor",
]);

/**
 * Returns `true` when `name` is distinctive enough to be used for body-text
 * matching. Short names (≤3 chars) and common prose words are filtered out.
 */
export function isSafeAssetName(name: string | null | undefined): boolean {
  const lower = String(name || "").toLowerCase().trim();
  if (lower.length < 4) return false;
  if (COMMON_ASSET_NAME_BLOCKLIST.has(lower)) return false;
  return true;
}
