import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrowserProjectDocumentSchema,
  PROJECT_FILE_SAFE_PATH_PATTERN_SOURCE,
  VALID_FILE_ROOTS,
} from "./jsonb-schemas";

type FixtureFile = {
  path: string;
  title: string;
  kind: string;
  content: string;
  contextGroup: string;
  createdAt: string;
  updatedAt: string;
};

function fixtureProject() {
  const now = "2026-05-12T00:00:00.000Z";
  const files: Record<string, FixtureFile> = {
    "story/project-scope.md": {
      path: "story/project-scope.md",
      title: "Project Scope",
      kind: "markdown",
      content: "",
      contextGroup: "project",
      createdAt: now,
      updatedAt: now,
    },
  };

  return {
    schemaVersion: 1,
    icon: "canon-book",
    files,
    assetCategories: [
      {
        id: "characters",
        name: "Characters",
        kind: "character",
      },
    ],
    assets: [
      {
        assetId: "asset-1",
        section: "characters",
        name: "Hero",
        folder: null,
        content: "",
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    timeline: {
      version: 1,
      clips: [],
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("browser project JSONB schemas", () => {
  it("accepts the persisted browser project shape", () => {
    expect(BrowserProjectDocumentSchema.safeParse(fixtureProject()).success).toBe(true);
  });

  it("rejects files outside the allowed markdown roots", () => {
    const project = fixtureProject();

    expect(
      BrowserProjectDocumentSchema.safeParse({
        ...project,
        files: {
          "private/secret.md": {
            ...project.files["story/project-scope.md"],
            path: "private/secret.md",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the TypeScript file roots in parity with the latest Supabase path constraint", () => {
    const migrationsDir = path.resolve(__dirname, "../../../supabase/migrations");
    const migrationPath = readdirSync(migrationsDir)
      .filter((fileName) => fileName.endsWith(".sql"))
      .map((fileName) => path.join(migrationsDir, fileName))
      .filter((filePath) => readFileSync(filePath, "utf8").includes("anvil_project_files_safe_path"))
      .sort()
      .at(-1);
    if (!migrationPath) throw new Error("No Supabase migration defines anvil_project_files_safe_path.");
    const sql = readFileSync(migrationPath, "utf8");
    const sqlPathPatterns = [...sql.matchAll(/\b(?:path|file_entry\.key)\s+~\s+'([^']+\[.\]md\$)'/g)].map(
      (match) => match[1],
    );

    expect(sqlPathPatterns.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sqlPathPatterns)).toEqual(new Set([PROJECT_FILE_SAFE_PATH_PATTERN_SOURCE]));

    const roots = PROJECT_FILE_SAFE_PATH_PATTERN_SOURCE.match(/^\^\(([^)]+)\)\//)?.[1]?.split("|");
    expect(roots).toEqual([...VALID_FILE_ROOTS]);
  });
});
