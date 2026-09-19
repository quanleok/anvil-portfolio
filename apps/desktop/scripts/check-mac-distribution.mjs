#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

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

loadEnvFile(".env.local");
loadEnvFile(".vercel/.env.production.local");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function fail(message) {
  failures.push(message);
}

const failures = [];

if (process.platform !== "darwin") {
  fail("macOS release builds must run on macOS so codesign, notarytool, and stapler are available.");
}

try {
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (!/Developer ID Application:/i.test(identities)) {
    fail("No Developer ID Application certificate was found in the current keychain.");
  }
} catch (error) {
  fail(`Could not inspect code-signing identities: ${error.message}`);
}

try {
  run("xcrun", ["notarytool", "--help"]);
} catch (error) {
  fail(`xcrun notarytool is not available: ${error.message}`);
}

const env = process.env;
const appleIdFields = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const apiKeyFields = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
const keychainFields = ["APPLE_KEYCHAIN_PROFILE"];

const hasAny = (fields) => fields.some((field) => Boolean(env[field]));
const hasAll = (fields) => fields.every((field) => Boolean(env[field]));
const missing = (fields) => fields.filter((field) => !env[field]);

if (!hasAny(appleIdFields) && !hasAny(apiKeyFields) && !hasAny(keychainFields)) {
  fail(
    "No notarization credentials were configured. Set APPLE_KEYCHAIN_PROFILE, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER.",
  );
}

if (hasAny(appleIdFields) && !hasAll(appleIdFields)) {
  fail(`Partial Apple ID notarization config. Missing: ${missing(appleIdFields).join(", ")}.`);
}

if (hasAny(apiKeyFields) && !hasAll(apiKeyFields)) {
  fail(`Partial App Store Connect API key notarization config. Missing: ${missing(apiKeyFields).join(", ")}.`);
}

if (env.APPLE_KEYCHAIN_PROFILE && env.ANVIL_MAC_SKIP_NOTARY_LOGIN_CHECK !== "1") {
  const args = ["notarytool", "history", "--keychain-profile", env.APPLE_KEYCHAIN_PROFILE, "--output-format", "json"];
  if (env.APPLE_KEYCHAIN) {
    args.splice(2, 0, "--keychain", env.APPLE_KEYCHAIN);
  }

  try {
    run("xcrun", args);
  } catch (error) {
    fail(
      `Stored notarytool profile '${env.APPLE_KEYCHAIN_PROFILE}' could not authenticate. Re-store it with xcrun notarytool store-credentials, or set ANVIL_MAC_SKIP_NOTARY_LOGIN_CHECK=1 to skip this network check.`,
    );
  }
}

if (failures.length > 0) {
  console.error("macOS release signing is not ready:");
  for (const item of failures) {
    console.error(`- ${item}`);
  }
  console.error("");
  console.error("This blocks public package:mac builds so an ad-hoc DMG is not uploaded to the live download page.");
  process.exit(1);
}

console.log("macOS release signing preflight passed.");
