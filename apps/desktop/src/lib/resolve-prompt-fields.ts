// TypeScript shim around the canonical CJS implementation in
// `electron/resolve-prompt-fields.cjs`. The CJS file is the source of
// truth so the same logic runs in main + renderer + agent tools without
// drift. This module exists to give the renderer's TSX call sites
// proper types and IDE autocomplete.
//
// IMPORTANT: don't add new behavior here — extend the CJS module and
// keep this thin. If the `ResolveContext` shape changes, both the CJS
// file and `src/types.ts` need matching updates.

import type {
  PromptEntry,
  ScriptEntry,
  ProjectDefaults,
  ModelSpec,
  ResolvedField,
  ResolvedPromptFields,
} from "../types";

// Cut #1 retired the shot tier. The cjs cascade resolver still
// supports an optional shot in its ResolveContext for any legacy call
// site or test fixture; the renderer always passes null for it.
type LegacyShotShape = {
  id: string;
  title: string;
  shotType?: string | null;
  lensHint?: string | null;
  model?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  fps?: number | null;
  lens?: string | null;
  cameraMovement?: string | null;
  motionIntensity?: string | null;
  mood?: string | null;
  soundFlag?: boolean | null;
};

// Vite handles CommonJS interop transparently. The default-import shape
// works both in dev (esbuild dep optimizer) and production (Rollup CJS
// plugin).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require("../../electron/resolve-prompt-fields.cjs") as {
  PROMPT_FIELDS: ReadonlyArray<keyof ResolvedPromptFields>;
  resolvePromptFields(ctx: ResolveContext): ResolvedPromptFields;
  resolveSingleField<K extends keyof ResolvedPromptFields>(
    ctx: ResolveContext,
    fieldName: K,
  ): ResolvedPromptFields[K];
  isMeaningful(value: unknown): boolean;
};

export interface ResolveContext {
  prompt: PromptEntry | null;
  shot: LegacyShotShape | null;
  scene: ScriptEntry | null;
  projectDefaults: ProjectDefaults;
  modelSpec?: ModelSpec;
}

export const PROMPT_FIELDS = impl.PROMPT_FIELDS;

export function resolvePromptFields(ctx: ResolveContext): ResolvedPromptFields {
  return impl.resolvePromptFields(ctx);
}

export function resolveSingleField<K extends keyof ResolvedPromptFields>(
  ctx: ResolveContext,
  fieldName: K,
): ResolvedPromptFields[K] {
  return impl.resolveSingleField(ctx, fieldName);
}

export function isMeaningful(value: unknown): boolean {
  return impl.isMeaningful(value);
}

// Re-export the field+source types for convenience at TSX call sites.
export type { ResolvedField, ResolvedPromptFields };
