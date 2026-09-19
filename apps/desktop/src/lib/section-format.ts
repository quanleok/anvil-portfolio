import type { FormatKind } from "../types";

// Labels for the per-section format convention docs. Used by the
// FormatMenu gear, the sidebar icon tooltips, and the editor-head when
// one of these docs is selected. Kept in its own module so the FormatMenu
// component doesn't need to import App.tsx.
export const SECTION_FORMAT_LABELS: Record<FormatKind, { label: string; pathHint: string }> = {
  script: { label: "Master Script format", pathHint: ".forge/scene-format.md · scenes + prompt plan" },
  prompts: { label: "Prompt format", pathHint: ".forge/prompt-format.md · 5-15s Seedance generation unit" },
};
