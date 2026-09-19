"use client";

import { useWorkspace } from "../WorkspaceProvider";

// Centered "nothing here yet" panel rendered by section workspaces
// when their underlying lists are empty. One sentence + one CTA
// matching the +New action that lives in the docs-rail head, so the
// user has a single obvious path forward.
//
// Improvement-plan §4.4.

type Section = "story" | "script" | "assets" | "workshop";

const COPY: Record<Section, { lede: string; cta: string }> = {
  story: {
    lede: "No context docs yet. Start with a project bible or a world doc.",
    cta: "+ New context doc",
  },
  script: {
    lede: "No scenes yet. The master script + your first scene live here.",
    cta: "+ New scene",
  },
  assets: {
    lede: "No assets yet. Characters, locations, props, keyframes, and audio cards.",
    cta: "+ Add character card",
  },
  workshop: {
    lede: "No media yet. Upload a clip or audio to start a bin.",
    cta: "+ Upload media",
  },
};

export function EmptySectionState({ section }: { section: Section }) {
  const { createFile, createProjectAsset, fileInputRef, mediaBusy } = useWorkspace();
  const copy = COPY[section];

  function onClick() {
    if (section === "story") {
      void createFile("custom");
      return;
    }
    if (section === "script") {
      void createFile("scenes");
      return;
    }
    if (section === "assets") {
      void createProjectAsset("characters");
      return;
    }
    if (section === "workshop") {
      fileInputRef.current?.click();
      return;
    }
  }

  return (
    <div className="anvil-workspace-empty-state" role="status">
      <p>{copy.lede}</p>
      <button type="button" onClick={onClick} disabled={mediaBusy && section === "workshop"}>
        {copy.cta}
      </button>
    </div>
  );
}
