import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const assetsDir = path.join(root, "dist", "assets");
const maxJsChunkBytes = 650 * 1024;
// The app shell uses one global stylesheet for the Electron surface. Keep
// the cap close to the current compressed UI surface so real CSS bloat
// still fails. Bumped 2026-05-04 from 250 → 280 KiB to absorb today's
// stabilization-pass additions (error-card hints, adaptive script tree
// container queries, sub-prompt visuals, magnetic-timeline ghost states,
// floating notice toast, clip thumbnails). Real CSS bloat above ~280 KiB
// still fails.
const maxCssChunkBytes = 280 * 1024;
const maxDistAssetBytes = 8 * 1024 * 1024;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function readDistAssets() {
  try {
    return readdirSync(assetsDir).map((name) => {
      const filePath = path.join(assetsDir, name);
      return { name, size: statSync(filePath).size };
    });
  } catch {
    console.error("Bundle check failed: dist/assets is missing. Run npm run build first.");
    process.exit(1);
  }
}

const assets = readDistAssets();
const totalBytes = assets.reduce((sum, item) => sum + item.size, 0);
const oversizedJs = assets.filter((item) => item.name.endsWith(".js") && item.size > maxJsChunkBytes);
const oversizedCss = assets.filter((item) => item.name.endsWith(".css") && item.size > maxCssChunkBytes);
const failures = [];

if (totalBytes > maxDistAssetBytes) {
  failures.push(`dist assets are ${formatBytes(totalBytes)}, over ${formatBytes(maxDistAssetBytes)}`);
}
if (oversizedJs.length) {
  failures.push(`oversized JS chunks:\n${oversizedJs.map((item) => `  - ${item.name} (${formatBytes(item.size)})`).join("\n")}`);
}
if (oversizedCss.length) {
  failures.push(`oversized CSS chunks:\n${oversizedCss.map((item) => `  - ${item.name} (${formatBytes(item.size)})`).join("\n")}`);
}

if (failures.length) {
  console.error(`Bundle check failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(`Bundle check passed: ${assets.length} files, ${formatBytes(totalBytes)}.`);
