import { PATH_COLLATOR } from "../constants";
import type { CloudFile } from "../types";

// Ordering rule lifted out of BrowserProjectWorkspace.tsx as part of
// commit 4. Files under scenes/, shots/, prompts/ use leading-digit
// prefixes (`02-storm.md` → 2). When two files lack a numeric
// prefix, fall back to the path collator so the order is at least
// stable.

const orderCache = new WeakMap<CloudFile, {
  path: string;
  title: string;
  content: string;
  order: number | null;
}>();

export function numberedCreativeOrder(file: CloudFile): number | null {
  const cached = orderCache.get(file);
  if (
    cached &&
    cached.path === file.path &&
    cached.title === file.title &&
    cached.content === file.content
  ) {
    return cached.order;
  }

  const root = file.path.split("/")[0] || "";
  const name = file.path.split("/").pop() || file.path;
  const filenameMatch = name.match(/^(\d{1,4})(?:[-_.\s]|$)/);
  if (filenameMatch) {
    const order = Number(filenameMatch[1]);
    orderCache.set(file, { path: file.path, title: file.title, content: file.content, order });
    return order;
  }

  const prefix =
    root === "scenes" ? "scene" : root === "shots" ? "shot" : root === "prompts" ? "prompt" : "";
  if (!prefix) {
    orderCache.set(file, { path: file.path, title: file.title, content: file.content, order: null });
    return null;
  }
  const content = `${file.title}\n${file.content.slice(0, 4000)}`;
  const explicit = content.match(
    new RegExp(`(^|\\n)\\s{0,3}(?:#{1,4}\\s*)?${prefix}\\s+0*(\\d{1,4})(\\b|\\s|[-:])`, "i"),
  );
  if (explicit) {
    const order = Number(explicit[2]);
    orderCache.set(file, { path: file.path, title: file.title, content: file.content, order });
    return order;
  }
  const frontmatter = content.match(/(^|\n)\s*(?:order|index|number)\s*:\s*0*(\d{1,4})(\b|$)/i);
  const order = frontmatter ? Number(frontmatter[2]) : null;
  orderCache.set(file, { path: file.path, title: file.title, content: file.content, order });
  return order;
}

export function compareProjectFiles(a: CloudFile, b: CloudFile) {
  const aRoot = a.path.split("/")[0] || "";
  const bRoot = b.path.split("/")[0] || "";
  if (aRoot === bRoot && ["scenes", "shots", "prompts"].includes(aRoot)) {
    const aOrder = numberedCreativeOrder(a);
    const bOrder = numberedCreativeOrder(b);
    if (aOrder !== null || bOrder !== null) {
      if (aOrder === null) return 1;
      if (bOrder === null) return -1;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
  }
  return PATH_COLLATOR.compare(a.path, b.path);
}
