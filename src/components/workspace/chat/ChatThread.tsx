"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../WorkspaceProvider";
import { ChatMessage } from "./ChatMessage";
import type { ChatMessage as ChatMessageData } from "./types";

// Thread per visual spec §5. Plain mapping for now — drop in a
// virtualizer later if throughput becomes an issue. The "thinking"
// indicator (three pulsing dots) renders while a turn is in flight,
// before the first agent token streams back. The dots line names
// the section + file the agent is most likely focused on (the
// user's current selection), so the user can see both *where* the
// work is happening and *that* it's happening.
//
// Auto-scroll-on-new (improvement-plan §1.8): only follow to the
// bottom when the user is *already* near the bottom. If they've
// scrolled up to read history, surface a sticky "↓ N new" pill so
// new messages aren't lost. Click the pill to catch up.

export type ChatThreadProps = {
  messages: ChatMessageData[];
  agentBusy: boolean;
  onOpenPath: (path: string) => void;
};

const STICK_TO_BOTTOM_THRESHOLD_PX = 48;

function sectionLabel(section: string) {
  if (section === "story") return "Context";
  if (section === "script") return "Script";
  if (section === "assets") return "Assets";
  if (section === "workshop") return "Workshop";
  return "workspace";
}

export const ChatThread = memo(function ChatThread({ messages, agentBusy, onOpenPath }: ChatThreadProps) {
  const { activeSection, selectedPath, selectedFile, selectedMedia } = useWorkspace();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // wasAtBottom: latest scroll-position read. Starts true so the very
  // first messages effect scrolls to bottom on mount.
  const wasAtBottomRef = useRef(true);
  // Track message count delta so the pill counts only the messages
  // that arrived since the user scrolled up.
  const prevMessageCountRef = useRef(messages.length);
  const [newCount, setNewCount] = useState(0);

  // Track elapsed seconds while the agent is mid-turn so the user
  // sees concrete progress instead of just three pulsing dots.
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!agentBusy) return;
    const start = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => {
      window.clearInterval(interval);
      setElapsedSec(0);
    };
  }, [agentBusy]);

  // Subscribe to the container's scroll position. Passive listener;
  // ref-based so it doesn't trigger renders on every scroll tick.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - STICK_TO_BOTTOM_THRESHOLD_PX;
      wasAtBottomRef.current = atBottom;
      if (atBottom) setNewCount(0);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // On message-list growth: if the user is already at the bottom,
  // follow. Otherwise bump the new-count pill.
  useEffect(() => {
    const delta = messages.length - prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (delta <= 0) return;
    if (wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      setNewCount((current) => current + delta);
    }
  }, [messages.length]);

  // Thinking-dots toggle also follows the same rule — scroll only
  // if the user hasn't moved up to read.
  useEffect(() => {
    if (!agentBusy) return;
    if (wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [agentBusy]);

  function jumpToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    setNewCount(0);
  }

  const workingTarget = (() => {
    if (activeSection === "assets" || activeSection === "workshop") {
      return selectedMedia?.fileName || null;
    }
    if (selectedFile?.title) return selectedFile.title;
    if (selectedPath) {
      const base = selectedPath.split("/").pop();
      return base || selectedPath;
    }
    return null;
  })();

  return (
    <div className="anvil-workspace-messages" ref={containerRef}>
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} onOpenPath={onOpenPath} />
      ))}
      {agentBusy ? (
        <div className="anvil-workspace-thinking" aria-live="polite">
          <span className="anvil-workspace-thinking-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span>
            Working in <strong>{sectionLabel(activeSection)}</strong>
            {workingTarget ? (
              <>
                {" · "}
                <code>{workingTarget}</code>
              </>
            ) : null}
            …
            {elapsedSec > 0 ? (
              <span className="anvil-workspace-thinking-elapsed">{elapsedSec}s</span>
            ) : null}
          </span>
        </div>
      ) : null}
      {newCount > 0 ? (
        <button
          type="button"
          className="anvil-workspace-thread-newpill"
          onClick={jumpToBottom}
          aria-label={`Scroll to ${newCount} new message${newCount === 1 ? "" : "s"}`}
          title="Click to catch up"
        >
          ↓ {newCount} new
        </button>
      ) : null}
      <div ref={bottomRef} aria-hidden />
    </div>
  );
});
