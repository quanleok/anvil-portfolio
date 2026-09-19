import { AnvilMark } from "./AnvilMark";
import { Field } from "./Field";
import { Modal } from "./Modal";
import type { RecentProjectEntry } from "../types";

interface WelcomeScreenProps {
  appVersion: { version: string; build: string; commitCount?: number; appName?: string; variant?: string } | null;
  busy: string | null;
  error: string | null;
  recentProjects: RecentProjectEntry[];
  showCreateProjectModal: boolean;
  projectNameDraft: string;
  onOpenProject: () => void;
  onOpenRecentProject: (projectDir: string) => void;
  onOpenCreateModal: () => void;
  onCancelCreateModal: () => void;
  onSubmitCreateModal: () => void;
  onProjectNameChange: (value: string) => void;
}

export function WelcomeScreen({
  appVersion,
  busy,
  error,
  recentProjects,
  showCreateProjectModal,
  projectNameDraft,
  onOpenProject,
  onOpenRecentProject,
  onOpenCreateModal,
  onCancelCreateModal,
  onSubmitCreateModal,
  onProjectNameChange,
}: WelcomeScreenProps) {
  const appTitle = appVersion?.appName || "Anvil";
  const openBusy = busy === "open" || busy === "open-pick";
  const createBusy = busy === "create" || busy === "create-pick";
  const openLabel = busy === "open" ? "Opening…" : busy === "open-pick" ? "Choose project…" : "Open project";
  const createLabel = busy === "create" ? "Creating…" : busy === "create-pick" ? "Choose folder…" : "Continue";
  return (
    <div className="desktop-shell welcome-mode">
      <div className="welcome-backdrop" aria-hidden>
        <span className="welcome-ambient welcome-ambient-top" />
        <span className="welcome-ambient welcome-ambient-floor" />
        <span className="welcome-orb welcome-orb-a" />
        <span className="welcome-orb welcome-orb-b" />
        <span className="welcome-grid" />
      </div>
      {appVersion ? (
        <div className="welcome-version" title="Version">
          {appVersion.variant ? <span className="welcome-version-build welcome-version-variant">{appVersion.variant}</span> : null}
          <span className="welcome-version-num">v{appVersion.version}</span>
          {appVersion.build ? <span className="welcome-version-build">{appVersion.build}</span> : null}
          {appVersion.commitCount ? <span className="welcome-version-build">#{appVersion.commitCount}</span> : null}
        </div>
      ) : null}
      <div className="welcome-hero">
        <p className="welcome-kicker">Local cinematic workspace</p>
        <div className="welcome-mark">
          <span className="welcome-mark-halo" aria-hidden />
          <AnvilMark size={212} />
        </div>
        <h1 className="welcome-title">{appTitle}</h1>
        <p className="welcome-subtitle">
          Scripts, prompts, and references on your machine.
        </p>
        <div className="welcome-actions">
          <button className="primary-btn welcome-btn" onClick={onOpenCreateModal} disabled={openBusy || createBusy}>
            Create project
          </button>
          <button className="ghost-btn welcome-btn" onClick={onOpenProject} disabled={openBusy || createBusy}>
            {openLabel}
          </button>
        </div>
        <div className="welcome-signal-row" aria-hidden>
          <span className="welcome-signal-text">Local files · Fast restore · Script + assets</span>
        </div>
        {error ? <div className="welcome-error" aria-live="polite">{error}</div> : null}
        <section className="welcome-recents" aria-label="Recent projects">
          <div className="welcome-recents-head">
            <span className="welcome-recents-kicker">Recent projects</span>
            <span className="welcome-recents-note">
              {recentProjects.length ? "Jump back in quickly" : "Create one or open one from disk"}
            </span>
          </div>
          {recentProjects.length > 0 ? (
            <div className="welcome-recents-list">
              {recentProjects.map((recent) => (
                <button
                  key={recent.projectDir}
                  className="welcome-recent-card"
                  type="button"
                  onClick={() => onOpenRecentProject(recent.projectDir)}
                  disabled={openBusy || createBusy}
                  title={recent.projectDir}
                >
                  <span className="welcome-recent-name">{recent.projectName}</span>
                  <span className="welcome-recent-path">{recent.projectDir}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="welcome-recents-empty">No recent projects yet.</div>
          )}
        </section>
      </div>
      {showCreateProjectModal ? (
        <Modal
          title="Create local project"
          description="Name the project, then choose a folder."
          onCancel={onCancelCreateModal}
          onSubmit={onSubmitCreateModal}
          submitLabel={createLabel}
        >
          <Field label="Project name" value={projectNameDraft} onChange={onProjectNameChange} />
        </Modal>
      ) : null}
    </div>
  );
}
