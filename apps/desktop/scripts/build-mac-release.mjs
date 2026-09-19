#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopRoot, "../..");
const electronBuilder = path.join(desktopRoot, "node_modules", ".bin", "electron-builder");

function parseEnvValue(value) {
  let next = String(value || "").trim();
  if (!next) return "";
  if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1);
  }
  return next.replace(/\\n/g, "\n");
}

function loadEnvFile(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = parseEnvValue(match[2]);
  }
}

function run(command, args, options = {}) {
  console.log(`\n> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env: process.env,
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(result.status || 1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

loadEnvFile(".env.local");
loadEnvFile(".vercel/.env.production.local");

run("npm", ["run", "check:mac-distribution"]);
run("npm", ["run", "build"]);
run(electronBuilder, ["--mac", "dmg", "zip", "--arm64", "-c.forceCodeSigning=true"]);
run("npm", ["run", "audit:distribution-ip"]);
run("npm", ["run", "verify:mac-distribution"]);
