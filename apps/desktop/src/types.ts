export type BuiltInSectionId =
  | "story"
  | "script"
  | "dialogue"
  | "prompts"
  | "media"
  | "characters"
  | "locations"
  | "props"
  | "keyframes"
  | "audio"
  | "videos"
  | "timeline"
  | "workshop"
  // Retired tier ids preserved on the union so SectionId values that
  // round-trip through legacy .forge/index.json files don't fail
  // exhaustive-switch checks. They never appear in the live UI.
  | "beats"
  | "shots";

/** SectionId carries either a known built-in or a user-defined custom
 *  subsection. Built-ins keep their literal types so switch statements
 *  stay exhaustive; custom ids fall through to the default branch. */
export type SectionId = BuiltInSectionId | `custom:${string}`;

// Sections that have a dedicated per-section format doc under
// `.forge/*-format.md`. Narrower than SectionId — only the places
// the agent writes free-form content.
export type FormatKind = "script" | "prompts";

// Account / billing entitlement contract. Returned by the hosted billing
// API (Codex 1's `/api/billing/status`) and rendered into the Account tab
// + the top-header plan badge. Plan id matches the Stripe price family.
export type AccountPlanId = "free" | "pro" | "studio";
export type AccountEntitlementStatus = "active" | "past_due" | "canceled" | "trialing" | "unknown";
export interface AccountEntitlement {
  plan: AccountPlanId;
  status: AccountEntitlementStatus;
  /** ISO timestamp the current billing cycle renews/expires. Optional for
   *  free tier. */
  renewsAt?: string;
  /** Stripe customer id, when the account has billed before. Used by the
   *  manage-subscription portal link. */
  customerId?: string;
}

export interface AssetMedia {
  durationSec?: number | null;
  fileUrl: string;
  id: string;
  kind: "audio" | "image" | "video";
  label: string;
  path: string;
}

export interface ChatAttachment {
  fileUrl: string;
  id: string;
  kind: "audio" | "document" | "image" | "other" | "video";
  label: string;
  path: string;
  size: number;
}

export interface BaseEntry {
  content: string;
  id: string;
  path: string;
  title: string;
}

export type StoryContextGroupBuiltIn = "project" | "canon" | "asset";
export type StoryContextGroup = StoryContextGroupBuiltIn | (string & {});

export interface StoryEntry extends BaseEntry {
  contextGroup?: StoryContextGroup;
  kind: "story";
}

export type MagicDocKind = "atlas" | "bible" | "custom" | "digest" | "grammar" | "map";
export type MagicDocStatus = "broken" | "fresh" | "hand-edited" | "never-synced" | "stale";

export interface MagicDocEntry extends BaseEntry {
  currentSourcesHash: string;
  description: string;
  handEdited: boolean;
  isStale: boolean;
  kind: MagicDocKind;
  name: string;
  neverSynthesized: boolean;
  resolvedSources: string[];
  scope: string[];
  scopeErrors: string[];
  scopeResolvedCount: number;
  sourceCount: number;
  sourcesHash: string;
  sourcesTruncated: boolean;
  status: MagicDocStatus;
  synthesizedBodyHash: string;
  updatedAt: string;
}

export interface AssetContextGuideReference {
  fileUrl: string;
  label: string;
  path: string;
}

export interface AssetContextGuideEntry {
  content: string;
  name: string;
  path: string;
  references: AssetContextGuideReference[];
}

/** Sub-kind for entries in the audio section. Lets the bin filter
 *  music / sfx / voiceover / ambient and lets the agent route generation
 *  to the right slot. Optional so existing audio entries (which never
 *  declared a kind) keep loading; the renderer treats missing as "music". */
export type AudioKind = "music" | "sfx" | "voiceover" | "ambient";

/** Identifier for a user-defined subsection that lives on a primary's
 *  icon sub-rail. Stored as `custom:<uuid>` so the value coexists with
 *  the built-in SectionId literal union without colliding. */
export type CustomSubsectionId = `custom:${string}`;

/** Content shape for a custom subsection. Drives both the disk
 *  layout (which file extensions seed) and the future per-kind UI
 *  renderer. `freeform` accepts anything the user drops in. */
export type CustomSubsectionKind = "docs" | "gallery" | "audio" | "freeform";

/** A user-defined subsection on a primary section's icon rail. Each
 *  subsection has its own folder on disk. Script/Canon subsections expose
 *  markdown docs as simple titles in the UI; other subsection kinds may use
 *  their hidden INSTRUCTIONS.md as implementation guidance. */
export interface CustomSubsection {
  /** `custom:<uuid>` — globally unique within a project. */
  id: CustomSubsectionId;
  /** Which primary's sub-rail this lives under. */
  primary: "story" | "script" | "assets" | "workshop";
  /** Display label on the rail tooltip and pane header. */
  name: string;
  /** Content shape — drives the file-extension seed + (later) the
   *  pane renderer. */
  kind: CustomSubsectionKind;
  /** Project-relative folder where this subsection's files live. The
   *  folder is created on disk at subsection creation. Slug-safe. */
  folder: string;
  /** Project-relative path to the hidden INSTRUCTIONS.md. Always inside
   *  `folder`. Canon docs do not surface this file in the UI. */
  instructionsPath: string;
  /** Allowed extensions for files in this subsection. Lowercase,
   *  including the dot (e.g. [".md", ".png"]). Empty/undefined →
   *  no restriction (freeform). */
  fileExtensions?: string[];
  /** Optional emoji or short glyph used by the icon-rail button when
   *  no vector icon has been picked. */
  icon?: string;
  /** Free-form description / notes the user can attach. Optional. */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

// Single = the canonical solo reference image (one character / location
// / one keyframe shot). Sheet = a multi-angle / multi-shot composition
// where the identity card or sequence layout is baked into the
// generated image itself. Consumed by characters + locations (Single |
// Sheet) and keyframes (Single = frame, Sheet = storyboard sheet).
// Missing → "single".
export type AssetEntryKind = "single" | "sheet";

export interface AssetEntry extends BaseEntry {
  folder: string | null;
  media: AssetMedia[];
  name: string;
  usedIn?: AssetUsageEntry[];
  /** Only meaningful on entries in the `audio` section. Ignored on
   *  characters / locations / props / keyframes. Missing → "music". */
  audioKind?: AudioKind;
  /** Single vs Sheet variant. Only consumed by characters / locations /
   *  keyframes; ignored on props / audio / library. */
  kind?: AssetEntryKind;
}

export interface AssetRefs {
  characters?: string[];
  locations?: string[];
  props?: string[];
  keyframes?: string[];
  audio?: string[];
}
export interface MediaRecord {
  id: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  kind: "audio" | "image" | "video" | "document";
  source: "upload" | "generation" | "library" | "asset";
  addedAt: string;
  tags?: string[];
  referencedBy?: string[];
}

export interface MediaRef {
  mediaId: string;
  role: "canonical" | "variant" | "alternate";
  addedAt: string;
}

/**
 * One external API provider the user has registered. Holds the API key
 * (loaded from the encrypted secrets blob, not from project.json), an
 * optional endpoint URL, optional default model, and free-form docs the
 * user pasted from the provider's docs page so the local agent can read
 * them via `read_provider_docs(id)`. The agent never sees the apiKey
 * value — `list_providers` returns booleans only.
 */
export type ApiProviderCapability = "image" | "video" | "music" | "voice" | "code" | "text" | "custom";

export interface ApiProvider {
  id: string;
  label: string;
  /** Legacy single-capability field. Read for migration; new UI writes
   *  capabilities so one provider can opt into video + music but not image. */
  capability?: ApiProviderCapability;
  capabilities?: ApiProviderCapability[];
  endpoint?: string;
  /** Encrypted at rest. Populated on load from secrets.json; stripped
   *  before persisting back to project.json. */
  apiKey?: string;
  /** Optional shell env-var name. When set, that env var (if exported)
   *  takes precedence over the stored key. Useful for shared CI keys or
   *  when the user keeps their key in `~/.anvil/.env`. */
  envVar?: string;
  defaultModel?: string;
  docs?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type SkillAddonGroupId = "cinematic" | "story" | "commercial" | "finishing" | "custom";

export interface SkillLibraryEntry {
  addon: boolean;
  core: boolean;
  crossRefs: string[];
  disabled?: boolean;
  enabled: boolean;
  groupId: SkillAddonGroupId;
  groupLabel: string;
  custom?: boolean;
  systemProtocol?: boolean;
  internal?: boolean;
  name: string;
  path: string;
  slug: string;
  summary: string;
  triggers: string[];
  version: string;
  words: number;
}

export interface SkillLibraryGroup {
  defaultEnabled?: boolean;
  description: string;
  enabled: boolean;
  enabledSkillCount?: number;
  id: SkillAddonGroupId;
  kind: "core" | "addon";
  label: string;
  skillCount: number;
  skills: SkillLibraryEntry[];
}

export interface SkillLibraryPayload {
  disabledSkills: string[];
  enabledSkillAddons: SkillAddonGroupId[];
  groups: SkillLibraryGroup[];
  skills: SkillLibraryEntry[];
}

export interface PinboardEntry {
  id: string;
  text: string;
  category: "preference" | "fact" | "constraint" | "naming" | "decision" | "workflow";
  scope: "project" | "user";
  createdAt: string;
  updatedAt: string;
  confirmed: boolean;
  source?: { kind: "chat" | "file" | "manual"; ref?: string };
}

// Scope-based focus lock — enforcement uses path prefixes derived from
// scenePath (not frozen path enumerations), so children created after the
// lock is set (new beats, new shots, new prompts) stay within scope automatically.
export type FocusScope =
  | { kind: "file"; path: string }
  | { kind: "scene"; sceneId: string; scenePath: string }
  | { kind: "shot"; shotId: string; shotPath: string; scenePath: string }
  | { kind: "readonly" }
  | { kind: "none" };
export type EntityRefRole = "featured" | "mentioned" | "background";

export interface EntityRef {
  entityId: string;
  role: EntityRefRole;
  section: "audio" | "characters" | "keyframes" | "locations" | "props";
}

/**
 * Legacy suppressed implicit link retained for old project compatibility.
 * The current UI no longer auto-detects prompt links from prose.
 */
export interface SuppressedRef {
  entityId: string;
  section: "audio" | "characters" | "keyframes" | "locations" | "props";
}

export interface AssetUsageEntry {
  entryId: string;
  entryPath: string;
  entrySection: "beats" | "dialogue" | "prompts" | "script" | "shots";
  entryTitle: string;
  role: EntityRefRole;
  sceneId?: string | null;
  shotId?: string | null;
}
// ContinuityKind / ContinuityRecord were dropped in the 2026-05-04
// bloat-cuts pass — the structured continuity field (with kind /
// carryOver / intent / prevId) was over-engineered for what the user
// actually needed: a "continue from prompt N-1" hint. PromptEntry now
// carries a simple `prevPromptId?: string | null` instead. The hint
// text in the prompt body is auto-generated at create_prompt time
// from the previous prompt's title.
/**
 * A secondary script peer to the Master Script — e.g. a trailer, an
 * episode, a behind-the-scenes — written in the same Master-Script
 * frontmatter shape (`---\nid: ...\ntitle: ...\n---`) and stored at
 * `script/<slug>.md`. Optional on Project so single-film projects (the
 * common case) carry no extra schema. Master Script itself is NOT
 * tracked here — it's implicit and always lives at
 * `script/master-script.md`.
 */
export interface SecondaryScript {
  id: string;
  name: string;
  /** Project-relative path, posix-style. e.g. `script/trailer.md`. */
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptEntry extends BaseEntry {
  assetRefs?: AssetRefs;
  durationSec?: number | null;
  entityRefs?: EntityRef[];
  sceneOrder?: number | null;
  suppressedRefs?: SuppressedRef[];
  kind: "master" | "scene";
  /** Project-relative path of the script this entry belongs to, e.g.
   *  `script/master-script.md` or `script/trailer.md`. Optional so old
   *  projects (single-film, no secondary scripts) load without
   *  modification — missing parent is treated as belonging to Master
   *  Script by the renderer's scene-tree filter. */
  parentScriptPath?: string;
  // Coarse, scene-level cascade slots. All optional. Children (shots,
  // prompts) inherit when their own value is missing AND the field is
  // marked scene-inheritable in the resolver. See
  // `src/lib/resolve-prompt-fields.ts`.
  model?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  fps?: number | null;
  mood?: string | null;
  soundFlag?: boolean | null;
  location?: string | null;
}

export interface DialogueEntry extends BaseEntry {
  assetRefs?: AssetRefs;
  entityRefs?: EntityRef[];
  sceneId: string | null;
  scenePath: string | null;
  shotId: string | null;
  shotPath: string | null;
  suppressedRefs?: SuppressedRef[];
}

export interface PromptEntry extends BaseEntry {
  assetRefs?: AssetRefs;
  beatId?: string | null;
  beatPath?: string | null;
  durationSec?: number | null;
  entityRefs?: EntityRef[];
  /** Id of the prompt that comes immediately before this one in the
   *  scene's intended generation order. Used for the "Continue from
   *  prompt N-1" hint in the prompt body. Replaced the older structured
   *  `continuity?: ContinuityRecord | null` + deprecated `continuousFrom`
   *  pair on 2026-05-04 — the structured field carried kind / carryOver /
   *  intent metadata that the user never edited and the agent didn't
   *  use. A single id pointer covers the actual UX value (let the agent
   *  reference the previous prompt's text when writing the next one). */
  prevPromptId?: string | null;
  /** Optional parent prompt id. When set, this prompt is a child
   *  ("sub-prompt") of the named parent — used when a beat needs more
   *  than the 15s ceiling and must be split into 2+ chunks. The parent
   *  carries the intent/context; children are the actual 5-15s
   *  generation units. Single-level only — children cannot themselves
   *  be parents. Optional + nullable for backwards compat with all
   *  existing flat-prompt projects. */
  parentPromptId?: string | null;
  /** Manual readiness override. Lets the user mark a prompt "good" when
   *  the auto-check is wrong. The override only applies while the exact
   *  issue signature still matches, so it expires automatically if the
   *  underlying problems change. */
  readinessOverride?: {
    issueKey: string;
    state: "ready";
    updatedAt?: string;
  } | null;
  suppressedRefs?: SuppressedRef[];
  sceneId: string | null;
  scenePath: string | null;
  segmentCount?: number | null;
  segmentEndSec?: number | null;
  segmentIndex?: number | null;
  segmentStartSec?: number | null;
  shotId: string | null;
  shotPath: string | null;
  /** Ordered VideoEntry ids — takes rendered from this prompt, in generation
   *  order. null/undefined when this prompt has never been rendered. */
  renders?: string[];
  // Prompt-level cascade slots — the finest tier. When set, lock the
  // value for this prompt regardless of shot/scene/project defaults.
  // When absent (or null), the resolver falls through to the shot →
  // scene → project → library → agent-decides chain.
  model?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  fps?: number | null;
  lens?: string | null;
  cameraMovement?: string | null;
  motionIntensity?: string | null;
  mood?: string | null;
  soundFlag?: boolean | null;
  /** null/undefined → random per generation. Lock for reproducibility. */
  seed?: number | null;
  /** Model-specific overflow (cfgScale, stepCount, etc.). Never inherits;
   *  always either locked here or supplied by the model library default. */
  modelParams?: Record<string, unknown> | null;
}

/** Defaults loaded from `.forge/project-defaults.md` frontmatter. Every
 *  field is optional — missing means "fall through to the next cascade
 *  tier" (model library default, then agent-decides at gen time). */
export interface ProjectDefaults {
  scene?: {
    durationTargetSec?: number | null;
    mood?: string | null;
  };
  shot?: {
    durationSec?: number | null;
    shotType?: string | null;
    lensHint?: string | null;
  };
  prompt?: {
    model?: string | null;
    durationSec?: number | null;
    aspectRatio?: string | null;
    resolution?: string | null;
    fps?: number | null;
    lens?: string | null;
    cameraMovement?: string | null;
    motionIntensity?: string | null;
    mood?: string | null;
    soundFlag?: boolean | null;
    seed?: number | null;
    modelParams?: Record<string, unknown> | null;
  };
}

/** Field schema for one prompt-able field, sourced from a model spec
 *  (e.g. `library/models/seedance-1.5.md`). Drives form chip options +
 *  the `library-default` cascade tier. */
export interface ModelFieldSchema {
  type: "number" | "enum" | "boolean" | "object";
  options?: ReadonlyArray<string | number>;
  min?: number;
  max?: number;
  default?: unknown;
  advanced?: boolean;
  constraint?: string;
}

export interface ModelSpec {
  id: string;
  displayName?: string;
  status?: "stable" | "preview" | "deprecated";
  deprecates?: string[];
  fields: Record<string, ModelFieldSchema>;
  constraints?: Array<{
    if?: Record<string, unknown>;
    then?: Record<string, unknown>;
    message: string;
  }>;
  promptAssembly?: {
    /** Mustache-lite template string. Tokens: {{ promptBody }}, {{ lens }},
     *  {{ cameraMovement }}, {{ motionIntensity }}, {{ mood }}, etc. */
    template: string;
  };
}

// ---------------------------------------------------------------------------
// Cascade resolver — output shape
// ---------------------------------------------------------------------------

export type FieldSourceKind =
  | "locked-prompt"
  | "locked-shot"
  | "locked-scene"
  | "project-default"
  | "library-default"
  | "agent-decides";

export interface FieldSource {
  kind: FieldSourceKind;
  /** "shot-001" / "scene-001" / "project" / model id. Optional — only
   *  populated for tiers where it makes sense. */
  ownerId?: string;
  /** "01.01 — Crow perch wide" / "01 — Threshold". For tooltip copy. */
  ownerTitle?: string;
  /** For library-default tier — which model supplied the value. */
  modelId?: string;
  /** For agent-decides tier — short reasoning, populated at gen time
   *  when the agent commits to a value. Empty pre-resolution. */
  rationale?: string;
}

export interface ResolvedField<T> {
  /** null = cascade exited at "agent-decides" without a stored choice.
   *  Render-time callers (preview) show "Auto"; gen-time callers MUST
   *  consult the agent before sending to the model. */
  value: T | null;
  source: FieldSource;
  /** Pre-baked tooltip string for chip hover. */
  tooltip: string;
}

export interface ResolvedPromptFields {
  model: ResolvedField<string>;
  durationSec: ResolvedField<number>;
  aspectRatio: ResolvedField<string>;
  resolution: ResolvedField<string>;
  fps: ResolvedField<number>;
  lens: ResolvedField<string>;
  cameraMovement: ResolvedField<string>;
  motionIntensity: ResolvedField<string>;
  mood: ResolvedField<string>;
  soundFlag: ResolvedField<boolean>;
  seed: ResolvedField<number>;
  modelParams: ResolvedField<Record<string, unknown>>;
}

/**
 * A rendered-video "take" tied back to the script pipeline. Storage lives
 * under `assets/videos/<scene>/<shot>/<prompt>/take-NN.mp4` so the folder
 * structure mirrors the script tree and is human-browsable. `sceneId` /
 * `shotId` / `promptId` are the source of truth — path is cosmetic and
 * survives renames by id lookup.
 *
 * An orphan video (`promptId === null`) is a file found on disk with no
 * matching prompt — either a user upload dropped outside the pipeline or a
 * prompt that was deleted after generation. The file is preserved either
 * way; the UI surfaces orphans in an "Unlinked" drawer for manual
 * reassignment or deletion.
 */
export interface VideoEntry {
  id: string;
  path: string;
  sceneId: string | null;
  shotId: string | null;
  promptId: string | null;
  /** 1-based take index within the owning prompt. Not renumbered on delete —
   *  gaps are intentional so older takes stay referenceable by index. */
  takeIndex: number;
  durationSec: number | null;
  generator: "evolink" | "topview" | "upload" | null;
  generatedAt: string;
  note: string;
  /** In-point for timeline playback (seconds from start of file). null = 0. */
  trimInSec?: number | null;
  /** Out-point for timeline playback (seconds from start of file). null = full duration. */
  trimOutSec?: number | null;
  /** Keeper flag — when a prompt has multiple takes, the keeper lands on
   *  the auto-assembled timeline. If unset across all takes, the latest
   *  take wins by default. */
  isKeeper?: boolean;
  // Compat shims for the SectionEntry union — VideoEntry is structurally
  // distinct from BaseEntry-shaped siblings (no editable body, no title),
  // but App.tsx's selectedItem is typed as the union and occasionally
  // reads `.content` / `.title`. Both stay optional and are never
  // serialized; renderers handling videos derive labels from takeIndex +
  // note instead.
  content?: string;
  title?: string;
}

/** Multi-track NLE lanes. V1 = main video, V2 = overlay video,
 *  A1/A2 = audio. Old clips without an explicit track default to V1. */
export type TimelineTrack = "V1" | "V2" | "A1" | "A2";

/**
 * Granular Workshop NLE events emitted by main-process tools the
 * moment they commit. The renderer subscribes via
 * `window.forgeDesktop.onTimelineEvent(...)` and reduces them into the
 * NLE state in-place — no full project reload required for the visible
 * effect. The `forge:project-changed` watcher still fires later as the
 * canonical safety net.
 *
 * `intent` is the only event that doesn't mutate state — it's the
 * agent narrating what it's about to do, with optional clipIds the UI
 * highlights so the user can see what's about to change.
 */
export type TimelineEvent =
  | { kind: "intent"; message: string; clipIds?: string[]; ts: string }
  | { kind: "intent-cleared"; ts: string }
  | {
      kind: "clip-added";
      clipId: string;
      track: TimelineTrack;
      startSec: number;
      videoId: string | null;
      mediaPath: string | null;
      ts: string;
    }
  | { kind: "clip-removed"; clipId: string; ts: string }
  | { kind: "clip-moved"; clipId: string; track: TimelineTrack; startSec: number; ts: string }
  | { kind: "clip-trimmed"; clipId: string; inSec: number | null; outSec: number | null; ts: string }
  | { kind: "clip-volume"; clipId: string; volume: number; ts: string }
  | { kind: "clip-fade"; clipId: string; fadeInSec: number; fadeOutSec: number; ts: string }
  | { kind: "clip-enabled"; clipId: string; enabled: boolean; ts: string }
  | { kind: "clip-label"; clipId: string; label: string | null; ts: string }
  | {
      kind: "clip-split";
      originalId: string;
      leftId: string;
      rightId: string;
      cutSec: number;
      ts: string;
    }
  | { kind: "keeper-changed"; promptId: string; videoId: string | null; ts: string }
  | { kind: "video-reassigned"; videoId: string; promptId: string | null; ts: string };

/** Project-level output spec used by the Workshop NLE for display
 *  (timecode frame count, frame-snap) and ffmpeg export (render
 *  dimensions). Missing on old projects → defaults to 1920x1080@24. */
export interface VideoSpec {
  width: number;
  height: number;
  fps: number;
}

export const DEFAULT_VIDEO_SPEC: VideoSpec = { width: 1920, height: 1080, fps: 24 };

/** One clip slot on the Timeline / Workshop NLE.
 *  - `promptId`: script anchor when the clip maps to a prompt. null for
 *    ad-hoc inserts (no-script-backed) and audio clips.
 *  - `videoId`: the rendered take this clip references. null = gap
 *    placeholder, or an audio clip (uses `mediaPath`).
 *  - `mediaPath`: project-relative path for non-VideoEntry sources
 *    (audio assets, ad-hoc videos). Used when `videoId` is null.
 *  - `inSec`/`outSec`: trim in-point / out-point in seconds from the
 *    start of the source file. null = play from start / to end.
 *  - `orderIndex`: 0-based position within the same track.
 *  - `track`: NLE lane. Defaults to "V1" when absent.
 *  - `startSec`: explicit timeline position in seconds (where the clip
 *    starts on its track). When absent, the clip is appended after the
 *    previous clip on the same track.
 *  - `volume`: 0-1 multiplier for audio output. Defaults to 1.
 *  - `fadeInSec`/`fadeOutSec`: linear ramp at clip head/tail. */
export interface TimelineClip {
  id: string;
  promptId: string | null;
  videoId: string | null;
  inSec: number | null;
  outSec: number | null;
  enabled: boolean;
  orderIndex: number;
  track?: TimelineTrack;
  startSec?: number | null;
  mediaPath?: string | null;
  volume?: number | null;
  fadeInSec?: number | null;
  fadeOutSec?: number | null;
  label?: string | null;
}

export type AnvilMethodId =
  | "scope_intake"
  | "context_build"
  | "master_script"
  | "scene_prompt_plan"
  | "reference_images"
  | "storyboard_sheets"
  | "video_sequence"
  | "continuity_audit"
  | "timeline_assembly";

export interface AnvilMethodState {
  access?: "granted" | "basic";
  checkpoint: string;
  directiveVersion?: string;
  methodId: AnvilMethodId;
  phase: string;
  source?: string;
  tier?: "creator" | "free";
  updatedAt: string;
}

export interface ForgeProjectData {
  /** Legacy assets.pool field — retired with the Pool → unified media
      merge. Kept optional on the type so we can read old project.json
      files without tsc errors; writers no longer populate it. */
  assets?: {
    pool?: Array<{
      hash?: string;
      id: string;
      kind: "audio" | "image";
      label: string;
      path: string;
      promoted?: string[];
      size?: number;
    }>;
  };
  audio: AssetEntry[];
  characters: AssetEntry[];
  folders: Array<{ id: string; name: string; parentId: string | null }>;
  keyframes: AssetEntry[];
  library: AssetEntry[];
  locations: AssetEntry[];
  magicDocs?: MagicDocEntry[];
  project: {
    createdAt: string;
    id: string;
    name: string;
    updatedAt: string;
    /** Set true after the script-primary subrail has been pre-seeded with
     *  Drafts / Characters / Beats / Dialogue subsections on first load.
     *  Stops re-seeding when the user explicitly deletes one. */
    scriptSubsectionsSeeded?: boolean;
  };
  dialogue?: DialogueEntry[];
  prompts: PromptEntry[];
  props: AssetEntry[];
  story: StoryEntry[];
  script: ScriptEntry[];
  /** Video takes rendered from prompts. Optional on the type so old
   *  project.json files without this field load without tsc errors; the
   *  renderer normalizes missing → []. */
  videos?: VideoEntry[];
  /** Persisted timeline state. When present, the Timeline primary
   *  renders these clips in `orderIndex` order; when absent, the
   *  default timeline is derived from script order at render time. */
  timeline?: TimelineClip[];
  /** User-defined subsections that appear on each primary's icon rail.
   *  Includes secondary scripts (kind: "script", primary: "script",
   *  folder: "script", instructionsPath: "script/<slug>.md") which use
   *  the Master-Script frontmatter shape on disk and a different read/
   *  write IPC pair than the other custom-doc kinds. */
  customSubsections?: CustomSubsection[];
  /** Output spec for the Workshop NLE: render dimensions + frame rate.
   *  Drives display timecode (frames-per-second), frame-snap on cuts,
   *  and the ffmpeg export. Missing → DEFAULT_VIDEO_SPEC. */
  videoSpec?: VideoSpec;
  /** Project-tier defaults loaded from `.forge/project-defaults.json`.
   *  Populated by main.cjs at project read time. Consumed by the
   *  prompt-field cascade resolver. Absent / partial sections are
   *  fine — the resolver tolerates missing keys. */
  defaults?: ProjectDefaults;
  /** Project-relative paths the user has marked as read-only. Mutating
   *  tools refuse to write to these paths until the user toggles the
   *  flag off in the UI. Defaults to `["ANVIL.md"]` for new and
   *  upgraded projects so the project spine is protected by default.
   *  Distinct from the in-memory `FocusScope` lock, which is a
   *  per-session focus mechanism, not persistent. */
  readOnlyPaths?: string[];
  /** Current local workflow phase for protected Anvil methods.
   *  Proprietary method logic runs server-side and returns visible replies
   *  plus safe file actions for the desktop app to apply. */
  methodState?: AnvilMethodState;
  settings: {
    hookToken: string;
    hookUrl: string;
    /** Archived hosted-agent endpoint. Kept so older project.json files
     *  still parse; local launch saves this disabled/blank. */
    remoteAgentUrl?: string;
    /** Bearer token for remoteAgentUrl. Saved through the encrypted
     *  project secret store by the main process, not project.json. */
    remoteAgentToken?: string;
    /** True when a remoteAgentToken exists in the encrypted project secret
     *  store. The renderer uses this instead of relying on the raw secret
     *  field, which may be blank after a safe reload. */
    remoteAgentTokenSaved?: boolean;
    /** Hosted-agent off switch. Defaults off for the local launch. */
    remoteAgentEnabled?: boolean;
    /** Archived terminal-directive method-server base URL. Kept so older
     *  project.json files still parse; local launch saves this disabled/blank. */
    methodServerUrl?: string;
    /** Bearer token for the method server. Saved through the encrypted
     *  project secret store by the main process, not project.json. */
    methodServerToken?: string;
    /** Terminal-directive method switch. Defaults off for the local launch. */
    methodServerEnabled?: boolean;
    /** Protected server turn endpoint for Anvil-owned methods. Unlike terminal
     *  directives, this server may run private method logic, provider LLM calls,
     *  and return structured file actions. */
    protectedAnvilUrl?: string;
    /** Bearer token for protectedAnvilUrl. Saved through the encrypted
     *  project secret store by the main process when a UI enables it. */
    protectedAnvilToken?: string;
    /** Protected server switch for Anvil-owned method calls. */
    protectedAnvilEnabled?: boolean;
    sessionKey: string;
    /** Supported wrapper runtimes. Hosted API agent providers were removed;
     *  OpenClaw covers local-agent routing and Hermes is the direct
     *  local-binary path. */
    agentProvider?: "openclaw" | "hermes";
    agentBinPath?: string;
    /** Approval posture for Anvil-launched agent wrappers. Missing on older
     *  projects means autonomous. */
    agentApprovalMode?: "autonomous" | "ask";
    /** Local autonomy switch for Anvil-launched agent wrappers. Defaults on;
     *  when enabled, Anvil starts supported CLIs with their permission-bypass
     *  flags and shows a launch warning. */
    agentBypassPermissions?: boolean;
    /** Default routing for generated asset media. `direct` saves untargeted
     *  generations to All media; `inbox` is a temporary review/trash lane. */
    agentMediaStaging?: "inbox" | "direct";
    /** Skill groups exposed to the agent. The Anvil Skills group is
     *  default-on; other groups can be toggled per project. */
    enabledSkillAddons?: SkillAddonGroupId[];
    /** Per-skill off switches. Group must still be enabled for a skill to run. */
    disabledSkills?: string[];
    agentModel?: string;
    /** Legacy hosted-agent field kept so older project.json files
     *  still parse. The supported agent modes ignore it. */
    customAgentEndpoint?: string;
    /** Legacy hosted-agent key. Supported agent modes ignore it; media
     *  generation uses mediaKeys / evolinkApiKey below instead. */
    apiKey?: string;
    /** Legacy hosted-agent key map. Retained for backwards-compatible
     *  parsing only; new saves clear it. */
    apiKeys?: Partial<
      Record<"anthropic" | "openai" | "openrouter" | "custom", string>
    >;
    /** Per-capability media generation keys. User pastes whatever key
     *  their preferred provider uses; adapter code (EvoLink today,
     *  more later) reads the right capability's key. Keys are stored
     *  in the encrypted media-keys blob on disk. */
    mediaKeys?: {
      image?: string;
      video?: string;
      music?: string;
      voice?: string;
    };
    /** Per-capability model override. User picks the exact model slug
     *  their provider / token has access to (e.g. "gemini-3-pro-image-
     *  preview" for EvoLink image). When set, it overrides whatever
     *  the agent tries to pass to the generate_* tools — the agent
     *  can't drift to an unsupported model like gpt-image-1. Blank
     *  falls back to the adapter's built-in default. Plain strings in
     *  project.json, not encrypted. */
    mediaModels?: {
      image?: string;
      video?: string;
      music?: string;
      voice?: string;
    };
    /** Archived hosted Anvil credit routing. Free local release forces these
     *  off; BYOK providers and terminal-agent native generation are the live
     *  paths. */
    anvilCredits?: {
      image?: {
        enabled?: boolean;
        model?: string;
      };
      video?: {
        enabled?: boolean;
        model?: string;
      };
    };
    /** Media-tab UI mode. "one" = single key applied to all
     *  capabilities (most users, one provider fronts everything).
     *  "per" = four separate keys. Default "one". */
    mediaMode?: "one" | "per";
    /** Legacy single EvoLink key — still honored. On load, auto-
     *  populates mediaKeys.image/video/music if those are blank. */
    evolinkApiKey?: string;
    /** Generic provider registry. Holds API keys + endpoints + user-
     *  pasted docs for any external service the user wants the agent
     *  to know about (EvoLink, Suno, ElevenLabs, OpenAI, custom internal
     *  APIs, etc.). Keys are encrypted as a single blob in secrets.json.
     *  Non-secret fields (label, capability, endpoint, defaultModel,
     *  envVar, docs, notes) live in project.json. The seeded "evolink"
     *  entry is auto-populated from the legacy mediaKeys + evolinkApiKey
     *  on load so existing flows keep working. */
    apiProviders?: ApiProvider[];
  };
  version: number;
}

export interface ForgeProjectHandle {
  project: ForgeProjectData;
  projectDir: string;
}

export interface RecentProjectEntry {
  openedAt: string;
  projectDir: string;
  projectName: string;
}

export type ReviewFileScope = "repo" | "project" | "review";

export interface ReviewFileTarget {
  scope: ReviewFileScope;
  path: string;
}

export interface ReviewFileEntry extends ReviewFileTarget {
  label: string;
  group: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ReviewFileGroup {
  id: string;
  label: string;
  files: ReviewFileEntry[];
}

export interface ReviewFileList {
  root: string;
  reviewDataRoot?: string;
  projectDir: string;
  groups: ReviewFileGroup[];
}

export interface ReviewFileContent {
  target: ReviewFileTarget;
  content: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface OpenClawAction {
  content?: string;
  description?: string;
  label?: string;
  path?: string;
  type: "copy" | "create_file" | "insert_below" | "replace" | "write_file" | string;
}

export interface OpenClawMeta {
  agentId?: string;
  attempts?: number;
  capability?: string;
  model?: string;
  provider?: string;
  routeTransport?: string;
  transport: "api" | "cli" | "hook" | "remote";
}

export interface AgentRouteInfo {
  defaultModel?: string;
  model?: string;
  provider?: string;
  resolvedDefault?: string;
}

export interface ChatTarget {
  itemId: string | null;
  label: string;
  section: SectionId;
}

export interface ChatOperation {
  description: string;
  error?: string;
  id: string;
  path?: string;
  status: "error" | "success";
  timestamp: string;
  type: "copy" | "create_file" | "insert_below" | "replace" | "write_file";
}

export interface ChatMessageStats {
  elapsedMs: number;
  terminated: string;
  turns: number;
}

export interface ChatMessage {
  actions?: OpenClawAction[];
  activity?: AgentActivityItem[];
  attachments?: ChatAttachment[];
  hammerAction?: string | null;
  id: string;
  /** Epoch millis of the most recent agent event for this message.
   *  Used to surface a heartbeat / "no activity for Ns" warning while
   *  the message is still pending. */
  lastActivityAt?: number;
  meta?: OpenClawMeta | null;
  operations?: ChatOperation[];
  requestId?: string;
  role: "assistant" | "user";
  state?: "error" | "pending" | "queued" | "ready";
  stats?: ChatMessageStats;
  target?: ChatTarget | null;
  text: string;
  timestamp: string;
}

export interface OpenClawResponse {
  actions?: OpenClawAction[];
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  content?: string;
  message?: string;
  output_text?: string;
  reply?: string;
  meta?: OpenClawMeta;
  result?: {
    actions?: OpenClawAction[];
    reply?: string;
  };
}

export interface ToolCall {
  args: Record<string, unknown>;
  id: string;
  mutating?: boolean;
  name: string;
}

export interface ToolResult {
  error?: string;
  /** Coarse failure classification surfaced by adapters (evolink, etc).
   *  Drives the inline error CTA in ActivityFeed. Optional — falls back
   *  to plain message rendering when missing. */
  errorType?:
    | "auth"
    | "quota"
    | "rate-limit"
    | "timeout"
    | "network"
    | "server"
    | "payload"
    | "unknown"
    | string;
  errorStatus?: number;
  errorProvider?: string;
  id: string;
  name: string;
  ok: boolean;
  result?: unknown;
}

export interface AgentPhase {
  id: string;
  verb: string;
  mood: "passive" | "active" | "long" | "done";
  theme: string;
}

export type AgentEvent =
  | { type: "tool:call"; turn: number; call: ToolCall }
  | { type: "tool:result"; turn: number; call: ToolCall; result: ToolResult }
  | { type: "reply:preview"; turn: number; reply: string }
  | { type: "phase"; phase: AgentPhase };

export interface AgentActivityItem {
  call: ToolCall;
  result?: ToolResult;
  startedAt?: number;
  turn: number;
}

declare global {
  interface Window {
    forgeDesktop: {
      askAgent(
        requestId: string,
        settings: ForgeProjectData["settings"],
        payload: unknown,
      ): Promise<{
        reply: string;
        actions: OpenClawAction[];
        turnCount: number;
        turns?: unknown[];
        terminated: string;
        meta?: OpenClawMeta | null;
      }>;
      cancelAgent(requestId: string): Promise<void>;
      getMethodDirective(
        settings: ForgeProjectData["settings"],
        payload: {
          methodId: AnvilMethodId | string;
          projectId?: string;
          appVersion?: string;
          phase?: string;
          selection?: Record<string, unknown>;
          contextSummary?: Record<string, unknown>;
        },
      ): Promise<{
        methodId: string;
        version: string;
        access: "granted" | "basic";
        tier: "creator" | "free";
        phase: string;
        directive: string;
        checkpoint: string;
        expiresAt: string;
        contextPolicy?: Record<string, unknown>;
          meta?: Record<string, unknown>;
      }>;
      protectedAnvilTurn(
        projectDir: string,
        payload: {
          userMessage?: string;
          message?: string;
          phase?: string;
          methodId?: string;
          maxActions?: number;
          applyActions?: boolean;
          context?: Record<string, unknown>;
        },
      ): Promise<{
        reply: string;
        checkpoint?: string | null;
        methodVersion?: string;
        warnings?: string[];
        actions: Array<{
          type: "create_dir" | "write_file" | "append_file";
          path: string;
          content?: string;
          reason?: string;
        }>;
        appliedActions: Array<{ type: string; path: string }>;
        project: ForgeProjectHandle | null;
        meta?: Record<string, unknown>;
      }>;
      getDesktopAccountStatus(projectDir: string): Promise<{
        ok: boolean;
        endpoint?: string;
        auth?: string;
        metering?: string;
        message?: string;
        entitlement: AccountEntitlement;
      }>;
      getDesktopAccountSession(): Promise<{
        ok: boolean;
        endpoint?: string;
        auth?: string;
        metering?: string;
        message?: string;
        entitlement: AccountEntitlement;
      }>;
      connectDesktopAccountSession(payload: {
        token: string;
        endpoint?: string;
      }): Promise<{
        ok: boolean;
        endpoint?: string;
        auth?: string;
        metering?: string;
        message?: string;
        entitlement: AccountEntitlement;
      }>;
      clearDesktopAccountSession(): Promise<{ ok: boolean }>;
      onAgentEvent(listener: (message: { requestId: string; event: AgentEvent }) => void): () => void;
      createProject(name: string): Promise<ForgeProjectHandle | null>;
      createProjectAtPath(projectDir: string, name?: string): Promise<ForgeProjectHandle | null>;
      getRecentProjects(): Promise<RecentProjectEntry[]>;
      openProject(): Promise<ForgeProjectHandle | null>;
      openProjectAtPath(projectDir: string): Promise<ForgeProjectHandle | null>;
      openRecentProject(projectDir: string): Promise<ForgeProjectHandle | null>;
      loadChatHistory(projectDir: string, sessionKey: string): Promise<ChatMessage[]>;
      onProjectChanged(listener: () => void): () => void;
      onTimelineEvent(listener: (event: TimelineEvent) => void): () => void;
      onInboxEvent(
        listener: (event:
          | { kind: "files-changed"; ts: string }
          | { kind: "job-started"; id: string; capability: "image" | "video" | "music" | "audio" | "asset"; prompt: string; model?: string; section?: string; durationSec?: number; ts: string }
          | { kind: "job-completed"; id: string; savedPaths?: string[]; ts: string }
          | { kind: "job-failed"; id: string; error: string; ts: string }
        ) => void,
      ): () => void;
      saveProject(projectDir: string, project: ForgeProjectData): Promise<ForgeProjectData>;
      saveProjectSettings(projectDir: string, project: ForgeProjectData): Promise<ForgeProjectData>;
      saveChatHistory(projectDir: string, sessionKey: string, history: ChatMessage[]): Promise<void>;
      unwatchProject(projectDir: string): Promise<void>;
      uploadAssets(projectDir: string, section: "characters" | "locations" | "props" | "keyframes" | "audio", entityId: string, entityName: string): Promise<AssetMedia[]>;
      createAssetEntriesFromFiles(
        projectDir: string,
        section: "characters" | "locations" | "props" | "keyframes" | "audio",
      ): Promise<{ uploaded: Array<{ title: string; media: AssetMedia }> }>;
      detachAssetVariant(
        projectDir: string,
        section: "characters" | "locations" | "props" | "keyframes" | "audio",
        assetId: string,
        mediaId: string,
      ): Promise<ForgeProjectData>;
      deleteAssetEntry(projectDir: string, section: "media" | "characters" | "locations" | "props" | "keyframes" | "audio", assetId: string): Promise<ForgeProjectHandle | null>;
      uploadLibraryAssets(projectDir: string): Promise<Array<{ label: string; path: string; fileUrl: string; size: number }>>;
      uploadLibraryFolder(projectDir: string): Promise<Array<{ label: string; path: string; fileUrl: string; size: number }>>;
      dropLibraryFiles(projectDir: string, filePaths: string[]): Promise<Array<{ label: string; path: string; fileUrl: string; size: number }>>;
      importWorkshopMedia(projectDir: string, filePaths?: string[] | null): Promise<{ videos: string[]; audio: string[] }>;
      importVideos(projectDir: string, destSubPath?: string | string[], filePaths?: string[] | null): Promise<string[]>;
      generatePromptVideo(projectDir: string, promptId: string): Promise<{
        ok: true;
        bundle: {
          startFrame: string | null;
          startFrameSource: unknown | null;
          referenceCount: number;
          durationSec: number;
        };
        result: unknown;
        project: ForgeProjectHandle | null;
      }>;
      generateAssetImage(projectDir: string, payload: {
        prompt: string;
        assetSection: "library" | "characters" | "locations" | "props" | "keyframes";
        entityId?: string | null;
        assetName?: string;
        size?: string;
        quality?: string;
      }): Promise<{
        ok: true;
        result: unknown;
        project: ForgeProjectHandle | null;
      }>;
      trimAssetMedia(
        projectDir: string,
        section: "media" | "characters" | "locations" | "props" | "keyframes" | "audio",
        assetId: string,
        mediaId: string,
        payload: { startSec?: number | null; endSec?: number | null },
      ): Promise<{ project: ForgeProjectHandle | null; mediaId: string; path: string; durationSec: number | null }>;
      deleteVideoEntry(projectDir: string, videoId: string): Promise<ForgeProjectHandle | null>;
      revealPath(projectDir: string, relativePath?: string): Promise<{ ok: boolean; path: string }>;
      listInboxFiles(projectDir: string): Promise<Array<{
        name: string;
        relPath: string;
        kind: "image" | "video" | "audio" | "document" | "other";
        size: number;
        mtime: number;
        fileUrl: string;
      }>>;
      listInboxPending(projectDir: string): Promise<Array<{
        id: string;
        capability: "image" | "video" | "music" | "audio" | "asset";
        prompt: string;
        model?: string;
        section?: string;
        startedAt: number;
      }>>;
      moveInboxToLibrary(projectDir: string, name: string): Promise<{ ok: boolean; name: string }>;
      deleteInboxFile(projectDir: string, name: string): Promise<{ ok: boolean }>;
      copyImageToClipboard(
        projectDir: string,
        relativePath: string,
      ): Promise<
        | { ok: true; path: string; sizeBytes: number }
        | { ok: false; reason: "missing" | "not-a-file" | "too-large" | "unsupported"; path: string; sizeBytes?: number }
      >;
      exportTimeline(
        projectDir: string,
        clips: Array<{ videoPath: string; inSec?: number | null; outSec?: number | null }>,
      ): Promise<{ ok: boolean; path: string; absolutePath: string }>;
      exportTimelineSequences(
        projectDir: string,
        sequences: Array<{
          label: string;
          clips: Array<{ videoPath: string; inSec?: number | null; outSec?: number | null }>;
        }>,
      ): Promise<{
        ok: boolean;
        folder: string;
        absoluteFolderPath: string;
        files: Array<{ label: string; path: string; absolutePath: string; clipCount: number }>;
      }>;
      exportWorkshopNLE(
        projectDir: string,
        payload: {
          totalDurationSec: number;
          width?: number;
          height?: number;
          includeV1Audio?: boolean;
          v1Clips: Array<{
            mediaPath: string;
            startSec: number;
            inSec?: number | null;
            outSec?: number | null;
          }>;
          v2Clips: Array<{
            mediaPath: string;
            startSec: number;
            inSec?: number | null;
            outSec?: number | null;
          }>;
          audioClips: Array<{
            mediaPath: string;
            startSec: number;
            inSec?: number | null;
            outSec?: number | null;
            volume?: number | null;
            fadeInSec?: number | null;
            fadeOutSec?: number | null;
          }>;
        },
      ): Promise<{
        ok: boolean;
        path: string;
        absolutePath: string;
        v1Count: number;
        v2Count: number;
        audioCount: number;
      }>;
      repairProject(projectDir: string): Promise<{ repairs: string[]; repairCount: number; project: ForgeProjectData }>;
      getAppVersion(): Promise<{ version: string; build: string; commitCount?: number; appName?: string; variant?: string }>;
      openExternal(url: string): Promise<{ ok: boolean }>;
      openProjectTerminal(
        projectDir: string,
        launcher?: "shell" | "codex" | "claude",
      ): Promise<{ ok: boolean; launcher: "shell" | "codex" | "claude"; label: string }>;
      startProjectTerminal(payload: {
        projectDir: string;
        launcher?: "shell" | "codex" | "claude" | "cli";
        cols?: number;
        rows?: number;
        binPath?: string;
      }): Promise<{
        ok: boolean;
        sessionId: string;
        launcher: "shell" | "codex" | "claude" | "cli";
        label: string;
        pid: number;
      }>;
      readProjectTerminalTranscript(
        projectDir: string,
        launcher?: "shell" | "codex" | "claude" | "cli",
      ): Promise<{
        ok: boolean;
        launcher: "shell" | "codex" | "claude" | "cli";
        path: string;
        text: string;
        bytes: number;
        truncated: boolean;
      }>;
      clearProjectTerminalTranscript(
        projectDir: string,
        launcher?: "shell" | "codex" | "claude" | "cli",
      ): Promise<{ ok: boolean; launcher: "shell" | "codex" | "claude" | "cli"; path: string }>;
      writeProjectTerminal(sessionId: string, data: string): void;
      resizeProjectTerminal(sessionId: string, cols: number, rows: number): void;
      killProjectTerminal(sessionId: string): void;
      onProjectTerminalData(listener: (message: { sessionId: string; data: string }) => void): () => void;
      onProjectTerminalExit(
        listener: (message: { sessionId: string; exitCode: number; signal?: number }) => void,
      ): () => void;
      listAgentProviders(): Promise<Array<{ id: string; label: string; installHint: string }>>;
      testAgentConnection(payload: { provider: string; binPath?: string; apiKey?: string; endpoint?: string }): Promise<{
        ok: boolean;
        binPath?: string;
        error?: string;
        route?: AgentRouteInfo;
        routeError?: string;
        version?: string;
      }>;
      detectEntityPlaceholders(payload: {
        project: ForgeProjectData | null;
        settings: ForgeProjectData["settings"];
      }): Promise<{
        candidates: Array<{ name: string; section: "characters" | "locations" | "props"; mentions: number }>;
        aliasLinks: Array<{
          alias: string;
          assetId: string;
          section: "characters" | "locations" | "props" | "keyframes" | "audio";
          mentions: number;
        }>;
      }>;
      uploadChatAttachments(projectDir: string): Promise<ChatAttachment[]>;
      watchProject(projectDir: string): Promise<void>;
      readConventions(projectDir: string): Promise<string>;
      writeConventions(projectDir: string, text: string): Promise<{ path: string; bytes: number }>;
      resetConventions(projectDir: string): Promise<{ path: string; bytes: number }>;
      listSkillLibrary(projectDir: string): Promise<SkillLibraryPayload>;
      readSkillMarkdown(projectDir: string, name: string): Promise<{ slug: string; path: string; content: string }>;
      writeSkillMarkdown(
        projectDir: string,
        name: string,
        text: string,
      ): Promise<{ slug: string; path: string; bytes: number }>;
      resetSkillMarkdown(projectDir: string, name: string): Promise<{ slug: string; path: string; content: string }>;
      createCustomSkill(projectDir: string, name: string): Promise<{ slug: string; path: string; content: string }>;
      importSkillMarkdown(
        projectDir: string,
      ): Promise<{ canceled: boolean; imported: Array<{ slug: string; path: string; bytes: number }> }>;
      exportSkillMarkdown(projectDir: string, name: string): Promise<{ canceled: boolean; path?: string; bytes?: number }>;
      createCustomSubsection(payload: {
        projectDir: string;
        name: string;
        primary: "story" | "script" | "assets" | "workshop";
        kind: CustomSubsectionKind;
        instructions?: string;
      }): Promise<{ folder: string; instructionsPath: string }>;
      readCustomSubsectionInstructions(projectDir: string, instructionsPath: string): Promise<string>;
      writeCustomSubsectionInstructions(
        projectDir: string,
        instructionsPath: string,
        text: string,
      ): Promise<{ ok: true }>;
      listCustomSubsectionFiles(
        projectDir: string,
        folder: string,
        fileExtensions?: string[],
      ): Promise<{
        folder: string;
        files: Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string; createdAt: string; ext: string }>;
      }>;
      deleteCustomSubsection(projectDir: string, folder: string): Promise<{ ok: true }>;
      readCustomSubsectionDoc(projectDir: string, filePath: string): Promise<string>;
      writeCustomSubsectionDoc(
        projectDir: string,
        filePath: string,
        text: string,
      ): Promise<{ ok: true }>;
      createCustomSubsectionDoc(
        projectDir: string,
        folder: string,
        title: string,
      ): Promise<{ path: string; title: string; text: string }>;
      renameCustomSubsectionDoc(
        projectDir: string,
        filePath: string,
        title: string,
      ): Promise<{ path: string; title: string }>;
      createScript(payload: {
        projectDir: string;
        name: string;
      }): Promise<SecondaryScript>;
      readScript(
        projectDir: string,
        scriptPath: string,
      ): Promise<{ content: string; title: string; meta: Record<string, unknown> }>;
      writeScript(
        projectDir: string,
        scriptPath: string,
        payload: { content: string; title?: string },
      ): Promise<{ ok: true }>;
      renameScript(
        projectDir: string,
        scriptPath: string,
        newName: string,
      ): Promise<{ path: string; name: string }>;
      deleteScript(
        projectDir: string,
        scriptPath: string,
      ): Promise<{ ok: true }>;
      readProjectContext(projectDir: string, projectName?: string): Promise<string>;
      writeProjectContext(projectDir: string, text: string): Promise<{ path: string; bytes: number }>;
      readAgentEntrypoints(projectDir: string): Promise<{ agent: string; agents?: string; claude: string }>;
      writeAgentEntrypoint(projectDir: string, fileName: "AGENT.md" | "AGENTS.md" | "CLAUDE.md", text: string): Promise<{ path: string; bytes: number }>;
      readAgentNote(projectDir: string): Promise<{ path: string; content: string }>;
      writeAgentNote(projectDir: string, text: string): Promise<{ path: string; bytes: number }>;
      listReviewFiles(projectDir: string): Promise<ReviewFileList>;
      readReviewFile(projectDir: string, target: ReviewFileTarget): Promise<ReviewFileContent>;
      writeReviewFile(
        projectDir: string,
        target: ReviewFileTarget,
        text: string,
      ): Promise<{ target: ReviewFileTarget; modifiedAt: string; sizeBytes: number }>;
      appendReviewNote(
        projectDir: string,
        note: string,
      ): Promise<{ target: ReviewFileTarget; modifiedAt: string; sizeBytes: number }>;
      readSectionConvention(projectDir: string, kind: FormatKind): Promise<string>;
      writeSectionConvention(projectDir: string, kind: FormatKind, text: string): Promise<string>;
      resetSectionConvention(projectDir: string, kind: FormatKind): Promise<string>;
      readAssetContextGuide(projectDir: string): Promise<AssetContextGuideEntry>;
      writeAssetContextGuide(projectDir: string, text: string): Promise<{ path: string; bytes: number }>;
      uploadAssetContextGuideReferences(projectDir: string): Promise<AssetContextGuideEntry>;
      addAssetContextGuideReferencePaths(projectDir: string, relativePaths: string[]): Promise<AssetContextGuideEntry>;
      deleteAssetContextGuideReference(projectDir: string, relativePath: string): Promise<AssetContextGuideEntry>;
      getMediaIndex(projectDir: string): Promise<Record<string, MediaRecord>>;
      attachMedia(
        projectDir: string,
        mediaId: string,
        section: "characters" | "locations" | "props" | "keyframes" | "audio",
        entityId: string,
        mode?: "reference" | "copy",
      ): Promise<{ result: unknown; project: ForgeProjectData }>;
      attachMediaBatch(
        projectDir: string,
        items: Array<{
          mediaId: string;
          section: "characters" | "locations" | "props" | "keyframes" | "audio";
          entityId: string;
          mode?: "reference" | "copy";
        }>,
      ): Promise<{
        results: Array<{
          mediaId: string;
          section: "characters" | "locations" | "props" | "keyframes" | "audio";
          entityId: string;
          mode: "reference" | "copy";
          ok: boolean;
          result?: unknown;
          error?: string;
        }>;
        project: ForgeProjectData;
      }>;
      getPinboard(projectDir: string): Promise<PinboardEntry[]>;
      updatePinboard(projectDir: string, entries: PinboardEntry[]): Promise<void>;
      syncMagicDoc(projectDir: string, name: string, force?: boolean): Promise<ForgeProjectHandle & {
        skipped: boolean;
        reason: string;
        scopeErrors: string[];
        scopeResolvedCount: number;
      }>;
    };
  }
}
