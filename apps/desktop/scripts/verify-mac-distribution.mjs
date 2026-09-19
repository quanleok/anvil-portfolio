#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(desktopRoot, "release");
const appPath = path.join(releaseDir, "mac-arm64", "Anvil.app");

function runInherit(command, args) {
  execFileSync(command, args, {
    cwd: desktopRoot,
    stdio: "inherit",
  });
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function fail(message) {
  console.error(`macOS distribution verification failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(appPath)) {
  fail(`missing built app at ${appPath}`);
}

runInherit("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

const details = runCapture("codesign", ["-dv", "--verbose=4", appPath]);
if (/Signature=adhoc/i.test(details)) {
  fail("app is still ad-hoc signed");
}
if (/TeamIdentifier=not set/i.test(details) || !/TeamIdentifier=/i.test(details)) {
  fail("app is missing a Developer ID TeamIdentifier");
}

runInherit("xcrun", ["stapler", "validate", appPath]);
runInherit("spctl", ["-a", "-vvv", "-t", "exec", appPath]);

const dmgArtifacts = fs
  .readdirSync(releaseDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"))
  .map((entry) => path.join(releaseDir, entry.name));

if (dmgArtifacts.length === 0) {
  fail(`missing DMG artifact in ${releaseDir}`);
}

console.log("macOS distribution verification passed.");
