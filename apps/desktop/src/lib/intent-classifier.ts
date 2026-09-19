// Deterministic rule-based classifier that turns a chat submission into a
// structured intent. Runs renderer-side with zero LLM cost. Handles the
// majority of user messages; the fallthrough `unclear` intent triggers the
// agent-side Pass 1 classifier (not yet wired).
//
// The mapping from ItemActionBar labels to intents mirrors the action
// catalog in `agent-actions.ts` exactly — so every hammer click produces
// the right intent by construction.

import type { FocusScope, FormatKind, SectionId } from "../types";

// -----------------------------------------------------------------------
// Intent catalog
// -----------------------------------------------------------------------

export type IntentId =
  // Writing — primary craft output
  | "write-prompt"
  | "refine-prompt"
  | "continue-prompt"
  | "write-scene"
  | "refine-scene"
  | "write-dialogue"
  | "refine-dialogue"
  | "decompose-scene"
  // Story & canon — docs that drive the agent
  | "refine-story-doc"
  | "sync-canon-down"
  | "sync-canon-up"
  | "refine-project-context"
  | "apply-format"
  // Assets — entities and their references
  | "describe-asset"
  | "link-asset-refs"
  | "find-asset-usage"
  | "find-asset-duplicates"
  | "organize-media"
  // Media generation — direct-tool path (not a prefetch intent)
  | "generate-image"
  | "generate-video"
  | "generate-music"
  | "generate-voice"
  // Validation & audit — no mutation
  | "validate-prompt"
  | "validate-scene"
  | "audit-durations"
  | "full-audit"
  // Operational
  | "read-file"
  | "search-project"
  | "explain"
  | "navigate"
  // Meta
  | "remember"
  | "forget"
  // Fallthrough
  | "unclear"
  | "open";

// Canonical enumeration of every IntentId the classifier can return.
// Kept in sync with the union type above and consumed by the
// intent-coverage test (electron/__tests__/intent-coverage.test.cjs),
// which asserts every id either has a prefetch bundle or is listed in
// agent-loop's INTENT_HINT_SKIP. Update both when adding a new intent.
export const ALL_INTENT_IDS = [
  "write-prompt",
  "refine-prompt",
  "continue-prompt",
  "write-scene",
  "refine-scene",
  "write-dialogue",
  "refine-dialogue",
  "decompose-scene",
  "refine-story-doc",
  "sync-canon-down",
  "sync-canon-up",
  "refine-project-context",
  "apply-format",
  "describe-asset",
  "link-asset-refs",
  "find-asset-usage",
  "find-asset-duplicates",
  "organize-media",
  "generate-image",
  "generate-video",
  "generate-music",
  "generate-voice",
  "validate-prompt",
  "validate-scene",
  "audit-durations",
  "full-audit",
  "read-file",
  "search-project",
  "explain",
  "navigate",
  "remember",
  "forget",
  "unclear",
  "open",
] as const satisfies readonly IntentId[];

// -----------------------------------------------------------------------
// I/O shapes
// -----------------------------------------------------------------------

export interface ClassifierSelection {
  section: SectionId | null;
  itemId: string | null;
  scriptKind?: "master" | "scene" | null;
  canContinue?: boolean;
}

export interface ClassifierInput {
  message: string;
  selection: ClassifierSelection;
  projectContextSelected: boolean;
  sectionFormatSelected: FormatKind | null;
  pinboardSelected: boolean;
  hammerLabel: string | null;
  focusScope: FocusScope;
  hasAttachment: boolean;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ClassifierOutput {
  intent: IntentId;
  confidence: ConfidenceLevel;
  reason: string;
}

// -----------------------------------------------------------------------
// Verb sets
// -----------------------------------------------------------------------

const REFINE_VERBS = new Set([
  "refine", "polish", "improve", "tighten", "fix", "enhance", "rewrite",
  "edit", "revise", "update", "adjust", "tune", "smooth", "clean",
]);

const WRITE_VERBS = new Set([
  "write", "create", "add", "draft", "compose", "make", "generate", "build",
]);

const AUDIT_VERBS = new Set([
  "check", "audit", "verify", "validate", "review", "inspect", "report",
]);

const DECOMPOSE_VERBS = new Set([
  "decompose", "break", "split", "divide", "shotlist", "storyboard",
]);

const SYNC_DOWN_VERBS = new Set([
  "sync", "propagate", "push", "apply", "cascade", "spread",
]);

const PINBOARD_FORGET_VERBS = new Set(["forget", "remove", "delete", "dismiss"]);
const PINBOARD_REMEMBER_VERBS = new Set(["remember", "save", "pin", "add"]);

// Common leading filler words that should be skipped when looking for
// the first meaningful verb in a message.
const VERB_FILLER = new Set([
  "hey", "hi", "please", "can", "could", "would", "will", "you", "i",
  "let's", "lets", "ok", "okay", "just", "now", "go",
]);

// -----------------------------------------------------------------------
// ItemActionBar label → intent lookup
//
// The action catalog in `agent-actions.ts` generates labels per context;
// the same label ("Check") means different things in different contexts.
// We dispatch by (context, label) to recover the right intent.
// -----------------------------------------------------------------------

function hammerLabelToIntent(input: ClassifierInput): IntentId | null {
  const label = input.hammerLabel;
  if (!label) return null;

  // 1. ANVIL.md (hidden agent protocol)
  if (input.projectContextSelected) {
    if (label === "Apply to script" || label === "Sync down") return "sync-canon-down";
    if (label === "Check") return "full-audit";
  }

  // 2. Section format conventions
  if (input.sectionFormatSelected) {
    if (label === "Apply format") return "apply-format";
    if (label === "Audit") return "full-audit";
  }

  const section = input.selection.section;

  // 3. Story docs
  if (section === "story") {
    if (label === "Apply to script" || label === "Sync down") return "sync-canon-down";
    // Story-doc "Regenerate from script" = regenerate THIS doc from the current
    // master-script state (per agent-actions.ts:108-110). Not the same
    // as master-script's "Update docs" (below) which pushes canon → all
    // story docs at once.
    if (label === "Regenerate from script" || label === "Sync up" || label === "Regenerate") return "refine-story-doc";
    if (label === "Check") return "full-audit";
  }

  // 4. Script — scene vs master
  if (section === "script") {
    if (input.selection.scriptKind === "scene") {
      if (label === "Build prompts" || label === "Build clips" || label === "Fill shots") return "write-prompt";
      if (label === "Gen prompts") return "write-prompt";
      if (label === "Check") return "validate-scene";
    }
    if (input.selection.scriptKind === "master") {
      if (label === "Update docs" || label === "Sync up") return "sync-canon-up";
      if (label === "Build prompts" || label === "Build clips" || label === "Fill shots") return "write-prompt";
      if (label === "Full check") return "full-audit";
    }
  }

  // 5. Prompt / segment
  if (section === "prompts") {
    if (label === "Refine") return "refine-prompt";
    if (label === "Continue") return "continue-prompt";
    if (label === "Check") return "validate-prompt";
  }

  // 6. Asset sections
  if (isAssetSection(section)) {
    if (label === "Link") return "link-asset-refs";
    if (label === "Describe") return "describe-asset";
    if (label === "Scan refs") return "find-asset-usage";
  }

  // Project-wide fallback fired from chat-thread header
  if (label === "Full check") return "full-audit";

  return null;
}

function isAssetSection(section: SectionId | null): boolean {
  return (
    section === "characters" ||
    section === "locations" ||
    section === "props" ||
    section === "keyframes" ||
    section === "audio"
  );
}

// -----------------------------------------------------------------------
// First-verb extractor
// -----------------------------------------------------------------------

function firstVerb(message: string): string {
  const words = message.trim().toLowerCase().split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-z'-]/g, "");
    if (!VERB_FILLER.has(clean) && clean.length >= 2) return clean;
  }
  return words[0]?.replace(/[^a-z'-]/g, "") || "";
}

// -----------------------------------------------------------------------
// Main classifier
// -----------------------------------------------------------------------

export function classifyIntent(input: ClassifierInput): ClassifierOutput {
  // =====================================================================
  // TIER 1 — ItemActionBar labels: 100% confident, no interpretation.
  // =====================================================================
  const hammerIntent = hammerLabelToIntent(input);
  if (hammerIntent) {
    return {
      intent: hammerIntent,
      confidence: "high",
      reason: `hammer: ${input.hammerLabel}`,
    };
  }

  // =====================================================================
  // TIER 2 — Empty message with attachment
  // =====================================================================
  const trimmed = input.message.trim();
  if (!trimmed && input.hasAttachment) {
    return { intent: "unclear", confidence: "low", reason: "attachment only, no message" };
  }

  const msg = trimmed.toLowerCase();
  const verb = firstVerb(trimmed);
  const section = input.selection.section;

  // =====================================================================
  // TIER 3 — Pinboard context
  // =====================================================================
  if (input.pinboardSelected) {
    if (PINBOARD_FORGET_VERBS.has(verb)) {
      return { intent: "forget", confidence: "high", reason: "pinboard + forget verb" };
    }
    if (PINBOARD_REMEMBER_VERBS.has(verb)) {
      return { intent: "remember", confidence: "high", reason: "pinboard + remember verb" };
    }
  }

  // =====================================================================
  // TIER 4 — Explicit instruction patterns (work anywhere)
  // =====================================================================
  if (/\bremember (that |to )?\b/.test(msg) || /\bdon'?t forget\b/.test(msg)) {
    return { intent: "remember", confidence: "high", reason: "explicit remember" };
  }
  // `forget` is destructive, so the global case requires the user name
  // an OBJECT ("forget Alex", "forget the last reference", "forget all
  // pinboard entries"). Conversational tails ("let's forget about it
  // for now", "I forgot to mention") must NOT route to memory-wipe.
  // Audit context-M6 (2026-04-20).
  //   - Accepts: `forget <object>`, `forget the <thing>`, `forget about
  //     <thing>`, `forget all <things>`, `forget this/that <thing>`.
  //   - Rejects: `forget about it`, `forget it`, `I forgot` (past tense),
  //     `did you forget X` (question addressed at system), conversational
  //     fillers.
  if (
    !input.pinboardSelected &&
    /\bforget\s+(?:about\s+)?(?:the\s+|this\s+|that\s+|all\s+|every\s+)?[a-z][a-z-]{2,}/i.test(msg) &&
    // Block the two common no-op phrases even when they structurally
    // match the pattern above.
    !/\bforget\s+(?:about\s+)?it\b/i.test(msg) &&
    !/\bi\s+forgot\b/i.test(msg)
  ) {
    return { intent: "forget", confidence: "medium", reason: "forget verb + object" };
  }

  // Media generation — direct-tool path. Catch "make image" / "generate
  // video" / "compose music" BEFORE the section-based dispatch routes
  // them to describe-asset. Noun patterns use prefix-tolerant matches
  // (imag\w* catches image / images / imange typo / imagery; pict\w*
  // catches picture / pict / pictures) because real users misspell.
  if (
    /\b(make|generate|create|render|produce|draw|paint)\s+(an?\s+|another\s+|one\s+more\s+|new\s+|a\s+new\s+|more\s+)?(imag\w*|pict\w*|photo\w*|photograph\w*|still|frame|render\w*|visual\w*|thumbnail\w*|\bimg\b|art|artwork)\b/.test(msg)
  ) {
    return { intent: "generate-image", confidence: "high", reason: "image-generation verb" };
  }
  if (
    /\b(make|generate|create|render|produce)\s+(an?\s+|another\s+|new\s+)?(video\w*|clip\w*|take\w*|animat\w*|shot\s+render|moving\s+(imag\w*|frame))\b/.test(msg)
  ) {
    return { intent: "generate-video", confidence: "high", reason: "video-generation verb" };
  }
  if (
    /\b(make|generate|create|compose|produce|write)\s+(an?\s+|another\s+|a\s+piece\s+of\s+|new\s+)?(music\w*|song\w*|track\w*|score\w*|soundtrack\w*|tune\w*|sfx|sound\s+effect|audio\s+bed)\b/.test(msg)
  ) {
    return { intent: "generate-music", confidence: "high", reason: "music-generation verb" };
  }
  if (
    /\b(make|generate|produce|synthesize|record)\s+(an?\s+|new\s+)?(voiceover\w*|voice\s+over|vo|narrat\w*|voice\s+(line|track)|dialogue\s+audio)\b/.test(msg)
  ) {
    return { intent: "generate-voice", confidence: "high", reason: "voice-generation verb" };
  }

  // =====================================================================
  // TIER 5 — Selection-driven classification
  // =====================================================================

  // 5a. Hidden agent protocol (ANVIL.md)
  if (input.projectContextSelected) {
    if (REFINE_VERBS.has(verb)) {
      return { intent: "refine-project-context", confidence: "high", reason: "context + refine verb" };
    }
    if (SYNC_DOWN_VERBS.has(verb)) {
      return { intent: "sync-canon-down", confidence: "high", reason: "context + sync verb" };
    }
  }

  // 5b. Section format conventions
  if (input.sectionFormatSelected) {
    if (SYNC_DOWN_VERBS.has(verb) || REFINE_VERBS.has(verb)) {
      return { intent: "apply-format", confidence: "high", reason: "format conventions + sync/refine verb" };
    }
    if (AUDIT_VERBS.has(verb)) {
      return { intent: "full-audit", confidence: "high", reason: "format conventions + audit verb" };
    }
  }

  // 5c. Script section
  if (section === "script") {
    const isScene = input.selection.scriptKind === "scene";
    const hasSelection = input.selection.itemId !== null;

    if (AUDIT_VERBS.has(verb)) {
      return {
        intent: isScene ? "validate-scene" : "full-audit",
        confidence: "high",
        reason: "script + audit verb",
      };
    }
    if (DECOMPOSE_VERBS.has(verb) || /\bshot list\b|\bstoryboard\b/.test(msg)) {
      return { intent: "decompose-scene", confidence: "high", reason: "script + decompose verb" };
    }
    if (/\bfill\b|\bshots? for\b|\bmissing shots?\b/.test(msg)) {
      return { intent: "write-prompt", confidence: "high", reason: "script + fill shots pattern" };
    }
    if (REFINE_VERBS.has(verb)) {
      return {
        intent: isScene ? "refine-scene" : "write-scene",
        confidence: "high",
        reason: "script + refine verb",
      };
    }
    if (WRITE_VERBS.has(verb) && !hasSelection) {
      return { intent: "write-scene", confidence: "high", reason: "script + write verb, no selection" };
    }
    if (WRITE_VERBS.has(verb)) {
      return { intent: "write-scene", confidence: "high", reason: "script + write verb" };
    }
  }

  // 5d. Dialogue section — its own subsection under script. Dialogue
  // edits are routed to refine-dialogue / write-dialogue so the prefetch
  // bundle pulls scene + dialogue context together.
  if (section === "dialogue") {
    if (REFINE_VERBS.has(verb) || /\bpunchier|terser|shorter|tighter|crisper\b/.test(msg)) {
      return { intent: "refine-dialogue", confidence: "high", reason: "dialogue + refine verb" };
    }
    if (WRITE_VERBS.has(verb)) {
      return { intent: "write-dialogue", confidence: "high", reason: "dialogue + write verb" };
    }
  }

  // Cross-section dialogue cue — user is in script/shots/prompts but
  // explicitly mentions dialogue/lines/VO. Route to refine-dialogue so
  // the bundle carries dialogue alongside the structural context.
  if (
    (section === "script" || section === "shots" || section === "prompts") &&
    /\bdialogue|\blines\b|\bVO\b|\bvoice ?over\b/i.test(msg)
  ) {
    if (REFINE_VERBS.has(verb) || /\bpunchier|terser|shorter|tighter|crisper\b/.test(msg)) {
      return { intent: "refine-dialogue", confidence: "high", reason: "section + dialogue mention + refine verb" };
    }
  }

  // 5e. Prompts section
  if (section === "prompts") {
    if (AUDIT_VERBS.has(verb)) {
      return { intent: "validate-prompt", confidence: "high", reason: "prompts + audit verb" };
    }
    if (/\bcontinu|next segment|segment b|segment c\b/.test(msg) && input.selection.canContinue !== false) {
      return { intent: "continue-prompt", confidence: "high", reason: "prompts + continue pattern" };
    }
    if (REFINE_VERBS.has(verb)) {
      return { intent: "refine-prompt", confidence: "high", reason: "prompts + refine verb" };
    }
    if (WRITE_VERBS.has(verb)) {
      return { intent: "write-prompt", confidence: "high", reason: "prompts + write verb" };
    }
  }

  // 5f. Asset sections
  if (isAssetSection(section)) {
    if (/\bwhere.* (used|referenced|appears?)\b|\buses of\b|\breferences of\b/.test(msg)) {
      return { intent: "find-asset-usage", confidence: "high", reason: "asset + usage question" };
    }
    if (/\blink|update refs?|propagate\b/.test(msg)) {
      return { intent: "link-asset-refs", confidence: "high", reason: "asset + link pattern" };
    }
    // Rename / retitle now goes through update_asset_entry — bundle is
    // describe-asset which already loads the entry + project context.
    if (/\brename\b|\bretitle\b|\brewrite\b|\bcall (it|this|them)\b|\bchange the name\b/.test(msg)) {
      return { intent: "describe-asset", confidence: "high", reason: "asset + rename verb" };
    }
    // Audio tagging — set_audio_kind lives in the edit tier; describe-asset
    // bundle gives the agent enough context to pick + apply the tag.
    if (
      section === "audio" &&
      (/\btag\b|\bmark (as|it as|this as)\b|\bset .* (kind|type)\b|\bclassify\b|\bcategoriz\b/.test(msg) ||
        /\b(music|sfx|voiceover|ambient)\b/.test(msg))
    ) {
      return { intent: "describe-asset", confidence: "high", reason: "audio + tag/kind verb" };
    }
    // Cross-section move — move_asset_entry tool is in the edit tier;
    // describe-asset bundle has the source asset, agent fills the rest.
    if (/\bmove .* (to|into) (characters|locations|props|keyframes|audio|library)\b|\bswitch .* section\b/i.test(msg)) {
      return { intent: "describe-asset", confidence: "high", reason: "asset + cross-section move" };
    }
    // Duplicate detection — new find_duplicate_media tool. Routes to its
    // own intent so the bundle includes media-index data, not asset body.
    if (/\bduplicat(e|es)\b|\bidentical\b|\bsame (file|content|image|asset)\b/.test(msg)) {
      return { intent: "find-asset-duplicates", confidence: "high", reason: "asset + duplicate verb" };
    }
    // Visual comparison — compare_images tool. describe-asset bundle gives
    // the candidate paths; agent calls compare_images directly.
    if (/\bcompare (these|those|two|both)\b|\bwhich (one|of these)\b|\bbetter\b.*\bimage\b/.test(msg)) {
      return { intent: "describe-asset", confidence: "high", reason: "asset + compare verb" };
    }
    if (REFINE_VERBS.has(verb) || WRITE_VERBS.has(verb) || /\bdescribe|detail\b/.test(msg)) {
      return { intent: "describe-asset", confidence: "high", reason: "asset + describe/refine verb" };
    }
  }

  // 5g. Media section
  if (section === "media") {
    if (/\btag|categoriz|organiz|move\b/.test(msg)) {
      return { intent: "organize-media", confidence: "medium", reason: "media + organize verb" };
    }
  }

  // 5h. Story docs
  if (section === "story") {
    if (SYNC_DOWN_VERBS.has(verb)) {
      return { intent: "sync-canon-down", confidence: "high", reason: "story + sync down verb" };
    }
    if (/\bsync up\b|\bupdate (story|docs|bible)\b/.test(msg)) {
      return { intent: "sync-canon-up", confidence: "high", reason: "story + sync up pattern" };
    }
    if (REFINE_VERBS.has(verb) || WRITE_VERBS.has(verb)) {
      return { intent: "refine-story-doc", confidence: "high", reason: "story + refine/write verb" };
    }
  }

  // =====================================================================
  // TIER 6 — Global verb patterns (no selection context)
  // =====================================================================
  if (/\bfull (audit|check|review)\b|\baudit (everything|all|the project)\b/.test(msg)) {
    return { intent: "full-audit", confidence: "high", reason: "global full audit" };
  }
  if (/\bduration|runtime|timing\b/.test(msg) && AUDIT_VERBS.has(verb)) {
    return { intent: "audit-durations", confidence: "high", reason: "duration audit" };
  }
  if (/^(what|where|how|who|when) (is|are|does|do)\b/.test(msg) && msg.endsWith("?")) {
    return { intent: "explain", confidence: "medium", reason: "question pattern" };
  }
  if (/\bfind|search for|look for\b/.test(msg)) {
    return { intent: "search-project", confidence: "medium", reason: "search verb" };
  }
  if (/\bshow me|open|go to|navigate|take me to\b/.test(msg)) {
    return { intent: "navigate", confidence: "medium", reason: "navigate verb" };
  }
  if (/\bread|look at|check out\b/.test(msg) && trimmed.split(/\s+/).length < 10) {
    return { intent: "read-file", confidence: "medium", reason: "short read request" };
  }

  // =====================================================================
  // FALLTHROUGH — agent-side Pass 1 will classify
  // =====================================================================
  return { intent: "unclear", confidence: "low", reason: "no rule matched" };
}
