import { z } from "zod";

export const VALID_FILE_ROOTS = [
  "story",
  "script",
  "scenes",
  "shots",
  "prompts",
  "assets",
  "custom",
  "dialogue",
] as const;

export const PROJECT_FILE_SAFE_PATH_PATTERN_SOURCE =
  `^(${VALID_FILE_ROOTS.join("|")})/[A-Za-z0-9._/ -]+[.]md$`;

export const PROJECT_FILE_SAFE_PATH_REGEX = new RegExp(PROJECT_FILE_SAFE_PATH_PATTERN_SOURCE);

const JsonObjectSchema = z.record(z.string(), z.unknown());
const TimestampStringSchema = z.string().min(1);

export const BrowserProjectFilePathSchema = z.string().refine(
  (path) =>
    PROJECT_FILE_SAFE_PATH_REGEX.test(path) &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.includes("//"),
  "browser project file path must stay in a safe markdown root",
);

export const BrowserProjectFileSchema = z.object({
  path: BrowserProjectFilePathSchema,
  title: z.string(),
  kind: z.enum(["markdown", "media-note", "system"]),
  content: z.string(),
  contextGroup: z.string().nullable().optional(),
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema,
}).strip();

export const BrowserProjectAssetCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["character", "location", "prop", "keyframe", "audio", "video", "other"]),
}).strip();

export const BrowserProjectAssetSectionSchema = z.enum([
  "characters",
  "locations",
  "props",
  "keyframes",
  "audio",
  "videos",
]);

export const BrowserProjectAssetSchema = z.object({
  assetId: z.string(),
  section: BrowserProjectAssetSectionSchema,
  name: z.string(),
  folder: z.string().nullable(),
  content: z.string(),
  metadata: JsonObjectSchema,
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema,
}).strip();

export const BrowserTimelineClipSchema = z.object({
  id: z.string(),
  mediaAssetId: z.string(),
  track: z.enum(["V1", "A1"]),
  startSec: z.number().finite().nonnegative(),
  durationSec: z.number().finite().positive(),
  title: z.string(),
  fileName: z.string(),
  kind: z.enum(["video", "audio"]),
}).strip();

export const BrowserProjectTimelineSchema = z.object({
  version: z.literal(1),
  clips: z.array(BrowserTimelineClipSchema),
  updatedAt: TimestampStringSchema,
}).strip();

export const BrowserProjectDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  icon: z.string(),
  files: z.record(BrowserProjectFilePathSchema, BrowserProjectFileSchema),
  assetCategories: z.array(BrowserProjectAssetCategorySchema),
  assets: z.array(BrowserProjectAssetSchema),
  timeline: BrowserProjectTimelineSchema,
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema,
}).strip();

const BrowserProjectDocumentInputSchema = z.object({
  schemaVersion: z.unknown().optional(),
  icon: z.unknown().optional(),
  files: z.record(z.string(), z.unknown()).optional().catch({}),
  assetCategories: z.array(z.unknown()).optional().catch([]),
  assets: z.array(z.unknown()).optional().catch([]),
  timeline: z.unknown().optional(),
  createdAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
}).passthrough();

function logJsonbValidationError(context: string, error: z.ZodError) {
  console.warn("[projects/jsonb] invalid browser project JSONB", {
    context,
    issues: error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export function parseBrowserProjectDocumentJsonb(
  value: unknown,
  context = "project-read",
): Record<string, unknown> | null {
  const parsed = BrowserProjectDocumentInputSchema.safeParse(value);
  if (!parsed.success) {
    logJsonbValidationError(context, parsed.error);
    return null;
  }
  return parsed.data;
}

export function parseBrowserProjectDocumentForWrite<T>(
  value: T,
  context = "project-write",
): T {
  const parsed = BrowserProjectDocumentSchema.safeParse(value);
  if (!parsed.success) {
    logJsonbValidationError(context, parsed.error);
    throw new Error("Browser project JSONB failed validation.");
  }
  return parsed.data as T;
}
