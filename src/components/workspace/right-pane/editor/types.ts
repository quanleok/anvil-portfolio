// Types + pure helpers for the internal file revision store.
// Kept here so the monolith doesn't have to re-host editor-specific
// utilities after Commit 1 of the three-column layout pivot.

export type FileRevision = {
  id: string;
  ownerId: string;
  projectId: string;
  path: string;
  title: string;
  kind: string;
  operation: "create" | "update" | "append" | "delete" | "action" | "import" | "system";
  content: string;
  previousContent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RevisionCompare = {
  same: number;
  changed: number;
  added: number;
  removed: number;
  currentLines: number;
  revisionLines: number;
};

export function revisionLabel(revision: FileRevision) {
  const time = Date.parse(revision.createdAt);
  const when = Number.isFinite(time)
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(time)
    : "Saved";
  return `${revision.operation} · ${when}`;
}

export function compareRevisionText(current: string, revision: string): RevisionCompare {
  const currentLines = current ? current.split(/\r?\n/) : [];
  const revisionLines = revision ? revision.split(/\r?\n/) : [];
  const maxLines = Math.max(currentLines.length, revisionLines.length);
  let same = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;

  for (let index = 0; index < maxLines; index += 1) {
    const currentLine = currentLines[index];
    const revisionLine = revisionLines[index];
    if (currentLine === undefined) {
      added += 1;
    } else if (revisionLine === undefined) {
      removed += 1;
    } else if (currentLine === revisionLine) {
      same += 1;
    } else {
      changed += 1;
    }
  }

  return {
    same,
    changed,
    added,
    removed,
    currentLines: currentLines.length,
    revisionLines: revisionLines.length,
  };
}
