import contextCompassUrl from "../assets/nav-icons/context-compass.webp";
import scriptGrimoireUrl from "../assets/nav-icons/script-grimoire.webp";
import scriptGrimoireOpenUrl from "../assets/nav-icons/script-grimoire-open.webp";
import assetsArmoryUrl from "../assets/nav-icons/assets-armory.webp";
import assetsArmoryOpenUrl from "../assets/nav-icons/assets-armory-open.webp";
import mediaArchiveUrl from "../assets/nav-icons/media-archive.webp";
import charactersAnatomyUrl from "../assets/nav-icons/characters-anatomy.webp";
import locationsMapUrl from "../assets/nav-icons/locations-map.webp";
import propsRelicUrl from "../assets/nav-icons/props-relic.webp";
import propsRelicOpenUrl from "../assets/nav-icons/props-relic-open.webp";
import keyframesFrameUrl from "../assets/nav-icons/keyframes-frame.webp";
import audioBellUrl from "../assets/nav-icons/audio-bell.webp";
import hammerToolbarUrl from "../assets/nav-icons/hammer-toolbar.webp";
import settingsToolbarUrl from "../assets/nav-icons/settings-toolbar.webp";
import controlSyncUrl from "../assets/ui-pack/controls/control-sync.webp";
import controlLockOpenUrl from "../assets/ui-pack/controls/control-lock-open.webp";
import controlLockClosedUrl from "../assets/ui-pack/controls/control-lock-closed.webp";
import controlUndoUrl from "../assets/ui-pack/controls/control-undo.webp";
import controlRedoUrl from "../assets/ui-pack/controls/control-redo.webp";
import controlPlusUrl from "../assets/ui-pack/controls/control-plus.webp";
import controlPulseOrbUrl from "../assets/ui-pack/controls/control-pulse-orb.webp";
import controlCopyUrl from "../assets/ui-pack/controls/control-copy.webp";
import controlHideChatUrl from "../assets/ui-pack/controls/control-hide-chat.svg";
import controlMoreUrl from "../assets/ui-pack/controls/control-more.webp";
import controlNoticeBellUrl from "../assets/ui-pack/controls/control-notice-bell.webp";
import anvilLogoUrl from "../assets/anvil-logo.webp";
import anvilLogoUrl2x from "../assets/anvil-logo@2x.webp";
import type { StoryChildId, AssetSectionId, PrimarySectionId, WorkshopSectionId } from "../lib/sections";

const commonSvgProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function ArcaneSparkleOverlay({ className }: { className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <path d="M18 6.5 20.7 15.3 29.5 18l-8.8 2.7L18 29.5l-2.7-8.8L6.5 18l8.8-2.7L18 6.5Z" />
        <path d="M26.8 8.8 27.8 12.2 31.2 13.2l-3.4 1-1 3.4-1-3.4-3.4-1 3.4-1 1-3.4Z" />
      </svg>
    </span>
  );
}

function ArchiveCoreOverlay() {
  return (
    <span className="rail-icon-archive-core" aria-hidden="true">
      <span className="rail-icon-archive-core-pulse" />
      <span className="rail-icon-archive-core-ring" />
    </span>
  );
}

function BellResonanceOverlay() {
  return (
    <span className="rail-icon-bell-rings" aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <path d="M8.2 12.6c-2.2 2.1-3.5 4.6-3.5 5.4 0 .8 1.3 3.3 3.5 5.4" />
        <path d="M12 9.6c-3.1 2.7-4.9 5.9-4.9 8.4 0 2.5 1.8 5.7 4.9 8.4" />
        <path d="M27.8 12.6c2.2 2.1 3.5 4.6 3.5 5.4 0 .8-1.3 3.3-3.5 5.4" />
        <path d="M24 9.6c3.1 2.7 4.9 5.9 4.9 8.4 0 2.5-1.8 5.7-4.9 8.4" />
      </svg>
    </span>
  );
}

function AgentPrimaryIcon() {
  return (
    <span className="rail-icon-agent" aria-hidden="true">
      <span className="rail-icon-agent-glow" />
      <img
        className="rail-icon-agent-image"
        src={anvilLogoUrl}
        srcSet={`${anvilLogoUrl} 1x, ${anvilLogoUrl2x} 2x`}
        alt=""
        draggable={false}
      />
      <span className="rail-icon-agent-orbit" />
    </span>
  );
}

function TimelineChildIcon() {
  return (
    <span className="rail-icon-timeline" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path className="timeline-track timeline-track--top" d="M4.2 7.2h15.6" {...commonSvgProps} />
        <path className="timeline-track timeline-track--mid" d="M4.2 12h15.6" {...commonSvgProps} />
        <path className="timeline-track timeline-track--bottom" d="M4.2 16.8h15.6" {...commonSvgProps} />
        <rect className="timeline-clip timeline-clip--one" x="5.2" y="5.4" width="5.8" height="3.6" rx="1.1" />
        <rect className="timeline-clip timeline-clip--two" x="11.6" y="10.2" width="7.2" height="3.6" rx="1.1" />
        <rect className="timeline-clip timeline-clip--three" x="7.3" y="15" width="6.7" height="3.6" rx="1.1" />
        <path className="timeline-playhead" d="M15.9 4.5v15" {...commonSvgProps} />
        <circle className="timeline-playhead-dot" cx="15.9" cy="4.5" r="1.6" />
      </svg>
    </span>
  );
}

export function VideoMirrorIcon() {
  return <ArtworkIcon src={assetsArmoryUrl} hoverSrc={assetsArmoryOpenUrl} label="Video bin" tone="iron" variant="chest" />;
}

function CompassActivationOverlay() {
  return (
    <>
      <span className="rail-icon-compass-ring" aria-hidden="true" />
      <span className="rail-icon-compass-needle" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <path d="M18 5.5 22.4 18 18 20.1 13.6 18 18 5.5Z" />
          <path d="M18 30.5 21.4 19.5 18 17.8 14.6 19.5 18 30.5Z" />
          <circle cx="18" cy="18" r="2.3" />
        </svg>
      </span>
    </>
  );
}

function ArtworkIcon({
  src,
  hoverSrc,
  label,
  tone,
  variant,
}: {
  src: string;
  hoverSrc?: string;
  label: string;
  tone: string;
  variant?: "archive" | "audio" | "book" | "chest" | "compass" | "frame" | "hammer" | "mirror" | "satchel";
}) {
  const variantClass = variant ? ` variant-${variant}` : "";
  return (
    <span className={`rail-icon-art tone-${tone}${variantClass}`} aria-hidden="true">
      <span className="rail-icon-art-state rail-icon-art-state--base">
        <span className="rail-icon-art-glow">
          <img src={src} alt="" draggable={false} data-icon-label={label} />
        </span>
        <img className="rail-icon-art-image" src={src} alt="" draggable={false} data-icon-label={label} />
      </span>
      {hoverSrc ? (
        <span className="rail-icon-art-state rail-icon-art-state--hover">
          <span className="rail-icon-art-glow">
            <img src={hoverSrc} alt="" draggable={false} data-icon-label={`${label} hover`} />
          </span>
          <img className="rail-icon-art-image" src={hoverSrc} alt="" draggable={false} data-icon-label={`${label} hover`} />
        </span>
      ) : null}
      {variant === "compass" ? <CompassActivationOverlay /> : null}
      {variant === "archive" ? <ArchiveCoreOverlay /> : null}
      {variant === "audio" ? <BellResonanceOverlay /> : null}
      {variant === "frame" ? <ArcaneSparkleOverlay className="rail-icon-spark rail-icon-spark--frame" /> : null}
      {variant === "hammer" ? <ArcaneSparkleOverlay className="rail-icon-spark rail-icon-spark--hammer" /> : null}
      {variant === "mirror" ? <ArcaneSparkleOverlay className="rail-icon-spark rail-icon-spark--mirror" /> : null}
    </span>
  );
}

function ToolbarArtworkIcon({
  src,
  label,
  variant,
}: {
  src: string;
  label: string;
  variant: "hammer" | "settings";
}) {
  return (
    <span className={`toolbar-icon-art variant-${variant}`} aria-hidden="true">
      <span className="toolbar-icon-art-glow">
        <img src={src} alt="" draggable={false} data-icon-label={label} />
      </span>
      <img className="toolbar-icon-art-image" src={src} alt="" draggable={false} data-icon-label={label} />
    </span>
  );
}

function ControlArtworkIcon({
  src,
  label,
  variant,
}: {
  src: string;
  label: string;
  variant:
    | "copy"
    | "hide-chat"
    | "lock-closed"
    | "lock-open"
    | "more"
    | "notice-bell"
    | "plus"
    | "pulse-orb"
    | "redo"
    | "show-chat"
    | "sync"
    | "temporary-trash"
    | "undo";
}) {
  return (
    <span className={`control-icon-art variant-${variant}`} aria-hidden="true">
      <span className="control-icon-art-glow">
        <img src={src} alt="" draggable={false} data-icon-label={label} />
      </span>
      <img className="control-icon-art-image" src={src} alt="" draggable={false} data-icon-label={label} />
    </span>
  );
}

export function primaryIconForSection(section: PrimarySectionId) {
  switch (section) {
    case "story":
      return <ArtworkIcon src={contextCompassUrl} label="Context compass" tone="brass" variant="compass" />;
    case "script":
      return <ArtworkIcon src={scriptGrimoireUrl} hoverSrc={scriptGrimoireOpenUrl} label="Script grimoire" tone="ember" variant="book" />;
    case "assets":
      return <ArtworkIcon src={assetsArmoryUrl} hoverSrc={assetsArmoryOpenUrl} label="Assets armory" tone="iron" variant="chest" />;
    case "workshop":
      return <ArtworkIcon src={hammerToolbarUrl} label="Workshop forge hammer" tone="arcane" variant="hammer" />;
    case "agent":
      return <AgentPrimaryIcon />;
  }
}

export function workshopChildIcon(section: WorkshopSectionId) {
  switch (section) {
    case "videos":
      return <VideoMirrorIcon />;
    case "timeline":
      return <TimelineChildIcon />;
    case "workshop":
      // The unified Workshop NLE entry. Re-uses the timeline-tracks
      // glyph since the sub-rail "workshop" item IS the timeline editor
      // — distinct from the primary hammer-mark above.
      return <TimelineChildIcon />;
  }
}

export function storyChildIcon(section: StoryChildId) {
  switch (section) {
    case "world-bible":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6.5 5h9a2.5 2.5 0 0 1 2.5 2.5V19l-4-2-4 2-4-2V7.5A2.5 2.5 0 0 1 6.5 5Z" {...commonSvgProps} />
          <path d="M9 9.5h6" {...commonSvgProps} />
          <path d="M9 13h6" {...commonSvgProps} />
        </svg>
      );
  }
}

export function assetIconForSection(section: AssetSectionId) {
  switch (section) {
    case "media":
      return <ArtworkIcon src={mediaArchiveUrl} label="Media archive" tone="arcane" variant="archive" />;
    case "characters":
      return <ArtworkIcon src={charactersAnatomyUrl} label="Characters anatomy study" tone="parchment" />;
    case "locations":
      return <ArtworkIcon src={locationsMapUrl} label="Locations map" tone="parchment" />;
    case "props":
      return <ArtworkIcon src={propsRelicUrl} hoverSrc={propsRelicOpenUrl} label="Props satchel" tone="leather" variant="satchel" />;
    case "keyframes":
      return <ArtworkIcon src={keyframesFrameUrl} label="Keyframes frame" tone="arcane" variant="frame" />;
    case "audio":
      return <ArtworkIcon src={audioBellUrl} label="Audio bell" tone="void" variant="audio" />;
  }
}

export function SettingsIcon() {
  return <ToolbarArtworkIcon src={settingsToolbarUrl} label="Settings gear" variant="settings" />;
}

export function MoreIcon() {
  return <ControlArtworkIcon src={controlMoreUrl} label="More actions" variant="more" />;
}

export function NoticeBellIcon() {
  return <ControlArtworkIcon src={controlNoticeBellUrl} label="Notifications" variant="notice-bell" />;
}

export function CopyIcon() {
  return <ControlArtworkIcon src={controlCopyUrl} label="Copy" variant="copy" />;
}

export function HideChatIcon() {
  return <ControlArtworkIcon src={controlHideChatUrl} label="Hide chat" variant="hide-chat" />;
}

export function ShowChatIcon() {
  return <ControlArtworkIcon src={controlHideChatUrl} label="Show chat" variant="show-chat" />;
}

export function LockOpenIcon() {
  return <ControlArtworkIcon src={controlLockOpenUrl} label="Lock open" variant="lock-open" />;
}

export function HammerIcon() {
  return <ToolbarArtworkIcon src={hammerToolbarUrl} label="Forge hammer" variant="hammer" />;
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7 7l1 11.3A1.7 1.7 0 0 0 9.7 20h4.6a1.7 1.7 0 0 0 1.7-1.7L17 7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 10.5v6M13.5 10.5v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function TemporaryTrashIcon() {
  return <ControlArtworkIcon src={propsRelicUrl} label="Temporary trash" variant="temporary-trash" />;
}

export function UploadPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

// Solid upload arrow — used in chat composer attach + Media Library button.
// Brand-purple fill (styled via CSS with color: var(--brand)).
export function UploadArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.5a1 1 0 01.7.29l5 5a1 1 0 01-1.4 1.42L13 6.9V15a1 1 0 01-2 0V6.9L7.7 10.21a1 1 0 11-1.4-1.42l5-5A1 1 0 0112 3.5z"
        fill="currentColor"
      />
      <path d="M5 18h14a1 1 0 010 2H5a1 1 0 010-2z" fill="currentColor" />
    </svg>
  );
}

export function UploadFilesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4.8h6.4L17.8 9v9.2A1.8 1.8 0 0 1 16 20H7a1.8 1.8 0 0 1-1.8-1.8V6.6A1.8 1.8 0 0 1 7 4.8Z" {...commonSvgProps} />
      <path d="M13.1 5.1v4.2h4.3" {...commonSvgProps} />
      <path d="M8.3 13.2h6.4M8.3 16h4.7" {...commonSvgProps} />
    </svg>
  );
}

export function UploadFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 8.2h5l1.5 2h8.5v7.1A2.2 2.2 0 0 1 17.3 19H6.7a2.2 2.2 0 0 1-2.2-2.2V8.2Z" {...commonSvgProps} />
      <path d="M4.5 8.2V7A2 2 0 0 1 6.5 5h3.1l1.6 2h6.3a2 2 0 0 1 2 2v1.2" {...commonSvgProps} />
      <path d="M12 13.1v3.3M10.4 14.7H13.6" {...commonSvgProps} />
    </svg>
  );
}

export function OpenLibraryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 6.5h8.8A2.2 2.2 0 0 1 16.5 8.7v8.8h-11V6.5Z" {...commonSvgProps} />
      <path d="M8.5 9.5h5M8.5 12.5h4" {...commonSvgProps} />
      <path d="M14.5 5.5h4v4" {...commonSvgProps} />
      <path d="m18.5 5.5-6 6" {...commonSvgProps} />
    </svg>
  );
}

export function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11.1 5.8 3.9 18a1.4 1.4 0 0 0 1.2 2.1h13.8a1.4 1.4 0 0 0 1.2-2.1L12.9 5.8a1 1 0 0 0-1.8 0Z" {...commonSvgProps} />
      <path d="M12 9.5v4.2" {...commonSvgProps} />
      <path d="M12 17h.01" {...commonSvgProps} />
    </svg>
  );
}

export function InlineLockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="10.2" width="11" height="8.3" rx="2" {...commonSvgProps} />
      <path d="M8.8 10.2V8.1a3.2 3.2 0 0 1 6.4 0v2.1" {...commonSvgProps} />
      <path d="M12 13.2v2.2" {...commonSvgProps} />
    </svg>
  );
}

export function AudioWaveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 13.5v-3" {...commonSvgProps} />
      <path d="M8.5 16.5v-9" {...commonSvgProps} />
      <path d="M12 18.5v-13" {...commonSvgProps} />
      <path d="M15.5 16.5v-9" {...commonSvgProps} />
      <path d="M19 13.5v-3" {...commonSvgProps} />
    </svg>
  );
}

export function MediaFileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.8" y="6" width="14.4" height="12" rx="2" {...commonSvgProps} />
      <path d="M8 9.2h8" {...commonSvgProps} />
      <path d="M8 13.8h3.8" {...commonSvgProps} />
      <path d="m13.2 14.2 2.3-2.4 3.7 4.2" {...commonSvgProps} />
    </svg>
  );
}

export function FilmMasterIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="6.2" width="15" height="11.6" rx="2.2" {...commonSvgProps} />
      <path d="M8 6.2v11.6M16 6.2v11.6" {...commonSvgProps} />
      <path d="M4.8 10h14.4M4.8 14h14.4" {...commonSvgProps} />
    </svg>
  );
}

export function SceneReelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8.2" cy="8.2" r="2.7" {...commonSvgProps} />
      <circle cx="15.8" cy="8.2" r="2.7" {...commonSvgProps} />
      <rect x="5.2" y="12.2" width="13.6" height="6.2" rx="1.8" {...commonSvgProps} />
      <path d="M8.5 15.3h7" {...commonSvgProps} />
    </svg>
  );
}

export function VideoCameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="7.2" width="10.8" height="9.6" rx="2" {...commonSvgProps} />
      <path d="m15.3 10.4 4.2-2.4v8l-4.2-2.4" {...commonSvgProps} />
      <path d="M7.5 10.2h4.2" {...commonSvgProps} />
    </svg>
  );
}

export function ShotChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6.8 15.2 12 9 17.2" {...commonSvgProps} />
    </svg>
  );
}

export function LockClosedIcon() {
  return <ControlArtworkIcon src={controlLockClosedUrl} label="Lock closed" variant="lock-closed" />;
}

export function UndoIcon() {
  return <ControlArtworkIcon src={controlUndoUrl} label="Undo" variant="undo" />;
}

export function RedoIcon() {
  return <ControlArtworkIcon src={controlRedoUrl} label="Redo" variant="redo" />;
}

export function SyncIcon() {
  return <ControlArtworkIcon src={controlSyncUrl} label="Sync" variant="sync" />;
}

export function PlusIcon() {
  return <ControlArtworkIcon src={controlPlusUrl} label="Add" variant="plus" />;
}

export function PulseOrbIcon() {
  return <ControlArtworkIcon src={controlPulseOrbUrl} label="Status orb" variant="pulse-orb" />;
}
