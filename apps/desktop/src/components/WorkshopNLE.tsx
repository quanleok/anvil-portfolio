// Workshop NLE — unified non-linear editor for the desktop app.
//
// Replaces the legacy split between Video Bin (videos section) and
// Timeline (timeline section). Single panel with:
//
//   left pane: clip bin (videos + audio + in-flight jobs)
//   top right: stitched preview player + transport
//   bottom right: 4-lane timeline (V1, V2, A1, A2)
//
// The data model is project.timeline[] with optional `track`, `startSec`,
// `mediaPath`, `volume`, `fadeInSec`, `fadeOutSec`. Old single-track clips
// (no `track`) are interpreted as V1 sequential clips and laid out in
// orderIndex order with no explicit start position. New clips persist
// explicit `track` + `startSec` so the agent and user can author
// arbitrary multi-track arrangements.
//
// Agent presence: any clip whose backing video / audio path is in the
// `touchedPathSet` pulses with the same brand-glow used by item rows.
// When a clip's `id` is in `agentSelectedClipIds`, it gets a stronger
// outline so the user can see what the agent is currently editing.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  ForgeProjectData,
  TimelineClip,
  TimelineEvent,
  TimelineTrack,
  VideoEntry,
  VideoSpec,
} from "../types";
import { DEFAULT_VIDEO_SPEC } from "../types";
import { indexMediaSrc } from "../lib/media";
import { useReducedMotion } from "../hooks/useReducedMotion";

const TRACKS: TimelineTrack[] = ["V1", "V2", "A1", "A2"];
const TRACK_KIND: Record<TimelineTrack, "video" | "audio"> = {
  V1: "video",
  V2: "video",
  A1: "audio",
  A2: "audio",
};
const TRACK_LABEL: Record<TimelineTrack, string> = {
  V1: "V1",
  V2: "V2",
  A1: "A1",
  A2: "A2",
};
const TRACK_HINT: Record<TimelineTrack, string> = {
  V1: "V1 — main video. Drag video bin tiles here.",
  V2: "V2 — overlay (picture-in-picture) on top of V1.",
  A1: "A1 — music or voice-over track. Drag audio bin tiles here.",
  A2: "A2 — sound effects or ambient track.",
};
const TRACK_EMPTY_HINT: Record<TimelineTrack, string> = {
  V1: "Drop video",
  V2: "Drop overlay",
  A1: "Drop audio",
  A2: "Drop audio",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isTimelineTrack(value: unknown): value is TimelineTrack {
  return value === "V1" || value === "V2" || value === "A1" || value === "A2";
}

function safeVideoEntries(project: ForgeProjectData): VideoEntry[] {
  const videos = (project as { videos?: unknown }).videos;
  if (!Array.isArray(videos)) return [];
  return videos.filter(
    (video): video is VideoEntry =>
      isRecord(video)
      && typeof video.id === "string"
      && typeof video.path === "string"
      && video.path.trim().length > 0,
  );
}

function safeTimelineEntries(project: ForgeProjectData): TimelineClip[] {
  const timeline = (project as { timeline?: unknown }).timeline;
  if (!Array.isArray(timeline)) return [];
  return timeline.filter((clip): clip is TimelineClip => isRecord(clip));
}

function safeVideoSpec(value: unknown): VideoSpec {
  const input = isRecord(value) ? value : {};
  const width = Number(input.width);
  const height = Number(input.height);
  const fps = Number(input.fps);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_VIDEO_SPEC.width,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_VIDEO_SPEC.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_VIDEO_SPEC.fps,
  };
}

const DEFAULT_PX_PER_SEC = 60;
const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 300;
const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 24;
const LANE_GUTTER = 56;
const SNAP_THRESHOLD_SEC = 0.18;
// Minimum playable slice length, in seconds. Used by:
//   - clip trim handles (can't drag below this)
//   - the split blade (each half must be at least this long)
//   - default audio clip placeholder length on insert
// 50 ms is small enough that splits and trims feel free, but big enough
// that ffmpeg never sees a zero-duration trim window. Was 200 ms; the
// agent + UI both could deadlock on small clips that couldn't be split.
const MIN_CLIP_DURATION = 0.05;


export interface BinVideoItem {
  kind: "video";
  id: string;
  label: string;
  takeIndex: number | null;
  durationSec: number | null;
  source: "uploaded" | "generated" | "unknown";
  videoPath: string;
}

export interface BinAudioItem {
  kind: "audio";
  id: string;
  label: string;
  durationSec: number | null;
  mediaPath: string;
  /** Sub-kind from AssetEntry.audioKind; defaults to "music" when missing. */
  audioKind: "music" | "sfx" | "voiceover" | "ambient";
}

export type BinItem = BinVideoItem | BinAudioItem;

export interface WorkshopImportResult {
  videos: string[];
  audio: string[];
}

interface NormalizedClip {
  id: string;
  track: TimelineTrack;
  startSec: number;
  durationSec: number;
  trimInSec: number;
  trimOutSec: number | null;
  fullDurationSec: number;
  videoId: string | null;
  promptId: string | null;
  mediaPath: string | null;
  enabled: boolean;
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  label: string;
  source: "video" | "audio" | "gap";
  raw: TimelineClip;
}


interface ClipDragState {
  clipId: string;
  pointerId: number;
  mode: "move" | "trim-start" | "trim-end";
  originStartSec: number;
  originTrimInSec: number;
  originTrimOutSec: number | null;
  originDurationSec: number;
  pointerStartX: number;
  laneEl: HTMLDivElement | null;
}

interface DragGhostState {
  clipId: string;
  track: TimelineTrack;
  startSec: number;
  durationSec: number;
}

export interface WorkshopNLEProps {
  project: ForgeProjectData;
  projectDir: string;
  /** Persist a new project state. Wired to App.tsx's `queueSave` so we get
   *  undo, watcher-ignore, debounce, and the "Saved Xs ago" indicator for
   *  free. May return void or a Promise. */
  onSaveProject: (next: ForgeProjectData) => Promise<void> | void;
  onNotice?: (message: string, kind?: "success" | "info" | "error") => void;
  touchedPathSet?: Set<string>;
  agentSelectedClipIds?: Set<string>;
  /** True while the agent is mid-request (any tool calls in flight).
   *  Surfaces as an always-on "Agent working" pill in the timeline so
   *  the user can tell the workshop will mutate even when the agent is
   *  doing reads or non-timeline work. */
  agentWorking?: boolean;
  onRevealPath?: (relativePath: string) => void;
  /** Import media into the project (videos -> project.videos[],
   *  audio -> project.audio[]). The picker/drop path is shared so sound
   *  can be added to A1/A2 without leaving Workshop. 
   *  Pass null to open the OS file picker; pass an array of absolute
   *  file paths for drag-drop. */
  onImportMedia?: (filePaths: string[] | null) => Promise<WorkshopImportResult>;
}

function roundSec(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, lo: number, hi: number) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function formatTimecode(sec: number, fps: number = DEFAULT_VIDEO_SPEC.fps) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.max(0, sec);
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_VIDEO_SPEC.fps;
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const frames = Math.floor((total - Math.floor(total)) * safeFps);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const ff = String(frames).padStart(2, "0");
  return `${mm}:${ss}:${ff}`;
}

function formatDuration(sec: number | null | undefined) {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Humanize a video file's basename into a clip label. "01.01-dai-quan-
// khoi-hanh-ref.mp4" → "01.01 dai quan khoi hanh ref". Hyphens become
// spaces; the extension is dropped. Used as a fallback when the take
// index is not distinctive (every imported video defaults to take=1,
// so a 4-clip timeline used to read "Take 01 / Take 01 / Take 01 / Take 01"
// — useless for navigation).
function humanizeVideoBasename(videoPath: string): string {
  const base = (videoPath || "").split("/").pop() || "";
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt.replace(/[_-]+/g, " ").trim();
}

function videoLabel(video: VideoEntry, ordinal?: number) {
  // Imported videos all carry takeIndex=1 by default. When that's the
  // case, fall back to a humanized filename so the timeline can be read
  // at a glance instead of every clip showing "Take 01".
  const humanized = humanizeVideoBasename(video.path || "");
  const useHumanized = humanized && (typeof video.takeIndex !== "number" || video.takeIndex <= 1);
  const take = useHumanized
    ? humanized
    : typeof video.takeIndex === "number"
      ? `Take ${String(video.takeIndex).padStart(2, "0")}`
      : ordinal
        ? `Clip ${ordinal}`
        : "Clip";
  return video.note ? `${take} · ${video.note}` : take;
}

function detectVideoSource(video: VideoEntry): BinVideoItem["source"] {
  if (video.generator === "upload") return "uploaded";
  if (video.generator === "evolink" || video.generator === "topview") return "generated";
  return "unknown";
}

function buildBinFromProject(project: ForgeProjectData): BinItem[] {
  const items: BinItem[] = [];
  const videos = safeVideoEntries(project);
  for (const video of videos) {
    items.push({
      kind: "video",
      id: video.id,
      label: videoLabel(video),
      takeIndex: video.takeIndex ?? null,
      durationSec: video.durationSec ?? null,
      source: detectVideoSource(video),
      videoPath: video.path,
    });
  }
  const audio = Array.isArray((project as { audio?: unknown }).audio)
    ? (project as { audio: unknown[] }).audio.filter(isRecord)
    : [];
  for (const asset of audio) {
    const audioKind = asset.audioKind === "sfx"
      || asset.audioKind === "voiceover"
      || asset.audioKind === "ambient"
      || asset.audioKind === "music"
      ? asset.audioKind
      : "music";
    const mediaList = Array.isArray(asset.media) ? asset.media.filter(isRecord) : [];
    mediaList.forEach((media, idx) => {
      if (media.kind !== "audio" || typeof media.path !== "string" || !media.path) return;
      const assetId = typeof asset.id === "string" && asset.id ? asset.id : "audio";
      const mediaId = typeof media.id === "string" && media.id ? media.id : String(idx);
      const baseLabel =
        (typeof asset.name === "string" && asset.name.trim())
        || (typeof asset.title === "string" && asset.title.trim())
        || "Audio";
      const suffix =
        (typeof media.label === "string" && media.label.trim())
        || media.path.split("/").pop()
        || "";
      const label = suffix && suffix !== baseLabel && mediaList.length > 1
        ? `${baseLabel} · ${suffix}`
        : baseLabel;
      const durationRaw = Number(media.durationSec);
      items.push({
        kind: "audio",
        id: `${assetId}::${mediaId}`,
        label,
        durationSec: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null,
        mediaPath: media.path,
        audioKind,
      });
    });
  }
  return items;
}

function normalizeClip(
  raw: TimelineClip,
  prevEndOnTrack: Map<TimelineTrack, number>,
  videoIndex: Map<string, VideoEntry>,
  fallbackOrderIndex: number,
): NormalizedClip {
  const track: TimelineTrack = isTimelineTrack(raw.track) ? raw.track : "V1";
  const id = typeof raw.id === "string" && raw.id.trim()
    ? raw.id
    : `clip-${fallbackOrderIndex + 1}`;
  const videoId = typeof raw.videoId === "string" && raw.videoId.trim() ? raw.videoId : null;
  const promptId = typeof raw.promptId === "string" && raw.promptId.trim() ? raw.promptId : null;
  const rawMediaPath = typeof raw.mediaPath === "string" && raw.mediaPath.trim() ? raw.mediaPath : null;
  const video = videoId ? videoIndex.get(videoId) || null : null;
  const fullDurationSec = Math.max(
    0,
    Number(video?.durationSec) || 0,
  );
  const trimInRaw = Number(raw.inSec);
  const trimIn = Number.isFinite(trimInRaw) && trimInRaw > 0 ? roundSec(trimInRaw) : 0;
  const trimOutRaw = Number(raw.outSec);
  const trimOut =
    Number.isFinite(trimOutRaw) && trimOutRaw > 0
      ? roundSec(Math.min(trimOutRaw, fullDurationSec || trimOutRaw))
      : fullDurationSec || null;
  let durationSec = trimOut !== null ? Math.max(MIN_CLIP_DURATION, trimOut - trimIn) : 4;
  // Audio clips with no trimOut: assume 4s placeholder; users can extend.
  if (raw.mediaPath && !raw.videoId && (raw.outSec === null || raw.outSec === undefined)) {
    durationSec = trimOut !== null ? Math.max(MIN_CLIP_DURATION, trimOut - trimIn) : 4;
  }
  const explicitStart = Number(raw.startSec);
  let startSec: number;
  if (Number.isFinite(explicitStart) && explicitStart >= 0) {
    startSec = roundSec(explicitStart);
  } else {
    startSec = roundSec(prevEndOnTrack.get(track) || 0);
  }
  const enabled = raw.enabled !== false;
  const volume = clamp(
    Number.isFinite(Number(raw.volume)) ? Number(raw.volume) : 1,
    0,
    2,
  );
  const fadeInSec = Math.max(0, Number(raw.fadeInSec) || 0);
  const fadeOutSec = Math.max(0, Number(raw.fadeOutSec) || 0);
  const sourceKind: NormalizedClip["source"] = rawMediaPath && !videoId
    ? "audio"
    : videoId
      ? "video"
      : "gap";
  const label =
    (typeof raw.label === "string" && raw.label.trim() ? raw.label : "")
      || (video ? videoLabel(video) : "")
      || (rawMediaPath ? rawMediaPath.split("/").pop() || "Audio" : `Clip ${fallbackOrderIndex + 1}`);
  prevEndOnTrack.set(track, startSec + durationSec);
  return {
    id,
    track,
    startSec,
    durationSec,
    trimInSec: trimIn,
    trimOutSec: trimOut,
    fullDurationSec,
    videoId,
    promptId,
    mediaPath: rawMediaPath || video?.path || null,
    enabled,
    volume,
    fadeInSec,
    fadeOutSec,
    label,
    source: sourceKind,
    raw,
  };
}

function normalizeAllClips(project: ForgeProjectData): NormalizedClip[] {
  const videoIndex = new Map<string, VideoEntry>();
  for (const video of safeVideoEntries(project)) videoIndex.set(video.id, video);
  const raw = safeTimelineEntries(project).slice().sort((a, b) => {
    const trackA = isTimelineTrack(a.track) ? a.track : "V1";
    const trackB = isTimelineTrack(b.track) ? b.track : "V1";
    if (trackA !== trackB) return TRACKS.indexOf(trackA) - TRACKS.indexOf(trackB);
    const aStart = Number(a.startSec);
    const bStart = Number(b.startSec);
    if (Number.isFinite(aStart) && Number.isFinite(bStart) && aStart !== bStart) return aStart - bStart;
    return (a.orderIndex || 0) - (b.orderIndex || 0);
  });
  const prevEnd = new Map<TimelineTrack, number>();
  return raw.map((clip, idx) => normalizeClip(clip, prevEnd, videoIndex, idx));
}

function clipsByTrack(clips: NormalizedClip[]) {
  const out: Record<TimelineTrack, NormalizedClip[]> = {
    V1: [],
    V2: [],
    A1: [],
    A2: [],
  };
  for (const clip of clips) out[clip.track].push(clip);
  for (const t of TRACKS) out[t].sort((a, b) => a.startSec - b.startSec);
  return out;
}

function persistClips(
  normalized: NormalizedClip[],
): TimelineClip[] {
  return normalized
    .slice()
    .sort((a, b) => {
      if (a.track !== b.track) return TRACKS.indexOf(a.track) - TRACKS.indexOf(b.track);
      return a.startSec - b.startSec;
    })
    .map((clip, orderIndex): TimelineClip => ({
      id: clip.id,
      promptId: clip.promptId,
      videoId: clip.videoId,
      mediaPath: clip.mediaPath,
      inSec: clip.trimInSec > 0 ? roundSec(clip.trimInSec) : null,
      outSec:
        clip.trimOutSec !== null && clip.trimOutSec > 0
          ? roundSec(clip.trimOutSec)
          : null,
      startSec: roundSec(clip.startSec),
      track: clip.track,
      enabled: clip.enabled,
      volume: clip.volume === 1 ? null : roundSec(clip.volume),
      fadeInSec: clip.fadeInSec > 0 ? roundSec(clip.fadeInSec) : null,
      fadeOutSec: clip.fadeOutSec > 0 ? roundSec(clip.fadeOutSec) : null,
      label: clip.label || null,
      orderIndex,
    }));
}

function newClipId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `clip-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `clip-${Math.random().toString(36).slice(2, 10)}`;
}

// Module-scoped peaks cache. Web Audio decode is expensive; one analysis
// per audio path is enough across re-mounts of the editor.
const waveformPeaksCache = new Map<string, number[]>();
const waveformInflight = new Map<string, Promise<number[] | null>>();
const PEAKS_PER_SECOND = 12;
const MAX_PEAK_SAMPLES = 1500;

async function loadWaveformPeaks(audioUrl: string, cacheKey: string): Promise<number[] | null> {
  if (waveformPeaksCache.has(cacheKey)) return waveformPeaksCache.get(cacheKey)!;
  const inflight = waveformInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const response = await fetch(audioUrl);
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      const ContextCtor =
        (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext })
          .OfflineAudioContext
        || (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      // Decode via a real (online) context first because OfflineAudioContext
      // requires up-front knowledge of duration / channels / sampleRate.
      const ACtor =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!ACtor) return null;
      const ac = new ACtor();
      try {
        const decoded = await ac.decodeAudioData(buffer.slice(0));
        const channels = decoded.numberOfChannels;
        const length = decoded.length;
        const targetSamples = Math.min(
          MAX_PEAK_SAMPLES,
          Math.max(8, Math.round(decoded.duration * PEAKS_PER_SECOND)),
        );
        const samplesPerPeak = Math.max(1, Math.floor(length / targetSamples));
        const peaks: number[] = new Array(targetSamples);
        const data: Float32Array[] = [];
        for (let c = 0; c < channels; c += 1) data.push(decoded.getChannelData(c));
        for (let p = 0; p < targetSamples; p += 1) {
          const start = p * samplesPerPeak;
          const end = Math.min(length, start + samplesPerPeak);
          let max = 0;
          for (let s = start; s < end; s += 1) {
            for (let c = 0; c < channels; c += 1) {
              const v = Math.abs(data[c][s] || 0);
              if (v > max) max = v;
            }
          }
          peaks[p] = max;
        }
        waveformPeaksCache.set(cacheKey, peaks);
        return peaks;
      } finally {
        try { void ac.close(); } catch { /* ignore */ }
      }
      void ContextCtor; // satisfy unused
    } catch {
      return null;
    }
  })();
  waveformInflight.set(cacheKey, promise);
  promise.finally(() => waveformInflight.delete(cacheKey));
  return promise;
}

function useWaveformPeaks(mediaPath: string | null, audioUrl: string): number[] | null {
  const [loadedPeaks, setLoadedPeaks] = useState<{ mediaPath: string; peaks: number[] | null } | null>(null);
  const cachedPeaks = mediaPath ? waveformPeaksCache.get(mediaPath) || null : null;
  const peaks = cachedPeaks || (loadedPeaks?.mediaPath === mediaPath ? loadedPeaks.peaks : null);
  useEffect(() => {
    if (!mediaPath || !audioUrl) {
      return;
    }
    let cancelled = false;
    if (waveformPeaksCache.has(mediaPath)) {
      return;
    }
    void loadWaveformPeaks(audioUrl, mediaPath).then((result) => {
      if (cancelled) return;
      setLoadedPeaks({ mediaPath, peaks: result });
    });
    return () => {
      cancelled = true;
    };
  }, [audioUrl, mediaPath]);
  return peaks;
}

function WaveformSvg({ peaks, width, height }: { peaks: number[]; width: number; height: number }) {
  if (!peaks.length || width <= 0 || height <= 0) return null;
  const step = width / peaks.length;
  const center = height / 2;
  const path: string[] = [];
  for (let i = 0; i < peaks.length; i += 1) {
    const x = i * step;
    const peak = peaks[i];
    const h = Math.max(0.5, peak * (height - 4));
    path.push(`M${x.toFixed(2)},${(center - h / 2).toFixed(2)}L${x.toFixed(2)},${(center + h / 2).toFixed(2)}`);
  }
  return (
    <svg
      className="workshop-clip-waveform"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      <path d={path.join(" ")} stroke="currentColor" strokeWidth={1} strokeLinecap="round" />
    </svg>
  );
}

function ClipWaveform({
  mediaPath,
  projectDir,
  width,
  height,
}: {
  mediaPath: string;
  projectDir: string;
  width: number;
  height: number;
}) {
  const url = useMemo(() => indexMediaSrc(projectDir, mediaPath), [mediaPath, projectDir]);
  const peaks = useWaveformPeaks(mediaPath, url);
  if (!peaks) return null;
  return <WaveformSvg peaks={peaks} width={width} height={height} />;
}

interface PendingTimelineEdit {
  description: string;
  build: (clips: NormalizedClip[]) => NormalizedClip[];
}

function computeTotalDuration(clips: NormalizedClip[]) {
  let max = 0;
  for (const clip of clips) {
    const end = clip.startSec + clip.durationSec;
    if (end > max) max = end;
  }
  return max;
}

function clipAtTime(track: NormalizedClip[], sec: number): NormalizedClip | null {
  for (const clip of track) {
    if (!clip.enabled || !clip.mediaPath || clip.source !== "video") continue;
    if (sec >= clip.startSec - 0.001 && sec < clip.startSec + clip.durationSec - 0.001) {
      return clip;
    }
  }
  return null;
}

const TIMELINE_SEEK_EPSILON_PAUSED = 0.04;
// Tightened from 0.45 → 0.15 so the timeline-visual playhead can't
// race more than ~150ms ahead of the actual rendered video frame.
// Above 0.15s the user perceives "video frozen, timeline keeps going"
// — exactly the conflict symptom we're chasing.
const TIMELINE_SEEK_EPSILON_PLAYING = 0.15;

interface VideoElementSyncState {
  src: string;
  clipId: string | null;
}

interface AudioElementSyncState {
  el: HTMLAudioElement;
  src: string;
}

function clipLocalTime(clip: NormalizedClip, playheadSec: number) {
  const raw = clip.trimInSec + (playheadSec - clip.startSec);
  const min = Math.max(0, clip.trimInSec);
  const clipOut =
    clip.trimOutSec !== null && clip.trimOutSec > min
      ? clip.trimOutSec
      : clip.fullDurationSec > min
        ? clip.fullDurationSec
        : raw;
  const max = Math.max(min, clipOut - 0.02);
  return clamp(raw, min, max);
}

function clearVideoElement(
  el: HTMLVideoElement,
  syncRef: MutableRefObject<VideoElementSyncState>,
) {
  syncRef.current = { src: "", clipId: null };
  try { el.pause(); } catch { /* ignore */ }
  if (el.getAttribute("src")) {
    el.removeAttribute("src");
    try { el.load(); } catch { /* ignore */ }
  }
}

function maybePlay(el: HTMLVideoElement, isPlaying: boolean) {
  if (isPlaying) {
    if (el.paused) {
      void el.play().catch((err) => {
        // Surface Chromium media errors instead of silencing them — this
        // is exactly what hid the protocol/autoplay/codec bugs for days.
        // err.name is typically NotAllowedError | NotSupportedError |
        // AbortError. el.error?.code maps to MEDIA_ERR_ABORTED(1)/
        // _NETWORK(2)/_DECODE(3)/_SRC_NOT_SUPPORTED(4).
        console.warn("[workshop] video.play() rejected", {
          err: err?.name || String(err),
          message: err?.message,
          mediaErrorCode: el.error?.code,
          mediaErrorMessage: el.error?.message,
          src: el.currentSrc || el.getAttribute("src"),
          readyState: el.readyState,
          paused: el.paused,
          muted: el.muted,
        });
      });
    }
  } else {
    try { el.pause(); } catch { /* ignore */ }
  }
}

function syncBinPreviewVideoElement(
  el: HTMLVideoElement,
  src: string,
  syncRef: MutableRefObject<VideoElementSyncState>,
) {
  if (!src) {
    clearVideoElement(el, syncRef);
    return;
  }
  const changed = syncRef.current.src !== src || syncRef.current.clipId !== "__bin__";
  if (changed || el.getAttribute("src") !== src) {
    syncRef.current = { src, clipId: "__bin__" };
    el.src = src;
    try { el.load(); } catch { /* ignore */ }
    const seekStart = () => {
      if (syncRef.current.src !== src || syncRef.current.clipId !== "__bin__") return;
      // Some codecs don't paint frame 0 until seeked; nudge past 0.
      try { el.currentTime = 0.05; } catch { /* ignore */ }
    };
    el.addEventListener("loadedmetadata", seekStart, { once: true });
  }
  if (el.paused) {
    void el.play().catch((err) => {
      console.warn("[workshop] bin-preview play() rejected", {
        err: err?.name || String(err),
        message: err?.message,
        mediaErrorCode: el.error?.code,
        src: el.currentSrc,
        readyState: el.readyState,
      });
    });
  }
}

function syncTimelineVideoElement({
  el,
  clip,
  projectDir,
  playheadSecRef,
  isPlaying,
  syncRef,
}: {
  el: HTMLVideoElement;
  clip: NormalizedClip;
  projectDir: string;
  /** Live playhead reference — read inside async callbacks where captured
   *  render props can be stale by the time media events fire. */
  playheadSecRef: MutableRefObject<number>;
  isPlaying: boolean;
  syncRef: MutableRefObject<VideoElementSyncState>;
}) {
  if (!clip.mediaPath) {
    clearVideoElement(el, syncRef);
    return;
  }
  const src = indexMediaSrc(projectDir, clip.mediaPath);
  const changed = syncRef.current.src !== src || syncRef.current.clipId !== clip.id;
  const currentSrc = el.getAttribute("src") || "";
  const seekTolerance = isPlaying ? TIMELINE_SEEK_EPSILON_PLAYING : TIMELINE_SEEK_EPSILON_PAUSED;

  const seekAndPlayback = (force: boolean) => {
    if (syncRef.current.src !== src || syncRef.current.clipId !== clip.id) return;
    // Recompute localSec from the LIVE playhead. When this is invoked
    // from a deferred loadedmetadata listener (clip swap path), the
    // wall-clock RAF has advanced 100-500ms past the playheadSec
    // captured at effect-run time. Using the stale value made every
    // new clip start behind the playhead — the visual "timeline races,
    // video frozen" conflict the user reported.
    const liveLocalSec = clipLocalTime(clip, playheadSecRef.current);
    const duration = Number(el.duration);
    // Floor the seek at 0.05s — some codecs don't paint frame 0 until seeked.
    const maxLocal = Number.isFinite(duration) && duration > 0
      ? Math.max(0.05, Math.min(liveLocalSec, duration - 0.02))
      : Math.max(0.05, liveLocalSec);
    const current = Number(el.currentTime);
    const drift = Number.isFinite(current) ? Math.abs(current - maxLocal) : Number.POSITIVE_INFINITY;
    const wantSeek = force || drift > seekTolerance;
    if (wantSeek) {
      // Death-spiral guard: when the element is mid-seek or hasn't
      // buffered HAVE_CURRENT_DATA yet, every additional currentTime=
      // restarts the buffer fill from scratch. The wall-clock RAF
      // ticks at 60Hz, so an unguarded drift correction floods the
      // element with seeks faster than it can buffer — element stays
      // pinned at readyState=1, fires `waiting` continuously, and
      // audio decoder produces hiccups/clicks on every interrupted
      // segment. Forced seeks (clip change, fresh src) still go
      // through because the load() reset means we MUST set the start
      // position before play() can do anything useful.
      const elementBusy = el.seeking || el.readyState < 2;
      if (force || !elementBusy) {
        try { el.currentTime = maxLocal; } catch { /* ignore */ }
      }
    }
    maybePlay(el, isPlaying);
  };

  if (changed || currentSrc !== src) {
    syncRef.current = { src, clipId: clip.id };
    el.src = src;
    // Defensive unmute on every src swap. Chromium's autoplay policy
    // implicitly mutes elements that try to play without an active user
    // gesture; the timeline UI has no mute control so a silent element
    // means broken audio for generated takes with embedded sound.
    el.muted = false;
    try { el.load(); } catch { /* ignore */ }
    // Seek + play happen ONLY after metadata loads — setting currentTime
    // on a NaN-duration element is silently rejected by Chromium, which
    // is why the preview was sticking at 0:00 with the playhead elsewhere.
    el.addEventListener("loadedmetadata", () => seekAndPlayback(true), { once: true });
    // Belt-and-braces: queue a play() now too. Chromium accepts play()
    // on a loading element and starts as soon as enough data is buffered.
    // Without this, if loadedmetadata is racy or the listener missed
    // the event (cached file fires synchronously in some Chromium
    // builds), the new clip would never start playing.
    if (isPlaying) {
      void el.play().catch((err) => {
        console.warn("[workshop] timeline play()-on-load rejected", {
          err: err?.name || String(err),
          message: err?.message,
          mediaErrorCode: el.error?.code,
          src: el.currentSrc,
          readyState: el.readyState,
          clipId: clip.id,
        });
      });
    }
    return;
  }

  seekAndPlayback(changed);
}

function buildVideoExportClips(clips: NormalizedClip[]) {
  const v1 = clips.filter((c) => c.track === "V1" && c.enabled && c.source === "video" && c.mediaPath);
  v1.sort((a, b) => a.startSec - b.startSec);
  return v1.map((clip) => ({
    videoPath: clip.mediaPath as string,
    inSec: clip.trimInSec > 0 ? clip.trimInSec : null,
    outSec: clip.trimOutSec !== null && clip.trimOutSec > 0 ? clip.trimOutSec : null,
  }));
}

function buildWorkshopNLEPayload(clips: NormalizedClip[]) {
  const enabled = clips.filter((c) => c.enabled && c.mediaPath);
  const v1Clips = enabled
    .filter((c) => c.track === "V1" && c.source === "video")
    .map((c) => ({
      mediaPath: c.mediaPath as string,
      startSec: c.startSec,
      inSec: c.trimInSec > 0 ? c.trimInSec : null,
      outSec: c.trimOutSec !== null && c.trimOutSec > 0 ? c.trimOutSec : null,
    }));
  const v2Clips = enabled
    .filter((c) => c.track === "V2" && c.source === "video")
    .map((c) => ({
      mediaPath: c.mediaPath as string,
      startSec: c.startSec,
      inSec: c.trimInSec > 0 ? c.trimInSec : null,
      outSec: c.trimOutSec !== null && c.trimOutSec > 0 ? c.trimOutSec : null,
    }));
  const audioClips = enabled
    .filter((c) => (c.track === "A1" || c.track === "A2") && c.source === "audio")
    .map((c) => ({
      mediaPath: c.mediaPath as string,
      startSec: c.startSec,
      inSec: c.trimInSec > 0 ? c.trimInSec : null,
      outSec: c.trimOutSec !== null && c.trimOutSec > 0 ? c.trimOutSec : null,
      volume: c.volume,
      fadeInSec: c.fadeInSec || null,
      fadeOutSec: c.fadeOutSec || null,
    }));
  const totalDurationSec = computeTotalDuration(enabled);
  return { v1Clips, v2Clips, audioClips, totalDurationSec };
}

export function WorkshopNLE({
  project,
  projectDir,
  onSaveProject,
  onNotice,
  touchedPathSet,
  agentSelectedClipIds,
  agentWorking,
  onRevealPath,
  onImportMedia,
}: WorkshopNLEProps) {
  const reducedMotion = useReducedMotion();
  const handleBinImport = useCallback(
    async (filePaths: string[] | null) => {
      if (!onImportMedia) return { videos: [], audio: [] };
      try {
        const result = await onImportMedia(filePaths);
        const videoCount = result.videos.length;
        const audioCount = result.audio.length;
        const total = videoCount + audioCount;
        if (total > 0 && onNotice) {
          const parts = [
            videoCount ? `${videoCount} video${videoCount === 1 ? "" : "s"}` : null,
            audioCount ? `${audioCount} audio` : null,
          ].filter(Boolean);
          onNotice(`Imported ${parts.join(" + ")}.`, "success");
        }
        return result;
      } catch (error) {
        if (onNotice) {
          onNotice(error instanceof Error ? error.message : "Import failed.", "error");
        }
        return { videos: [], audio: [] };
      }
    },
    [onImportMedia, onNotice],
  );
  const [binWidth, setBinWidth] = useState<number>(() => {
    try {
      const stored = window.localStorage.getItem("anvil:workshop-bin-width");
      const n = stored ? Number(stored) : NaN;
      return Number.isFinite(n) && n >= 220 && n <= 600 ? n : 320;
    } catch {
      return 320;
    }
  });
  const [draggingBin, setDraggingBin] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem("anvil:workshop-bin-width", String(binWidth));
    } catch { /* ignore */ }
  }, [binWidth]);
  const startBinResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingBin(true);
    const startX = event.clientX;
    const startWidth = binWidth;
    const onMove = (e: PointerEvent) => {
      const next = clamp(startWidth + (e.clientX - startX), 220, 600);
      setBinWidth(next);
    };
    const onUp = () => {
      setDraggingBin(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [binWidth]);
  const [pixelsPerSec, setPixelsPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playheadSec, setPlayheadSec] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Blade-mode tool retired — Split at playhead (toolbar button or `S`
  // key) covers the same need without making the user maintain a mode.
  const [busy, setBusy] = useState<"export" | null>(null);
  const [hoverLane, setHoverLane] = useState<TimelineTrack | null>(null);
  const [exportBanner, setExportBanner] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhostState | null>(null);
  // Bin-preview source: when no V1 clip sits at the playhead, single-clicking
  // a bin tile loads the raw source into the preview pane with native
  // controls so the user can scrub it without committing to the timeline.
  const [binPreviewItem, setBinPreviewItem] = useState<BinItem | null>(null);
  // Right-click context menu for timeline clips. `x`/`y` are viewport
  // coordinates so the menu stays anchored to the cursor regardless of
  // scroll. Closing is wired to outside-click + Escape.
  const [clipContextMenu, setClipContextMenu] = useState<{
    x: number;
    y: number;
    clipId: string;
  } | null>(null);
  const [binContextMenu, setBinContextMenu] = useState<{
    x: number;
    y: number;
    item: BinItem;
  } | null>(null);

  const clipDragRef = useRef<ClipDragState | null>(null);
  // TWO independent V1 video elements — one for bin preview (with native
  // controls), one for timeline playback (controlled by the transport).
  // They never coexist in the DOM: isBinPreviewing toggles which one is
  // mounted. Mixing them on a single <video> element used to cause a
  // pile of edge cases (shared el.load() interrupting each other,
  // gesture-token loss across mode switch, muted-flap on src swap).
  // With the split, each side has its own state machine and they don't
  // touch each other.
  const binPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const timelineVideoRef = useRef<HTMLVideoElement | null>(null);
  const overlayVideoRef = useRef<HTMLVideoElement | null>(null);
  const binPreviewSyncRef = useRef<VideoElementSyncState>({ src: "", clipId: null });
  const timelineSyncRef = useRef<VideoElementSyncState>({ src: "", clipId: null });
  const overlaySyncRef = useRef<VideoElementSyncState>({ src: "", clipId: null });
  const audioElementsRef = useRef<Map<string, AudioElementSyncState>>(new Map());
  const playStartedAtRef = useRef<{ wallClock: number; sequenceSec: number } | null>(null);
  const playheadSecRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollDeltaRef = useRef<number>(0);
  const pendingRevealClipIdRef = useRef<string | null>(null);
  const suppressNextClipClickRef = useRef(false);
  // Tracks whether the user has explicitly tweaked zoom (via +/-, wheel,
  // or cmd-scroll). Auto-fit only fires while this is false so it doesn't
  // fight the user's deliberate zoom level.
  const userZoomedRef = useRef<boolean>(false);
  const initialTimelineAutoFitDoneRef = useRef<boolean>(false);

  // Real-time agent feedback overlays. These are pure UI state — the
  // canonical clip data still flows through the `project` prop, which
  // the disk watcher refreshes after every write. The events below drive
  // the intent banner + per-clip pulses BEFORE that reload lands, so
  // the user sees the agent's work as it happens.
  const [agentIntent, setAgentIntent] = useState<
    | { message: string; clipIds: Set<string>; ts: number }
    | null
  >(null);
  // Map of clipId → expiry-ms timestamp. A clip mentioned in any event
  // gets a 1.4s pulse highlight after the change lands. Re-using the
  // map with a single ticker effect keeps re-renders cheap.
  const [recentEditClips, setRecentEditClips] = useState<Map<string, number>>(
    () => new Map(),
  );
  // Memoized Set of currently-pulsing clip ids. Rebuilds only when the
  // map's key set changes — avoids handing TimelinePanel a fresh Set on
  // every parent render, which would trip its own React reconciliation
  // even when nothing actually changed.
  const recentEditClipIdSet = useMemo(
    () => (recentEditClips.size ? new Set(recentEditClips.keys()) : undefined),
    [recentEditClips],
  );

  // Subscribe to granular timeline events from main-process tools. Each
  // event drives the intent banner and/or per-clip pulse — the canonical
  // clip data still flows through the `project` prop. The intent banner
  // auto-clears 12s after the last update so the user never gets stuck
  // looking at a stale "Agent is …" line.
  useEffect(() => {
    const off = window.forgeDesktop?.onTimelineEvent?.((event: TimelineEvent) => {
      const eventProjectDir = (event as { projectDir?: unknown }).projectDir;
      if (typeof eventProjectDir === "string" && eventProjectDir && eventProjectDir !== projectDir) {
        return;
      }
      const now = Date.now();
      if (event.kind === "intent") {
        setAgentIntent({
          message: event.message,
          clipIds: new Set(event.clipIds || []),
          ts: now,
        });
        if (event.clipIds && event.clipIds.length) {
          setRecentEditClips((prev) => {
            const next = new Map(prev);
            for (const id of event.clipIds!) next.set(id, now + 1400);
            return next;
          });
        }
        return;
      }
      if (event.kind === "intent-cleared") {
        setAgentIntent(null);
        return;
      }
      // Mutation events all touch one or more clip ids. Pulse them.
      const ids: string[] = [];
      if ("clipId" in event && event.clipId) ids.push(event.clipId);
      if (event.kind === "clip-split") {
        ids.push(event.leftId, event.rightId);
      }
      if (ids.length === 0) return;
      setRecentEditClips((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.set(id, now + 1400);
        return next;
      });
    });
    return () => off?.();
  }, [projectDir]);

  // (auto-scroll-to-recent-edit effect lives below `clips` definition)
  const lastFocusedAgentClipRef = useRef<string | null>(null);

  // Sweep expired pulses + intent-banner timeout. One ticker for both;
  // runs only while there's something to expire.
  useEffect(() => {
    const hasPulses = recentEditClips.size > 0;
    const hasIntent = !!agentIntent;
    if (!hasPulses && !hasIntent) return undefined;
    const handle = window.setInterval(() => {
      const now = Date.now();
      setRecentEditClips((prev) => {
        if (prev.size === 0) return prev;
        let dirty = false;
        const next = new Map(prev);
        for (const [id, expiry] of prev) {
          if (expiry <= now) {
            next.delete(id);
            dirty = true;
          }
        }
        return dirty ? next : prev;
      });
      setAgentIntent((prev) => (prev && now - prev.ts > 12_000 ? null : prev));
    }, 400);
    return () => window.clearInterval(handle);
  }, [recentEditClips.size, agentIntent]);

  const applyZoom = useCallback(
    (compute: number | ((prev: number) => number)) => {
      userZoomedRef.current = true;
      setPixelsPerSec((prev) => {
        const target = typeof compute === "function" ? compute(prev) : compute;
        const next = clamp(target, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
        if (next !== prev && timelineScrollRef.current) {
          pendingScrollDeltaRef.current += playheadSec * (next - prev);
        }
        return next;
      });
    },
    [playheadSec],
  );

  useEffect(() => {
    const scroller = timelineScrollRef.current;
    const delta = pendingScrollDeltaRef.current;
    if (scroller && delta) {
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft + delta);
    }
    pendingScrollDeltaRef.current = 0;
  }, [pixelsPerSec]);

  const rawVideoSpec = (project as { videoSpec?: unknown }).videoSpec;
  const videoSpec: VideoSpec = useMemo(() => safeVideoSpec(rawVideoSpec), [rawVideoSpec]);
  const fps = videoSpec.fps;
  const frameStep = 1 / fps;

  const binItems = useMemo(() => buildBinFromProject(project), [project]);

  const clips = useMemo(() => normalizeAllClips(project), [project]);
  const clipsPerTrack = useMemo(() => clipsByTrack(clips), [clips]);
  const visibleTracks = useMemo(
    () => TRACKS.filter((track) => track === "V1" || track === "A1" || clipsPerTrack[track].length > 0),
    [clipsPerTrack],
  );
  const totalDurationSec = useMemo(() => Math.max(8, computeTotalDuration(clips)), [clips]);

  const revealClipInTimeline = useCallback(
    (clip: NormalizedClip, behavior: ScrollBehavior) => {
      const scroller = timelineScrollRef.current;
      if (!scroller) return;
      const padding = 16;
      const clipLeftPx = clip.startSec * pixelsPerSec + LANE_GUTTER;
      const clipRightPx = clipLeftPx + clip.durationSec * pixelsPerSec;
      const viewLeft = scroller.scrollLeft;
      const viewRight = viewLeft + scroller.clientWidth;
      let nextLeft = viewLeft;

      if (clipLeftPx - padding < viewLeft) {
        nextLeft = clipLeftPx - padding;
      } else if (clipRightPx + padding > viewRight) {
        nextLeft = clipRightPx + padding - scroller.clientWidth;
      } else {
        return;
      }

      scroller.scrollTo({
        left: Math.max(0, nextLeft),
        behavior,
      });
    },
    [pixelsPerSec],
  );

  // When the agent edits a clip we don't currently see (out of view in
  // the timeline scroller), auto-scroll the timeline so the user can
  // actually watch the change happen. Throttled to once per pulse via
  // a ref so rapid agent batches don't fight the user's manual scroll.
  useEffect(() => {
    const ids = recentEditClips.size > 0 ? [...recentEditClips.keys()] : [];
    if (!ids.length) {
      lastFocusedAgentClipRef.current = null;
      return;
    }
    const target = ids[ids.length - 1];
    if (target === lastFocusedAgentClipRef.current) return;
    lastFocusedAgentClipRef.current = target;
    const clip = clips.find((c) => c.id === target);
    if (!clip) return;
    revealClipInTimeline(clip, reducedMotion ? "auto" : "smooth");
  }, [recentEditClips, clips, reducedMotion, revealClipInTimeline]);

  useEffect(() => {
    const clipId = pendingRevealClipIdRef.current;
    if (!clipId) return undefined;
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return undefined;
    pendingRevealClipIdRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      revealClipInTimeline(clip, reducedMotion ? "auto" : "smooth");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [clips, reducedMotion, revealClipInTimeline]);

  // Compute the px-per-second that fits the entire sequence within the
  // visible timeline width. Returns null if the scroller hasn't mounted yet
  // or there's nothing meaningful to fit. The 24px padding leaves room for
  // the rightmost ruler tick label so it doesn't get clipped.
  const computeFitPx = useCallback(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller || totalDurationSec <= 0) return null;
    const usable = scroller.clientWidth - LANE_GUTTER - 24;
    if (usable < 200) return null;
    return clamp(usable / totalDurationSec, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
  }, [totalDurationSec]);

  const fitTimelineToView = useCallback(() => {
    const fitPx = computeFitPx();
    if (fitPx === null) return;
    userZoomedRef.current = false;
    setPixelsPerSec(fitPx);
  }, [computeFitPx]);

  // Auto-fit only once for a freshly-loaded/non-empty timeline. Re-fitting
  // after every add/delete changes zoom and clamps scrollLeft, which reads as
  // the timeline "jumping" while the user is building an edit.
  useEffect(() => {
    if (!clips.length) {
      initialTimelineAutoFitDoneRef.current = false;
      return;
    }
    if (initialTimelineAutoFitDoneRef.current) return;
    initialTimelineAutoFitDoneRef.current = true;
    if (userZoomedRef.current) return;
    const fitPx = computeFitPx();
    if (fitPx === null) return;
    setPixelsPerSec((prev) => {
      const overflowing = totalDurationSec * prev > (timelineScrollRef.current?.clientWidth ?? 0) - LANE_GUTTER - 24;
      return overflowing ? fitPx : prev;
    });
  }, [clips.length, totalDurationSec, computeFitPx]);

  const selectedClip = useMemo(
    () => (selectedClipId ? clips.find((c) => c.id === selectedClipId) || null : null),
    [clips, selectedClipId],
  );

  // Synchronously pump play() on the timeline video from inside the
  // click handler so any residual autoplay policy sees a live user
  // gesture. With autoplayPolicy='no-user-gesture-required' set on the
  // BrowserWindow this is mostly belt-and-braces, but it still helps
  // when the timeline element has just been mounted (bin → timeline
  // mode switch) and the sync effect hasn't fired yet. Tolerant of
  // null ref — the element may not be in the DOM at click time.
  const pumpUserGesturePlay = useCallback(() => {
    const el = timelineVideoRef.current;
    if (!el) return;
    el.muted = false;
    void el.play().catch((err) => {
      console.warn("[workshop] gesture-pump play() rejected", {
        err: (err as { name?: string })?.name || String(err),
        message: (err as { message?: string })?.message,
        mediaErrorCode: el.error?.code,
        src: el.currentSrc,
        readyState: el.readyState,
      });
    });
  }, []);

  const startTimelinePlayback = useCallback(() => {
    setBinPreviewItem(null);
    if (playheadSecRef.current >= totalDurationSec - 0.05) {
      playheadSecRef.current = 0;
      setPlayheadSec(0);
    }
    pumpUserGesturePlay();
    setIsPlaying(true);
  }, [totalDurationSec, pumpUserGesturePlay]);

  const toggleTimelinePlayback = useCallback(() => {
    setBinPreviewItem(null);
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (playheadSecRef.current >= totalDurationSec - 0.05) {
      playheadSecRef.current = 0;
      setPlayheadSec(0);
    }
    pumpUserGesturePlay();
    setIsPlaying(true);
  }, [isPlaying, totalDurationSec, pumpUserGesturePlay]);

  const seekTimeline = useCallback(
    (sec: number) => {
      setBinPreviewItem(null);
      const next = clamp(sec, 0, totalDurationSec);
      playheadSecRef.current = next;
      setPlayheadSec(next);
      if (isPlaying) {
        playStartedAtRef.current = { wallClock: performance.now(), sequenceSec: next };
      }
    },
    [isPlaying, totalDurationSec],
  );

  const selectTimelineClip = useCallback(
    (clip: NormalizedClip | null) => {
      setBinPreviewItem(null);
      setSelectedClipId(clip?.id || null);
      if (!clip) return;
      if (suppressNextClipClickRef.current) {
        suppressNextClipClickRef.current = false;
        return;
      }
      const current = playheadSecRef.current;
      const insideClip = current >= clip.startSec && current < clip.startSec + clip.durationSec;
      if (!insideClip) seekTimeline(clip.startSec);
    },
    [seekTimeline],
  );

  const persistAndSave = useCallback(
    async (nextClips: NormalizedClip[], description?: string) => {
      const persisted = persistClips(nextClips);
      const next: ForgeProjectData = {
        ...project,
        timeline: persisted,
        project: {
          ...project.project,
          updatedAt: new Date().toISOString(),
        },
      };
      try {
        await onSaveProject(next);
        if (description && onNotice) onNotice(description, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Save failed.";
        if (onNotice) onNotice(message, "error");
      }
    },
    [project, onSaveProject, onNotice],
  );

  const applyEdit = useCallback(
    (edit: PendingTimelineEdit) => {
      const next = edit.build(clips);
      void persistAndSave(next, edit.description);
    },
    [clips, persistAndSave],
  );

  const insertBinItemAt = useCallback(
    (item: BinItem, track: TimelineTrack, atSec: number) => {
      const desiredKind = TRACK_KIND[track];
      const itemKind = item.kind === "video" ? "video" : "audio";
      if (desiredKind !== itemKind) {
        if (onNotice) {
          onNotice(
            itemKind === "video"
              ? "Video clips go on V1 or V2."
              : "Audio clips go on A1 or A2.",
            "info",
          );
        }
        return;
      }
      // First drop on an empty matching track snaps to 0 — users almost
      // always want to start the sequence at the head, not at "wherever
      // the cursor landed". After that, drops respect the cursor's sec
      // BUT slide to the nearest non-overlapping slot so we don't stack
      // a new clip on top of an existing one.
      const trackHasClip = clips.some((c) => c.track === track);
      // Estimate the new clip's duration so the overlap check has a
      // reasonable interval. For audio, item.durationSec is reliable.
      // For video, look up the source video's full duration; falls
      // back to 4s if unknown (matches normalizeClip's default).
      const estimatedDuration = (() => {
        if (item.kind === "audio") {
          return Number.isFinite(item.durationSec || NaN) && (item.durationSec || 0) > 0
            ? (item.durationSec as number)
            : 4;
        }
        const videoEntry = safeVideoEntries(project).find((v) => v.id === item.id);
        const dur = Number(videoEntry?.durationSec) || 0;
        if (dur > 0) return dur;
        return Number.isFinite(item.durationSec || NaN) && (item.durationSec || 0) > 0
          ? (item.durationSec as number)
          : 4;
      })();
      const desiredStart = !trackHasClip ? 0 : roundSec(Math.max(0, atSec));
      const startSec = !trackHasClip
        ? 0
        : findNonOverlappingStart(clips, track, "", desiredStart, estimatedDuration);
      const audioDuration =
        item.kind === "audio" && item.durationSec && Number.isFinite(item.durationSec)
          ? roundSec(item.durationSec)
          : null;
      const newClip: TimelineClip = {
        id: newClipId(),
        promptId: null,
        videoId: item.kind === "video" ? item.id : null,
        mediaPath: item.kind === "audio" ? item.mediaPath : null,
        inSec: null,
        outSec: audioDuration,
        enabled: true,
        orderIndex: clips.length,
        track,
        startSec,
        volume: null,
        fadeInSec: null,
        fadeOutSec: null,
        label: item.label,
      };
      pendingRevealClipIdRef.current = newClip.id;
      applyEdit({
        description: `Added ${item.label} to ${track}`,
        build: () => {
          const videoIndex = new Map<string, VideoEntry>();
          for (const video of safeVideoEntries(project)) videoIndex.set(video.id, video);
          const prevEnd = new Map<TimelineTrack, number>();
          // Re-normalize all existing + new clip together so layout stays clean.
          const raws = safeTimelineEntries(project).slice();
          raws.push(newClip);
          raws.sort((a, b) => {
            const ta = isTimelineTrack(a.track) ? a.track : "V1";
            const tb = isTimelineTrack(b.track) ? b.track : "V1";
            if (ta !== tb) return TRACKS.indexOf(ta) - TRACKS.indexOf(tb);
            const sa = Number(a.startSec);
            const sb = Number(b.startSec);
            if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
            return (a.orderIndex || 0) - (b.orderIndex || 0);
          });
          return raws.map((c, i) => normalizeClip(c, prevEnd, videoIndex, i));
        },
      });
      setSelectedClipId(newClip.id);
      // Jump the playhead to the new clip's start so the preview pane
      // immediately shows it instead of staying blank at "no V1 clip at
      // playhead" — Sequence Editor does the same on _add_to_sequence.
      setBinPreviewItem(null);
      playheadSecRef.current = startSec;
      setPlayheadSec(startSec);
      if (isPlaying) {
        playStartedAtRef.current = { wallClock: performance.now(), sequenceSec: startSec };
      }
    },
    [applyEdit, clips, isPlaying, onNotice, project],
  );

  const moveClip = useCallback(
    (clipId: string, nextTrack: TimelineTrack, nextStartSec: number) => {
      applyEdit({
        description: `Moved clip`,
        build: (current) =>
          current.map((c) => {
            if (c.id !== clipId) return c;
            const allowed = TRACK_KIND[nextTrack] === (c.source === "audio" ? "audio" : "video");
            if (!allowed) return c;
            return { ...c, track: nextTrack, startSec: roundSec(Math.max(0, nextStartSec)) };
          }),
      });
    },
    [applyEdit],
  );

  const trimClip = useCallback(
    (clipId: string, edge: "start" | "end", deltaSec: number) => {
      applyEdit({
        description: `Trimmed clip`,
        build: (current) =>
          current.map((c) => {
            if (c.id !== clipId) return c;
            if (edge === "start") {
              const maxIn = (c.trimOutSec ?? c.fullDurationSec ?? c.durationSec) - MIN_CLIP_DURATION;
              const nextIn = clamp(c.trimInSec + deltaSec, 0, Math.max(0, maxIn));
              const trimDelta = nextIn - c.trimInSec;
              return {
                ...c,
                trimInSec: roundSec(nextIn),
                startSec: roundSec(c.startSec + trimDelta),
                durationSec: roundSec(Math.max(MIN_CLIP_DURATION, c.durationSec - trimDelta)),
              };
            }
            const baseOut = c.trimOutSec ?? c.fullDurationSec ?? c.trimInSec + c.durationSec;
            const minOut = c.trimInSec + MIN_CLIP_DURATION;
            const maxOut = c.fullDurationSec > 0 ? c.fullDurationSec : baseOut + 60;
            const nextOut = clamp(baseOut + deltaSec, minOut, maxOut);
            return {
              ...c,
              trimOutSec: roundSec(nextOut),
              durationSec: roundSec(Math.max(MIN_CLIP_DURATION, nextOut - c.trimInSec)),
            };
          }),
      });
    },
    [applyEdit],
  );

  const splitClipAtPlayhead = useCallback(
    (clipId: string, atSec: number) => {
      applyEdit({
        description: `Split at ${formatTimecode(atSec)}`,
        build: (current) => {
          const out: NormalizedClip[] = [];
          for (const c of current) {
            if (c.id !== clipId) {
              out.push(c);
              continue;
            }
            const localOffset = atSec - c.startSec;
            if (localOffset <= MIN_CLIP_DURATION || localOffset >= c.durationSec - MIN_CLIP_DURATION) {
              out.push(c);
              continue;
            }
            const splitSourceSec = c.trimInSec + localOffset;
            const left: NormalizedClip = {
              ...c,
              trimOutSec: roundSec(splitSourceSec),
              durationSec: roundSec(localOffset),
            };
            const right: NormalizedClip = {
              ...c,
              id: newClipId(),
              startSec: roundSec(c.startSec + localOffset),
              trimInSec: roundSec(splitSourceSec),
              trimOutSec: c.trimOutSec,
              durationSec: roundSec(c.durationSec - localOffset),
            };
            out.push(left, right);
          }
          return out;
        },
      });
    },
    [applyEdit],
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      applyEdit({
        description: `Removed clip`,
        build: (current) => current.filter((c) => c.id !== clipId),
      });
      if (selectedClipId === clipId) setSelectedClipId(null);
    },
    [applyEdit, selectedClipId],
  );

  const handleClipContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, clip: NormalizedClip) => {
      event.preventDefault();
      event.stopPropagation();
      setBinPreviewItem(null);
      setSelectedClipId(clip.id);
      setClipContextMenu({ x: event.clientX, y: event.clientY, clipId: clip.id });
    },
    [],
  );

  useEffect(() => {
    if (!clipContextMenu) return undefined;
    const close = () => setClipContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [clipContextMenu]);

  useEffect(() => {
    if (!binContextMenu) return undefined;
    const close = () => setBinContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [binContextMenu]);

  const handleBinContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, item: BinItem) => {
      event.preventDefault();
      event.stopPropagation();
      setBinContextMenu({ x: event.clientX, y: event.clientY, item });
    },
    [],
  );

  // Delete a bin entry through the existing IPC. Videos remove the
  // VideoEntry record AND drop the source file from disk; audio entries
  // detach only the selected media variant and move it back to Media.
  const deleteBinItem = useCallback(
    async (item: BinItem) => {
      if (!projectDir) return;
      try {
        if (item.kind === "video") {
          if (window.forgeDesktop?.deleteVideoEntry) {
            await window.forgeDesktop.deleteVideoEntry(projectDir, item.id);
          }
        } else {
          // BinAudioItem id is `${assetId}::${mediaId}` — split it back
          // and call the variant-detach IPC. The renderer's own
          // refreshCurrentProject pulls the watcher update.
          const [assetId, mediaId] = String(item.id).split("::");
          if (assetId && mediaId && window.forgeDesktop?.detachAssetVariant) {
            await window.forgeDesktop.detachAssetVariant(projectDir, "audio", assetId, mediaId);
          }
        }
      } catch (error) {
        if (onNotice) {
          onNotice(error instanceof Error ? error.message : "Failed to remove media.", "error");
        }
      }
    },
    [projectDir, onNotice],
  );

  // Duplicate a clip in place — the copy lands immediately after the
  // original and inherits its trim window so the result plays an
  // identical second take of the same source range.
  const duplicateClip = useCallback(
    (clipId: string) => {
      const source = clips.find((c) => c.id === clipId);
      if (!source) return;
      const newId = newClipId();
      pendingRevealClipIdRef.current = newId;
      applyEdit({
        description: `Duplicated clip`,
        build: (current) => {
          const out: NormalizedClip[] = [];
          for (const c of current) {
            out.push(c);
            if (c.id === clipId) {
              out.push({
                ...c,
                id: newId,
                startSec: roundSec(c.startSec + c.durationSec),
              });
            }
          }
          return out;
        },
      });
      setSelectedClipId(newId);
      seekTimeline(roundSec(source.startSec + source.durationSec));
    },
    [applyEdit, clips, seekTimeline],
  );

  const setClipVolume = useCallback(
    (clipId: string, volume: number) => {
      applyEdit({
        description: `Volume`,
        build: (current) =>
          current.map((c) => (c.id === clipId ? { ...c, volume: clamp(volume, 0, 2) } : c)),
      });
    },
    [applyEdit],
  );

  const setClipFade = useCallback(
    (clipId: string, edge: "in" | "out", sec: number) => {
      applyEdit({
        description: `Fade ${edge}`,
        build: (current) =>
          current.map((c) => {
            if (c.id !== clipId) return c;
            const safe = Math.max(0, Math.min(sec, c.durationSec / 2));
            return edge === "in"
              ? { ...c, fadeInSec: roundSec(safe) }
              : { ...c, fadeOutSec: roundSec(safe) };
          }),
      });
    },
    [applyEdit],
  );

  const toggleClipEnabled = useCallback(
    (clipId: string) => {
      applyEdit({
        description: `Toggled clip`,
        build: (current) =>
          current.map((c) => (c.id === clipId ? { ...c, enabled: !c.enabled } : c)),
      });
    },
    [applyEdit],
  );

  // Bin → timeline drag, hand-rolled. HTML5 draggable+onClick proved
  // unreliable in our Electron + React 19 build (clicks on the tile
  // never reached the handler regardless of structure — see the long
  // saga in the chat history). Pointer tracking sidesteps the entire
  // browser drag pipeline: pointerdown on the tile starts a tracker,
  // pointermove past a 5px threshold flips it into "dragging" mode and
  // shows a floating ghost at the cursor, pointerup over a lane drops
  // the clip there. If the user releases without crossing the
  // threshold, the click event fires normally and the bin item enters
  // preview mode. No dataTransfer, no dragstart, no Chromium quirks.
  const binDragRef = useRef<{
    item: BinItem;
    startX: number;
    startY: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const [binDragOverlay, setBinDragOverlay] = useState<{
    item: BinItem;
    x: number;
    y: number;
  } | null>(null);
  const laneAtPoint = useCallback(
    (clientX: number, clientY: number): { track: TimelineTrack; rect: DOMRect } | null => {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return null;
      const lane = (el as HTMLElement).closest("[data-lane-track]") as HTMLElement | null;
      if (!lane) return null;
      const track = lane.dataset.laneTrack as TimelineTrack | undefined;
      if (!track) return null;
      return { track, rect: lane.getBoundingClientRect() };
    },
    [],
  );

  const beginBinDrag = useCallback(
    (item: BinItem, clientX: number, clientY: number, pointerId: number) => {
      binDragRef.current = {
        item,
        startX: clientX,
        startY: clientY,
        moved: false,
        pointerId,
      };
    },
    [],
  );

  // Pointer-event handlers that live on the button itself (via pointer
  // capture) — no document-level listeners so the native pointerup→click
  // sequence fires uninterrupted when the user just clicks.
  const handleBinPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = binDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = Math.abs(event.clientX - drag.startX);
      const dy = Math.abs(event.clientY - drag.startY);
      if (!drag.moved && (dx > 5 || dy > 5)) {
        drag.moved = true;
      }
      if (!drag.moved) return;
      setBinDragOverlay({ item: drag.item, x: event.clientX, y: event.clientY });
      const hit = laneAtPoint(event.clientX, event.clientY);
      if (hit) {
        const desired = TRACK_KIND[hit.track];
        const matches =
          drag.item.kind === "video" ? desired === "video" : desired === "audio";
        setHoverLane(matches ? hit.track : null);
      } else {
        setHoverLane(null);
      }
    },
    [laneAtPoint],
  );

  const handleBinPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = binDragRef.current;
      binDragRef.current = null;
      setBinDragOverlay(null);
      setHoverLane(null);
      if (!drag) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
      }
      // No movement → treat as click. We engage preview directly here
      // instead of waiting for the browser's native click event, because
      // that event chain has been unreliable across the saga (Chromium
      // text-selection start, React 19 synthetic-event delegation, etc.)
      // Setting state directly removes every external dependency.
      if (!drag.moved) {
        setBinPreviewItem(drag.item);
        return;
      }
      // Movement → drop on the lane under the cursor.
      const hit = laneAtPoint(event.clientX, event.clientY);
      if (!hit) return;
      const desired = TRACK_KIND[hit.track];
      const matches =
        drag.item.kind === "video" ? desired === "video" : desired === "audio";
      if (!matches) {
        if (onNotice) {
          onNotice(
            drag.item.kind === "video"
              ? "Video clips go on V1 or V2."
              : "Audio clips go on A1 or A2.",
            "info",
          );
        }
        return;
      }
      const sec = (event.clientX - hit.rect.left) / pixelsPerSec;
      insertBinItemAt(drag.item, hit.track, Math.max(0, sec));
    },
    [insertBinItemAt, laneAtPoint, onNotice, pixelsPerSec, setBinPreviewItem],
  );

  // Clip pointer-drag (move + edge trim)
  const handleClipPointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      clip: NormalizedClip,
      mode: ClipDragState["mode"],
      laneEl: HTMLDivElement | null,
    ) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      setSelectedClipId(clip.id);
      clipDragRef.current = {
        clipId: clip.id,
        pointerId: event.pointerId,
        mode,
        originStartSec: clip.startSec,
        originTrimInSec: clip.trimInSec,
        originTrimOutSec: clip.trimOutSec,
        originDurationSec: clip.durationSec,
        pointerStartX: event.clientX,
        laneEl,
      };
      setDragGhost({
        clipId: clip.id,
        track: clip.track,
        startSec: clip.startSec,
        durationSec: clip.durationSec,
      });
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [],
  );

  const handleClipPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = clipDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const deltaPx = event.clientX - drag.pointerStartX;
      const deltaSec = deltaPx / pixelsPerSec;
      const movingClip = clips.find((c) => c.id === drag.clipId);
      if (!movingClip) return;
      if (drag.mode === "move") {
        const nextStart = Math.max(0, drag.originStartSec + deltaSec);
        const snapped = snapToNeighborEdges(
          clips,
          drag.clipId,
          nextStart,
          drag.originDurationSec,
          playheadSec,
        );
        // After edge-snapping, slide to the nearest non-overlapping
        // slot so the ghost shows the user's actual landing zone, not
        // a position that would stack on top of an existing clip.
        const safeStart = findNonOverlappingStart(
          clips,
          movingClip.track,
          drag.clipId,
          snapped,
          drag.originDurationSec,
        );
        setDragGhost({
          clipId: drag.clipId,
          track: movingClip.track,
          startSec: safeStart,
          durationSec: drag.originDurationSec,
        });
      } else if (drag.mode === "trim-end") {
        // Mirror trimClip's clamp: out can't exceed source's full duration
        // when known. Without this, the ghost stretches past the source
        // and the user sees a phantom extension that won't actually persist.
        const sourceFullDur = movingClip.fullDurationSec > 0
          ? movingClip.fullDurationSec
          : drag.originTrimInSec + drag.originDurationSec + 60;
        const maxDuration = Math.max(
          MIN_CLIP_DURATION,
          sourceFullDur - drag.originTrimInSec,
        );
        const nextDuration = clamp(
          drag.originDurationSec + deltaSec,
          MIN_CLIP_DURATION,
          maxDuration,
        );
        setDragGhost({
          clipId: drag.clipId,
          track: movingClip.track,
          startSec: drag.originStartSec,
          durationSec: nextDuration,
        });
      } else if (drag.mode === "trim-start") {
        const trimDelta = clamp(
          deltaSec,
          -drag.originTrimInSec,
          drag.originDurationSec - MIN_CLIP_DURATION,
        );
        setDragGhost({
          clipId: drag.clipId,
          track: movingClip.track,
          startSec: Math.max(0, drag.originStartSec + trimDelta),
          durationSec: Math.max(MIN_CLIP_DURATION, drag.originDurationSec - trimDelta),
        });
      }
    },
    [clips, pixelsPerSec, playheadSec],
  );

  const handleClipPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = clipDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      clipDragRef.current = null;
      setDragGhost(null);
      const deltaPx = event.clientX - drag.pointerStartX;
      const deltaSec = deltaPx / pixelsPerSec;
      if (Math.abs(deltaPx) < 2) return;
      suppressNextClipClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClipClickRef.current = false;
      }, 0);
      if (drag.mode === "move") {
        const nextStart = Math.max(0, drag.originStartSec + deltaSec);
        const movingClip = clips.find((c) => c.id === drag.clipId);
        const movingDuration = movingClip ? movingClip.durationSec : 0;
        const movingTrack = getClipTrack(drag.clipId, clips) || "V1";
        const snappedStart = snapToNeighborEdges(clips, drag.clipId, nextStart, movingDuration, playheadSec);
        // Then slide to nearest non-overlapping slot so the dropped
        // clip never stacks on an existing one — matches what the
        // ghost showed during drag.
        const safeStart = findNonOverlappingStart(
          clips,
          movingTrack,
          drag.clipId,
          snappedStart,
          movingDuration,
        );
        moveClip(drag.clipId, movingTrack, safeStart);
      } else {
        const edge = drag.mode === "trim-start" ? "start" : "end";
        trimClip(drag.clipId, edge, deltaSec);
      }
    },
    [clips, moveClip, pixelsPerSec, playheadSec, trimClip],
  );

  // Pointer cancel = OS interrupted the drag (window switched away,
  // touch cancelled, etc.). Reset state so the ghost doesn't stay
  // pinned to the lane and the next click works normally.
  const handleClipPointerCancel = useCallback(() => {
    clipDragRef.current = null;
    setDragGhost(null);
  }, []);

  useEffect(() => {
    const onWindowBlur = () => {
      if (clipDragRef.current) {
        clipDragRef.current = null;
        setDragGhost(null);
      }
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      // Bail when ANY modifier (Cmd / Ctrl / Alt) is held — single-letter
      // shortcuts shouldn't shadow system actions like Cmd+S (save) or
      // Cmd+I (italic). Shift is allowed because Shift+Arrow is already
      // an established speed-jump shortcut.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        toggleTimelinePlayback();
      } else if (event.key === "s" || event.key === "S") {
        // Razor at playhead — splits the selected clip in two without
        // entering a modal blade tool.
        if (selectedClipId) {
          event.preventDefault();
          splitClipAtPlayhead(selectedClipId, playheadSec);
        }
      } else if ((event.key === "Delete" || event.key === "Backspace")) {
        if (selectedClipId) {
          event.preventDefault();
          deleteClip(selectedClipId);
        }
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTimeline(playheadSecRef.current - (event.shiftKey ? 5 : frameStep));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTimeline(playheadSecRef.current + (event.shiftKey ? 5 : frameStep));
      } else if (event.key === "Home") {
        seekTimeline(0);
      } else if (event.key === "End") {
        seekTimeline(totalDurationSec);
      } else if (event.key === "+" || event.key === "=") {
        applyZoom((p) => p * 1.25);
      } else if (event.key === "-" || event.key === "_") {
        applyZoom((p) => p / 1.25);
      } else if (event.key === "f" || event.key === "F") {
        // Fit the whole sequence to the visible timeline width.
        event.preventDefault();
        fitTimelineToView();
      } else if (event.key === "j" || event.key === "J") {
        seekTimeline(playheadSecRef.current - 1);
      } else if (event.key === "k" || event.key === "K") {
        setIsPlaying(false);
      } else if (event.key === "l" || event.key === "L") {
        startTimelinePlayback();
      } else if (event.key === "i" || event.key === "I") {
        // Set in-point on the selected clip at the current playhead
        // position. No-op if the playhead is outside the clip span (set
        // markers should never produce a reversed trim window).
        if (selectedClipId) {
          const clip = clips.find((c) => c.id === selectedClipId);
          if (clip && playheadSec >= clip.startSec && playheadSec <= clip.startSec + clip.durationSec) {
            event.preventDefault();
            trimClip(selectedClipId, "start", playheadSec - clip.startSec);
          }
        }
      } else if (event.key === "o" || event.key === "O") {
        // Set out-point on the selected clip at the current playhead.
        if (selectedClipId) {
          const clip = clips.find((c) => c.id === selectedClipId);
          if (clip && playheadSec >= clip.startSec && playheadSec <= clip.startSec + clip.durationSec) {
            event.preventDefault();
            const localOffset = playheadSec - clip.startSec;
            const currentOut = clip.trimOutSec ?? clip.fullDurationSec ?? clip.trimInSec + clip.durationSec;
            const desiredOut = clip.trimInSec + localOffset;
            trimClip(selectedClipId, "end", desiredOut - currentOut);
          }
        }
      } else if (event.key === "m" || event.key === "M") {
        // Toggle the selected clip's enabled flag — Premiere-style mute.
        if (selectedClipId) {
          event.preventDefault();
          toggleClipEnabled(selectedClipId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    applyZoom,
    clips,
    deleteClip,
    fitTimelineToView,
    frameStep,
    playheadSec,
    seekTimeline,
    selectedClipId,
    splitClipAtPlayhead,
    startTimelinePlayback,
    toggleClipEnabled,
    toggleTimelinePlayback,
    totalDurationSec,
    trimClip,
  ]);

  // Cmd/Ctrl + wheel anywhere over the timeline = smooth zoom around the
  // cursor position. Plain wheel keeps native horizontal/vertical scroll
  // intact. The wheel listener is attached non-passively so we can
  // preventDefault on cmd-zoom and stop the page from rubber-band-scrolling.
  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0025);
      const rect = scroller.getBoundingClientRect();
      const cursorPx = event.clientX - rect.left + scroller.scrollLeft - LANE_GUTTER;
      setPixelsPerSec((prev) => {
        const next = clamp(prev * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
        if (next !== prev && cursorPx >= 0) {
          const focusSec = cursorPx / prev;
          pendingScrollDeltaRef.current += focusSec * (next - prev);
          userZoomedRef.current = true;
        }
        return next;
      });
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);

  // Playback engine: advance playhead via rAF when isPlaying.
  useEffect(() => {
    playheadSecRef.current = playheadSec;
  }, [playheadSec]);

  useEffect(() => {
    if (!isPlaying) {
      playStartedAtRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    playStartedAtRef.current = { wallClock: performance.now(), sequenceSec: playheadSecRef.current };
    const tick = () => {
      const start = playStartedAtRef.current;
      if (!start) return;
      const elapsed = (performance.now() - start.wallClock) / 1000;
      const next = start.sequenceSec + elapsed;
      if (next >= totalDurationSec) {
        playheadSecRef.current = totalDurationSec;
        setPlayheadSec(totalDurationSec);
        setIsPlaying(false);
        return;
      }
      playheadSecRef.current = next;
      setPlayheadSec(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, totalDurationSec]);

  // Bin-preview acts like a source monitor: clicking a bin video should
  // preview that source even if the timeline playhead currently sits on
  // a V1 clip. Timeline playback takes priority only while playing.
  const isBinPreviewing =
    !isPlaying && !!binPreviewItem && binPreviewItem.kind === "video";
  const v1ActiveClip = useMemo(
    () => (isBinPreviewing ? null : clipAtTime(clipsPerTrack.V1, playheadSec)),
    [clipsPerTrack.V1, playheadSec, isBinPreviewing],
  );
  const v2ActiveClip = useMemo(
    () => (isBinPreviewing ? null : clipAtTime(clipsPerTrack.V2, playheadSec)),
    [clipsPerTrack.V2, playheadSec, isBinPreviewing],
  );
  const binPreviewSrc = useMemo(
    () =>
      isBinPreviewing
        ? indexMediaSrc(projectDir, (binPreviewItem as BinVideoItem).videoPath)
        : "",
    [isBinPreviewing, binPreviewItem, projectDir],
  );

  // Bin preview sync — runs only while isBinPreviewing. Drives
  // binPreviewVideoRef ONLY. The timeline element doesn't exist in
  // the DOM in this mode so we can't accidentally touch it.
  useEffect(() => {
    const el = binPreviewVideoRef.current;
    if (!el) return;
    if (isBinPreviewing && binPreviewSrc) {
      syncBinPreviewVideoElement(el, binPreviewSrc, binPreviewSyncRef);
    } else {
      clearVideoElement(el, binPreviewSyncRef);
    }
  }, [isBinPreviewing, binPreviewSrc]);

  // Diagnostic layer: every media event Chromium fires on the timeline
  // V1 element. Was useful for catching residual audio glitches that
  // surfaced as media events rather than promise rejections. Gated to
  // dev-only because `waiting` / `suspend` fire on every normal buffer
  // cycle and scrub seek — leaving these unconditional in production
  // floods the console during heavy playback and buries real errors.
  // Toggle via `localStorage.WORKSHOP_DEBUG = "1"` if you need it in a
  // packaged build.
  useEffect(() => {
    const debugWorkshop =
      typeof localStorage !== "undefined" && localStorage.getItem("WORKSHOP_DEBUG") === "1";
    if (!debugWorkshop) return;
    const el = timelineVideoRef.current;
    if (!el) return;
    const log = (eventName: string) => () => {
      console.warn(`[workshop] timeline video event: ${eventName}`, {
        src: el.currentSrc || el.getAttribute("src"),
        currentTime: el.currentTime,
        duration: el.duration,
        readyState: el.readyState,
        networkState: el.networkState,
        paused: el.paused,
        muted: el.muted,
        volume: el.volume,
        ended: el.ended,
        seeking: el.seeking,
        mediaErrorCode: el.error?.code,
        mediaErrorMessage: el.error?.message,
      });
    };
    const events: Array<keyof HTMLMediaElementEventMap> = [
      "error",
      "stalled",
      "waiting",
      "suspend",
      "abort",
      "ended",
      "emptied",
    ];
    const handlers = events.map((name) => {
      const h = log(name);
      el.addEventListener(name, h);
      return [name, h] as const;
    });
    return () => {
      for (const [name, h] of handlers) el.removeEventListener(name, h);
    };
    // The ref is stable across renders; this effect only re-runs when
    // the timeline element remounts (bin↔timeline mode switch). Any
    // mid-clip change does NOT remount the element.
  }, [v1ActiveClip ? "mounted" : "unmounted"]);

  // Timeline V1 sync — runs only while NOT in bin preview mode.
  // Drives timelineVideoRef ONLY. Receives all the playhead/isPlaying
  // ticks that used to fight with the bin path.
  useEffect(() => {
    const el = timelineVideoRef.current;
    if (!el) return;
    if (isBinPreviewing) {
      // Element isn't actually in the DOM in this branch (conditional
      // mount), but be defensive for the brief tick during mode swap.
      clearVideoElement(el, timelineSyncRef);
      return;
    }
    if (v1ActiveClip) {
      syncTimelineVideoElement({
        el,
        clip: v1ActiveClip,
        projectDir,
        playheadSecRef,
        isPlaying,
        syncRef: timelineSyncRef,
      });
      return;
    }
    clearVideoElement(el, timelineSyncRef);
  }, [isPlaying, playheadSec, projectDir, v1ActiveClip, isBinPreviewing]);

  useEffect(() => {
    const el = overlayVideoRef.current;
    if (!el) return;
    if (isBinPreviewing || !v2ActiveClip) {
      clearVideoElement(el, overlaySyncRef);
      return;
    }
    syncTimelineVideoElement({
      el,
      clip: v2ActiveClip,
      projectDir,
      playheadSecRef,
      isPlaying,
      syncRef: overlaySyncRef,
    });
  }, [isPlaying, playheadSec, projectDir, v2ActiveClip, isBinPreviewing]);

  // Audio mix: hidden <audio> elements driven by playhead
  useEffect(() => {
    const audioMap = audioElementsRef.current;
    if (!isPlaying) {
      for (const state of audioMap.values()) {
        try { state.el.pause(); } catch { /* ignore */ }
      }
      return;
    }
    const activeIds = new Set<string>();
    const audioClips = [...clipsPerTrack.A1, ...clipsPerTrack.A2];
    for (const clip of audioClips) {
      if (!clip.enabled || !clip.mediaPath) continue;
      activeIds.add(clip.id);
      let state = audioMap.get(clip.id);
      if (!state) {
        const el = new Audio();
        el.preload = "auto";
        state = { el, src: "" };
        audioMap.set(clip.id, state);
      }
      const src = indexMediaSrc(projectDir, clip.mediaPath);
      const el = state.el;
      if (state.src !== src || el.getAttribute("src") !== src) {
        state.src = src;
        el.setAttribute("src", src);
        try { el.load(); } catch { /* ignore */ }
      }
      el.volume = clamp(clip.volume * fadeMultiplier(clip, playheadSec), 0, 1);
      const inWindow = playheadSec >= clip.startSec && playheadSec <= clip.startSec + clip.durationSec;
      if (inWindow) {
        const localSec = playheadSec - clip.startSec + clip.trimInSec;
        if (Math.abs(el.currentTime - localSec) > TIMELINE_SEEK_EPSILON_PLAYING) {
          try { el.currentTime = Math.max(0, localSec); } catch { /* ignore */ }
        }
        if (el.paused) {
          void el.play().catch((err) => {
            console.warn("[workshop] audio-mix play() rejected", {
              err: (err as { name?: string })?.name || String(err),
              clipId: clip.id,
              src: el.currentSrc,
              readyState: el.readyState,
            });
          });
        }
      } else {
        el.pause();
      }
    }
    // Stop audio for removed clips
    for (const [id, state] of audioMap.entries()) {
      if (!activeIds.has(id)) {
        try { state.el.pause(); } catch { /* ignore */ }
        state.el.removeAttribute("src");
        audioMap.delete(id);
      }
    }
  }, [clipsPerTrack.A1, clipsPerTrack.A2, isPlaying, playheadSec, projectDir]);

  // Cleanup on unmount
  useEffect(() => {
    const audioMap = audioElementsRef.current;
    return () => {
      for (const state of audioMap.values()) {
        try { state.el.pause(); } catch { /* ignore */ }
        state.el.removeAttribute("src");
      }
      audioMap.clear();
    };
  }, []);

  const handleExport = useCallback(async () => {
    if (busy) return;
    const payload = buildWorkshopNLEPayload(clips);
    const hasAnything = payload.v1Clips.length || payload.v2Clips.length || payload.audioClips.length;
    if (!hasAnything) {
      if (onNotice) onNotice("Drop at least one clip onto the timeline before exporting.", "info");
      return;
    }
    setBusy("export");
    const trackSummary = [
      payload.v1Clips.length ? `${payload.v1Clips.length} V1` : null,
      payload.v2Clips.length ? `${payload.v2Clips.length} V2` : null,
      payload.audioClips.length ? `${payload.audioClips.length} audio` : null,
    ]
      .filter(Boolean)
      .join(" + ");
    setExportBanner(`Rendering ${trackSummary}…`);
    try {
      let result: { path: string } | null = null;
      if (window.forgeDesktop?.exportWorkshopNLE) {
        result = await window.forgeDesktop.exportWorkshopNLE(projectDir, {
          ...payload,
          width: videoSpec.width,
          height: videoSpec.height,
          includeV1Audio: true,
        });
      } else {
        const v1Legacy = buildVideoExportClips(clips);
        if (!v1Legacy.length) {
          if (onNotice) onNotice("Add at least one V1 clip before exporting.", "info");
          setBusy(null);
          setExportBanner(null);
          return;
        }
        result = await window.forgeDesktop.exportTimeline(projectDir, v1Legacy);
      }
      if (result?.path) {
        setExportBanner(`Exported to ${result.path}`);
        if (onNotice) onNotice(`Exported to ${result.path}`, "success");
        if (onRevealPath) onRevealPath(result.path);
      } else {
        setExportBanner(null);
      }
    } catch (err) {
      setExportBanner(null);
      if (onNotice) onNotice(err instanceof Error ? err.message : "Export failed.", "error");
    } finally {
      setBusy(null);
    }
  }, [busy, clips, onNotice, onRevealPath, projectDir, videoSpec.width, videoSpec.height]);

  const handleAddBinItemEnd = useCallback(
    (item: BinItem) => {
      const track: TimelineTrack = item.kind === "video" ? "V1" : "A1";
      const tail = computeTotalDuration(clips.filter((c) => c.track === track));
      insertBinItemAt(item, track, tail);
    },
    [clips, insertBinItemAt],
  );

  // ---- Renders ----------------------------------------------------------

  const totalForRuler = Math.max(8, totalDurationSec, playheadSec + 4);
  const timelineWidth = Math.max(720, totalForRuler * pixelsPerSec + 240);
  const contextClip = clipContextMenu
    ? clips.find((clip) => clip.id === clipContextMenu.clipId) || null
    : null;
  const canSplitContextClip =
    !!contextClip
    && playheadSec > contextClip.startSec + MIN_CLIP_DURATION
    && playheadSec < contextClip.startSec + contextClip.durationSec - MIN_CLIP_DURATION;

  return (
    <div
      className={`workshop-nle${draggingBin ? " is-resizing-bin" : ""}`}
      style={{
        gridTemplateColumns: `${binWidth}px 6px minmax(0, 1fr)`,
      }}
    >
      <BinPane
        items={binItems}
        onBeginDrag={beginBinDrag}
        onPointerMove={handleBinPointerMove}
        onPointerUp={handleBinPointerUp}
        onDoubleClick={handleAddBinItemEnd}
        onPreview={setBinPreviewItem}
        onContextMenu={handleBinContextMenu}
        previewItemId={binPreviewItem?.id || null}
        projectDir={projectDir}
        onImportMedia={handleBinImport}
      />
      <div
        className="workshop-bin-resizer"
        onPointerDown={startBinResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize media bin"
        title="Drag to resize media bin"
      />

      <div className={`workshop-nle-editor${agentIntent ? " has-agent-intent" : ""}${agentWorking ? " is-agent-working" : ""}`}>
        {agentIntent ? (
          <div
            className="workshop-agent-intent"
            role="status"
            aria-live="polite"
          >
            <span className="workshop-agent-intent-dot" aria-hidden="true" />
            <span
              className="workshop-agent-intent-text"
              title={agentIntent.message}
            >
              {agentIntent.message}
            </span>
            <button
              type="button"
              className="workshop-agent-intent-dismiss"
              onClick={() => setAgentIntent(null)}
              aria-label="Dismiss agent intent"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        ) : agentWorking ? (
          // Fallback when the agent is running but hasn't called
          // announce_intent yet. Confirms "something is happening" so
          // the user doesn't think the timeline is frozen — the chat
          // panel's spinner is easy to miss while focus is on the NLE.
          <div className="workshop-agent-intent workshop-agent-intent-soft" role="status" aria-live="polite">
            <span className="workshop-agent-intent-dot working" aria-hidden="true" />
            <span className="workshop-agent-intent-text">Agent is working…</span>
          </div>
        ) : null}
        <PreviewPane
          binPreviewVideoRef={binPreviewVideoRef}
          timelineVideoRef={timelineVideoRef}
          overlayVideoRef={overlayVideoRef}
          totalDurationSec={totalDurationSec}
          playheadSec={playheadSec}
          isPlaying={isPlaying}
          v1Active={v1ActiveClip}
          v2Active={v2ActiveClip}
          isBinPreviewing={isBinPreviewing}
          onTogglePlay={toggleTimelinePlayback}
          onSeek={seekTimeline}
          onExport={handleExport}
          busy={busy}
          exportBanner={exportBanner}
          onClearBanner={() => setExportBanner(null)}
          selectedClip={selectedClip}
          onDeleteSelected={() => selectedClipId && deleteClip(selectedClipId)}
          onSplitSelected={() => selectedClipId && splitClipAtPlayhead(selectedClipId, playheadSec)}
          onToggleEnabled={() => selectedClipId && toggleClipEnabled(selectedClipId)}
          onSetVolume={(v) => selectedClipId && setClipVolume(selectedClipId, v)}
          onSetFade={(edge, sec) => selectedClipId && setClipFade(selectedClipId, edge, sec)}
          pixelsPerSec={pixelsPerSec}
          onZoomChange={applyZoom}
          onZoomFit={fitTimelineToView}
          fps={fps}
        />

        <TimelinePanel
          timelineScrollRef={timelineScrollRef}
          width={timelineWidth}
          totalSec={totalForRuler}
          pixelsPerSec={pixelsPerSec}
          playheadSec={playheadSec}
          onSeek={seekTimeline}
          tracks={visibleTracks}
          clipsPerTrack={clipsPerTrack}
          selectedClipId={selectedClipId}
          onSelectClip={selectTimelineClip}
          onClipPointerDown={handleClipPointerDown}
          onClipPointerMove={handleClipPointerMove}
          onClipPointerUp={handleClipPointerUp}
          onClipPointerCancel={handleClipPointerCancel}
          onClipContextMenu={handleClipContextMenu}
          hoverLane={hoverLane}
          dragGhost={dragGhost}
          fps={fps}
          touchedPathSet={touchedPathSet}
          agentSelectedClipIds={agentSelectedClipIds}
          agentIntentClipIds={agentIntent?.clipIds}
          recentEditClipIds={recentEditClipIdSet}
          projectDir={projectDir}
        />
      </div>
      {binDragOverlay ? (
        <div
          className="workshop-bin-drag-ghost"
          style={{
            left: `${binDragOverlay.x + 12}px`,
            top: `${binDragOverlay.y + 12}px`,
          }}
          aria-hidden
        >
          {binDragOverlay.item.label}
          {hoverLane ? (
            <span className="workshop-bin-drag-ghost-target"> → {hoverLane}</span>
          ) : null}
        </div>
      ) : null}
      {binContextMenu ? (
        <div
          className="workshop-clip-menu"
          role="menu"
          style={{ left: `${binContextMenu.x}px`, top: `${binContextMenu.y}px` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="workshop-clip-menu-header" title={binContextMenu.item.label}>
            {binContextMenu.item.label}
          </div>
          <button
            type="button"
            className="workshop-clip-menu-item"
            role="menuitem"
            onClick={() => {
              handleAddBinItemEnd(binContextMenu.item);
              setBinContextMenu(null);
            }}
          >
            Append to timeline
          </button>
          <div className="workshop-clip-menu-divider" />
          <button
            type="button"
            className="workshop-clip-menu-item danger"
            role="menuitem"
            onClick={() => {
              const item = binContextMenu.item;
              setBinContextMenu(null);
              void deleteBinItem(item);
            }}
          >
            Remove from project
          </button>
        </div>
      ) : null}
      {clipContextMenu ? (
        <div
          className="workshop-clip-menu"
          role="menu"
          style={{ left: `${clipContextMenu.x}px`, top: `${clipContextMenu.y}px` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="workshop-clip-menu-item"
            role="menuitem"
            disabled={!canSplitContextClip}
            title={canSplitContextClip ? "Split selected clip at playhead" : "Move the playhead inside this clip to split"}
            onClick={() => {
              if (!canSplitContextClip) return;
              splitClipAtPlayhead(clipContextMenu.clipId, playheadSec);
              setClipContextMenu(null);
            }}
          >
            Split at playhead
            <span className="workshop-clip-menu-key">S</span>
          </button>
          <button
            type="button"
            className="workshop-clip-menu-item"
            role="menuitem"
            onClick={() => {
              duplicateClip(clipContextMenu.clipId);
              setClipContextMenu(null);
            }}
          >
            Duplicate
          </button>
          <button
            type="button"
            className="workshop-clip-menu-item"
            role="menuitem"
            onClick={() => {
              toggleClipEnabled(clipContextMenu.clipId);
              setClipContextMenu(null);
            }}
          >
            {contextClip?.enabled === false ? "Enable clip" : "Disable clip"}
          </button>
          <div className="workshop-clip-menu-divider" />
          <button
            type="button"
            className="workshop-clip-menu-item danger"
            role="menuitem"
            onClick={() => {
              deleteClip(clipContextMenu.clipId);
              setClipContextMenu(null);
            }}
          >
            Remove
            <span className="workshop-clip-menu-key">⌫</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------
// Helpers used by handlers
// -----------------------------------------------------------------------

function fadeMultiplier(clip: NormalizedClip, playheadSec: number) {
  if (playheadSec < clip.startSec || playheadSec > clip.startSec + clip.durationSec) return 0;
  const local = playheadSec - clip.startSec;
  let mult = 1;
  if (clip.fadeInSec > 0 && local < clip.fadeInSec) {
    mult *= clamp(local / clip.fadeInSec, 0, 1);
  }
  if (clip.fadeOutSec > 0 && clip.durationSec - local < clip.fadeOutSec) {
    mult *= clamp((clip.durationSec - local) / clip.fadeOutSec, 0, 1);
  }
  return mult;
}

function snapToNeighborEdges(
  clips: NormalizedClip[],
  movingId: string,
  candidateStart: number,
  movingDurationSec: number,
  playheadSec: number,
) {
  // Snap targets: 0, playhead, 1s grid (nearest second on either edge),
  // other clips' starts and ends. We test both the leading edge
  // (candidateStart) and the trailing edge (candidateStart + duration)
  // so aligning out-points is as easy as aligning in-points.
  const trailing = candidateStart + movingDurationSec;
  const targets: number[] = [
    0,
    playheadSec,
    Math.round(candidateStart),
    Math.round(trailing),
  ];
  for (const clip of clips) {
    if (clip.id === movingId) continue;
    targets.push(clip.startSec, clip.startSec + clip.durationSec);
  }
  let best = candidateStart;
  let bestDelta = SNAP_THRESHOLD_SEC;
  for (const t of targets) {
    if (!Number.isFinite(t) || t < 0) continue;
    const dLead = Math.abs(t - candidateStart);
    if (dLead < bestDelta) {
      best = t;
      bestDelta = dLead;
    }
    const dTrail = Math.abs(t - trailing);
    if (dTrail < bestDelta) {
      best = t - movingDurationSec;
      bestDelta = dTrail;
    }
  }
  return roundSec(Math.max(0, best));
}

// Find a non-overlapping start position for a clip of the given duration
// on a given track. If `candidateStart` already fits without overlap, it
// is returned unchanged. Otherwise the clip is slid to the nearest free
// slot — either flush to the left edge of the first overlapping clip or
// to the right edge of the last overlapping clip, whichever is closer to
// the user's intent. If neither side has room, falls through subsequent
// gaps until a fit is found, or appends to the end.
//
// This is what makes the timeline magnetic: dropping a clip into
// occupied space never stacks two clips on top of each other; it slides
// to the next available space.
function findNonOverlappingStart(
  clips: NormalizedClip[],
  track: TimelineTrack,
  movingId: string,
  candidateStart: number,
  movingDurationSec: number,
): number {
  const occupied = clips
    .filter((c) => c.track === track && c.id !== movingId)
    .map((c) => ({ start: c.startSec, end: c.startSec + c.durationSec }))
    .sort((a, b) => a.start - b.start);

  if (occupied.length === 0) return Math.max(0, roundSec(candidateStart));

  const overlaps = (start: number) => {
    const end = start + movingDurationSec;
    return occupied.some((o) => start < o.end - 0.001 && end > o.start + 0.001);
  };

  const desired = Math.max(0, candidateStart);
  if (!overlaps(desired)) return roundSec(desired);

  // Find the first occupied interval the candidate overlaps with, then
  // try positioning flush-left of it (end-on-start) and flush-right
  // (start-on-end). Pick whichever is non-overlapping AND closer to the
  // user's desired position.
  const firstHit = occupied.find(
    (o) => desired < o.end - 0.001 && desired + movingDurationSec > o.start + 0.001,
  );
  if (!firstHit) return roundSec(desired);

  const candidates: number[] = [];
  // Left of the overlap: end aligns with overlap.start
  const leftStart = firstHit.start - movingDurationSec;
  if (leftStart >= 0 && !overlaps(leftStart)) candidates.push(leftStart);

  // Right of the overlap: start aligns with overlap.end. If still
  // overlaps a later clip, slide further right by stepping through
  // each subsequent occupied interval.
  let rightCursor = firstHit.end;
  for (let i = 0; i < occupied.length; i += 1) {
    if (!overlaps(rightCursor)) {
      candidates.push(rightCursor);
      break;
    }
    const blocker = occupied.find(
      (o) => rightCursor < o.end - 0.001 && rightCursor + movingDurationSec > o.start + 0.001,
    );
    if (!blocker) {
      candidates.push(rightCursor);
      break;
    }
    rightCursor = blocker.end;
  }

  if (candidates.length === 0) {
    // Pathological — no gap found. Append to the end of the track.
    const lastEnd = occupied[occupied.length - 1].end;
    return roundSec(lastEnd);
  }

  // Pick the candidate closest to the user's desired position.
  candidates.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
  return roundSec(candidates[0]);
}

function getClipTrack(id: string, clips: NormalizedClip[]): TimelineTrack | null {
  for (const c of clips) if (c.id === id) return c.track;
  return null;
}

// -----------------------------------------------------------------------
// BinPane
// -----------------------------------------------------------------------

interface BinPaneProps {
  onPreview: (item: BinItem) => void;
  previewItemId: string | null;
  items: BinItem[];
  onBeginDrag: (item: BinItem, clientX: number, clientY: number, pointerId: number) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: (item: BinItem) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, item: BinItem) => void;
  projectDir: string;
  onImportMedia?: (filePaths: string[] | null) => Promise<WorkshopImportResult>;
}

function BinPane({
  items,
  onBeginDrag,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
  onPreview,
  previewItemId,
  onContextMenu,
  projectDir,
  onImportMedia,
}: BinPaneProps) {
  const [importing, setImporting] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const handlePick = useCallback(async () => {
    if (importing || !onImportMedia) return;
    setImporting(true);
    try {
      await onImportMedia(null);
    } finally {
      setImporting(false);
    }
  }, [importing, onImportMedia]);

  // BinPane's drop target is an `<aside>` (HTMLElement), so the handlers
  // need to accept the wider HTMLElement event type — typing them on
  // HTMLDivElement was an inheritance mismatch that tsc rejected.
  const handleDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // Only highlight when the drag carries actual files from the OS.
    // Clip-from-bin drags use a custom mime and shouldn't activate the
    // import drop zone.
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }, []);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // Ignore leaves into descendants — only reset on actual exit of the bin.
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDropActive(false);
  }, []);

  const handleDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      setDropActive(false);
      if (importing || !onImportMedia) return;
      const files = event.dataTransfer.files;
      if (!files || !files.length) return;
      const paths: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const p = (f as unknown as { path?: string }).path;
        if (p) paths.push(p);
      }
      if (!paths.length) return;
      setImporting(true);
      try {
        await onImportMedia(paths);
      } finally {
        setImporting(false);
      }
    },
    [importing, onImportMedia],
  );

  return (
    <aside
      className={`workshop-bin${dropActive ? " is-drop-target" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      <div className="workshop-bin-head">
        <div className="workshop-bin-title">
          <span>Workshop</span>
          <span className="workshop-bin-count">
            {items.length}
          </span>
          <button
            type="button"
            className="workshop-bin-import-btn"
            onClick={() => void handlePick()}
            disabled={importing}
            title={importing ? "Importing…" : "Import video or audio files into the bin"}
            aria-label="Import media"
          >
            {importing ? "…" : "+"}
          </button>
        </div>
      </div>
      <div className="workshop-bin-grid">
        {items.length === 0 ? (
          <div className="workshop-bin-empty">
            <div className="workshop-bin-empty-title">Drop media here</div>
          </div>
        ) : (
          items.map((item) => (
            <BinCard
              key={item.id}
              item={item}
              projectDir={projectDir}
              isPreviewing={previewItemId === item.id}
              onBeginDrag={onBeginDrag}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={onDoubleClick}
              onPreview={onPreview}
              onContextMenu={onContextMenu}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function BinCard({
  item,
  projectDir,
  isPreviewing,
  onBeginDrag,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
  onPreview,
  onContextMenu,
}: {
  item: BinItem;
  projectDir: string;
  isPreviewing: boolean;
  onBeginDrag: (item: BinItem, clientX: number, clientY: number, pointerId: number) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: (item: BinItem) => void;
  onPreview: (item: BinItem) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, item: BinItem) => void;
}) {
  const isVideo = item.kind === "video";
  const audioUrl = useMemo(
    () => (!isVideo ? indexMediaSrc(projectDir, (item as BinAudioItem).mediaPath) : ""),
    [isVideo, item, projectDir],
  );
  const videoUrl = useMemo(
    () => (isVideo ? indexMediaSrc(projectDir, (item as BinVideoItem).videoPath) : ""),
    [isVideo, item, projectDir],
  );
  const peaks = useWaveformPeaks(isVideo ? null : (item as BinAudioItem).mediaPath, audioUrl);
  // pointerdown starts a manual drag tracker in the parent (onBeginDrag).
  // If the user releases without moving, parent's pointerup engages preview.
  // Move past threshold → parent flips into drag mode, shows a ghost at the
  // cursor, and drops on the lane under pointerup. preventDefault is required
  // to stop Chromium from interpreting the press as text-selection start.
  void onPreview;
  return (
    <button
      type="button"
      className={`workshop-bin-tile workshop-bin-tile-${item.kind}${isPreviewing ? " is-previewing" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // ignore right/middle
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch { /* unsupported in some test envs */ }
        onBeginDrag(item, e.clientX, e.clientY, e.pointerId);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onDoubleClick(item)}
      onContextMenu={(e) => onContextMenu(e, item)}
      title={isVideo ? "Click to preview · Drag onto V1 / V2 · Right-click to remove" : "Click to preview · Drag onto A1 / A2 · Right-click to remove"}
    >
      <div className="workshop-bin-tile-thumb">
        {isVideo ? (
          <div className="workshop-bin-tile-video" aria-hidden>
            {videoUrl ? (
              <video
                src={videoUrl}
                preload="metadata"
                muted
                playsInline
                onLoadedMetadata={(e) => {
                  // Some codecs don't paint the first frame until a seek.
                  try { e.currentTarget.currentTime = 0.05; } catch { /* ignore */ }
                }}
                style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none", display: "block" }}
              />
            ) : null}
          </div>
        ) : (
          <div className="workshop-bin-tile-audio" aria-hidden>
            {peaks ? <WaveformSvg peaks={peaks} width={150} height={56} /> : <span className="workshop-bin-tile-audio-glyph">♪</span>}
          </div>
        )}
        {!isVideo ? (
          <span className={`workshop-bin-tile-kind workshop-bin-tile-kind-${item.kind}`}>
            {(item as BinAudioItem).audioKind.toUpperCase()}
          </span>
        ) : null}
      </div>
      <div className="workshop-bin-tile-body">
        <div className="workshop-bin-tile-label">{item.label}</div>
        <div className="workshop-bin-tile-meta">
          {isVideo && (item as BinVideoItem).source !== "unknown"
            ? (item as BinVideoItem).source === "uploaded" ? "Imported" : "Generated"
            : null}
          {item.durationSec ? <span className="workshop-bin-dot" /> : null}
          {item.durationSec ? formatDuration(item.durationSec) : null}
        </div>
      </div>
    </button>
  );
}

// -----------------------------------------------------------------------
// PreviewPane
// -----------------------------------------------------------------------

interface PreviewPaneProps {
  /** Ref for the bin-preview <video>. Mounted ONLY when isBinPreviewing
   *  is true. Carries native HTML5 controls for scrubbing the raw bin
   *  source. Independent state machine from timeline preview. */
  binPreviewVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  /** Ref for the timeline V1 <video>. Mounted ONLY when NOT in bin
   *  preview mode (and a V1 clip exists at the playhead). No native
   *  controls — driven entirely by the transport bar. */
  timelineVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  overlayVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  totalDurationSec: number;
  playheadSec: number;
  isPlaying: boolean;
  v1Active: NormalizedClip | null;
  v2Active: NormalizedClip | null;
  /** When true, the user is previewing a raw bin source (no V1 clip at
   *  playhead). The video element switches to native controls and the
   *  empty overlay yields to the live preview. */
  isBinPreviewing: boolean;
  onTogglePlay: () => void;
  onSeek: (sec: number) => void;
  onExport: () => void;
  busy: "export" | null;
  exportBanner: string | null;
  onClearBanner: () => void;
  selectedClip: NormalizedClip | null;
  onDeleteSelected: () => void;
  onSplitSelected: () => void;
  onToggleEnabled: () => void;
  onSetVolume: (v: number) => void;
  onSetFade: (edge: "in" | "out", sec: number) => void;
  pixelsPerSec: number;
  onZoomChange: (px: number) => void;
  onZoomFit: () => void;
  fps: number;
}

function PreviewPane({
  binPreviewVideoRef,
  timelineVideoRef,
  overlayVideoRef,
  totalDurationSec,
  playheadSec,
  isPlaying,
  v1Active,
  v2Active,
  isBinPreviewing,
  onTogglePlay,
  onSeek,
  onExport,
  busy,
  exportBanner,
  onClearBanner,
  selectedClip,
  onDeleteSelected,
  onSplitSelected,
  onToggleEnabled,
  onSetVolume,
  onSetFade,
  pixelsPerSec,
  onZoomChange,
  onZoomFit,
  fps,
}: PreviewPaneProps) {
  const handleScrubKey = (event: React.ChangeEvent<HTMLInputElement>) => {
    onSeek(Number(event.target.value));
  };
  return (
    <section className="workshop-preview">
      <div className="workshop-preview-stage">
        {/* Two distinct V1 video elements — only one is mounted at a
         *  time. Conditional mounting means each element is born fresh
         *  when its mode is entered, and dies cleanly when the mode is
         *  exited. No shared src, no shared load(), no gesture loss
         *  across mode switches. The empty state below is the third
         *  exclusive branch.
         */}
        {isBinPreviewing ? (
          <video
            ref={binPreviewVideoRef}
            className="workshop-preview-v1"
            playsInline
            controls
            preload="auto"
          />
        ) : v1Active ? (
          <video
            ref={timelineVideoRef}
            className="workshop-preview-v1"
            playsInline
            preload="auto"
          />
        ) : (
          <div className="workshop-preview-empty">
            <div className="workshop-preview-empty-title">No clip at playhead</div>
          </div>
        )}
        {v2Active && !isBinPreviewing ? (
          <video
            key={v2Active.id}
            ref={overlayVideoRef}
            className="workshop-preview-v2"
            playsInline
            muted
            preload="auto"
          />
        ) : null}
      </div>

      <div className="workshop-transport">
        <button
          type="button"
          className="workshop-transport-btn primary"
          onClick={onTogglePlay}
          title="Play / pause (space)"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <div className="workshop-transport-time">
          <span>{formatTimecode(playheadSec, fps)}</span>
          <span className="workshop-transport-time-sep">/</span>
          <span>{formatTimecode(totalDurationSec, fps)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={totalDurationSec}
          step={0.04}
          value={playheadSec}
          onChange={handleScrubKey}
          className="workshop-transport-scrub"
          aria-label="Scrub timeline"
        />
        <div className="workshop-transport-tools">
          {selectedClip ? (
            <div className="workshop-tool-group">
              <button
                type="button"
                className="workshop-tool-btn"
                onClick={onSplitSelected}
                title="Split clip at playhead (S)"
              >
                Split
              </button>
              <button
                type="button"
                className="workshop-tool-btn"
                onClick={onToggleEnabled}
                title="Mute / unmute clip"
              >
                {selectedClip.enabled === false ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                className="workshop-tool-btn danger"
                onClick={onDeleteSelected}
                title="Delete clip (Delete)"
              >
                Delete
              </button>
            </div>
          ) : null}
          <div className="workshop-tool-group workshop-zoom">
            <button
              type="button"
              className="workshop-tool-btn small"
              onClick={() => onZoomChange(pixelsPerSec / 1.25)}
              title="Zoom out (−)"
            >
              −
            </button>
            <button
              type="button"
              className="workshop-tool-btn small"
              onClick={() => onZoomChange(pixelsPerSec * 1.25)}
              title="Zoom in (+)"
            >
              +
            </button>
            <button
              type="button"
              className="workshop-tool-btn small"
              onClick={onZoomFit}
              title="Fit sequence to timeline width (F)"
            >
              Fit
            </button>
          </div>
          <button
            type="button"
            className="workshop-tool-btn export"
            onClick={onExport}
            disabled={busy === "export"}
            title="Export timeline to .mp4"
          >
            {busy === "export" ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>

      {selectedClip ? (
        <div className="workshop-inspector">
          <div className="workshop-inspector-row">
            <span className="workshop-inspector-label">{selectedClip.label}</span>
            <span className="workshop-inspector-meta">
              {TRACK_LABEL[selectedClip.track]} · {formatDuration(selectedClip.durationSec)}
            </span>
          </div>
          {selectedClip.source === "audio" ? (
            <div className="workshop-inspector-row">
              <label className="workshop-inspector-control">
                <span>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={selectedClip.volume}
                  onChange={(e) => onSetVolume(Number(e.target.value))}
                />
                <span className="workshop-inspector-value">{Math.round(selectedClip.volume * 100)}%</span>
              </label>
              <label className="workshop-inspector-control">
                <span>Fade in</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.2, selectedClip.durationSec / 2)}
                  step={0.05}
                  value={selectedClip.fadeInSec}
                  onChange={(e) => onSetFade("in", Number(e.target.value))}
                />
                <span className="workshop-inspector-value">{selectedClip.fadeInSec.toFixed(2)}s</span>
              </label>
              <label className="workshop-inspector-control">
                <span>Fade out</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.2, selectedClip.durationSec / 2)}
                  step={0.05}
                  value={selectedClip.fadeOutSec}
                  onChange={(e) => onSetFade("out", Number(e.target.value))}
                />
                <span className="workshop-inspector-value">{selectedClip.fadeOutSec.toFixed(2)}s</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {exportBanner ? (
        <div className="workshop-export-banner">
          <span>{exportBanner}</span>
          <button type="button" className="workshop-tool-btn small" onClick={onClearBanner}>
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------
// TimelinePanel
// -----------------------------------------------------------------------

interface TimelinePanelProps {
  timelineScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  width: number;
  totalSec: number;
  pixelsPerSec: number;
  playheadSec: number;
  onSeek: (sec: number) => void;
  tracks: TimelineTrack[];
  clipsPerTrack: Record<TimelineTrack, NormalizedClip[]>;
  selectedClipId: string | null;
  onSelectClip: (clip: NormalizedClip | null) => void;
  onClipPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    clip: NormalizedClip,
    mode: ClipDragState["mode"],
    laneEl: HTMLDivElement | null,
  ) => void;
  onClipPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClipPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClipPointerCancel: () => void;
  onClipContextMenu: (event: ReactMouseEvent<HTMLDivElement>, clip: NormalizedClip) => void;
  hoverLane: TimelineTrack | null;
  dragGhost: DragGhostState | null;
  touchedPathSet?: Set<string>;
  agentSelectedClipIds?: Set<string>;
  // Real-time agent overlays plumbed in from the parent NLE.
  agentIntentClipIds?: Set<string>;
  recentEditClipIds?: Set<string>;
  projectDir: string;
  fps: number;
}

function TimelinePanel({
  timelineScrollRef,
  width,
  totalSec,
  pixelsPerSec,
  playheadSec,
  onSeek,
  tracks,
  clipsPerTrack,
  selectedClipId,
  onSelectClip,
  onClipPointerDown,
  onClipPointerMove,
  onClipPointerUp,
  onClipPointerCancel,
  onClipContextMenu,
  hoverLane,
  dragGhost,
  touchedPathSet,
  agentSelectedClipIds,
  agentIntentClipIds,
  recentEditClipIds,
  projectDir,
  fps,
}: TimelinePanelProps) {
  const tickInterval = pixelsPerSec >= 80 ? 1 : pixelsPerSec >= 30 ? 5 : 10;
  const ticks: Array<{ sec: number; major: boolean }> = [];
  for (let s = 0; s <= totalSec; s += tickInterval) {
    ticks.push({ sec: s, major: s % (tickInterval * 5) === 0 });
  }
  const playheadX = playheadSec * pixelsPerSec + LANE_GUTTER;

  const handleRulerClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const sec = (event.clientX - rect.left - LANE_GUTTER) / pixelsPerSec;
    onSeek(Math.max(0, sec));
  };

  return (
    <section
      className="workshop-timeline"
      ref={timelineScrollRef}
      onPointerMove={onClipPointerMove}
      onPointerUp={onClipPointerUp}
      onPointerCancel={onClipPointerCancel}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelectClip(null);
      }}
    >
      <div className="workshop-timeline-inner" style={{ width: `${width}px` }}>
        <div
          className="workshop-timeline-ruler"
          style={{ height: `${RULER_HEIGHT}px`, paddingLeft: `${LANE_GUTTER}px` }}
          onClick={handleRulerClick}
        >
          {ticks.map((t) => (
            <div
              key={t.sec}
              className={`workshop-tick${t.major ? " major" : ""}`}
              style={{ left: `${t.sec * pixelsPerSec + LANE_GUTTER}px` }}
            >
              {t.major ? <span className="workshop-tick-label">{formatTimecode(t.sec, fps)}</span> : null}
            </div>
          ))}
        </div>

        {tracks.map((track) => (
          <div key={track} className={`workshop-track workshop-track-${TRACK_KIND[track]}`}>
            <div
              className="workshop-track-label"
              style={{ width: `${LANE_GUTTER}px`, height: `${TRACK_HEIGHT}px` }}
              title={TRACK_HINT[track]}
            >
              <span className="workshop-track-label-tag">{TRACK_LABEL[track]}</span>
            </div>
            <div
              className={`workshop-track-lane${hoverLane === track ? " drop-target" : ""}`}
              style={{ height: `${TRACK_HEIGHT}px` }}
              data-lane-track={track}
              ref={(el) => { /* lane el captured per-clip */ void el; }}
            >
              {clipsPerTrack[track].length === 0 ? (
                <div className="workshop-track-lane-empty" aria-hidden>
                  {TRACK_EMPTY_HINT[track]}
                </div>
              ) : null}
              {dragGhost && dragGhost.track === track ? (
                <div
                  className="workshop-clip-ghost"
                  style={{
                    left: `${dragGhost.startSec * pixelsPerSec}px`,
                    width: `${Math.max(8, dragGhost.durationSec * pixelsPerSec)}px`,
                    height: `${TRACK_HEIGHT - 8}px`,
                  }}
                  aria-hidden
                />
              ) : null}
              {clipsPerTrack[track].map((clip) => {
                const isSelected = selectedClipId === clip.id;
                const isTouched = clip.mediaPath ? touchedPathSet?.has(clip.mediaPath) : false;
                const isAgentEditing = agentSelectedClipIds?.has(clip.id);
                const isAgentIntent = agentIntentClipIds?.has(clip.id);
                const isRecentlyEdited = recentEditClipIds?.has(clip.id);
                const left = clip.startSec * pixelsPerSec;
                const width = Math.max(8, clip.durationSec * pixelsPerSec);
                const style: CSSProperties = {
                  left: `${left}px`,
                  width: `${width}px`,
                  height: `${TRACK_HEIGHT - 8}px`,
                };
                const isDragging = dragGhost?.clipId === clip.id;
                const className = [
                  "workshop-clip",
                  `workshop-clip-${clip.source}`,
                  isSelected ? "selected" : "",
                  !clip.enabled ? "disabled" : "",
                  isTouched ? "touched" : "",
                  isAgentEditing ? "agent-editing" : "",
                  isAgentIntent ? "agent-intent" : "",
                  isRecentlyEdited ? "agent-edited" : "",
                  isDragging ? "dragging" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <div
                    key={clip.id}
                    className={className}
                    style={style}
                    onPointerDown={(e) =>
                      onClipPointerDown(e, clip, "move", e.currentTarget.parentElement as HTMLDivElement)
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectClip(clip);
                    }}
                    onContextMenu={(e) => onClipContextMenu(e, clip)}
                    title={clip.label}
                  >
                    <div
                      className="workshop-clip-handle workshop-clip-handle-start"
                      onPointerDown={(e) =>
                        onClipPointerDown(e, clip, "trim-start", e.currentTarget.parentElement as HTMLDivElement)
                      }
                    />
                    <div className="workshop-clip-body">
                      {clip.source === "audio" && clip.mediaPath ? (
                        <ClipWaveform
                          mediaPath={clip.mediaPath}
                          projectDir={projectDir}
                          width={Math.max(8, width - 12)}
                          height={TRACK_HEIGHT - 14}
                        />
                      ) : null}
                      {clip.source === "video" && clip.mediaPath ? (
                        // Inline first-frame thumbnail. Same pattern as bin
                        // tiles (preload metadata + tiny seek to paint frame
                        // 0). Lets the user read the timeline visually
                        // instead of seeing four identical blue blocks.
                        // pointer-events: none so clicks pass through to
                        // the clip drag/select handler.
                        <video
                          className="workshop-clip-thumb"
                          src={indexMediaSrc(projectDir, clip.mediaPath)}
                          preload="metadata"
                          muted
                          playsInline
                          onLoadedMetadata={(e) => {
                            try { e.currentTarget.currentTime = 0.05; } catch { /* ignore */ }
                          }}
                          aria-hidden
                        />
                      ) : null}
                      <span className="workshop-clip-label">{clip.label}</span>
                      <span className="workshop-clip-meta">
                        {formatDuration(clip.durationSec)}
                        {clip.source === "audio" && clip.volume !== 1
                          ? ` · ${Math.round(clip.volume * 100)}%`
                          : null}
                      </span>
                    </div>
                    <div
                      className="workshop-clip-handle workshop-clip-handle-end"
                      onPointerDown={(e) =>
                        onClipPointerDown(e, clip, "trim-end", e.currentTarget.parentElement as HTMLDivElement)
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div
          className="workshop-playhead"
          style={{ left: `${playheadX}px`, height: `${RULER_HEIGHT + tracks.length * TRACK_HEIGHT}px` }}
        />
      </div>
    </section>
  );
}

export default WorkshopNLE;
