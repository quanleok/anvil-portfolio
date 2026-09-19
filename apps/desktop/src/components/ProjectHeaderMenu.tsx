import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AnvilMark } from "./AnvilMark";
import { focusFirstMenuItem, handleMenuNavigation } from "./menu-navigation";
import type { RecentProjectEntry } from "../types";

interface ProjectHeaderMenuProps {
  appVersion: { version: string; build: string; commitCount?: number; appName?: string; variant?: string } | null;
  busy: "open" | "open-pick" | "create" | "create-pick" | string | null;
  children: ReactNode;
  inFlight: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onCreateProject: () => void;
  onOpenProject: () => void | Promise<void>;
  onRecentProjectOpen: (projectDir: string) => void | Promise<void>;
  onRevealCurrentProjectFolder: () => void | Promise<void>;
  onSettingsOpen: () => void;
  /** Kept for compatibility with the parent's wiring while the Anvil Skills
   *  menu item is hidden — re-add the menu entry to surface it again. */
  onSkillLibraryOpen?: () => void;
  open: boolean;
  recentProjects: RecentProjectEntry[];
  setOpen: (next: boolean | ((current: boolean) => boolean)) => void;
}

export function ProjectHeaderMenu({
  appVersion,
  busy,
  children,
  inFlight,
  menuRef,
  onCreateProject,
  onOpenProject,
  onRecentProjectOpen,
  onRevealCurrentProjectFolder,
  onSettingsOpen,
  onSkillLibraryOpen: _onSkillLibraryOpen,
  open,
  recentProjects,
  setOpen,
}: ProjectHeaderMenuProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const projectMenuBusy =
    busy === "open" || busy === "open-pick" || busy === "create" || busy === "create-pick";

  useEffect(() => {
    if (open) focusFirstMenuItem(popoverRef.current);
  }, [open]);

  const closeAnd = (action: () => void | Promise<void>) => {
    setOpen(false);
    void action();
  };

  return (
    <div className="header-menu project-header-menu" ref={menuRef}>
      <button
        className={`desktop-header-mark project-menu-trigger icon-hover-tooltip tooltip-bottom${inFlight ? " working" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
        data-tooltip="Project menu"
        aria-label="Project menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Project menu"
      >
        <AnvilMark size={48} variant={inFlight ? "idle" : "static"} />
      </button>
      <button
        className="desktop-header-text project-title-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
        aria-label="Open project menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Open project menu"
      >
        {children}
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="header-menu-popover project-header-menu-popover"
          role="menu"
          aria-label="Project menu"
          onKeyDown={handleMenuNavigation}
        >
          <div className="header-menu-section-label" role="presentation">Current project</div>
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            onClick={() => closeAnd(onRevealCurrentProjectFolder)}
          >
            <span className="header-menu-item-label">Reveal in Finder</span>
          </button>
          {recentProjects.length > 0 ? (
            <>
              <div className="header-menu-divider" role="presentation" />
              <div className="header-menu-section-label" role="presentation">Recent</div>
              {recentProjects.map((recent) => (
                <button
                  key={recent.projectDir}
                  className="header-menu-item"
                  type="button"
                  role="menuitem"
                  disabled={projectMenuBusy}
                  onClick={() => closeAnd(() => onRecentProjectOpen(recent.projectDir))}
                  title={recent.projectDir}
                >
                  <span className="header-menu-item-label">{recent.projectName}</span>
                  <span className="header-menu-item-meta">{recent.projectDir}</span>
                </button>
              ))}
            </>
          ) : null}
          <div className="header-menu-divider" role="presentation" />
          <div className="header-menu-section-label" role="presentation">Workspace</div>
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            disabled={projectMenuBusy}
            onClick={() => closeAnd(onOpenProject)}
          >
            <span className="header-menu-item-label">
              {busy === "open" ? "Opening…" : busy === "open-pick" ? "Choose Project…" : "Open Project…"}
            </span>
          </button>
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            disabled={projectMenuBusy}
            onClick={() => closeAnd(onCreateProject)}
          >
            <span className="header-menu-item-label">
              {busy === "create" ? "Creating…" : busy === "create-pick" ? "Choose Folder…" : "New Project…"}
            </span>
          </button>
          <div className="header-menu-divider" role="presentation" />
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            onClick={() => closeAnd(onSettingsOpen)}
          >
            <span className="header-menu-item-label">Settings</span>
          </button>
          {appVersion ? (
            <>
              <div className="header-menu-divider" role="presentation" />
              <div className="header-menu-section-label" role="presentation">App</div>
              <div className="header-menu-version" role="presentation">
                <span>Anvil v{appVersion.version}</span>
                {appVersion.variant ? <span>{appVersion.variant}</span> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
