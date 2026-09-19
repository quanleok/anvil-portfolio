import type { CloudFile } from "../types";
import { frontmatterDurationSec } from "./parseFrontmatter";
import { compareProjectFiles, numberedCreativeOrder } from "./sortNumberedFiles";

// Derive an ordered master → scenes → prompts(under scenes) tree
// from the flat files map. Scene stem is the filename without the
// .md extension; prompts live under `prompts/<scene-stem>/...`. A
// prompt whose folder doesn't match any scene's stem is surfaced as
// an orphan so it doesn't silently disappear if a scene is renamed.

export type ScriptPromptNode = {
  promptFile: CloudFile;
  durationSec: number | null;
};

export type ScriptSceneNode = {
  sceneFile: CloudFile;
  stem: string;
  durationSec: number | null;
  prompts: ScriptPromptNode[];
  /** Paths that share this scene's stem in a case-insensitive
   *  comparison (e.g. `scenes/01-scene.md` and `scenes/01-Scene.md`
   *  on macOS APFS). When set, the rail surfaces a warning chip so
   *  the colliding scenes don't silently shadow each other. */
  collidingPaths?: string[];
};

export type ScriptTree = {
  master: CloudFile | null;
  scenes: ScriptSceneNode[];
  orphanPrompts: CloudFile[];
};

const MASTER_PATH = "script/master-script.md";

function pathStem(path: string) {
  const name = path.split("/").pop() || path;
  return name.replace(/\.md$/i, "");
}

function compareByOrder(a: CloudFile, b: CloudFile) {
  const aOrder = numberedCreativeOrder(a);
  const bOrder = numberedCreativeOrder(b);
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
  if (aOrder !== null && bOrder === null) return -1;
  if (aOrder === null && bOrder !== null) return 1;
  return compareProjectFiles(a, b);
}

export function buildScriptTree(files: CloudFile[]): ScriptTree {
  const master = files.find((file) => file.path === MASTER_PATH) || null;

  const scenes: ScriptSceneNode[] = files
    .filter((file) => file.path.startsWith("scenes/"))
    .map((sceneFile) => ({
      sceneFile,
      stem: pathStem(sceneFile.path),
      durationSec: frontmatterDurationSec(sceneFile.content),
      prompts: [] as ScriptPromptNode[],
    }))
    .sort((a, b) => compareByOrder(a.sceneFile, b.sceneFile));

  // Map lowercase stem → first scene that owns it. Track every
  // path that shared the stem (case-insensitively) so we can warn
  // the user; the last writer still wins for prompt routing, which
  // is the lesser evil vs an empty rail (improvement-plan §5.7,
  // companion to Codex-1's lowercase-stem fix).
  const sceneByStem = new Map<string, ScriptSceneNode>();
  const collisionsByKey = new Map<string, string[]>();
  for (const scene of scenes) {
    const key = scene.stem.toLowerCase();
    const existing = sceneByStem.get(key);
    if (existing) {
      const bucket = collisionsByKey.get(key) || [existing.sceneFile.path];
      bucket.push(scene.sceneFile.path);
      collisionsByKey.set(key, bucket);
    }
    sceneByStem.set(key, scene);
  }
  for (const [key, paths] of collisionsByKey) {
    const owner = sceneByStem.get(key);
    if (owner) {
      owner.collidingPaths = paths.filter((path) => path !== owner.sceneFile.path);
    }
  }

  const orphanPrompts: CloudFile[] = [];
  for (const file of files) {
    if (!file.path.startsWith("prompts/")) continue;
    const segments = file.path.split("/");
    // `prompts/<scene-stem>/<prompt>.md` → segments.length >= 3.
    // `prompts/<prompt>.md` (flat) → orphan.
    if (segments.length < 3) {
      const promptOrder = numberedCreativeOrder(file);
      const numberedParent =
        promptOrder === null
          ? null
          : scenes.find((scene) => numberedCreativeOrder(scene.sceneFile) === promptOrder) ||
            (scenes.length === 1 ? scenes[0] : null);
      if (numberedParent) {
        numberedParent.prompts.push({
          promptFile: file,
          durationSec: frontmatterDurationSec(file.content),
        });
      } else {
        orphanPrompts.push(file);
      }
      continue;
    }
    const stem = segments[1].toLowerCase();
    const parent = sceneByStem.get(stem);
    if (!parent) {
      orphanPrompts.push(file);
      continue;
    }
    parent.prompts.push({
      promptFile: file,
      durationSec: frontmatterDurationSec(file.content),
    });
  }

  for (const scene of scenes) {
    scene.prompts.sort((a, b) => compareByOrder(a.promptFile, b.promptFile));
    // Scene duration falls back to the sum of its prompts' durations
    // when the scene itself doesn't carry frontmatter.
    if (scene.durationSec === null && scene.prompts.length) {
      const sum = scene.prompts.reduce(
        (total, prompt) => (prompt.durationSec ? total + prompt.durationSec : total),
        0,
      );
      if (sum > 0) scene.durationSec = Math.round(sum * 10) / 10;
    }
  }

  orphanPrompts.sort(compareProjectFiles);

  return { master, scenes, orphanPrompts };
}
