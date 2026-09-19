const fs = require("node:fs");
const path = require("node:path");

const builtins = require("./builtins.cjs");

let customToolsLoaded = false;

function registerCustomModule(modulePath) {
  const loaded = require(modulePath);
  const api = {
    registerTool: builtins.registerTool,
    runTool: builtins.runTool,
    listTools: builtins.listTools,
    listTierIndex: builtins.listTierIndex,
    resolveInside: builtins.resolveInside,
  };

  if (typeof loaded === "function") {
    loaded(api);
    return;
  }

  if (loaded && typeof loaded.register === "function") {
    loaded.register(api);
    return;
  }

  if (loaded && typeof loaded.name === "string" && loaded.definition) {
    builtins.registerTool(loaded.name, loaded.definition);
    return;
  }

  throw new Error(
    `Custom tool module ${path.basename(modulePath)} must export a function, a register(api) method, or { name, definition }.`,
  );
}

function loadCustomTools() {
  if (customToolsLoaded) return;
  customToolsLoaded = true;

  const customDir = path.join(__dirname, "custom");
  if (!fs.existsSync(customDir)) return;

  const entries = fs
    .readdirSync(customDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tool.cjs"))
    .map((entry) => entry.name)
    .sort();

  for (const entry of entries) {
    registerCustomModule(path.join(customDir, entry));
  }
}

loadCustomTools();

module.exports = builtins;
