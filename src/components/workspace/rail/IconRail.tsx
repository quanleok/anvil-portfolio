"use client";

import { memo } from "react";
import Link from "next/link";

import { useWorkspace } from "../WorkspaceProvider";

// Thin icon-only rail (80px) — matches the desktop app's primary
// section rail. Logo at top, vertical section tabs in the middle,
// account chip pinned at bottom.
//
// Icons are the bundled desktop WebPs from /public/anvil-ui/ so the
// browser and desktop apps share the same visual language. Where the
// desktop has an open/closed pair (script-grimoire, assets-armory),
// we cross-fade between them on hover + active state. Compass and
// the workshop hammer are singletons so they just brighten without
// a swap.
//
// Smart click behavior:
//   Click a non-active section icon → switch + ensure DocsRail expanded.
//   Click the active section icon → toggle DocsRail open/closed.
//
// While the agent is mid-turn, the active section icon gets an
// outline-pulse animation (.is-working) so the user knows where
// updates are about to land.

type SectionTab = {
  id: string;
  label: string;
  icon: string;
  iconOpen?: string;
};

const TABS: SectionTab[] = [
  { id: "story", label: "Context", icon: "/anvil-ui/context-compass.webp" },
  {
    id: "script",
    label: "Script",
    icon: "/anvil-ui/script-grimoire.webp",
    iconOpen: "/anvil-ui/script-grimoire-open.webp",
  },
  {
    id: "assets",
    label: "Assets",
    icon: "/anvil-ui/assets-armory.webp",
    iconOpen: "/anvil-ui/assets-armory-open.webp",
  },
  { id: "workshop", label: "Workshop", icon: "/anvil-ui/hammer-toolbar.webp" },
];

export const IconRail = memo(function IconRail({
  railCollapsed,
  onToggleCollapsed,
  onExpand,
}: {
  railCollapsed: boolean;
  onToggleCollapsed: () => void;
  onExpand: () => void;
}) {
  const { activeSection, switchSection, user, agentBusy, touchedFilesBySection } = useWorkspace();
  const initial = (user.email || "?").slice(0, 1).toUpperCase();

  function handleTabClick(id: string) {
    if (id === activeSection) {
      onToggleCollapsed();
      return;
    }
    switchSection(id);
    if (railCollapsed) onExpand();
  }

  return (
    <aside className="anvil-workspace-iconrail" aria-label="Anvil sections">
      <Link
        className="anvil-workspace-iconrail-logo"
        href="/app/projects"
        title="All projects"
        aria-label="All projects"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/anvil-logo.png" alt="" />
      </Link>
      <nav className="anvil-workspace-iconrail-tabs">
        {TABS.map(({ id, label, icon, iconOpen }) => {
          const isActive = id === activeSection;
          const isWorking = isActive && agentBusy;
          const recentFiles = touchedFilesBySection[id] || [];
          const labelText = isActive
            ? railCollapsed
              ? `Open ${label}`
              : `Collapse ${label}`
            : label;
          const className = [
            isActive ? "is-active" : "",
            isWorking ? "is-working" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={id} className="anvil-workspace-iconrail-group">
              <button
                type="button"
                className={className}
                onClick={() => handleTabClick(id)}
                title={isWorking ? `Anvil is working in ${label}…` : labelText}
                aria-label={labelText}
                aria-current={isActive ? "page" : undefined}
                aria-expanded={isActive ? !railCollapsed : undefined}
                aria-busy={isWorking ? true : undefined}
              >
                <span className="anvil-workspace-iconrail-glyph" aria-hidden>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="is-base" src={icon} alt="" />
                  {iconOpen ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img className="is-open" src={iconOpen} alt="" />
                  ) : null}
                </span>
                <span>{label}</span>
              </button>
              {recentFiles.length ? (
                <div className="anvil-workspace-iconrail-touched" role="status" aria-live="polite">
                  <span className="anvil-workspace-iconrail-touched-label">editing</span>
                  {recentFiles.map((name) => (
                    <span key={name} className="anvil-workspace-iconrail-touched-name" title={name}>
                      {name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
      <Link
        href="/app/account"
        className="anvil-workspace-iconrail-account"
        title={user.email || "Account"}
        aria-label="Account"
      >
        <span className="anvil-workspace-iconrail-avatar" aria-hidden>
          {initial}
        </span>
      </Link>
    </aside>
  );
});
