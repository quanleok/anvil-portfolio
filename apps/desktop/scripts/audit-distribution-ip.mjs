#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const defaultAsar = path.join(desktopRoot, "release", "mac-arm64", "Anvil.app", "Contents", "Resources", "app.asar");

function resolveAsarPath(input) {
  if (!input) return defaultAsar;
  const absolute = path.resolve(input);
  if (absolute.endsWith(".asar")) return absolute;
  if (absolute.endsWith(".app")) return path.join(absolute, "Contents", "Resources", "app.asar");
  return absolute;
}

const asarPath = resolveAsarPath(process.argv[2]);

function fail(message) {
  console.error(`desktop distribution IP audit failed: ${message}`);
  process.exit(1);
}

const forbiddenSourcePaths = [
  {
    path: path.join(desktopRoot, "electron", "defaults", "premium-skills"),
    reason: "premium automation recipes must not live under apps/desktop source",
  },
];

for (const rule of forbiddenSourcePaths) {
  if (fs.existsSync(rule.path)) {
    fail(`${rule.reason}: ${rule.path}`);
  }
}

if (!fs.existsSync(asarPath)) {
  fail(`missing app.asar at ${asarPath}`);
}

const forbiddenPaths = [
  {
    pattern: /^\/electron\/defaults\/premium-skills(?:\/|$)/,
    reason: "premium automation recipes must stay server-side",
  },
  {
    pattern: /^\/electron\/defaults\/skills\/(?:agent-manual|intake-protocol|prompt-protocol)\.md$/,
    reason: "hidden agent/protocol docs must not ship in the public client",
  },
  {
    pattern: /^\/src\/server(?:\/|$)/,
    reason: "server implementation must not ship in the desktop client",
  },
  {
    pattern: /^\/src\/app\/api(?:\/|$)/,
    reason: "Next API routes must not ship in the desktop client",
  },
  {
    pattern: /^\/(?:\.env|.*\.env(?:\..*)?)$/,
    reason: "environment files must not ship in the desktop client",
  },
  {
    pattern: /^\/(?:docs|supabase)(?:\/|$)/,
    reason: "planning docs and Supabase server migrations must not ship in the desktop client",
  },
];

const asarFiles = asar.listPackage(asarPath);
const pathFailures = [];
for (const filePath of asarFiles) {
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(filePath)) {
      pathFailures.push({ filePath, reason: rule.reason });
    }
  }
}

const secretPatterns = [
  { pattern: /sk_live_[A-Za-z0-9_-]{20,}/, reason: "Stripe live secret key literal" },
  { pattern: /sk_test_[A-Za-z0-9_-]{20,}/, reason: "Stripe test secret key literal" },
  { pattern: /sk-ant-api[0-9A-Za-z_-]{20,}/, reason: "Anthropic key literal" },
  { pattern: /whsec_[A-Za-z0-9_-]{20,}/, reason: "Stripe webhook secret literal" },
  { pattern: /-----BEGIN (?:RSA |OPENSSH |EC |)PRIVATE KEY-----/, reason: "private key material" },
  { pattern: /\b(?:STRIPE_SECRET_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|BUNNY_STORAGE_ACCESS_KEY)\s*=\s*['"]?[^'"\s]+/, reason: "server secret assignment" },
  { pattern: /Premium skill\./i, reason: "premium skill recipe text" },
  { pattern: /You are the protected Anvil method runtime/i, reason: "protected method system prompt text" },
];

function walkFiles(rootDir) {
  const stack = [rootDir];
  const out = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(absolute);
      } else if (entry.isFile()) {
        out.push(absolute);
      }
    }
  }
  return out;
}

function isProbablyText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / Math.max(sample.length, 1) < 0.02;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-asar-audit-"));
const contentFailures = [];

try {
  asar.extractAll(asarPath, tempDir);
  for (const filePath of walkFiles(tempDir)) {
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) continue;
    const buffer = fs.readFileSync(filePath);
    if (!isProbablyText(buffer)) continue;
    const text = buffer.toString("utf8");
    const relativePath = `/${path.relative(tempDir, filePath).split(path.sep).join("/")}`;
    for (const rule of secretPatterns) {
      if (rule.pattern.test(text)) {
        contentFailures.push({ filePath: relativePath, reason: rule.reason });
      }
    }
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const failures = [...pathFailures, ...contentFailures];
if (failures.length > 0) {
  console.error(`Found ${failures.length} blocked item(s) in ${asarPath}:`);
  for (const failure of failures.slice(0, 80)) {
    console.error(`- ${failure.filePath}: ${failure.reason}`);
  }
  if (failures.length > 80) {
    console.error(`- ... ${failures.length - 80} more`);
  }
  process.exit(1);
}

console.log(`desktop distribution IP audit passed: ${asarPath}`);
