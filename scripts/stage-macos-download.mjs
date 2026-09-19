import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const rootDir = process.cwd();
const releaseDir = path.join(rootDir, "apps", "desktop", "release");
const manifestDir = path.join(rootDir, "public", "download-manifests");
const packageFile = path.join(rootDir, "apps", "desktop", "package.json");
const DOWNLOAD_OBJECT_KEY =
  process.env.ANVIL_MACOS_ARM64_DMG_OBJECT_KEY || "downloads/forge-macos-arm64-0.2.2-clean.dmg";
const DOWNLOAD_ROUTE = "/downloads/forge-macos-arm64.dmg";

function parseEnvValue(value) {
  let next = String(value || "").trim();
  if (!next) return "";
  if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1);
  }
  return next.replace(/\\n/g, "\n");
}

async function loadEnvFile(relativePath, override = false) {
  try {
    const raw = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      if (!override && process.env[match[1]]) continue;
      process.env[match[1]] = parseEnvValue(match[2]);
    }
  } catch {}
}

async function findArtifact(extension) {
  const entries = await fs.readdir(releaseDir);
  const match = entries
    .filter((entry) => entry.endsWith(extension))
    .sort()
    .at(-1);

  if (!match) {
    throw new Error(`No ${extension} artifact found in ${releaseDir}`);
  }

  return path.join(releaseDir, match);
}

function bunnyConfig() {
  const zone = process.env.BUNNY_STORAGE_ZONE || process.env.BUNNY_STORAGE_ZONE_NAME || "";
  const accessKey = process.env.BUNNY_STORAGE_ACCESS_KEY || process.env.BUNNY_ACCESS_KEY || "";
  const endpoint = (process.env.BUNNY_STORAGE_ENDPOINT || "https://storage.bunnycdn.com").replace(/\/+$/, "");
  return {
    configured: Boolean(zone && accessKey),
    zone,
    accessKey,
    endpoint,
  };
}

async function uploadToBunny(filePath, objectKey, contentType) {
  const config = bunnyConfig();
  if (!config.configured) return false;

  const body = await fs.readFile(filePath);
  const url = `${config.endpoint}/${encodeURIComponent(config.zone)}/${objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      AccessKey: config.accessKey,
      "content-type": contentType,
      "content-length": String(body.byteLength),
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Bunny upload failed for ${objectKey}: ${response.status} ${detail.slice(0, 200)}`);
  }
  return true;
}

async function main() {
  await loadEnvFile(".env.local");
  await loadEnvFile(".vercel/.env.production.local");
  await fs.rm(path.join(rootDir, "public", "downloads"), { recursive: true, force: true });
  await fs.mkdir(manifestDir, { recursive: true });
  const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8"));

  execFileSync("npm", ["--prefix", "apps/desktop", "run", "audit:distribution-ip"], {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (process.env.ANVIL_ALLOW_UNSIGNED_STAGE !== "1") {
    execFileSync("npm", ["--prefix", "apps/desktop", "run", "verify:mac-distribution"], {
      cwd: rootDir,
      stdio: "inherit",
    });
  }

  const dmgSource = await findArtifact(".dmg");
  const uploaded = await uploadToBunny(dmgSource, DOWNLOAD_OBJECT_KEY, "application/x-apple-diskimage");

  const manifest = {
    version: packageJson.version,
    platform: "macos",
    arch: "arm64",
    dmg: DOWNLOAD_ROUTE,
    objectKey: DOWNLOAD_OBJECT_KEY,
    storage: uploaded ? "bunny" : "local",
  };

  await fs.writeFile(
    path.join(manifestDir, "forge-macos-arm64.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  console.log(
    uploaded
      ? `Uploaded macOS artifact to Bunny and staged manifest in ${manifestDir}`
      : `Staged macOS manifest in ${manifestDir}; set Bunny env for a downloadable artifact`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
