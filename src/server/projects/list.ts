import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { bunnyDownloadUrlForObjectKey } from "@/lib/storage/bunny";
import {
  browserProjectStoreStatus,
  listBrowserProjectsForOwner,
  type BrowserProjectPrivacy,
} from "./store";

export type ProjectPickerItem = {
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  lastUpdatedAt: string;
  thumbnailUrl: string | null;
};

export type ProjectPickerResult = {
  items: ProjectPickerItem[];
  nextCursor: string | null;
};

type ProjectPickerRow = {
  id: string;
  owner_id: string | null;
  name: string;
  privacy: BrowserProjectPrivacy;
  project: unknown;
  created_at: string;
  updated_at: string;
  thumbnail?: ProjectThumbnailRow[] | ProjectThumbnailRow | null;
};

type ProjectThumbnailRow = {
  object_key: string | null;
  created_at: string | null;
};

type ProjectListDatabase = {
  public: {
    Tables: {
      anvil_projects: {
        Row: ProjectPickerRow;
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "anvil_media_assets_project_id_fkey";
            columns: ["id"];
            referencedRelation: "anvil_media_assets";
            referencedColumns: ["project_id"];
            isOneToOne: false;
          },
        ];
      };
      anvil_media_assets: {
        Row: {
          id: string;
          owner_id: string | null;
          project_id: string | null;
          asset_id: string | null;
          kind: "image" | "video" | "audio" | "other";
          status: "pending_upload" | "uploaded" | "processing" | "ready" | "failed" | "deleted";
          object_key: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_OWNERS = 100;
const MAX_PAGES_PER_OWNER = 8;

type CursorValue = {
  createdAt: string;
  id: string;
};

type OwnerCache = {
  pages: Map<string, { expiresAt: number; result: ProjectPickerResult }>;
  touchedAt: number;
};

const projectListCache = new Map<string, OwnerCache>();

function boundedLimit(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(number)));
}

function slugForProject(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "project"
  );
}

function encodeCursor(item: ProjectPickerItem) {
  return Buffer.from(JSON.stringify({ createdAt: item.createdAt, id: item.id }), "utf8").toString("base64url");
}

function parseCursor(value: unknown): CursorValue | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const cursor = value.trim();
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorValue>;
    if (typeof decoded.createdAt === "string" && Date.parse(decoded.createdAt)) {
      return { createdAt: decoded.createdAt, id: typeof decoded.id === "string" ? decoded.id : "\uffff" };
    }
  } catch {
    // Backward-compatible plain ISO cursor support.
  }
  return Date.parse(cursor) ? { createdAt: cursor, id: "\uffff" } : null;
}

function cacheKey(limit: number, cursor: CursorValue | null) {
  return `${limit}:${cursor?.createdAt || ""}:${cursor?.id || ""}`;
}

function ownerCache(ownerId: string) {
  let cache = projectListCache.get(ownerId);
  if (!cache) {
    cache = { pages: new Map(), touchedAt: Date.now() };
    projectListCache.set(ownerId, cache);
  }
  cache.touchedAt = Date.now();
  return cache;
}

function trimProjectListCache() {
  while (projectListCache.size > MAX_CACHE_OWNERS) {
    const oldest = [...projectListCache.entries()].sort(([, left], [, right]) => left.touchedAt - right.touchedAt)[0]?.[0];
    if (!oldest) return;
    projectListCache.delete(oldest);
  }
}

function readCached(ownerId: string, key: string) {
  const cache = projectListCache.get(ownerId);
  const entry = cache?.pages.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache?.pages.delete(key);
    return null;
  }
  if (cache) cache.touchedAt = Date.now();
  return {
    items: entry.result.items.map((item) => ({ ...item })),
    nextCursor: entry.result.nextCursor,
  };
}

function writeCached(ownerId: string, key: string, result: ProjectPickerResult) {
  const cache = ownerCache(ownerId);
  cache.pages.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    result: {
      items: result.items.map((item) => ({ ...item })),
      nextCursor: result.nextCursor,
    },
  });
  while (cache.pages.size > MAX_PAGES_PER_OWNER) {
    const firstKey = cache.pages.keys().next().value;
    if (!firstKey) break;
    cache.pages.delete(firstKey);
  }
  trimProjectListCache();
}

export function invalidateProjectsForOwner(ownerId: string) {
  projectListCache.delete(ownerId);
}

function firstThumbnail(row: ProjectPickerRow) {
  const thumbnails = Array.isArray(row.thumbnail)
    ? row.thumbnail
    : row.thumbnail
      ? [row.thumbnail]
      : [];
  const objectKey = thumbnails.find((thumbnail) => typeof thumbnail.object_key === "string" && thumbnail.object_key)
    ?.object_key;
  if (!objectKey) return null;
  return bunnyDownloadUrlForObjectKey(objectKey)?.url || null;
}

function projectRowToItem(row: ProjectPickerRow): ProjectPickerItem {
  return {
    id: row.id,
    title: row.name || "Anvil Project",
    slug: slugForProject(row.name || row.id),
    createdAt: row.created_at,
    lastUpdatedAt: row.updated_at,
    thumbnailUrl: firstThumbnail(row),
  };
}

async function listMemoryProjects(ownerId: string, limit: number, cursor: CursorValue | null): Promise<ProjectPickerResult> {
  let items = (await listBrowserProjectsForOwner(ownerId))
    .map((project) => ({
      id: project.id,
      title: project.name,
      slug: slugForProject(project.name || project.id),
      createdAt: project.createdAt,
      lastUpdatedAt: project.updatedAt,
      thumbnailUrl: null,
    }))
    .sort((left, right) => {
      const created = right.createdAt.localeCompare(left.createdAt);
      return created || right.id.localeCompare(left.id);
    });

  if (cursor) {
    items = items.filter((item) => item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id < cursor.id));
  }

  const page = items.slice(0, limit + 1);
  const visible = page.slice(0, limit);
  return {
    items: visible,
    nextCursor: page.length > limit && visible.length ? encodeCursor(visible[visible.length - 1]) : null,
  };
}

export async function listProjectsForOwner(
  ownerId: string,
  options: { limit?: unknown; cursor?: unknown } = {},
): Promise<ProjectPickerResult> {
  const limit = boundedLimit(options.limit);
  const cursor = parseCursor(options.cursor);
  const key = cacheKey(limit, cursor);
  const cached = readCached(ownerId, key);
  if (cached) return cached;

  if (!browserProjectStoreStatus(ownerId).ownerHasDurableStore) {
    const result = await listMemoryProjects(ownerId, limit, cursor);
    writeCached(ownerId, key, result);
    return result;
  }

  let query = createSupabaseAdminClient<ProjectListDatabase>()
    .from("anvil_projects")
    .select(
      `
        id,
        owner_id,
        name,
        privacy,
        project,
        created_at,
        updated_at,
        thumbnail:anvil_media_assets!left(
          object_key,
          created_at
        )
      `,
    )
    .eq("owner_id", ownerId)
    .eq("thumbnail.owner_id", ownerId)
    .eq("thumbnail.kind", "image")
    .in("thumbnail.status", ["uploaded", "ready"])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .order("created_at", { ascending: true, referencedTable: "thumbnail" })
    .limit(limit + 1)
    .limit(1, { referencedTable: "thumbnail" });

  if (cursor) {
    query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  }

  const { data, error } = await query;
  if (error) throw error;

  const page = ((data || []) as ProjectPickerRow[]).map(projectRowToItem);
  const visible = page.slice(0, limit);
  const result = {
    items: visible,
    nextCursor: page.length > limit && visible.length ? encodeCursor(visible[visible.length - 1]) : null,
  };
  writeCached(ownerId, key, result);
  return result;
}
