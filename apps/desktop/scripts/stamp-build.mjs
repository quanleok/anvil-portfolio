// Writes electron/build-info.json with the current git short SHA, build time,
// and package version. Also regenerates CHANGELOG.md at the repo root from
// `git log`. Runs as a prebuild step so the packaged app can read build-info
// even when git isn't available at runtime.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const repoRoot = join(here, "..", "..", "..");

let sha = "";
try {
  sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
} catch {
  sha = "";
}

let dirty = false;
try {
  // Only flag dirty on TRACKED changes — untracked scratch files (evals,
  // notes, logs) shouldn't show up as a build-state change.
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
  dirty = status.length > 0;
} catch {}

let commitCount = 0;
try {
  commitCount = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim()) || 0;
} catch {}

const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const info = {
  version: pkg.version,
  build: sha ? (dirty ? `${sha}+dirty` : sha) : "",
  commitCount,
  builtAt: new Date().toISOString(),
};

writeFileSync(
  join(projectRoot, "electron", "build-info.json"),
  `${JSON.stringify(info, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`stamped build-info: ${info.version} ${info.build} #${commitCount}\n`);

// --- CHANGELOG.md (repo root) ------------------------------------------------
// Regenerate from `git log` every prebuild. Deterministic — same git state
// produces the same file, so no spurious diffs between rebuilds on the same
// commit. Bails silently if git is unavailable or the repo has no commits.

const CHANGELOG_ENTRIES = 60;
try {
  const raw = execFileSync(
    "git",
    [
      "log",
      `-${CHANGELOG_ENTRIES}`,
      "--pretty=format:%h%x09%ad%x09%s",
      "--date=short",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    },
  ).trim();

  if (raw) {
    const groupsByDate = new Map();
    for (const line of raw.split("\n")) {
      const tab1 = line.indexOf("\t");
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab1 < 0 || tab2 < 0) continue;
      const shortSha = line.slice(0, tab1);
      const date = line.slice(tab1 + 1, tab2);
      const subject = line.slice(tab2 + 1);
      if (!groupsByDate.has(date)) groupsByDate.set(date, []);
      groupsByDate.get(date).push({ shortSha, subject });
    }

    const lines = [
      "# Changelog",
      "",
      "_Auto-generated from `git log` on every prebuild (`apps/desktop/scripts/stamp-build.mjs`). Do not hand-edit — changes are overwritten on the next build._",
      "",
      `_Showing the most recent ${CHANGELOG_ENTRIES} commits, grouped by day. Full history: \`git log\`._`,
      "",
    ];
    for (const [date, entries] of groupsByDate) {
      lines.push(`## ${date}`, "");
      for (const { shortSha, subject } of entries) {
        lines.push(`- ${subject} (\`${shortSha}\`)`);
      }
      lines.push("");
    }

    const nextBody = lines.join("\n");
    const changelogPath = join(repoRoot, "CHANGELOG.md");
    // Skip the write when unchanged to avoid noisy mtime churn on watch tools.
    const prevBody = existsSync(changelogPath)
      ? readFileSync(changelogPath, "utf8")
      : "";
    if (prevBody !== nextBody) {
      writeFileSync(changelogPath, nextBody, "utf8");
      process.stdout.write(`stamped CHANGELOG.md: ${groupsByDate.size} day(s), ${raw.split("\n").length} commit(s)\n`);
    } else {
      process.stdout.write("CHANGELOG.md unchanged — skipped\n");
    }
  }
} catch {
  // Git unavailable or no commits — leave any existing CHANGELOG.md alone.
}
