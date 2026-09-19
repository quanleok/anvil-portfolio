import type { ScriptEntry } from "../types";
import { getEntryLabel } from "./sections.ts";

export const DIALOGUE_DOC_TITLE = "Dialogue";
export const DIALOGUE_DOC_PATH = "dialogue/dialogue.md";

export function buildDialogueScaffold(
  scenes: Array<Pick<ScriptEntry, "id" | "title" | "kind">>,
) {
  const blocks: string[] = [];

  for (const scene of scenes) {
    if (scene.kind !== "scene") continue;
    blocks.push(`## ${getEntryLabel("script", scene)}`);
  }

  return blocks.join("\n\n");
}

export function dialogueHasWrittenLines(content: string | null | undefined) {
  return String(content || "")
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("#")) return false;
      return true;
    });
}

export function syncEmptyDialogueScaffold(
  content: string | null | undefined,
  scenes: Array<Pick<ScriptEntry, "id" | "title" | "kind">>,
) {
  return dialogueHasWrittenLines(content)
    ? String(content || "")
    : buildDialogueScaffold(scenes);
}
