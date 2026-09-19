const premiumAutomation = require("../../premium-automation.cjs");
const skillLibrary = require("../../skill-library.cjs");

const SKILLS_DIR = skillLibrary.SKILLS_DIR;

module.exports = function registerSkillTools(api) {
  const { registerTool } = api;

  registerTool("list_skills", {
    tier: "meta",
    description:
      "List enabled user-visible Anvil Skills (.forge/skills/*.md): asset-reference, craft, add-on, and custom notes. Internal Anvil protocols and protected Anvil methods are hidden from the desktop client.",
    args: {},
    async run(_args, ctx) {
      const skills = await skillLibrary.listSkillDocs(ctx.projectDir, { enabledOnly: true });
      return { count: skills.length, skills };
    },
  });

  registerTool("read_skill", {
    tier: "meta",
    description:
      "Read one enabled user-visible Anvil Skill (.forge/skills/<name>.md). Use for asset-reference, craft, add-on, and custom guidance before writing project files.",
    args: { name: "skill name or slug (e.g. 'image-generation', 'prompt-protocol')" },
    async run({ name }, ctx) {
      const doc = await skillLibrary.readSkillDoc(ctx.projectDir, name);
      if (!doc) {
        const available = await skillLibrary.listSkillDocs(ctx.projectDir, { enabledOnly: true });
        throw new Error(
          `read_skill: '${name}' not found. Available: ${available.map((s) => s.name).join(", ") || "none"}`,
        );
      }
      return doc;
    },
  });

  registerTool("list_premium_automation_skills", {
    tier: "premium",
    description:
      "Legacy compatibility tool. Reports that protected Anvil method recipes are server-side and not readable from the desktop client.",
    args: {},
    async run(_args, ctx) {
      return premiumAutomation.listPremiumAutomationSkills(ctx.projectDir);
    },
  });

  registerTool("read_premium_automation_skill", {
    tier: "premium",
    description:
      "Legacy compatibility tool. Returns a server-side lock response; protected Anvil recipe content must be requested through hosted Anvil method endpoints.",
    args: { name: "protected method name or slug (e.g. 'film-blueprint-director', 'seedance-prompting')" },
    async run({ name }, ctx) {
      return premiumAutomation.readPremiumAutomationSkill(ctx.projectDir, name);
    },
  });
};

module.exports.SKILLS_DIR = SKILLS_DIR;
