const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const evolink = require("../../evolink.cjs");
const { extractFirstAndLastFrames } = require("../../frames.cjs");
const { stageReferenceMedia } = require("../../reference-staging.cjs");

const VALID_SECTIONS = new Set(["characters", "locations", "props", "keyframes", "audio", "inbox", "library"]);
const MEDIA_CAPABILITIES = new Set(["image", "video", "music", "voice"]);

// Serialize a meta object back to YAML-ish frontmatter. Mirrors
// serializeMarkdownDocument in main.cjs so round-trips stay stable:
// null/undefined/empty strings are skipped; everything else is coerced
// with String() and stripped of embedded newlines. Arrays go through
// JSON.stringify upstream (same convention as entityRefs) — we don't
// special-case them here.
function rewriteFrontmatter(raw, patch) {
  const text = typeof raw === "string" ? raw : "";
  const hasFrontmatter = text.startsWith("---\n");
  let body = text;
  let meta = {};
  if (hasFrontmatter) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      const metaBlock = text.slice(4, end);
      body = text.slice(end + 5);
      for (const line of metaBlock.split("\n")) {
        const sep = line.indexOf(":");
        if (sep === -1) continue;
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (key) meta[key] = value;
      }
    }
  }
  const next = { ...meta, ...patch };
  const lines = ["---"];
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${key}: ${String(value).replace(/\n+/g, " ").trim()}`);
  }
  lines.push("---", "", String(body || "").trim());
  return lines.join("\n").replace(/\n+$/, "\n");
}

function providerCapabilities(entry) {
  const raw = Array.isArray(entry?.capabilities) && entry.capabilities.length
    ? entry.capabilities
    : typeof entry?.capability === "string"
      ? [entry.capability]
      : [];
  const out = [];
  for (const value of raw) {
    const clean = String(value || "").trim().toLowerCase();
    if (!MEDIA_CAPABILITIES.has(clean) || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}

function providerSecret(entry) {
  const envVar = typeof entry?.envVar === "string" ? entry.envVar.trim() : "";
  const fromEnv = envVar && typeof process.env[envVar] === "string" ? process.env[envVar].trim() : "";
  if (fromEnv) return fromEnv;
  return typeof entry?.apiKey === "string" ? entry.apiKey.trim() : "";
}

function isEvolinkProvider(entry) {
  const haystack = [
    entry?.id,
    entry?.label,
    entry?.endpoint,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return haystack.includes("evolink");
}

// Decorated throws — pre-classified so the agent-loop envelope carries
// `errorType` straight to ActivityFeed's per-kind hint. Without these,
// unclassified throws fall through to errorType: "unknown" and the user
// sees a bare "failed" with no remediation pointer.
function authError(message) {
  const err = new Error(message);
  err.kind = "auth";
  err.provider = "evolink";
  return err;
}
function payloadError(message) {
  const err = new Error(message);
  err.kind = "payload";
  err.provider = "evolink";
  return err;
}
function providerError(message) {
  const err = new Error(message);
  err.kind = "server";
  err.provider = "evolink";
  return err;
}

function resolveApiKey(ctx, capability) {
  // Resolution order:
  //   1. Capability-enabled EvoLink provider from Settings -> Providers
  //   2. Legacy env/media fields, but only when the project has no
  //      explicit EvoLink provider disabling this capability.
  // This makes the Settings checkboxes real routing gates instead of
  // cosmetic labels: unchecked Image means "do not spend this API key
  // for images; use native CLI generation or ask the user."
  const providers = Array.isArray(ctx?.settings?.apiProviders) ? ctx.settings.apiProviders : [];
  const evolinkProviders = providers.filter(isEvolinkProvider);
  if (evolinkProviders.length) {
    const enabled = evolinkProviders.find((entry) => providerCapabilities(entry).includes(capability));
    if (enabled) {
      const key = providerSecret(enabled);
      if (key) return key;
      throw authError(
        `EvoLink ${capability} generation is enabled, but no key is configured. Add the key in Settings -> API Keys or set ${enabled.envVar || "EVOLINK_API_KEY"}.`,
      );
    }
    throw authError(
      `External EvoLink ${capability} generation is disabled for this project. Settings -> API Keys has EvoLink, but ${capability} is unchecked. Use the active terminal agent's native generation path for ${capability}, and save untargeted outputs under assets/library/, or enable ${capability} on the EvoLink provider.`,
    );
  }

  const externalProvider = providers.find((entry) => providerCapabilities(entry).includes(capability) && providerSecret(entry));
  if (externalProvider) {
    throw authError(
      `generate_${capability} is the EvoLink adapter, but provider '${externalProvider.label || externalProvider.id}' is selected for ${capability}. Use read_provider_docs('${externalProvider.id}') and the provider's documented endpoint instead, or add/enable an EvoLink provider.`,
    );
  }

  const fromEnv = typeof process.env.EVOLINK_API_KEY === "string" ? process.env.EVOLINK_API_KEY.trim() : "";
  if (fromEnv) return fromEnv;
  const perCap =
    capability && typeof ctx?.settings?.mediaKeys?.[capability] === "string"
      ? ctx.settings.mediaKeys[capability].trim()
      : "";
  if (perCap) return perCap;
  const fromSettings =
    typeof ctx?.settings?.evolinkApiKey === "string" ? ctx.settings.evolinkApiKey.trim() : "";
  if (fromSettings) return fromSettings;
  throw authError(
    `${capability ? `${capability} ` : ""}API key is not configured. Add an "EvoLink" entry in Settings → Providers with your API key, or export EVOLINK_API_KEY.`,
  );
}

// Pick the model for a capability. User-configured Settings model
// ALWAYS wins over whatever the agent passed — so the agent can't
// drift to an unsupported slug like gpt-image-1 when the token is
// actually scoped to nano-banana-pro. Order:
//   1. ctx.settings.mediaModels[capability]  (explicit user preset)
//   2. agentModel                            (agent's tool arg)
//   3. adapter default                        (normalize fallback)
function resolveMediaModel(ctx, capability, agentModel) {
  const preset =
    capability && typeof ctx?.settings?.mediaModels?.[capability] === "string"
      ? ctx.settings.mediaModels[capability].trim()
      : "";
  if (preset) return preset;
  const fromAgent = typeof agentModel === "string" ? agentModel.trim() : "";
  return fromAgent;
}

function normalizeSection(section, fallback) {
  const clean = String(section || "").trim().toLowerCase();
  if (!clean) return fallback;
  if (!VALID_SECTIONS.has(clean)) {
    throw payloadError(
      `Section '${clean}' is not valid. Must be one of: ${Array.from(VALID_SECTIONS).join(", ")}.`,
    );
  }
  return clean;
}

async function ensureUniquePath(absolutePath) {
  const dir = path.dirname(absolutePath);
  const ext = path.extname(absolutePath);
  const base = path.basename(absolutePath, ext);
  let candidate = absolutePath;
  let index = 2;
  while (true) {
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${base}-${index}${ext}`);
    index += 1;
  }
}

function normalizeDelivery(value, settings) {
  if (value === "direct" || value === "inbox") return value;
  return settings?.agentMediaStaging === "inbox" ? "inbox" : "direct";
}

function imageOutputDirectory(intentSection, delivery) {
  if (delivery === "inbox" || intentSection === "inbox") return "assets/inbox";
  if (intentSection === "library") return "assets/library/images";
  if (["characters", "locations", "props", "keyframes"].includes(intentSection)) {
    return `assets/${intentSection}`;
  }
  return "assets/library/images";
}

async function assertBindableEntity(projectDir, section, entityId, readProjectMetadata) {
  const cleanId = String(entityId || "").trim();
  if (!cleanId) return null;
  const metadata = await readProjectMetadata(projectDir);
  const entries = Array.isArray(metadata?.[section]) ? metadata[section] : [];
  const hit = entries.find((entry) => entry?.id === cleanId);
  if (!hit) {
    throw payloadError(`direct bind target '${cleanId}' was not found in ${section}.`);
  }
  return cleanId;
}

async function bindGeneratedMedia(projectDir, section, entityId, savedPaths, kind, readProjectMetadata, writeProjectMetadata) {
  const cleanId = String(entityId || "").trim();
  if (!cleanId || !["characters", "locations", "props", "keyframes", "audio"].includes(section)) {
    return { bound: false, mediaCount: 0 };
  }
  const metadata = await readProjectMetadata(projectDir);
  const entries = Array.isArray(metadata?.[section]) ? metadata[section] : [];
  const index = entries.findIndex((entry) => entry?.id === cleanId);
  if (index < 0) {
    throw payloadError(`direct bind target '${cleanId}' was not found in ${section}.`);
  }
  const existingMedia = Array.isArray(entries[index].media) ? entries[index].media : [];
  const existingPaths = new Set(existingMedia.map((media) => String(media?.path || "").replace(/\\/g, "/")));
  const additions = savedPaths
    .map((entry) => String(entry?.path || "").replace(/\\/g, "/"))
    .filter((relativePath) => relativePath && !existingPaths.has(relativePath))
    .map((relativePath) => ({
      id: crypto.randomUUID(),
      kind,
      label: path.posix.basename(relativePath),
      path: relativePath,
    }));
  if (!additions.length) {
    return { bound: false, mediaCount: 0 };
  }
  const nextEntry = {
    ...entries[index],
    media: [...existingMedia, ...additions],
  };
  await writeProjectMetadata(projectDir, {
    ...metadata,
    [section]: [
      ...entries.slice(0, index),
      nextEntry,
      ...entries.slice(index + 1),
    ],
    project: {
      ...(metadata.project || {}),
      updatedAt: new Date().toISOString(),
    },
  });
  return { bound: true, mediaCount: additions.length, entityId: cleanId };
}

module.exports = function registerEvolinkGenTools(api) {
  const {
    registerTool,
    resolveInside,
    slugifyName,
    readProjectMetadata,
    writeProjectMetadata,
  } = api;

  // After a video lands on disk, mint a VideoEntry, append its id to the
  // owning prompt's `renders` list, and persist. Returns the new entry so
  // the tool result can echo the id + takeIndex back to the caller.
  //
  // `promptMeta` is the PromptEntry from the already-loaded project — not
  // re-read here. Caller is responsible for resolving it.
  async function linkVideoToPrompt({
    projectDir,
    promptMeta,
    relativeVideoPath,
    durationSec,
    generator,
    note,
  }) {
    const metadata = await readProjectMetadata(projectDir);
    const videos = Array.isArray(metadata.videos) ? metadata.videos.map((v) => ({ ...v })) : [];

    // takeIndex is max existing for this prompt + 1. Gaps from prior
    // deletes are preserved — old take-03 stays take-03.
    const existing = videos.filter((v) => v.promptId === promptMeta.id);
    const takeIndex = existing.reduce((m, v) => Math.max(m, v.takeIndex || 0), 0) + 1;

    const videoId = crypto.randomUUID();
    videos.push({
      id: videoId,
      path: relativeVideoPath,
      sceneId: promptMeta.sceneId || null,
      shotId: promptMeta.shotId || null,
      promptId: promptMeta.id,
      takeIndex,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      generator: generator || null,
      generatedAt: new Date().toISOString(),
      note: typeof note === "string" ? note : "",
    });

    // Append to the prompt's markdown frontmatter `renders` list. We
    // re-read the file (not trust metadata cache) to capture any renders
    // the user added manually between loads.
    const promptAbs = path.join(projectDir, promptMeta.path);
    let raw = "";
    try {
      raw = await fs.readFile(promptAbs, "utf8");
    } catch {
      // Prompt file missing — skip the markdown update but keep the
      // VideoEntry so the video isn't orphaned on disk.
    }
    if (raw) {
      let existingRenders = [];
      const match = raw.match(/^renders:\s*(.+)$/m);
      if (match) {
        const rawValue = match[1].trim();
        try {
          const parsed = JSON.parse(rawValue);
          if (Array.isArray(parsed)) existingRenders = parsed;
        } catch {
          // Corrupt renders field — start fresh to avoid wedging the append.
        }
      }
      const nextRenders = [...existingRenders, videoId];
      const patched = rewriteFrontmatter(raw, { renders: JSON.stringify(nextRenders) });
      await fs.writeFile(promptAbs, patched, "utf8");
    }

    // Persist project.json. writeProjectMetadata is atomic + serialized
    // (per-project withWriteLock + atomicWriteFile, see system/tools/
    // builtins.cjs and asset-C1 audit 2026-04-20) — concurrent fires
    // from agent-loop's Promise.all dispatch coordinate correctly.
    metadata.videos = videos;
    metadata.project = {
      ...metadata.project,
      updatedAt: new Date().toISOString(),
    };
    await writeProjectMetadata(projectDir, metadata);

    return { videoId, takeIndex };
  }

  // Derive scene-slug / shot-slug / prompt-slug from an entity's path so
  // the video mirror folder matches the script tree 1:1. Returns null if
  // the prompt path is malformed (no scene/shot/prompt parts).
  function mirrorFolderSegmentsFor(promptPath) {
    const parts = String(promptPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    // Expected shape: prompts/<scene-slug>/<shot-slug>/<prompt-file>.md
    if (parts.length < 4 || parts[0] !== "prompts") return null;
    const sceneSlug = parts[1];
    const shotSlug = parts[2];
    const promptSlug = path.basename(parts[parts.length - 1], path.extname(parts[parts.length - 1]));
    if (!sceneSlug || !shotSlug || !promptSlug) return null;
    return { sceneSlug, shotSlug, promptSlug };
  }

  registerTool("generate_image", {
    tier: "media",
    description:
      "Provider-first image generation through EvoLink; when Image is enabled for EvoLink in Settings, call this before terminal-agent native image generation. Fallback is only for tool/provider failure or when Image is disabled. Defaults to All media under assets/library/images; delivery:'direct' with a target section can bind to entityId when the user asked for a specific asset. Requires an EvoLink API key in Settings or the EVOLINK_API_KEY env var. Blocks until the image is ready (usually 10-60s).",
    args: {
      prompt: "required — text prompt for the image",
      assetSection:
        "optional — intended asset type and direct destination: characters | locations | props | keyframes | library | inbox (default: library / All media).",
      entityId:
        "optional — when delivery is direct and assetSection is characters | locations | props | keyframes, bind the saved image to this asset entry.",
      delivery:
        "optional — inbox | direct. Defaults to Settings -> Generated media routing.",
      assetName:
        "optional — used for the filename slug (e.g. 'frozen-skeleton-hall'). Default: slug of prompt.",
      model:
        "optional — nanobanana-pro | nanobanana-2 (default: gemini-3-pro-image-preview)",
      size: "optional — aspect hint like 16:9, 9:16, 1:1, auto (default: auto)",
      quality: "optional — 0.5K | 1K | 2K | 4K (default: 2K)",
      referenceUrls: "optional — array of public HTTPS image URLs",
    },
    async run({ prompt, assetSection, entityId, delivery, assetName, model, size = "auto", quality = "2K", referenceUrls = [] }, ctx) {
      const cleanPrompt = String(prompt || "").trim();
      if (!cleanPrompt) throw payloadError("generate_image: 'prompt' is required.");
      const apiKey = resolveApiKey(ctx, "image");
      // User's Settings preset wins over the agent's model arg.
      const chosenModel = resolveMediaModel(ctx, "image", model);
      const intentSection = normalizeSection(assetSection, "library");
      if (intentSection === "audio") {
        throw payloadError("generate_image: assetSection 'audio' is not valid for images.");
      }
      const deliveryMode = normalizeDelivery(delivery, ctx?.settings);
      const outputDir = imageOutputDirectory(intentSection, deliveryMode);
      const section = outputDir === "assets/inbox" ? "inbox" : intentSection;
      const bindEntityId = section !== "inbox" && section !== "library"
        ? await assertBindableEntity(ctx.projectDir, section, entityId, readProjectMetadata)
        : null;
      const nameSlug = slugifyName(assetName || cleanPrompt.slice(0, 48)) || `image-${Date.now()}`;

      // Asset destinations affect storage and binding, not the user's creative prompt.
      const effectivePrompt = cleanPrompt;
      const effectiveSize = size;

      const urls = (Array.isArray(referenceUrls) ? referenceUrls : [])
        .map((v) => String(v || "").trim())
        .filter(Boolean);
      for (const u of urls) {
        if (!/^https:\/\//i.test(u)) {
          throw payloadError("generate_image: referenceUrls must be public HTTPS URLs only.");
        }
      }

      const payload = {
        model: evolink.normalizeImageModel(chosenModel),
        prompt: effectivePrompt,
        size: effectiveSize,
        quality,
      };
      if (urls.length) payload.image_urls = urls;

      const jobId = `gen-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ctx.emitInboxEvent?.({
        kind: "job-started",
        id: jobId,
        capability: "image",
        prompt: cleanPrompt.slice(0, 240),
        model: payload.model,
        section,
        intentSection,
      });
      try {
        const task = await evolink.createImageTask(payload, apiKey);
        const taskId = task?.id || task?.task_id;
        if (!taskId) throw providerError("EvoLink did not return a task id.");
        // Image gen had no overall cap; videos/music are at 15min. Match
        // the video timeout so a stuck image task fails loudly instead
        // of pinning the agent forever.
        const completed = await evolink.waitForTask(taskId, apiKey, { timeoutMs: 15 * 60 * 1000 });
        const resultUrls = evolink.extractResultUrls(completed);
        if (!resultUrls.length) {
          throw providerError("EvoLink returned no image URLs.");
        }

        const savedPaths = [];
        for (const [idx, url] of resultUrls.entries()) {
          const extension =
            evolink.inferUrlExtension(url, ".png") || ".png";
          const suffix = resultUrls.length > 1 ? `-${idx + 1}` : "";
          const relativePath = `${outputDir}/${nameSlug}${suffix}${extension}`;
          const absolutePath = await ensureUniquePath(resolveInside(ctx.projectDir, relativePath));
          const { bytes } = await evolink.downloadResult(url, absolutePath, apiKey);
          const finalRelative = path.posix.join(
            outputDir,
            path.basename(absolutePath),
          );
          savedPaths.push({ path: finalRelative, bytes });
        }

        const binding = bindEntityId
          ? await bindGeneratedMedia(
              ctx.projectDir,
              section,
              bindEntityId,
              savedPaths,
              "image",
              readProjectMetadata,
              writeProjectMetadata,
            )
          : { bound: false, mediaCount: 0 };

        ctx.emitInboxEvent?.({
          kind: "job-completed",
          id: jobId,
          savedPaths: savedPaths.map((entry) => entry.path),
        });

        return {
          ok: true,
          model: payload.model,
          section,
          intentSection,
          delivery: deliveryMode,
          saved: savedPaths,
          binding,
          isolationEnforced: effectivePrompt !== cleanPrompt ? intentSection : null,
          message: binding.bound
            ? `Saved and bound ${binding.mediaCount} image${binding.mediaCount === 1 ? "" : "s"} to ${section}/${bindEntityId}.`
            : section === "inbox"
              ? `Saved ${savedPaths.length} image${savedPaths.length === 1 ? "" : "s"} under assets/inbox/ for temporary review.`
              : `Saved ${savedPaths.length} image${savedPaths.length === 1 ? "" : "s"} under ${outputDir}/. Pass entityId to bind directly to an asset card.`,
        };
      } catch (err) {
        ctx.emitInboxEvent?.({
          kind: "job-failed",
          id: jobId,
          error: err?.message || String(err),
          errorType: err?.kind || "unknown",
          status: Number.isFinite(err?.status) ? err.status : null,
        });
        throw err;
      }
    },
  });

  registerTool("generate_video", {
    tier: "media",
    description:
      "Generate a video clip through EvoLink (Seedance) and save it as a take under the originating prompt's mirrored video folder. Requires an EvoLink API key (env var EVOLINK_API_KEY or Settings). Blocks until render completes (typically 60-180s). Pass `promptId` to link the video back to a prompt — the file lands at assets/videos/<scene>/<shot>/<prompt>/take-NN.mp4 and the prompt's renders list updates. Without `promptId` the video lands at assets/videos/orphans/ and surfaces in the UI's Unlinked drawer.",
    args: {
      prompt: "required — text prompt for the video",
      promptId:
        "optional but recommended — id of the PromptEntry this video is rendering. When provided, the video mirrors into the scene/shot/prompt folder tree and auto-appends to that prompt's renders list as the next take.",
      assetName:
        "optional — filename override (default: take-<NN>). Ignored when promptId resolves cleanly.",
      model:
        "optional — seedance-2.0 | seedance-2.0-image | seedance-2.0-fast-text | seedance-2.0-fast-image (default: seedance-2.0-fast-text-to-video)",
      durationSec: "optional — 5-15 seconds (default: 15)",
      imageUrl: "optional — public HTTPS image URL for image-to-video models",
      imagePath:
        "optional — local project image/frame path. EvoLink is URL-only, so Anvil will stage it to a public HTTPS URL via configured reference staging (Bunny or ANVIL_REFERENCE_PUBLIC_DIR).",
      aspectRatio: "optional — 16:9 | 9:16 | 1:1 (default: 16:9)",
      note: "optional — free-form take note (e.g. 'slower push, warmer grade'); shown in the UI alongside the take.",
    },
    async run(
      { prompt, promptId, assetName, model, durationSec = 15, imageUrl, imagePath, aspectRatio = "16:9", note },
      ctx,
    ) {
      const cleanPrompt = String(prompt || "").trim();
      if (!cleanPrompt) throw payloadError("generate_video: 'prompt' is required.");
      const apiKey = resolveApiKey(ctx, "video");
      const chosenModel = resolveMediaModel(ctx, "video", model);

      // Resolve the owning prompt + its mirror folder if promptId was given.
      // Failing to resolve is non-fatal — we fall back to orphan storage
      // so the agent still gets a working video even on a stale id.
      let promptMeta = null;
      let mirrorSegments = null;
      if (promptId) {
        const metadata = await readProjectMetadata(ctx.projectDir);
        promptMeta = Array.isArray(metadata.prompts)
          ? metadata.prompts.find((p) => p.id === promptId) || null
          : null;
        if (promptMeta) {
          mirrorSegments = mirrorFolderSegmentsFor(promptMeta.path);
        }
      }

      const payload = {
        model: evolink.normalizeVideoModel(chosenModel),
        prompt: cleanPrompt,
        duration: Math.max(5, Math.min(15, Math.round(Number(durationSec) || 15))),
        aspect_ratio: aspectRatio,
      };
      let stagedReference = null;
      if (imageUrl) {
        if (!/^https:\/\//i.test(String(imageUrl).trim())) {
          throw payloadError("generate_video: imageUrl must be a public HTTPS URL.");
        }
        payload.image_url = String(imageUrl).trim();
      } else if (imagePath) {
        stagedReference = await stageReferenceMedia({
          projectDir: ctx.projectDir,
          referencePath: imagePath,
          provider: "evolink",
          mode: "url",
        });
        if (!stagedReference?.publicUrl) {
          throw providerError("generate_video: imagePath could not be staged as a public HTTPS URL.");
        }
        payload.image_url = stagedReference.publicUrl;
      }

      const jobId = `gen-vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ctx.emitInboxEvent?.({
        kind: "job-started",
        id: jobId,
        capability: "video",
        prompt: cleanPrompt.slice(0, 240),
        model: payload.model,
        durationSec: payload.duration,
      });

      let task;
      let completed;
      let resultUrls;
      try {
        task = await evolink.createVideoTask(payload, apiKey);
        const taskId = task?.id || task?.task_id;
        if (!taskId) throw providerError("EvoLink did not return a task id.");
        // Videos take longer — give it 15 minutes before timing out.
        completed = await evolink.waitForTask(taskId, apiKey, { timeoutMs: 15 * 60 * 1000 });
        resultUrls = evolink.extractResultUrls(completed);
        if (!resultUrls.length) {
          throw providerError("EvoLink returned no video URLs.");
        }
      } catch (err) {
        ctx.emitInboxEvent?.({
          kind: "job-failed",
          id: jobId,
          error: err?.message || String(err),
          errorType: err?.kind || "unknown",
          status: Number.isFinite(err?.status) ? err.status : null,
        });
        throw err;
      }

      const savedTakes = [];
      for (const [idx, url] of resultUrls.entries()) {
        const extension = evolink.inferUrlExtension(url, ".mp4") || ".mp4";

        // Compute destination — mirror folder for linked renders, orphans
        // folder otherwise. Unique-path suffixing handles the case where
        // the chosen name collides (e.g. retake-on-same-take-index).
        let relativePath;
        if (mirrorSegments) {
          // Take index is decided AFTER download via linkVideoToPrompt so
          // existing VideoEntry count is fresh. We use a temporary name
          // here and move on write — ensureUniquePath handles the final
          // filename if multiple takes race to the same slot.
          const { sceneSlug, shotSlug, promptSlug } = mirrorSegments;
          const tempName = slugifyName(assetName) || `take-${Date.now()}-${idx + 1}`;
          relativePath = `assets/videos/${sceneSlug}/${shotSlug}/${promptSlug}/${tempName}${extension}`;
        } else {
          // Orphan path. Still under assets/videos/ so the scan picks it
          // up and it joins the Unlinked drawer next load.
          const nameSlug = slugifyName(assetName || cleanPrompt.slice(0, 48)) || `video-${Date.now()}`;
          const suffix = resultUrls.length > 1 ? `-${idx + 1}` : "";
          relativePath = `assets/videos/orphans/${nameSlug}${suffix}${extension}`;
        }

        const absolutePath = await ensureUniquePath(resolveInside(ctx.projectDir, relativePath));
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        const { bytes } = await evolink.downloadResult(url, absolutePath, apiKey);
        const finalRelative = path.posix.join(
          path.posix.dirname(relativePath),
          path.basename(absolutePath),
        );

        let linkResult = null;
        let savedRelative = finalRelative;
        let extractedFrames = null;
        if (promptMeta && mirrorSegments) {
          linkResult = await linkVideoToPrompt({
            projectDir: ctx.projectDir,
            promptMeta,
            relativeVideoPath: finalRelative,
            durationSec: payload.duration,
            generator: "evolink",
            note: typeof note === "string" ? note : "",
          });

          // Rename file to include the resolved take index so the disk
          // name matches the VideoEntry's takeIndex — humans can read the
          // directory and see takes in order.
          const takeFile = `take-${String(linkResult.takeIndex).padStart(2, "0")}${extension}`;
          const takeAbs = path.join(path.dirname(absolutePath), takeFile);
          if (takeAbs !== absolutePath) {
            const takeRelative = path.posix.join(path.posix.dirname(finalRelative), takeFile);
            let renamed = false;
            try {
              await fs.rename(absolutePath, takeAbs);
              renamed = true;
              // Patch the VideoEntry path to match the new name. Re-reads
              // project.json to avoid clobbering any concurrent writes.
              const metadata = await readProjectMetadata(ctx.projectDir);
              const entry = Array.isArray(metadata.videos)
                ? metadata.videos.find((v) => v.id === linkResult.videoId)
                : null;
              if (entry) {
                entry.path = takeRelative;
                await writeProjectMetadata(ctx.projectDir, metadata);
                savedRelative = takeRelative;
              }
            } catch {
              if (renamed) {
                try {
                  await fs.rename(takeAbs, absolutePath);
                } catch {}
              }
              // Rename failed (possibly a filesystem edge case). Keep the
              // temp name; everything still works, just less tidy.
            }
          }
          try {
            extractedFrames = await extractFirstAndLastFrames({
              projectDir: ctx.projectDir,
              videoPath: savedRelative,
              videoId: linkResult.videoId,
            });
          } catch {
            extractedFrames = null;
          }
        }

        savedTakes.push({
          path: savedRelative,
          bytes,
          videoId: linkResult?.videoId || null,
          takeIndex: linkResult?.takeIndex || null,
          orphan: !linkResult,
          frames: extractedFrames
            ? {
                first: extractedFrames.first?.ok ? extractedFrames.first.framePath : null,
                last: extractedFrames.last?.ok ? extractedFrames.last.framePath : null,
              }
            : null,
        });
      }

      const linkedCount = savedTakes.filter((t) => !t.orphan).length;
      ctx.emitInboxEvent?.({
        kind: "job-completed",
        id: jobId,
        savedPaths: savedTakes.map((t) => t.path),
      });
        return {
          ok: true,
          model: payload.model,
          reference: stagedReference
            ? {
                delivery: stagedReference.delivery,
                backend: stagedReference.backend || null,
                sourcePath: stagedReference.sourcePath || stagedReference.path || null,
                publicUrl: stagedReference.publicUrl,
              }
            : imageUrl
              ? { delivery: "url", backend: "input", publicUrl: String(imageUrl).trim() }
              : null,
          saved: savedTakes,
          message: promptMeta && mirrorSegments
          ? `Saved ${linkedCount} take${linkedCount === 1 ? "" : "s"} linked to prompt "${promptMeta.title || promptMeta.id}".`
          : `Saved ${savedTakes.length} video${savedTakes.length === 1 ? "" : "s"} to assets/videos/orphans/ — pass promptId next time to auto-link.`,
      };
    },
  });

  registerTool("generate_music", {
    tier: "media",
    description:
      "Generate a music/audio clip through EvoLink. Defaults to All media under assets/library/audio; delivery:'direct' plus entityId saves to assets/audio/ and binds to an Audio asset when the user asked for a specific target. Requires an EvoLink provider with Music enabled in Settings -> API Keys, or legacy EVOLINK_API_KEY/mediaKeys.music.",
    args: {
      prompt: "required — text prompt for the music/audio clip",
      assetName: "optional — used for the filename slug (e.g. 'low-war-drum-loop'). Default: slug of prompt.",
      entityId: "optional — when delivery is direct, bind the saved audio to this Audio asset entry.",
      delivery: "optional — inbox | direct. Defaults to Settings -> Generated media routing.",
      model: "optional — suno-v5 | suno-v4.5plus | suno-v4.5 | suno-v4 (default: suno-v5-beta)",
      durationSec: "optional — requested duration in seconds when the provider/model supports it",
    },
    async run({ prompt, assetName, entityId, delivery, model, durationSec }, ctx) {
      const cleanPrompt = String(prompt || "").trim();
      if (!cleanPrompt) throw payloadError("generate_music: 'prompt' is required.");
      const apiKey = resolveApiKey(ctx, "music");
      const chosenModel = resolveMediaModel(ctx, "music", model);
      const deliveryMode = normalizeDelivery(delivery, ctx?.settings);
      const wantsBoundAudio = deliveryMode === "direct" && String(entityId || "").trim();
      const outputDir = wantsBoundAudio ? "assets/audio" : deliveryMode === "inbox" ? "assets/inbox" : "assets/library/audio";
      const outputSection = wantsBoundAudio ? "audio" : outputDir === "assets/inbox" ? "inbox" : "library";
      const bindEntityId = wantsBoundAudio
        ? await assertBindableEntity(ctx.projectDir, "audio", entityId, readProjectMetadata)
        : null;
      const nameSlug = slugifyName(assetName || cleanPrompt.slice(0, 48)) || `music-${Date.now()}`;
      const payload = {
        model: evolink.normalizeMusicModel(chosenModel),
        prompt: cleanPrompt,
      };
      const duration = Number(durationSec);
      if (Number.isFinite(duration) && duration > 0) {
        payload.duration = duration;
      }

      const jobId = `gen-music-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ctx.emitInboxEvent?.({
        kind: "job-started",
        id: jobId,
        capability: "music",
        prompt: cleanPrompt.slice(0, 240),
        model: payload.model,
        durationSec: payload.duration || null,
        section: outputSection,
      });

      try {
        const task = await evolink.createMusicTask(payload, apiKey);
        const taskId = task?.id || task?.task_id;
        if (!taskId) throw providerError("EvoLink did not return a task id.");
        const completed = await evolink.waitForTask(taskId, apiKey, { timeoutMs: 15 * 60 * 1000 });
        const resultUrls = evolink.extractResultUrls(completed);
        if (!resultUrls.length) {
          throw providerError("EvoLink returned no audio URLs.");
        }

        const savedPaths = [];
        for (const [idx, url] of resultUrls.entries()) {
          const extension = evolink.inferUrlExtension(url, ".mp3") || ".mp3";
          const suffix = resultUrls.length > 1 ? `-${idx + 1}` : "";
          const relativePath = `${outputDir}/${nameSlug}${suffix}${extension}`;
          const absolutePath = await ensureUniquePath(resolveInside(ctx.projectDir, relativePath));
          const { bytes } = await evolink.downloadResult(url, absolutePath, apiKey);
          savedPaths.push({
            path: path.posix.join(outputDir, path.basename(absolutePath)),
            bytes,
          });
        }

        const binding = bindEntityId
          ? await bindGeneratedMedia(
              ctx.projectDir,
              "audio",
              bindEntityId,
              savedPaths,
              "audio",
              readProjectMetadata,
              writeProjectMetadata,
            )
          : { bound: false, mediaCount: 0 };

        ctx.emitInboxEvent?.({
          kind: "job-completed",
          id: jobId,
          savedPaths: savedPaths.map((entry) => entry.path),
        });

        return {
          ok: true,
          model: payload.model,
          section: outputSection,
          delivery: deliveryMode,
          saved: savedPaths,
          binding,
          message: binding.bound
            ? `Saved and bound ${binding.mediaCount} audio file${binding.mediaCount === 1 ? "" : "s"} to audio/${bindEntityId}.`
            : outputSection === "inbox"
              ? `Saved ${savedPaths.length} audio file${savedPaths.length === 1 ? "" : "s"} under assets/inbox/ for temporary review.`
              : `Saved ${savedPaths.length} audio file${savedPaths.length === 1 ? "" : "s"} under ${outputDir}/ for All media.`,
        };
      } catch (err) {
        ctx.emitInboxEvent?.({
          kind: "job-failed",
          id: jobId,
          error: err?.message || String(err),
          errorType: err?.kind || "unknown",
          status: Number.isFinite(err?.status) ? err.status : null,
        });
        throw err;
      }
    },
  });
};
