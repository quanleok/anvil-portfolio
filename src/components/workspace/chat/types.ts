// Types shared across the chat module. Extracted from the
// BrowserProjectWorkspace monolith as part of Commit 2 of the
// three-column layout pivot.

export type ChatRole = "user" | "agent" | "system";

/** Agent file-write summary, lifted out of the system-message
 *  rendering path into a first-class inline card. When present on a
 *  message, the renderer shows ToolCallCard instead of plain text.
 *  Visual spec §4 names three variants — create / edit / running. */
export type ChatToolCallKind = "create" | "edit" | "running";

export type ChatToolCall = {
  appliedCount: number;
  paths: string[];
  kind?: ChatToolCallKind;
  /** Optional per-path stats. Currently surfaced only as a count
   *  ("42 lines · just now" for create, "+8 −3 · just now" for
   *  edit). When omitted the card just shows the path. */
  stats?: string;
  /** For the "running" variant: "2 of 3" progress label. */
  progress?: string;
};

/** Per-turn token / cost stamp. Server route attaches this to the
 *  assistant message when the upstream provider returns usage. The
 *  renderer shows it as a small mono footer ("1.2k in · 340 out ·
 *  ~$0.001 · haiku") under the agent's reply so the user has direct
 *  feedback on spend per turn. */
export type ChatTokenMeta = {
  input: number;
  output: number;
  costUsd: number;
  model?: string;
  provider?: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  toolCall?: ChatToolCall;
  tokens?: ChatTokenMeta;
};

/** Shape returned by `/api/projects/[id]/agent/thread`. The monolith
 *  normalizes these into ChatMessage on read. */
export type StoredAgentMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
};
