import type { ChatAttachment } from "../types";

interface AttachmentChipProps {
  attachment: ChatAttachment;
  onRemove?: (attachmentId: string) => void;
}

export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const sizeLabel = formatBytes(attachment.size);

  return (
    <div className="chat-attachment-chip">
      {attachment.kind === "image" ? (
        <img className="chat-attachment-thumb" src={attachment.fileUrl} alt={attachment.label} />
      ) : (
        <div className="chat-attachment-kind">{attachmentKindLabel(attachment.kind)}</div>
      )}
      <div className="chat-attachment-copy">
        <div className="chat-attachment-label">{attachment.label}</div>
        <div className="chat-attachment-meta">
          {attachmentKindLabel(attachment.kind)}
          {sizeLabel ? ` · ${sizeLabel}` : ""}
        </div>
      </div>
      {onRemove ? (
        <button
          className="chat-attachment-remove"
          onClick={() => onRemove(attachment.id)}
          type="button"
          aria-label={`Remove ${attachment.label}`}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function attachmentKindLabel(kind: ChatAttachment["kind"]) {
  switch (kind) {
    case "image":
      return "Image";
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    case "document":
      return "Doc";
    default:
      return "File";
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
