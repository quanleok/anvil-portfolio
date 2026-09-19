const fs = require("node:fs/promises");
const path = require("node:path");

const APP_FOLDER = ".forge";
const PROJECT_FILE = "project.json";
const PREMIUM_SKILLS_DIR = path.join(APP_FOLDER, "premium-skills");
const PREMIUM_AUTOMATION_ENV = "ANVIL_PREMIUM_AUTOMATION";

const SERVER_SIDE_MESSAGE =
  "Protected Anvil automation recipes are server-side and are not readable in the desktop client.";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function readProjectEntitlement(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, APP_FOLDER, PROJECT_FILE), "utf8");
    const parsed = JSON.parse(raw);
    const settings = parsed?.settings && typeof parsed.settings === "object" ? parsed.settings : {};
    const entitlements = settings.entitlements && typeof settings.entitlements === "object"
      ? settings.entitlements
      : {};
    return Boolean(
      entitlements.premiumAutomation ||
      entitlements.studioAutomation ||
      settings.premiumAutomationEnabled,
    );
  } catch {
    return false;
  }
}

async function hasLegacyLocalPremiumSkills(projectDir) {
  try {
    await fs.access(path.join(projectDir, PREMIUM_SKILLS_DIR));
    return true;
  } catch {
    return false;
  }
}

async function isPremiumAutomationEnabled(projectDir) {
  if (truthy(process.env[PREMIUM_AUTOMATION_ENV])) return true;
  return readProjectEntitlement(projectDir);
}

async function ensurePremiumAutomationScaffold(projectDir) {
  const enabled = await isPremiumAutomationEnabled(projectDir);
  return {
    enabled,
    seeded: false,
    copied: 0,
    path: PREMIUM_SKILLS_DIR,
    serverSide: true,
    legacyLocalSkillsIgnored: await hasLegacyLocalPremiumSkills(projectDir),
    message: enabled
      ? "Premium automation is enabled, but recipe content is served by the protected Anvil server."
      : "Premium automation is disabled for this project.",
  };
}

async function listPremiumAutomationSkills(projectDir) {
  const enabled = await isPremiumAutomationEnabled(projectDir);
  return {
    locked: true,
    enabled,
    serverSide: true,
    requires: "protectedAnvilServer",
    message: enabled
      ? "Premium automation recipes live on the protected Anvil server. The desktop client does not list recipe bodies from disk."
      : "Premium automation is disabled for this project.",
    count: 0,
    skills: [],
    legacyLocalSkillsIgnored: await hasLegacyLocalPremiumSkills(projectDir),
  };
}

async function readPremiumAutomationSkill(projectDir, name) {
  const enabled = await isPremiumAutomationEnabled(projectDir);
  return {
    locked: true,
    enabled,
    serverSide: true,
    requires: "protectedAnvilServer",
    name: slugify(name),
    message: SERVER_SIDE_MESSAGE,
    legacyLocalSkillsIgnored: await hasLegacyLocalPremiumSkills(projectDir),
  };
}

module.exports = {
  PREMIUM_AUTOMATION_ENV,
  PREMIUM_SKILLS_DIR,
  ensurePremiumAutomationScaffold,
  isPremiumAutomationEnabled,
  listPremiumAutomationSkills,
  readPremiumAutomationSkill,
};
