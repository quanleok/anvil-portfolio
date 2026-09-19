import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const assetsDir = path.join(srcDir, "assets");
const sourceExtensions = new Set([".css", ".html", ".ts", ".tsx"]);
const assetExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const maxSourceAssetBytes = 8 * 1024 * 1024;
const maxSingleAssetBytes = 1024 * 1024;
const sourceRootsForJunkFiles = ["src", "electron", "scripts", "tests"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
    } else {
      out.push(fullPath);
    }
  }
  return out;
}

const sourceText = walk(srcDir)
  .filter((filePath) => !filePath.startsWith(assetsDir))
  .filter((filePath) => sourceExtensions.has(path.extname(filePath)))
  .map((filePath) => readFileSync(filePath, "utf8"))
  .join("\n");

const assetFiles = walk(assetsDir).filter((filePath) => assetExtensions.has(path.extname(filePath)));
let totalBytes = 0;
const oversize = [];
const orphaned = [];
const junkFiles = [];

for (const filePath of assetFiles) {
  const relativePath = path.relative(srcDir, filePath).split(path.sep).join("/");
  const baseName = path.basename(filePath);
  const byteSize = statSync(filePath).size;
  totalBytes += byteSize;
  if (byteSize > maxSingleAssetBytes) {
    oversize.push(`${relativePath} (${formatBytes(byteSize)})`);
  }
  if (!sourceText.includes(baseName) && !sourceText.includes(relativePath)) {
    orphaned.push(relativePath);
  }
}

for (const relativeRoot of sourceRootsForJunkFiles) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!existsSync(absoluteRoot)) continue;
  for (const filePath of walk(absoluteRoot)) {
    if (path.basename(filePath) === ".DS_Store") {
      junkFiles.push(path.relative(root, filePath).split(path.sep).join("/"));
    }
  }
}

const failures = [];
if (totalBytes > maxSourceAssetBytes) {
  failures.push(`source assets are ${formatBytes(totalBytes)}, over ${formatBytes(maxSourceAssetBytes)}`);
}
if (oversize.length) {
  failures.push(`oversized assets:\n${oversize.map((item) => `  - ${item}`).join("\n")}`);
}
if (orphaned.length) {
  failures.push(`orphaned assets:\n${orphaned.map((item) => `  - ${item}`).join("\n")}`);
}
if (junkFiles.length) {
  failures.push(`source junk files:\n${junkFiles.map((item) => `  - ${item}`).join("\n")}`);
}

if (failures.length) {
  console.error(`Asset check failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(`Asset check passed: ${assetFiles.length} files, ${formatBytes(totalBytes)}.`);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
