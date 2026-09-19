// Entity-mention detector. Pure function — takes a project's entity catalog
// and a tier hint, returns a regex + classifier that can decorate any text
// surface (master script editor, scene/shot/prompt editors, agent message
// rendering, sidebar previews). Lives in lib/ so multiple consumers share
// the same detection logic instead of redefining it per surface.
//
// Design constraints:
// - Generic across project types — no hardcoded story-specific rules.
// - Robust at scale — bounded regex size, deduplicated alternations,
//   longest-match-first ordering, case-insensitive but boundary-aware.
// - Tier-aware — narrative surfaces (master script, story docs) get ONLY
//   entity colors; production surfaces (shots, prompts) ALSO get the
//   prompt-grammar tints (camera, style, constraint).
// - Pure — accepts the entity catalog as input, no React / DOM / IO.

export type EntityCategory =
  | "character"
  | "location"
  | "prop"
  | "keyframe"
  | "audio"
  | "library";

export type DetectorTier =
  | "narrative" // master script, scenes, story docs — entities only
  | "production"; // shots, prompts — entities + prompt-grammar patterns

export interface EntityCatalog {
  characters?: string[];
  locations?: string[];
  props?: string[];
  keyframes?: string[];
  audio?: string[];
  library?: string[];
}

export interface DetectorMatch {
  from: number;
  to: number;
  category:
    | EntityCategory
    | "camera"
    | "style"
    | "constraint"
    | "scene-heading"
    | "transition"
    | "speaker"
    | "parenthetical";
  text: string;
  // The entity name that matched (after alias normalization). Null for
  // pattern-based (camera/style/constraint) matches.
  entityName: string | null;
}

// ---------------------------------------------------------------------------
// Stopwords / noise filters
// ---------------------------------------------------------------------------

// Words we refuse to promote to a standalone alias. These are common English
// words that would catastrophically over-match if accepted as a short form
// of an entity name (e.g. "The Hall" → ["The", "Hall"] — "The" can't be a
// usable alias, "Hall" is borderline).
const ALIAS_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "but", "by", "for", "from", "if",
  "in", "is", "it", "of", "on", "or", "so", "the", "to", "up", "with",
]);

// Words we refuse to highlight at all even if they exactly equal an entity
// name. Mostly defensive — protects against pathological projects where
// someone names a character "The" or "It".
const ENTITY_BLACKLIST = new Set(["the", "a", "an", "it", "he", "she", "they"]);

// Suffix words like "Character", "Location" that users sometimes append to
// asset names. Strip them when generating aliases so "Anvil Kid Character"
// also matches the bare "Anvil Kid".
const ENTITY_SUFFIX_RE =
  /\s+(?:character|location|prop|reference|keyframe|asset|audio|sfx|cue|v\d+)(?:\s+.*)?$/i;

// ---------------------------------------------------------------------------
// Prompt-grammar patterns (production tier only)
// ---------------------------------------------------------------------------

// Hoisted at module level (`js-hoist-regexp` rule) — recreating these on
// every detector call wasted measurable time per keystroke.
const CAMERA_RE =
  /\b(?:\d+\s*mm|(?:wide|medium|close(?:-up)?|long|extreme|establishing|OTS|POV|first[-\s]person|aerial|drone|insert|macro|overhead|handheld|static|locked|tracking|dolly|crane|drift|push(?:\s+in)?|pull(?:\s+out)?|pan|tilt|zoom|rack\s+focus|orbit|parallax|boom|slow\s+(?:forward|backward|push|pull)|(?:forward|backward|rear)\s+drift|(?:gentle|slow|smooth|tight|wide|fast|quick)\s+arc)\s*(?:shot|motion|movement)?)\b/gi;

const STYLE_RE =
  /\b(?:cinematic(?:\s+depth)?|(?:film|fantasy|magical|cinematic|grounded)\s*realism|realism|(?:color|colour)\s+grad(?:ing|ed)|premium\s+cinematic|muted\s+\w+\s*palette|earth\s+palette|grounded\s+(?:materials|fantasy)(?:\s+realism)?|tactile|realistic|photo[-\s]?realistic|stylized|painterly|documentary|anamorphic|shallow\s+depth|dof|golden\s+hour|backlit|rim\s+light|volumetric|bokeh|atmospheric|moody|dramatic|ethereal|dreamy|gritty|neo[-\s]noir)\b/gi;

const CONSTRAINT_RE = /\bno\s+[a-zA-Z][a-zA-Z-]*\b/g;

// Universal screenplay-shape patterns — light up script skeleton even on
// brand-new projects with zero named assets. All four fire in BOTH tiers
// because narrative scripts need structure highlights as much as
// production prompts do (arguably more — a master script is 80%
// screenplay by definition).

// Scene heading at line start: INT./EXT./INT-EXT. plus the rest of the
// line. Multiline flag handles per-line matching.
const SCENE_HEADING_RE =
  /^\s*(?:INT\.?\/EXT\.?|INT\.?|EXT\.?|I\/E\.?)\s+[^\n]+/gm;

// Transitions — "CUT TO:", "FADE IN/OUT", "DISSOLVE TO:", etc. Matched
// whole-line + case-insensitive so "cut to:" still lights up. The line
// has to END with the transition marker so prose like "cut to the chase"
// doesn't trigger.
const TRANSITION_RE =
  /^\s*(?:CUT\s+TO:|SMASH\s+CUT(?:\s+TO:)?|MATCH\s+CUT(?:\s+TO:)?|HARD\s+CUT(?:\s+TO:)?|JUMP\s+CUT(?:\s+TO:)?|DISSOLVE\s+TO:|FADE\s+(?:IN|OUT)(?:\.|:)?|FADE\s+TO\s+(?:BLACK|WHITE)\.?|IRIS\s+(?:IN|OUT)\.?|WIPE\s+TO:|TIME\s+CUT:|END\s+(?:CREDITS|TITLE)\.?)\s*$/gim;

// Parentheticals — short stage direction inside dialogue blocks like
// "(beat)" or "(whispering)". 40-char cap keeps real prose out of the
// match.
const PARENTHETICAL_RE = /\([^()\n]{1,40}\)/g;

// Speaker cue — ALL CAPS on its own line (2–40 chars). Allows digits +
// common dialogue modifiers like "(V.O.)" / "(CONT'D)". Line-scoped so
// uppercase sentences in prose don't get tinted.
const SPEAKER_CUE_RE =
  /^\s*([A-Z][A-Z0-9'.\- ]{1,30}(?:\s*\([A-Z0-9'.\- ]{1,20}\))?)\s*$/gm;

// ---------------------------------------------------------------------------
// Alias generation
// ---------------------------------------------------------------------------

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Generate the set of strings that should match a single entity name. Includes:
//   - the full name as-is
//   - the suffix-stripped form ("Anvil Kid Character" → "Anvil Kid")
//   - the last meaningful word ("Anvil Kid" → "Kid") if standalone-safe
//   - the last two words ("Royal Storage Room" → "Storage Room") for 3+
//     token names
// All filtered against ALIAS_STOPWORDS and ENTITY_BLACKLIST so we don't emit
// "the" or "and" as a standalone alias.
export function aliasesForEntity(name: string): string[] {
  const out = new Set<string>();
  const trimmed = (name || "").trim();
  if (!trimmed) return [];
  if (!ENTITY_BLACKLIST.has(trimmed.toLowerCase())) out.add(trimmed);
  const stripped = trimmed.replace(ENTITY_SUFFIX_RE, "").trim();
  if (stripped && stripped !== trimmed && !ENTITY_BLACKLIST.has(stripped.toLowerCase())) {
    out.add(stripped);
  }
  const tokens = stripped
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !ALIAS_STOPWORDS.has(t.toLowerCase()));
  // If the raw form was multi-token (e.g. "The Hall") but stopword
  // filtering reduced it to one usable token, surface that token as a
  // standalone alias too. Without this branch, "The Hall" would only
  // match exactly — "Hall walks in" wouldn't trigger.
  if (tokens.length === 1) {
    const sole = tokens[0];
    const rawTokenCount = stripped.split(/\s+/).length;
    if (sole.length >= 3 && rawTokenCount > 1 && !ENTITY_BLACKLIST.has(sole.toLowerCase())) {
      out.add(sole);
    }
  }
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (last.length >= 3 && !ENTITY_BLACKLIST.has(last.toLowerCase())) {
      out.add(last);
    }
  }
  if (tokens.length >= 3) {
    const lastTwo = tokens.slice(-2).join(" ");
    out.add(lastTwo);
  }
  return Array.from(out).filter((s) => s.length >= 2);
}

// ---------------------------------------------------------------------------
// Per-category regex builder
// ---------------------------------------------------------------------------

interface CategoryIndex {
  // The compiled regex. null when the category has no entities.
  regex: RegExp | null;
  // alias-lowercase → canonical entity name. Used to look up the source
  // entity from a match (so callers can navigate/click into it).
  aliasToName: Map<string, string>;
}

function buildCategoryIndex(names: string[] | undefined): CategoryIndex {
  if (!names || names.length === 0) {
    return { regex: null, aliasToName: new Map() };
  }
  const aliasToName = new Map<string, string>();
  // Process longer canonical names FIRST so when two entities collide on a
  // short alias, the longer canonical form wins the navigate target. Then
  // sort the actual alias list longest-first for regex alternation order
  // (regex engines try alternatives in declared order — longest-first
  // ensures "Anvil Kid" matches before "Kid").
  const sortedByCanonical = [...names].sort((a, b) => b.length - a.length);
  for (const canonical of sortedByCanonical) {
    for (const alias of aliasesForEntity(canonical)) {
      const key = alias.toLowerCase();
      if (!aliasToName.has(key)) {
        aliasToName.set(key, canonical);
      }
    }
  }
  if (aliasToName.size === 0) {
    return { regex: null, aliasToName };
  }
  // Sort aliases longest-first so "Anvil Kid" beats "Kid" in the regex
  // alternation. Append `'s?` to handle possessives without exploding the
  // pattern size; the trailing `\b` keeps boundaries clean.
  const aliasParts = Array.from(aliasToName.keys())
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const regex = new RegExp(`\\b(?:${aliasParts.join("|")})(?:'s|s)?\\b`, "gi");
  return { regex, aliasToName };
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export interface CompiledDetector {
  detect(text: string, baseOffset?: number): DetectorMatch[];
  // Look up the canonical entity name for a hovered/clicked match text.
  // Returns null if no entity matches (e.g. a camera-pattern match).
  resolveEntity(matchText: string): { category: EntityCategory; name: string } | null;
}

const CATEGORIES: { key: keyof EntityCatalog; out: EntityCategory }[] = [
  { key: "characters", out: "character" },
  { key: "locations", out: "location" },
  { key: "props", out: "prop" },
  { key: "keyframes", out: "keyframe" },
  { key: "audio", out: "audio" },
  { key: "library", out: "library" },
];

export function compileDetector(
  catalog: EntityCatalog,
  tier: DetectorTier = "narrative",
): CompiledDetector {
  // Build per-category indexes ONCE per catalog change. Callers that only
  // change tier should reuse the catalog/indexes and rebuild only the
  // wrapper (kept as a single function call for simplicity — the hot path
  // is detect(), not compile()).
  const indexes = new Map<EntityCategory, CategoryIndex>();
  for (const cat of CATEGORIES) {
    indexes.set(cat.out, buildCategoryIndex(catalog[cat.key]));
  }

  // Combined alias→category lookup so a single regex match can be classified
  // without re-running per-category regexes. Stored lowercase. Strip
  // possessive/plural suffix before lookup so "Alex's" / "Alexs" resolve
  // to "Alex".
  const aliasToCategory = new Map<string, { category: EntityCategory; name: string }>();
  for (const cat of CATEGORIES) {
    const idx = indexes.get(cat.out)!;
    for (const [alias, name] of idx.aliasToName.entries()) {
      // First-seen wins on collision (categories iterated in priority order
      // above — characters before locations etc.).
      if (!aliasToCategory.has(alias)) {
        aliasToCategory.set(alias, { category: cat.out, name });
      }
    }
  }

  function stripSuffixForLookup(s: string): string {
    return s.toLowerCase().replace(/(?:'s|s)$/, "");
  }

  function detect(text: string, baseOffset = 0): DetectorMatch[] {
    if (!text) return [];
    const matches: DetectorMatch[] = [];

    // Entity scan first so they win deduplication.
    for (const cat of CATEGORIES) {
      const idx = indexes.get(cat.out)!;
      if (!idx.regex) continue;
      idx.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = idx.regex.exec(text)) !== null) {
        if (m[0].length === 0) {
          idx.regex.lastIndex += 1;
          continue;
        }
        const lookupKey = stripSuffixForLookup(m[0]);
        const resolved = idx.aliasToName.get(lookupKey);
        matches.push({
          from: baseOffset + m.index,
          to: baseOffset + m.index + m[0].length,
          category: cat.out,
          text: m[0],
          entityName: resolved || null,
        });
      }
    }

    // Production-tier patterns. Skipped in narrative tier so master script
    // prose doesn't get tinted for "wide shot" or "no text" written as
    // narrative description.
    if (tier === "production") {
      for (const [re, category] of [
        [CAMERA_RE, "camera"],
        [STYLE_RE, "style"],
        [CONSTRAINT_RE, "constraint"],
      ] as const) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          matches.push({
            from: baseOffset + m.index,
            to: baseOffset + m.index + m[0].length,
            category,
            text: m[0],
            entityName: null,
          });
        }
      }
    }

    // Screenplay-shape patterns run in BOTH tiers — master scripts and
    // production prompts both benefit from seeing scene headings,
    // transitions, speaker cues, and parentheticals highlighted. These
    // patterns are conservative (line-anchored, ALL-CAPS requirements,
    // length caps) so they don't false-positive on plain prose.
    for (const [re, category] of [
      [SCENE_HEADING_RE, "scene-heading"],
      [TRANSITION_RE, "transition"],
      [SPEAKER_CUE_RE, "speaker"],
      [PARENTHETICAL_RE, "parenthetical"],
    ] as const) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        matches.push({
          from: baseOffset + m.index,
          to: baseOffset + m.index + m[0].length,
          category,
          text: m[0],
          entityName: null,
        });
      }
    }

    // Dedupe overlapping ranges. Sort by (start asc, length desc) so longer
    // matches at the same start position win. After sorting, walk left-to-
    // right keeping the first non-overlapping match — entity matches were
    // pushed first so they beat pattern matches at the same position.
    matches.sort((a, b) => a.from - b.from || b.to - a.to);
    const filtered: DetectorMatch[] = [];
    let lastEnd = -1;
    for (const m of matches) {
      if (m.from >= lastEnd) {
        filtered.push(m);
        lastEnd = m.to;
      }
    }
    return filtered;
  }

  function resolveEntity(matchText: string) {
    const key = stripSuffixForLookup(matchText);
    return aliasToCategory.get(key) || null;
  }

  return { detect, resolveEntity };
}

// ---------------------------------------------------------------------------
// Convenience: build a catalog from a project shape
// ---------------------------------------------------------------------------

export interface ProjectShape {
  characters?: { name?: string }[];
  locations?: { name?: string }[];
  props?: { name?: string }[];
  keyframes?: { name?: string }[];
  audio?: { name?: string }[];
  library?: { name?: string }[];
}

export function catalogFromProject(project: ProjectShape | null | undefined): EntityCatalog {
  const pull = (entries: { name?: string }[] | undefined): string[] =>
    (entries || []).map((e) => e?.name || "").filter(Boolean);
  // Always return a fully-populated object so consumers can iterate every
  // category without null-checking each key. Empty arrays where data is
  // missing.
  return {
    characters: pull(project?.characters),
    locations: pull(project?.locations),
    props: pull(project?.props),
    keyframes: pull(project?.keyframes),
    audio: pull(project?.audio),
    library: pull(project?.library),
  };
}
