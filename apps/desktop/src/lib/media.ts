import type { AssetMediaEntry } from "./sections";

export function firstRenderableAssetMedia(
  mediaItems: AssetMediaEntry[],
  brokenMediaIds: Record<string, boolean> = {},
) {
  return (
    mediaItems.find((media) => media.kind === "image" && media.fileUrl && !brokenMediaIds[media.id]) ||
    mediaItems.find((media) => media.fileUrl && !brokenMediaIds[media.id]) ||
    mediaItems.find((media) => media.kind === "image" && media.fileUrl) ||
    mediaItems.find((media) => media.fileUrl) ||
    mediaItems.find((media) => media.kind === "image") ||
    mediaItems[0] ||
    null
  );
}

export function mediaSrc(media: AssetMediaEntry | null, cacheKey: string) {
  if (!media?.fileUrl) return "";
  const separator = media.fileUrl.includes("?") ? "&" : "?";
  return `${media.fileUrl}${separator}v=${encodeURIComponent(cacheKey || "0")}`;
}

// Build an `anvil-asset://local/…` URL for a media-index record given
// its relative project path. Mirrors the main-process `assetUrlFor`
// helper: splits the absolute path on `/` and URI-encodes each
// segment so spaces / special characters (e.g. a project folder
// called "shortfilm project") don't silently break the protocol
// handler. The previous inline `anvil-asset://${dir}/${path}`
// pattern worked for simple paths but failed reliably on any path
// with a space — URL parsers are lenient about *some* chars but
// not whitespace.
export function indexMediaSrc(projectDir: string | null | undefined, relativePath: string, cacheKey?: string) {
  if (!projectDir || !relativePath) return "";
  const normalizedDir = String(projectDir).replace(/\\/g, "/");
  const withLeadingSlash = normalizedDir.startsWith("/") ? normalizedDir : `/${normalizedDir}`;
  const normalizedRel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = `${withLeadingSlash}/${normalizedRel}`;
  const url = `anvil-asset://local${fullPath.split("/").map(encodeURIComponent).join("/")}`;
  if (!cacheKey) return url;
  return `${url}?v=${encodeURIComponent(cacheKey)}`;
}

export async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
