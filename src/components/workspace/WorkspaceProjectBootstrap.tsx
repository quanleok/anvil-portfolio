"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type ProjectSummary = {
  id: string;
  updatedAt?: string;
  createdAt?: string;
};

function newestProject(projects: ProjectSummary[]) {
  return [...projects].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
    const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  })[0];
}

export function WorkspaceProjectBootstrap() {
  const router = useRouter();
  const [message, setMessage] = useState("Opening workspace...");

  useEffect(() => {
    const controller = new AbortController();

    async function openProject() {
      try {
        const listResponse = await fetch("/api/projects", {
          cache: "no-store",
          signal: controller.signal,
        });
        const listData = await listResponse.json().catch(() => ({}));
        if (!listResponse.ok) {
          setMessage(listData?.message || "Could not load projects.");
          return;
        }

        const existing = Array.isArray(listData.projects) ? newestProject(listData.projects) : null;
        if (existing?.id) {
          router.replace(`/app/project/${encodeURIComponent(existing.id)}`);
          return;
        }

        setMessage("Creating workspace...");
        const createResponse = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Untitled" }),
          signal: controller.signal,
        });
        const createData = await createResponse.json().catch(() => ({}));
        if (!createResponse.ok || !createData?.project?.id) {
          setMessage(createData?.message || "Could not create a project.");
          return;
        }

        router.replace(`/app/project/${encodeURIComponent(createData.project.id)}`);
      } catch (error) {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : "Could not open workspace.");
      }
    }

    void openProject();
    return () => controller.abort();
  }, [router]);

  return (
    <main className="workspace-account-shell">
      <section className="workspace-account-panel workspace-project-bootstrap" aria-live="polite">
        <div className="workspace-project-bootstrap-mark" aria-hidden />
        <h1>Anvil</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}
