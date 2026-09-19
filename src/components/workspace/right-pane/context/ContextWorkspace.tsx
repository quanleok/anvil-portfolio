"use client";

import { SharedDocEditor } from "../SharedDocEditor";

// Context section right pane — preview/editor only. The docs picker
// for this section now lives in the left rail (RailFileTree). The
// pane just renders the currently-selected doc.

export function ContextWorkspace() {
  return (
    <section className="anvil-workspace-section anvil-workspace-section--context">
      <SharedDocEditor />
    </section>
  );
}
