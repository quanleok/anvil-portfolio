const referenceStaging = require("../../reference-staging.cjs");

module.exports = function registerReferenceStagingTools(api) {
  const { registerTool } = api;

  registerTool("stage_reference_media", {
    tier: "media",
    description:
      "Prepare a local image/video/audio reference for a media provider. Use mode:'upload' for providers that accept local file upload paths (Topview-style). Use mode:'url' for providers that require public HTTPS references (EvoLink-style); URL mode publishes through ANVIL_REFERENCE_PUBLIC_DIR+ANVIL_REFERENCE_BASE_URL or Bunny env vars when configured. Public HTTPS inputs pass through unchanged.",
    args: {
      path: "required — project-relative path, absolute path inside the project, or public HTTPS URL.",
      provider: "optional — provider name/id. Auto mode chooses url for EvoLink and upload for Topview/unknown.",
      mode: "optional — auto | upload | url. Default auto.",
    },
    async run({ path, provider, mode }, ctx) {
      return referenceStaging.stageReferenceMedia({
        projectDir: ctx.projectDir,
        referencePath: path,
        provider,
        mode,
      });
    },
  });
};
