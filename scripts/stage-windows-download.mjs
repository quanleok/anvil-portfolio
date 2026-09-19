import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const rootDir = process.cwd();
const releaseDir = path.join(rootDir, "apps", "desktop", "release");
const downloadDir = path.join(rootDir, "public", "downloads");
const packageFile = path.join(rootDir, "apps", "desktop", "package.json");
const execFileAsync = promisify(execFile);
const INSTALLER_OBJECT_KEY = "downloads/forge-windows-x64.exe";
const ZIP_OBJECT_KEY = "downloads/forge-windows-x64.zip";
const INSTALLER_ROUTE = "/downloads/forge-windows-x64.exe";
const ZIP_ROUTE = "/downloads/forge-windows-x64.zip";

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
    .filter((entry) => entry.includes("Windows") && entry.endsWith(extension))
    .sort()
    .at(-1);

  if (!match) {
    throw new Error(`No Windows ${extension} artifact found in ${releaseDir}`);
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
  await fs.mkdir(downloadDir, { recursive: true });
  const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8"));

  const exeSource = await findArtifact(".exe");
  const exeTarget = path.join(downloadDir, "forge-windows-x64.exe");
  const zipTarget = path.join(downloadDir, "forge-windows-x64.zip");

  await fs.copyFile(exeSource, exeTarget);
  await fs.rm(zipTarget, { force: true });
  await execFileAsync("zip", ["-j", "-q", zipTarget, exeTarget], { cwd: downloadDir });
  const uploadedInstaller = await uploadToBunny(exeTarget, INSTALLER_OBJECT_KEY, "application/vnd.microsoft.portable-executable");
  const uploadedZip = await uploadToBunny(zipTarget, ZIP_OBJECT_KEY, "application/zip");

  if (process.env.ANVIL_STAGE_LOCAL_DOWNLOADS !== "1") {
    await fs.rm(exeTarget, { force: true });
    await fs.rm(zipTarget, { force: true });
  }

  const manifest = {
    version: packageJson.version,
    platform: "windows",
    arch: "x64",
    type: "installer",
    installer: INSTALLER_ROUTE,
    zip: ZIP_ROUTE,
    installerObjectKey: INSTALLER_OBJECT_KEY,
    zipObjectKey: ZIP_OBJECT_KEY,
    recommended: "zip",
    storage: uploadedInstaller && uploadedZip ? "bunny" : "local",
  };

  await fs.writeFile(
    path.join(downloadDir, "forge-windows-x64.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  console.log(
    uploadedInstaller && uploadedZip
      ? `Uploaded Windows artifacts to Bunny and staged manifest in ${downloadDir}`
      : `Staged Windows manifest in ${downloadDir}; set Bunny env or ANVIL_STAGE_LOCAL_DOWNLOADS=1 for downloadable artifacts`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
