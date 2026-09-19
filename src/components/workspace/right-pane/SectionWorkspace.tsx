"use client";

import { memo } from "react";

import { useWorkspace } from "../WorkspaceProvider";
import { AssetsWorkspace } from "./assets/AssetsWorkspace";
import { ContextWorkspace } from "./context/ContextWorkspace";
import { ScriptWorkspace } from "./script/ScriptWorkspace";
import { WorkshopWorkspace } from "./workshop/WorkshopWorkspace";

// Dispatches the right pane on activeSection. The four child
// workspaces are responsible for their own header + body shape. The
// chat lives outside this dispatch so section switches never re-mount
// it (spec acceptance criterion).

export const SectionWorkspace = memo(function SectionWorkspace() {
  const { activeSection } = useWorkspace();
  if (activeSection === "story") return <ContextWorkspace />;
  if (activeSection === "script") return <ScriptWorkspace />;
  if (activeSection === "assets") return <AssetsWorkspace />;
  if (activeSection === "workshop") return <WorkshopWorkspace />;
  return null;
});
