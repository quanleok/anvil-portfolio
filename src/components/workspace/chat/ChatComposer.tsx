"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { PlusIcon } from "../lib/icons";
import { useAgentComposer, useWorkspace } from "../WorkspaceProvider";

// Modern browsers can auto-grow textareas natively via `field-sizing:
// content` (Chromium 123+, Safari 17.4+, Firefox in progress). When
// supported, the CSS in three-column.css handles it and we skip the
// useLayoutEffect measurement that fires on every keystroke. The
// fallback path stays for older browsers. Improvement-plan §1.4.
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("field-sizing", "content")
    : false;

// Composer: textarea + Send + attach. Enter submits, Shift+Enter
// inserts a newline (preserves IME composition via `isComposing`).
// Attach opens a file picker; selected files go through onAttach
// (wired to project media upload upstream). A small ephemeral status
// pill above the row confirms an upload happened.
//
// Drag-and-drop lives at the agent column (AgentChat.tsx) since
// improvement-plan 4.7 — the entire column is the drop target, with
// a column-wide overlay. The composer just renders the form; drops
// inside the form bubble to the aside's handlers.

const ATTACH_TOAST_MS = 2500;

export function ChatComposer() {
  const { agentInput, setAgentInput, sendAgentTurn, agentBusy } = useAgentComposer();
  const { mediaBusy, mediaProgress, uploadMedia } = useWorkspace();
  const formRef = useRef<HTMLFormElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [attachToast, setAttachToast] = useState<string | null>(null);
  // While the upload is in flight (mediaBusy && mediaProgress != null),
  // override the static "Attaching N files…" text with a live
  // percentage. Improvement-plan 4.6.
  const liveAttachToast =
    mediaBusy && attachToast?.startsWith("Attaching") && mediaProgress !== null
      ? `Attaching… ${Math.round(mediaProgress * 100)}%`
      : attachToast;

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Auto-grow textarea: fallback for browsers without `field-sizing:
  // content`. The supported path skips this entire effect — CSS does
  // the work natively. Modern Chrome/Safari avoid two layout reads
  // per keystroke this way.
  useLayoutEffect(() => {
    if (SUPPORTS_FIELD_SIZING) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [agentInput]);

  function scheduleToastDismiss() {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setAttachToast(null), ATTACH_TOAST_MS);
  }

  async function attachFiles(files: File[] | FileList | null | undefined) {
    if (!files || files.length === 0) return;
    const count = files.length;
    const suffix = count > 1 ? "s" : "";
    setAttachToast(`Attaching ${count} file${suffix}…`);
    try {
      let failed = 0;
      for (const file of Array.from(files)) {
        const uploaded = await uploadMedia(file);
        if (!uploaded) failed += 1;
      }
      if (failed > 0) throw new Error(`${failed} upload${failed === 1 ? "" : "s"} failed.`);
      setAttachToast(`Attached ${count} file${suffix} to project`);
    } catch {
      setAttachToast("Attach failed");
    } finally {
      scheduleToastDismiss();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (agentBusy || !agentInput.trim()) return;
      formRef.current?.requestSubmit();
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files ? Array.from(event.target.files) : [];
    if (fileRef.current) fileRef.current.value = "";
    void attachFiles(picked);
  }

  return (
    <form
      ref={formRef}
      onSubmit={sendAgentTurn}
      className="anvil-workspace-composer"
    >
      {liveAttachToast ? (
        <div className="anvil-workspace-composer-toast" role="status" aria-live="polite">
          {liveAttachToast}
        </div>
      ) : null}
      <button
        type="button"
        className="anvil-workspace-composer-attach"
        onClick={() => fileRef.current?.click()}
        disabled={mediaBusy}
        title="Attach files to project"
        aria-label="Attach files to project"
      >
        <PlusIcon />
      </button>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        onChange={handleFileChange}
        style={{ display: "none" }}
        tabIndex={-1}
      />
      <textarea
        ref={textareaRef}
        value={agentInput}
        onChange={(event) => setAgentInput(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={agentBusy ? "Anvil is working — pre-type your follow-up…" : "Ask Anvil…"}
        rows={1}
      />
      <button type="submit" disabled={agentBusy || !agentInput.trim()}>
        Send
      </button>
    </form>
  );
}
