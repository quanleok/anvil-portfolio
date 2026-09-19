import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetEntry, AssetRefs, EntityRef, ForgeProjectData, SectionId, SuppressedRef } from "../types";
import { firstRenderableAssetMedia, mediaSrc } from "../lib/media";
import type { AssetSectionId } from "../lib/sections";
import { usePopover } from "../hooks/usePopover";
import { AudioWaveIcon } from "./icons";
import { handleMenuNavigation } from "./menu-navigation";

interface LinkedAssetRailProps {
  entityRefs?: EntityRef[];
  suppressedRefs?: SuppressedRef[];
  project: ForgeProjectData | null;
  refs: AssetRefs | undefined;
  bodyText?: string;
  ignoreMarkdownHeadings?: boolean;
  brokenMediaIds: Record<string, boolean>;
  mediaRefreshKey: string;
  onJumpTo: (section: SectionId, assetId: string) => void;
  onAddRef?: (section: AssetSectionId, assetId: string) => void;
  onAddRefs?: (refs: Array<{ section: AssetSectionId; assetId: string }>) => void;
  onRemoveRef?: (section: AssetSectionId, assetId: string) => void;
  onSuppressRef?: (section: AssetSectionId, assetId: string) => void;
  onChipContextMenu?: (section: AssetSectionId, assetId: string, x: number, y: number) => void;
}

interface ResolvedAssetRef {
  section: AssetSectionId;
  asset: AssetEntry;
  role: string;
  source: "body" | "explicit" | "legacy";
}

// Match a frontmatter ref token to a project asset. Tokens can be:
//   - asset id (uuid)
//   - asset name (case-insensitive exact match)
//   - asset slug derived from name
//   - asset file path (assets/characters/aki.md)
function matchAsset(project: ForgeProjectData, section: AssetSectionId, token: string): AssetEntry | null {
  const dataKey = section === "media" ? "library" : section;
  const items = (project[dataKey] || []) as AssetEntry[];
  const norm = token.trim().toLowerCase();
  if (!norm) return null;
  // id
  const byId = items.find((item) => item.id === token);
  if (byId) return byId;
  // exact name (case-insensitive)
  const byName = items.find((item) => (item.name || item.title || "").trim().toLowerCase() === norm);
  if (byName) return byName;
  // slug / path fragment
  const slugified = norm.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const bySlug = items.find((item) => {
    const itemSlug = (item.name || item.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return itemSlug === slugified;
  });
  if (bySlug) return bySlug;
  // path-ish match
  const byPath = items.find((item) =>
    (item.path || "").toLowerCase().includes(norm) ||
    (item.media || []).some((media) => (media.path || "").toLowerCase().includes(norm)),
  );
  return byPath || null;
}

// Reference assets only — videos are pipeline outputs, not references, and
// media is the global file view (handled separately). Prompts/shots/scenes
// don't "reference" videos the way they reference characters/locations.
type RefKind = Exclude<AssetSectionId, "media" | "videos">;

function resolveRefs(project: ForgeProjectData, refs: AssetRefs): ResolvedAssetRef[] {
  const resolved: ResolvedAssetRef[] = [];
  const seen = new Set<string>();
  const sections: RefKind[] = ["characters", "locations", "props", "keyframes", "audio"];
  for (const section of sections) {
    const tokens = refs[section];
    if (!Array.isArray(tokens) || !tokens.length) continue;
    for (const token of tokens) {
      const match = matchAsset(project, section, String(token || ""));
      if (!match) continue;
      const key = `${section}:${match.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ section, asset: match, role: "featured", source: "legacy" });
    }
  }
  return resolved;
}

function resolveEntityRefs(project: ForgeProjectData, refs: EntityRef[]): ResolvedAssetRef[] {
  const resolved: ResolvedAssetRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const section = ref.section;
    const items = (project[section] || []) as AssetEntry[];
    const match = items.find((item) => item.id === ref.entityId);
    if (!match) continue;
    const key = `${section}:${match.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      section,
      asset: match,
      role: ref.role || "featured",
      source: "explicit",
    });
  }
  return resolved;
}

export function LinkedAssetRail({
  entityRefs,
  project,
  refs,
  brokenMediaIds,
  mediaRefreshKey,
  onJumpTo,
  onAddRef,
  onRemoveRef,
  onChipContextMenu,
}: LinkedAssetRailProps) {
  const {
    open: pickerOpen,
    setOpen: setPickerOpen,
    close: closePicker,
    ref: pickerRef,
  } = usePopover<HTMLDivElement>();
  const [pickerFilter, setPickerFilter] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxRestoreFocusRef = useRef<HTMLElement | null>(null);

  const fromEntityRefs = project && entityRefs?.length ? resolveEntityRefs(project, entityRefs) : [];
  const fromLegacyRefs = project && refs ? resolveRefs(project, refs) : [];
  const linkedRefs: ResolvedAssetRef[] = [];
  const linkedSeen = new Set<string>();
  for (const item of [...fromEntityRefs, ...fromLegacyRefs]) {
    const key = `${item.section}:${item.asset.id}`;
    if (linkedSeen.has(key)) continue;
    linkedSeen.add(key);
    linkedRefs.push(item);
  }
  const linkedKeys = new Set(linkedRefs.map((r) => `${r.section}:${r.asset.id}`));
  const resolved = linkedRefs;
  const canEdit = Boolean(onAddRef || onRemoveRef);

  const pickableSections: RefKind[] = ["characters", "locations", "props", "keyframes", "audio"];
  const filterNorm = pickerFilter.trim().toLowerCase();
  // Stable content signature so the memo below invalidates on asset-swap
  // (same .length, different set) — not just on .length changes.
  const linkedKeySignature = resolved.map((r) => `${r.section}:${r.asset.id}`).join(",");

  // Memoize the per-section filtered list so we don't walk project.{section}
  // twice per render (once for .map and once for the empty-state .every).
  const sectionFiltered = useMemo(() => {
    const out: Array<{ section: RefKind; items: AssetEntry[] }> = [];
    for (const section of pickableSections) {
      const items = ((project?.[section] || []) as AssetEntry[]).filter((a) => {
        if (linkedKeys.has(`${section}:${a.id}`)) return false;
        if (!filterNorm) return true;
        const name = (a.name || a.title || "").toLowerCase();
        return name.includes(filterNorm);
      });
      out.push({ section, items });
    }
    return out;
    // Re-runs when project/filter/linked-set shifts. linkedKeys is rebuilt
    // from `resolved` each render but its *content* is captured by
    // linkedKeySignature — using that key is both stable and exhaustive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, filterNorm, linkedKeySignature]);
  const hasAnyPickable = sectionFiltered.some((g) => g.items.length > 0);

  const previewableRefs = resolved.filter((item) => {
    const media = firstRenderableAssetMedia(item.asset.media || [], brokenMediaIds);
    return Boolean(media && media.kind === "image" && media.fileUrl && !brokenMediaIds[media.id]);
  });
  const lightboxRef =
    lightboxIndex !== null && previewableRefs.length
      ? previewableRefs[Math.max(0, Math.min(lightboxIndex, previewableRefs.length - 1))]
      : null;
  const lightboxMedia = lightboxRef
    ? firstRenderableAssetMedia(lightboxRef.asset.media || [], brokenMediaIds)
    : null;
  const lightboxLabel = lightboxRef?.asset.name || lightboxRef?.asset.title || "Untitled";
  const canNavigateLightbox = previewableRefs.length > 1;
  const lightboxOpen = lightboxIndex !== null;

  const openLightbox = (ref: ResolvedAssetRef) => {
    const index = previewableRefs.findIndex((item) => item.section === ref.section && item.asset.id === ref.asset.id);
    if (index >= 0) {
      setLightboxIndex(index);
    }
  };

  const stepLightbox = useCallback((direction: -1 | 1) => {
    setLightboxIndex((current) => {
      if (!previewableRefs.length) return null;
      const start = current === null ? 0 : current;
      return (start + direction + previewableRefs.length) % previewableRefs.length;
    });
  }, [previewableRefs.length]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    if (!previewableRefs.length) {
      setLightboxIndex(null);
      return;
    }
    if (lightboxIndex >= previewableRefs.length) {
      setLightboxIndex(previewableRefs.length - 1);
    }
  }, [lightboxIndex, previewableRefs.length]);

  useEffect(() => {
    if (lightboxOpen) {
      lightboxRestoreFocusRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    const previousFocus = lightboxRestoreFocusRef.current;
    lightboxRestoreFocusRef.current = null;
    if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) {
      previousFocus.focus();
    }
  }, [lightboxOpen]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLightboxIndex(null);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepLightbox(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepLightbox(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [lightboxOpen, previewableRefs.length, stepLightbox]);

  if (!project) return null;
  if (!resolved.length && !canEdit) return null;

  return (
    <div className="linked-asset-rail" role="region" aria-label="Linked assets">
      <div className="linked-asset-rail-header">
        <div className="linked-asset-rail-title">Linked assets</div>
      </div>
      <div className="linked-asset-rail-row">
        <div className="linked-asset-rail-main">
          {resolved.length ? (
            <div className="linked-asset-rail-items">
              {resolved.map(({ section, asset, role, source }) => {
                const thumb = firstRenderableAssetMedia(asset.media || [], brokenMediaIds);
                const label = asset.name || asset.title || "Untitled";
                const initial = label.trim().charAt(0).toUpperCase() || "?";
                const thumbBroken = thumb ? brokenMediaIds[thumb.id] : false;
                return (
                  <div
                    key={`${section}:${asset.id}`}
                    className={`linked-asset-chip-wrapper${onRemoveRef ? " can-remove" : ""}`}
                  >
                    <button
                      className="linked-asset-chip"
                      onClick={() => openLightbox({ section, asset, role, source })}
                      onContextMenu={
                        onChipContextMenu
                          ? (e) => {
                              e.preventDefault();
                              onChipContextMenu(section, asset.id, e.clientX, e.clientY);
                            }
                          : undefined
                      }
                      title={`${label} · ${section}`}
                      type="button"
                    >
                      <span className="linked-asset-chip-media">
                        {thumb && thumb.kind === "image" && thumb.fileUrl && !thumbBroken ? (
                          <img src={mediaSrc(thumb, mediaRefreshKey)} alt={label} loading="lazy" />
                        ) : thumb && thumb.kind === "audio" ? (
                          <span className="linked-asset-chip-glyph"><AudioWaveIcon /></span>
                        ) : (
                          <span className="linked-asset-chip-initial">{initial}</span>
                        )}
                      </span>
                    </button>
                    {onRemoveRef ? (
                      <button
                        type="button"
                        className="linked-asset-chip-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveRef(section, asset.id);
                        }}
                        title="Unlink"
                        aria-label={`Unlink ${label}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="linked-asset-empty">
              No explicit asset references yet.
            </div>
          )}
        </div>
        <div className="linked-asset-rail-controls">
          {onAddRef ? (
            <div className="linked-asset-picker-wrapper" ref={pickerRef}>
              <button
                type="button"
                className="linked-asset-add-btn"
                onClick={() => {
                  setPickerFilter("");
                  setPickerOpen((c) => !c);
                }}
                title="Link asset"
              >
                + Link asset
              </button>
              {pickerOpen ? (
                <div className="linked-asset-picker" role="dialog" aria-label="Link asset" onKeyDown={handleMenuNavigation}>
                  <input
                    autoFocus
                    type="text"
                    className="linked-asset-picker-search"
                    name="linked-asset-search"
                    autoComplete="off"
                    placeholder="Search assets…"
                    value={pickerFilter}
                    onChange={(e) => setPickerFilter(e.target.value)}
                    aria-label="Search assets to link"
                  />
                  <div className="linked-asset-picker-body">
                    {sectionFiltered.map(({ section, items }) => {
                      if (!items.length) return null;
                      return (
                        <div key={section} className="linked-asset-picker-group" role="group" aria-label={section}>
                          <div className="linked-asset-picker-group-label">{section}</div>
                          {items.map((asset) => {
                            const thumb = firstRenderableAssetMedia(asset.media || [], brokenMediaIds);
                            const label = asset.name || asset.title || "Untitled";
                            const thumbBroken = thumb ? brokenMediaIds[thumb.id] : false;
                            return (
                              <button
                                key={asset.id}
                                type="button"
                                data-menu-item="true"
                                className="linked-asset-picker-item"
                                onClick={() => {
                                  onAddRef(section, asset.id);
                                  closePicker();
                                }}
                              >
                                <span className="linked-asset-picker-thumb">
                                  {thumb && thumb.kind === "image" && thumb.fileUrl && !thumbBroken ? (
                                    <img src={mediaSrc(thumb, mediaRefreshKey)} alt="" loading="lazy" />
                                  ) : thumb && thumb.kind === "audio" ? (
                                    <AudioWaveIcon />
                                  ) : null}
                                </span>
                                <span className="linked-asset-picker-copy">
                                  <span>{label}</span>
                                  <small>{thumb?.path || section}</small>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    {!hasAnyPickable ? (
                      <div className="linked-asset-picker-empty">
                        {filterNorm ? "No matches." : "All assets linked."}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {lightboxRef && lightboxMedia && lightboxMedia.kind === "image" && lightboxMedia.fileUrl ? (
        <div
          className="asset-preview-lightbox linked-asset-lightbox"
          onClick={() => setLightboxIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${lightboxLabel}`}
        >
          <div
            className="asset-preview-lightbox-card linked-asset-lightbox-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="asset-preview-lightbox-head">
              <div className="asset-preview-lightbox-copy">
                <div className="asset-preview-lightbox-title">{lightboxLabel}</div>
                <div className="asset-preview-lightbox-meta">
                  {lightboxMedia.path || lightboxRef.asset.path || lightboxRef.section} · Esc closes · ← / → changes image
                </div>
              </div>
              <div className="linked-asset-lightbox-actions">
                <button
                  className="ghost-btn compact"
                  type="button"
                  onClick={() => onJumpTo(lightboxRef.section, lightboxRef.asset.id)}
                >
                  Open asset
                </button>
                <button
                  className="ghost-btn compact"
                  type="button"
                  onClick={() => setLightboxIndex(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="asset-preview-lightbox-body linked-asset-lightbox-body">
              {canNavigateLightbox ? (
                <button
                  type="button"
                  className="linked-asset-lightbox-nav prev"
                  onClick={() => stepLightbox(-1)}
                  aria-label="Previous linked asset"
                >
                  ‹
                </button>
              ) : null}
              <img
                src={mediaSrc(lightboxMedia, mediaRefreshKey)}
                alt={lightboxLabel}
                className="asset-preview-lightbox-media linked-asset-lightbox-media"
              />
              {canNavigateLightbox ? (
                <button
                  type="button"
                  className="linked-asset-lightbox-nav next"
                  onClick={() => stepLightbox(1)}
                  aria-label="Next linked asset"
                >
                  ›
                </button>
              ) : null}
            </div>
            {previewableRefs.length > 1 ? (
              <div className="linked-asset-lightbox-strip" aria-label="Linked asset previews">
                {previewableRefs.map((item, index) => {
                  const media = firstRenderableAssetMedia(item.asset.media || [], brokenMediaIds);
                  if (!media || media.kind !== "image" || !media.fileUrl) return null;
                  const label = item.asset.name || item.asset.title || "Untitled";
                  return (
                    <button
                      key={`${item.section}:${item.asset.id}`}
                      type="button"
                      className={`linked-asset-lightbox-thumb${index === lightboxIndex ? " active" : ""}`}
                      onClick={() => setLightboxIndex(index)}
                      aria-label={`Preview ${label}`}
                      aria-pressed={index === lightboxIndex}
                    >
                      <img src={mediaSrc(media, mediaRefreshKey)} alt="" loading="lazy" />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
