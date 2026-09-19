"use client";

import { useEffect } from "react";

// Native-browser confirm when the user tries to close the tab with
// unsaved changes. Mount once inside the workspace shell. Driven by
// the `dirty` flag from useWorkspaceData — the only place that knows
// whether the editor draft has been flushed to the server yet.
//
// The browser ignores returnValue text on modern Chrome/Edge/Firefox
// and shows a generic prompt; we still set it for older browsers.
//
// Renders nothing.
export function BeforeUnloadGuard({ dirty }: { dirty: boolean }) {
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
      return "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  return null;
}
