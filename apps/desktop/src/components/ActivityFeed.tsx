import { useEffect, useId, useState } from "react";

import type { AgentActivityItem } from "../types";

// Tools that take long enough to warrant a distinct card style + a
// "typical" duration hint. Generation-job tools were removed 2026-04-18.
const JOB_TOOL_NAMES = new Set([
  "update_magic_doc",
]);

const TYPICAL_JOB_SECONDS: Record<string, number> = {
  update_magic_doc: 45,
};

export function ActivityFeed({
  items,
  pending,
}: {
  items: AgentActivityItem[];
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const panelId = useId();

  const total = items.length;
  let inFlight = 0;
  let failed = 0;
  for (const item of items) {
    if (!item.result) {
      inFlight += 1;
    } else if (!item.result.ok) {
      failed += 1;
    }
  }
  const status = inFlight > 0 ? "running" : failed > 0 ? "errors" : "ok";
  const summary = inFlight > 0
    ? `${inFlight} of ${total} step${total === 1 ? "" : "s"} running…`
    : failed > 0
      ? `${total} step${total === 1 ? "" : "s"} · ${failed} failed`
      : `${total} step${total === 1 ? "" : "s"} complete`;

  useEffect(() => {
    if (inFlight === 0) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [inFlight]);

  return (
    <div className={`chat-activity-feed ${status}${open ? " open" : ""}${pending ? " pending" : ""}`}>
      <button
        type="button"
        className="chat-activity-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={items.length ? panelId : undefined}
        aria-label={`${summary}. ${open ? "Hide activity details" : "Show activity details"}`}
      >
        <span className="chat-activity-dot" aria-hidden />
        <span className="chat-activity-summary">{summary}</span>
        <span className="chat-activity-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {items.length ? (
        <div id={panelId} className="chat-activity-cards" hidden={!open} aria-hidden={!open}>
          {items.map((item) => (
            <ActivityCard
              key={item.call.id}
              item={item}
              now={now}
              startedAt={item.startedAt || now}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Per-errorType hint shown under the failure message. Free-form text
// (no buttons / callbacks here — keeps ActivityFeed prop-stable). The
// user reads the hint and goes to the relevant surface themselves.
const ERROR_HINTS: Record<string, string> = {
  auth: "Check Settings → API Keys.",
  quota: "Out of credits — top up or reduce request size.",
  "rate-limit": "Too many requests. Try again in a moment.",
  timeout: "Provider timed out. Try again.",
  network: "Network unreachable. Check your connection and retry.",
  server: "Provider returned an error. Try again or report it.",
  payload: "The request was rejected. Check the prompt or settings.",
};

function truncateErr(message: string, max = 240): string {
  const trimmed = message.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function ActivityCard({
  item,
  now,
  startedAt,
}: {
  item: AgentActivityItem;
  now: number;
  startedAt: number;
}) {
  const isErr = item.result ? !item.result.ok : false;
  const status = item.result ? (item.result.ok ? "ok" : "err") : "pending";
  const errorType = isErr ? (item.result?.errorType || "unknown") : "";
  const errorMessage = isErr ? (item.result?.error || "failed").trim() : "";
  const summary = item.result?.ok
    ? summarizeToolResult(item.call.name, item.result.result)
    : isErr
      ? "failed"
      : "running…";
  const hint = isErr ? ERROR_HINTS[errorType] : null;
  const isJob = JOB_TOOL_NAMES.has(item.call.name);
  const typicalSec = TYPICAL_JOB_SECONDS[item.call.name] || 0;
  const hasTiming = Number.isFinite(startedAt) && startedAt > 0;
  const elapsed = hasTiming ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;

  const showElapsed = hasTiming && (isJob || elapsed >= 3);
  const showTypical = isJob && typicalSec > 0 && !item.result;
  const progressPct = showTypical
    ? Math.min(100, Math.round((elapsed / typicalSec) * 100))
    : 0;
  // Past 1.5× typical we flip the bar to an amber striped pattern so the user
  // can tell "longer than usual" from "still ramping toward typical."
  const isOverrun = showTypical && elapsed > typicalSec * 1.5;

  const cardClass = [
    "activity-card",
    status,
    isJob ? "is-job" : "",
    isErr && errorType ? `err-${errorType}` : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cardClass}>
      <div className="activity-card-head">
        <span className="activity-tool">{toolLabel(item.call.name)}</span>
        <span className="activity-summary">{summary}</span>
        {showElapsed ? (
          <span className="activity-elapsed" title={showTypical ? `typical ${formatElapsed(typicalSec)}` : undefined}>
            {formatElapsed(elapsed)}
            {showTypical ? <span className="activity-typical"> / {formatElapsed(typicalSec)}</span> : null}
          </span>
        ) : null}
      </div>
      {isErr && errorMessage ? (
        <div className="activity-card-error" title={errorMessage}>
          {truncateErr(errorMessage)}
        </div>
      ) : null}
      {hint ? <div className="activity-card-hint">{hint}</div> : null}
      {showTypical ? (
        <div
          className={`activity-progress${isOverrun ? " overrun" : ""}`}
          aria-label={
            isOverrun
              ? `${formatElapsed(elapsed)} elapsed — past typical ${formatElapsed(typicalSec)}`
              : `${progressPct}% of typical duration`
          }
        >
          <div className="activity-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function toolLabel(name: string): string {
  if (name.startsWith("generate_")) return "Generate media";
  if (name.includes("magic_doc") || name === "update_context") return "Update context";
  if (name.includes("pinboard") || name.includes("memory")) return "Update memory";
  if (name.includes("asset") || name.includes("media") || name.includes("library")) return "Update assets";
  if (name.includes("script") || name.includes("scene") || name.includes("shot") || name.includes("prompt") || name.includes("dialogue")) {
    return "Update script";
  }
  if (name.includes("read") || name.includes("list") || name.includes("search") || name.includes("inspect")) {
    return "Read project";
  }
  if (name.includes("write") || name.includes("edit") || name.includes("rename") || name.includes("delete")) {
    return "Apply edits";
  }
  return "Work step";
}

function summarizeToolResult(name: string, result: unknown): string {
  if (!result || typeof result !== "object") return "ok";
  const r = result as Record<string, unknown>;
  if (typeof r.summary === "string" && r.summary.trim()) return r.summary.trim();
  if (name === "read_file") return `${r.size ?? 0} chars`;
  if (name === "read_many_files") {
    return `${typeof r.files === "number" ? r.files : (r.files as unknown[])?.length ?? 0} files`;
  }
  if (name === "write_file") return `${r.bytesWritten ?? 0} bytes`;
  if (name === "edit_file") return `${r.replacements ?? 0} replaced`;
  if (name === "list_dir") {
    return `${typeof r.entries === "number" ? r.entries : (r.entries as unknown[])?.length ?? 0} entries`;
  }
  if (name === "get_project_index") {
    const counts = (r.counts as { scenes?: number } | undefined) ?? {};
    return `${counts.scenes ?? 0} scenes`;
  }
  if (name === "list_assets") {
    if (typeof r.totalAssets === "number") return `${r.totalAssets} assets`;
    const total = Object.values(r)
      .filter((value) => Array.isArray(value))
      .reduce((sum, value) => sum + value.length, 0);
    return `${total} assets`;
  }
  if (name === "normalize_asset_media_names") return `${r.count ?? 0} renamed`;
  if (name === "search") {
    return `${typeof r.matches === "number" ? r.matches : (r.matches as unknown[])?.length ?? 0} matches`;
  }
  return "ok";
}
