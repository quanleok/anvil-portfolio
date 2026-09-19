// TypeScript shim around the canonical CJS prompt assembler in
// `electron/prompt-assembly.cjs`. See note in `resolve-prompt-fields.ts`
// — the CJS module is the source of truth.

import type { ModelSpec, ResolvedPromptFields } from "../types";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require("../../electron/prompt-assembly.cjs") as {
  FALLBACK_TEMPLATE: string;
  buildTechnicalSidecar(resolved: ResolvedPromptFields): string;
  applyTemplate(
    template: string,
    resolved: ResolvedPromptFields,
    promptBody: string,
  ): string;
  assemblePromptText(
    resolved: ResolvedPromptFields,
    modelSpec: ModelSpec | null | undefined,
    promptBody: string,
  ): string;
};

export const FALLBACK_TEMPLATE = impl.FALLBACK_TEMPLATE;

export function buildTechnicalSidecar(resolved: ResolvedPromptFields): string {
  return impl.buildTechnicalSidecar(resolved);
}

export function applyTemplate(
  template: string,
  resolved: ResolvedPromptFields,
  promptBody: string,
): string {
  return impl.applyTemplate(template, resolved, promptBody);
}

export function assemblePromptText(
  resolved: ResolvedPromptFields,
  modelSpec: ModelSpec | null | undefined,
  promptBody: string,
): string {
  return impl.assemblePromptText(resolved, modelSpec, promptBody);
}
