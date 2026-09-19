"use client";

import { SharedDocEditor } from "../SharedDocEditor";

// Script section right pane — preview/editor only. The master /
// scene / prompt picker now lives in the left rail (RailFileTree).

export function ScriptWorkspace() {
  return (
    <section className="anvil-workspace-section anvil-workspace-section--script">
      <SharedDocEditor />
    </section>
  );
}
