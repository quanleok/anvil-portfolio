"use client";

import { memo } from "react";

import { ToolCallCard } from "./ToolCallCard";
import type { ChatMessage as ChatMessageData, ChatTokenMeta } from "./types";

// Compact human-readable formatter for token counts: 1500 → "1.5k",
// 850 → "850". Keeps the footer dense without losing precision.
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, "")}k`;
}

// Cost is small per turn (often <$0.01). Show 4 decimal places under
// $0.01, 3 between $0.01–$1, 2 above. "~$0" reads better than
// "~$0.0000" when the turn was effectively free.
function fmtCostUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "~$0";
  if (n < 0.01) return `~$${n.toFixed(4)}`;
  if (n < 1) return `~$${n.toFixed(3)}`;
  return `~$${n.toFixed(2)}`;
}

// Tighten model strings to a readable short form ("claude-3-5-haiku
// -latest" → "haiku-3.5", "claude-opus-4-7" → "opus-4.7", "gpt-4.1
// -mini" → "gpt-4.1-mini"). Falls back to the raw id when no rule
// matches so the user always sees something meaningful.
function fmtModel(model: string | undefined): string | null {
  if (!model) return null;
  const id = model.toLowerCase();
  if (id.startsWith("claude-3-5-haiku")) return "haiku-3.5";
  if (id.startsWith("claude-3-5-sonnet")) return "sonnet-3.5";
  if (id.startsWith("claude-opus-4-7")) return "opus-4.7";
  if (id.startsWith("claude-opus-4")) return "opus-4";
  if (id.startsWith("claude-sonnet-4-6")) return "sonnet-4.6";
  if (id.startsWith("claude-sonnet-4")) return "sonnet-4";
  if (id.startsWith("claude-haiku-4-5")) return "haiku-4.5";
  if (id.startsWith("claude-haiku-4")) return "haiku-4";
  return model;
}

function TokenFooter({ tokens }: { tokens: ChatTokenMeta }) {
  const modelLabel = fmtModel(tokens.model);
  // Plain-English hover so new users can decode "1.5k in · 2.1k out · ~$0.01".
  // Native title attribute matches the rest of the workspace (rail buttons,
  // icon-rail tabs) — no extra state, dismissed by just not hovering.
  const explainer =
    "Tokens this turn consumed (in) and generated (out). Cost is approximate, based on your current Anvil plan.";
  return (
    <div className="anvil-workspace-message-tokens" aria-label="Turn cost" title={explainer}>
      <span>{fmtTokens(tokens.input)} in</span>
      <span aria-hidden> · </span>
      <span>{fmtTokens(tokens.output)} out</span>
      <span aria-hidden> · </span>
      <span>{fmtCostUsd(tokens.costUsd)}</span>
      {modelLabel ? (
        <>
          <span aria-hidden> · </span>
          <span>{modelLabel}</span>
        </>
      ) : null}
    </div>
  );
}

// Visual spec §5: five rendering modes.
//   user        · right-aligned bubble, info bg, max 75% width
//   agent prose · no bubble, full message column, markdown inline
//   tool call   · ToolCallCard (separate component)
//   system      · centered, dashed top/bottom borders, tertiary
//   thinking    · 3 pulsing dots before first token (rendered by
//                 ChatThread.tsx via the agentBusy flag)

export type ChatMessageProps = {
  message: ChatMessageData;
  onOpenPath: (path: string) => void;
};

export const ChatMessage = memo(function ChatMessage({ message, onOpenPath }: ChatMessageProps) {
  if (message.toolCall) {
    return (
      <div className={`anvil-workspace-message is-${message.role}`}>
        <ToolCallCard toolCall={message.toolCall} onOpenPath={onOpenPath} />
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className="anvil-workspace-message is-user">
        <div className="anvil-workspace-message-bubble">{message.content}</div>
      </div>
    );
  }
  if (message.role === "system") {
    return <div className="anvil-workspace-message is-system">{message.content}</div>;
  }
  return (
    <div className="anvil-workspace-message is-agent">
      <div className="anvil-workspace-message-prose">{message.content}</div>
      {message.tokens ? <TokenFooter tokens={message.tokens} /> : null}
    </div>
  );
});
