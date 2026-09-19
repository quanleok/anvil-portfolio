"use client";

import { useCallback, useEffect, type CSSProperties } from "react";

import type { WorkspaceUser } from "@/lib/workspace-auth";

import "./three-column.css";
import { AgentChat } from "./chat/AgentChat";
import { BeforeUnloadGuard } from "./lib/BeforeUnloadGuard";
import { useShellState } from "./lib/useShellState";
import { useWorkspaceData } from "./lib/useWorkspaceData";
import { ChevronLeftIcon } from "./lib/icons";
import { DocsRail } from "./rail/DocsRail";
import { IconRail } from "./rail/IconRail";
import { SectionWorkspace } from "./right-pane/SectionWorkspace";
import { Splitter } from "./right-pane/Splitter";
import { WorkspaceProvider } from "./WorkspaceProvider";

// Workspace shell — desktop-app-style 4-pane layout (matching the local
// Anvil app's column order):
//   IconRail (80px) · DocsRail (resizable) · SectionWorkspace / editor (flex)
//     · AgentChat (resizable right pane)
//
// Data + agent state lives in useWorkspaceData. Width/collapse state
// + keyboard shortcuts + auto-expand-on-write live in useShellState.
// Track widths are written as CSS vars on the shell root and consumed
// by `.anvil-workspace-shell` rules in three-column.css; the
// `is-rail-collapsed` modifier swaps between the 6-track and 4-track
// layouts. Improvement-plan §3.1.
//
// 2026-05-14 swap: editor moved to the 1fr flex middle, agent moved to
// the fixed right column so the layout matches local-app muscle memory
// (the user types into the wide center column; the agent is the
// always-on-the-right co-pilot).

const ICON_RAIL_WIDTH = 80;

export function BrowserProjectWorkspace({
  projectId,
  user,
}: {
  projectId: string;
  user: WorkspaceUser;
}) {
  const data = useWorkspaceData(projectId, user);
  const shell = useShellState(data.touchedPaths, data.switchSection);

  // Body-level signal of agent-working state. Single source of truth
  // that CSS surfaces across panes (right-pane glow, future cues) so
  // we don't have to thread agentBusy through every child. Also
  // updates the tab title so the user gets feedback when the tab is
  // backgrounded — "(working) Anvil" cues them to come back.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (data.agentBusy) {
      document.body.dataset.anvilAgentBusy = "true";
      const original = document.title;
      const next = original.startsWith("(working) ") ? original : `(working) ${original}`;
      document.title = next;
      return () => {
        delete document.body.dataset.anvilAgentBusy;
        if (document.title.startsWith("(working) ")) {
          document.title = document.title.slice("(working) ".length);
        }
      };
    }
    delete document.body.dataset.anvilAgentBusy;
  }, [data.agentBusy]);

  const effectiveDocsWidth = shell.railCollapsed ? 0 : shell.railWidth;
  const effectiveRightWidth = shell.rightCollapsed ? 32 : shell.rightWidth;
  const { setRailCollapsed } = shell;
  const toggleRailCollapsed = useCallback(() => setRailCollapsed((c) => !c), [setRailCollapsed]);
  const expandRail = useCallback(() => setRailCollapsed(false), [setRailCollapsed]);
  // Track widths feed CSS custom properties; the actual grid template
  // lives in three-column.css and switches off the is-rail-collapsed
  // modifier so we never end up with mismatched track-count + child-
  // count (the old bug the inline template was working around).
  const shellStyle: CSSProperties = {
    "--col-rail": `${ICON_RAIL_WIDTH}px`,
    "--col-docs": `${effectiveDocsWidth}px`,
    "--col-right": `${effectiveRightWidth}px`,
  } as CSSProperties;
  const shellClassName = shell.railCollapsed
    ? "anvil-workspace-shell is-rail-collapsed"
    : "anvil-workspace-shell";

  return (
    <WorkspaceProvider value={data}>
      <BeforeUnloadGuard dirty={data.dirty} />
      <main className={shellClassName} style={shellStyle}>
        <IconRail
          railCollapsed={shell.railCollapsed}
          onToggleCollapsed={toggleRailCollapsed}
          onExpand={expandRail}
        />
        {shell.railCollapsed ? null : <DocsRail />}
        {shell.railCollapsed ? null : (
          <Splitter
            ariaLabel="Resize docs rail"
            onDrag={(dx) =>
              shell.setRailWidth((w) => Math.max(200, Math.min(420, w + dx)))
            }
          />
        )}
        <SectionWorkspace />
        <Splitter
          ariaLabel="Resize agent pane"
          onDrag={(dx) =>
            shell.setRightWidth((w) => Math.max(220, Math.min(640, w - dx)))
          }
        />
        {shell.rightCollapsed ? (
          <button
            type="button"
            className="anvil-workspace-right-gutter"
            onClick={() => shell.setRightCollapsed(false)}
            title="Expand agent pane"
            aria-label="Expand agent pane"
          >
            <ChevronLeftIcon size={14} />
          </button>
        ) : (
          <AgentChat />
        )}
      </main>
    </WorkspaceProvider>
  );
}
