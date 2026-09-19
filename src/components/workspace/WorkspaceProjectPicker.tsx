"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { ProjectPickerItem } from "@/server/projects/list";

const VIEW_STORAGE = "anvil-picker-view-v1";

type ViewMode = "grid" | "list";

function projectInitial(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "·";
  const codePoint = trimmed.codePointAt(0);
  return codePoint ? String.fromCodePoint(codePoint).toUpperCase() : "·";
}

function relativeTime(iso: string) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) {
    const minutes = Math.round(diff / 60_000);
    return `${minutes} min ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.round(diff / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (diff < 7 * 86_400_000) {
    const days = Math.round(diff / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  const date = new Date(then);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function readStoredView(): ViewMode {
  if (typeof window === "undefined") return "grid";
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE);
    return raw === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function WorkspaceProjectPicker({
  projects,
}: {
  projects: ProjectPickerItem[];
}) {
  const router = useRouter();
  const [view, setView] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(readStoredView());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_STORAGE, view);
    } catch {
      // not load-bearing
    }
  }, [view]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((p) => p.title.toLowerCase().includes(needle));
  }, [projects, query]);

  async function createProject(name = "Untitled project") {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Could not create project (HTTP ${response.status}).`);
      }
      const payload = await response.json();
      const projectId =
        typeof payload?.project?.id === "string"
          ? payload.project.id
          : typeof payload?.id === "string"
            ? payload.id
            : "";
      if (!projectId) throw new Error("Created project did not include an id.");
      router.push(`/app/project/${projectId}`);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Could not create project.";
      setError(message);
      setCreating(false);
    }
  }

  if (projects.length === 0) {
    const templates = [
      { id: "ad", label: "Ad / promo", hint: "30-second cinematic spot" },
      { id: "short", label: "Short film", hint: "2–5 minute narrative" },
      { id: "mv", label: "Music video", hint: "Song-driven beats" },
      { id: "blank", label: "Blank", hint: "Start from scratch" },
    ];
    return (
      <div className="workspace-projects-page">
        <div className="workspace-projects-empty">
          <h2>What kind of project?</h2>
          <p>Pick a starter — it just names the project, you can rename anytime.</p>
          {error ? <p className="workspace-projects-error">{error}</p> : null}
          <div className="workspace-projects-templates">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="workspace-projects-template"
                onClick={() => createProject(template.label)}
                disabled={creating}
              >
                <span className="workspace-projects-template-label">{template.label}</span>
                <span className="workspace-projects-template-hint">{template.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-projects-page">
      <header className="workspace-projects-header">
        <h1 className="workspace-projects-title">Your projects</h1>
        <input
          type="search"
          className="workspace-projects-search"
          placeholder="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter projects"
        />
        <div className="workspace-projects-view-toggle" role="tablist" aria-label="View mode">
          <button
            type="button"
            role="tab"
            aria-selected={view === "grid"}
            className={view === "grid" ? "is-active" : undefined}
            onClick={() => setView("grid")}
            title="Grid view"
          >
            Grid
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "list"}
            className={view === "list" ? "is-active" : undefined}
            onClick={() => setView("list")}
            title="List view"
          >
            List
          </button>
        </div>
      </header>

      {error ? <p className="workspace-projects-error">{error}</p> : null}

      {view === "grid" ? (
        <div className="workspace-projects-grid">
          {filtered.map((project) => (
            <button
              key={project.id}
              type="button"
              className="workspace-projects-card"
              onClick={() => router.push(`/app/project/${project.id}`)}
            >
              <div className="workspace-projects-card-thumb" aria-hidden>
                {project.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={project.thumbnailUrl} alt="" />
                ) : (
                  projectInitial(project.title)
                )}
              </div>
              <p className="workspace-projects-card-title">{project.title || "Untitled project"}</p>
              <p className="workspace-projects-card-date">
                Edited {relativeTime(project.lastUpdatedAt)}
              </p>
            </button>
          ))}
          <button
            type="button"
            className="workspace-projects-card workspace-projects-card-new"
            onClick={() => createProject()}
            disabled={creating}
          >
            <span className="plus" aria-hidden>+</span>
            <span>{creating ? "Creating…" : "New project"}</span>
          </button>
        </div>
      ) : (
        <div className="workspace-projects-list">
          {filtered.map((project) => (
            <button
              key={project.id}
              type="button"
              className="workspace-projects-row"
              onClick={() => router.push(`/app/project/${project.id}`)}
            >
              <div className="workspace-projects-row-thumb" aria-hidden>
                {project.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={project.thumbnailUrl} alt="" />
                ) : (
                  projectInitial(project.title)
                )}
              </div>
              <p className="workspace-projects-row-title">{project.title || "Untitled project"}</p>
              <p className="workspace-projects-row-date">
                {relativeTime(project.lastUpdatedAt)}
              </p>
            </button>
          ))}
          <button
            type="button"
            className="workspace-projects-row workspace-projects-row-new"
            onClick={() => createProject()}
            disabled={creating}
          >
            <span className="workspace-projects-row-thumb plus" aria-hidden>+</span>
            <span>{creating ? "Creating…" : "New project"}</span>
          </button>
        </div>
      )}

      {filtered.length === 0 && projects.length > 0 ? (
        <p className="workspace-projects-no-match">No projects match “{query}”.</p>
      ) : null}
    </div>
  );
}
