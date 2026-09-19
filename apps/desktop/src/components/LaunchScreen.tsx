import { AnvilMark } from "./AnvilMark";

interface LaunchScreenProps {
  appVersion: { version: string; build: string; commitCount?: number; appName?: string; variant?: string } | null;
  phase: "visible" | "exiting";
  mode: "boot" | "opening" | "handoff";
}

const COPY: Record<LaunchScreenProps["mode"], { eyebrow: string; subtitle: string; status: string }> = {
  boot: {
    eyebrow: "Booting local studio",
    subtitle: "Loading shell, recents, and editor state.",
    status: "Preparing workspace",
  },
  opening: {
    eyebrow: "Opening saved project",
    subtitle: "Reading project files and rebuilding the workspace.",
    status: "Rehydrating local project",
  },
  handoff: {
    eyebrow: "Workspace ready",
    subtitle: "Handing off from launch into the editor.",
    status: "Entering workspace",
  },
};

export function LaunchScreen({ appVersion, phase, mode }: LaunchScreenProps) {
  const appTitle = appVersion?.appName || "Anvil";
  const copy = COPY[mode];

  return (
    <div
      className={`launch-screen${phase === "exiting" ? " is-exiting" : ""}`}
      aria-hidden="true"
    >
      <div className="launch-screen-backdrop">
        <span className="launch-screen-ambient launch-screen-ambient-top" />
        <span className="launch-screen-ambient launch-screen-ambient-floor" />
        <span className="launch-screen-orb launch-screen-orb-a" />
        <span className="launch-screen-orb launch-screen-orb-b" />
        <span className="launch-screen-grid" />
      </div>
      <div className="launch-screen-stage">
        <div className="launch-screen-emblem">
          <span className="launch-screen-emblem-halo" />
          <AnvilMark size={132} />
        </div>
        <div className="launch-screen-copy">
          <div className="launch-screen-eyebrow">{copy.eyebrow}</div>
          <h1 className="launch-screen-title">{appTitle}</h1>
          <p className="launch-screen-subtitle">{copy.subtitle}</p>
          <div className="launch-screen-progress">
            <span className="launch-screen-progress-bar" />
          </div>
          <div className="launch-screen-footer">
            <span className="launch-screen-status">{copy.status}</span>
            {appVersion?.version ? (
              <span className="launch-screen-version">v{appVersion.version}</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
