// Permission critic — classifies each tool invocation as safe / confirm / blocked.
// Lives outside the tool registry so both the agent (via check_action_risk)
// and the host runTool wrapper (in main.cjs) can call it.

const path = require("node:path");

// Tools that should always run unmediated.
const SAFE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "search",
  "get_project_index",
  "read_many_files",
  "read_scene_bundle",
  "read_prompt_bundle",
  "read_story_bundle",
  "read_asset_bundle",
  "read_project_context",
  "read_asset_context_guide",
  "list_memory_topics",
  "read_memory_topic",
  "list_magic_docs",
  "read_magic_doc",
  "list_assets",
  "list_scenes",
  "list_prompts",
  "build_render_bundle",
  "extract_frame",
  "build_timeline",
  "export_timeline",
  "list_timeline",
  "query_takes",
  // announce_intent only emits a UI event; it never writes to disk, so
  // it sits in the safe bucket alongside read-only tools.
  "announce_intent",
  "list_more_tools",
  "inspect_images",
  "describe_images",
  "compare_images",
  "pick_best_reference",
  "summarize_audio",
  "run_heartbeat",
  "search_chats",
  "check_action_risk",
  "list_pinboard",
  "list_providers",
  "read_provider_docs",
  "list_skills",
  "read_skill",
  "list_premium_automation_skills",
  "read_premium_automation_skill",
  "list_media",
  "scan_media",
  "get_media_refs",
  "find_duplicate_media",
  "prefetch_context",
  // Media generation — writes new files to assets/<section>/ via a configured
  // provider. It creates new project media rather than overwriting existing
  // user-authored text, so SAFE.
  "generate_image",
  "generate_video",
  "generate_music",
  "stage_reference_media",
  "render_prompt_sequence",
]);

// Tools that always block — destructive and broad. Must require explicit
// user consent (not just agent discretion).
const BLOCKED_TOOLS = new Set();

// Tools that need a confirm gate by default.
const CONFIRM_TOOLS = new Set([
  "run_command",
  "delete_scene",
  "delete_prompt",
  "delete_asset_entry",
  "delete_asset_entries",
  "delete_magic_doc",
  "delete_memory_topic",
  "normalize_asset_media_names",
  "rename_paths",
  "detach_media",
  "delete_media",
  "move_asset_entry",
]);

// Extensions / roots that we protect from silent writes.
const PROTECTED_PATH_PREFIXES = [
  "ANVIL.md",
  ".forge/conventions.md",
  ".forge/scene-format.md",
  ".forge/beat-format.md",
  ".forge/shot-format.md",
  ".forge/prompt-format.md",
];

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function isProtectedPath(relativePath) {
  const normalized = normalizePath(relativePath);
  return PROTECTED_PATH_PREFIXES.some((prefix) => normalized === prefix);
}

function isReservedAppStatePath(relativePath) {
  const normalized = normalizePath(relativePath);
  return normalized === ".forge" || normalized.startsWith(".forge/");
}

function isAgentNotePath(relativePath) {
  return normalizePath(relativePath) === ".forge/agent-note.md";
}

function isOutsideProject(relativePath) {
  const normalized = normalizePath(relativePath);
  if (path.isAbsolute(normalized)) return true;
  return normalized.includes("../") || normalized.startsWith("..");
}

function classifyToolCall(toolName, args = {}) {
  const name = String(toolName || "");
  if (!name) {
    return { risk: "blocked", reason: "missing tool name" };
  }

  if (BLOCKED_TOOLS.has(name)) {
    return {
      risk: "blocked",
      reason: `${name} is a destructive meta tool and must be invoked only with explicit user consent.`,
    };
  }

  if (SAFE_TOOLS.has(name)) {
    return { risk: "safe", reason: "read-only or low-impact tool" };
  }

  // write_file / edit_file / set_title on protected paths need confirm.
  if (["write_file", "edit_file", "set_title"].includes(name)) {
    const targetPath = normalizePath(args?.path);
    if (!targetPath) {
      return { risk: "confirm", reason: `${name} without a path` };
    }
    if (isOutsideProject(targetPath)) {
      return { risk: "blocked", reason: `${targetPath} escapes the project root` };
    }
    if (isReservedAppStatePath(targetPath) && !isAgentNotePath(targetPath)) {
      return {
        risk: "blocked",
        reason: `${targetPath} is reserved .forge app state. Use dedicated Anvil tools or explicit app-state repair.`,
      };
    }
    if (isProtectedPath(targetPath)) {
      return {
        risk: "confirm",
        reason: `${targetPath} is a user-authored canonical doc — overwriting needs the user's OK.`,
      };
    }
    return { risk: "safe", reason: `${name} on a project-scoped path` };
  }

  if (name === "rename_paths") {
    const items = Array.isArray(args?.items) ? args.items : [];
    if (items.length > 10) {
      return { risk: "confirm", reason: `bulk rename of ${items.length} items` };
    }
    for (const item of items) {
      if (isOutsideProject(item?.from) || isOutsideProject(item?.to)) {
        return { risk: "blocked", reason: "rename path escapes the project root" };
      }
      if (isReservedAppStatePath(item?.from) || isReservedAppStatePath(item?.to)) {
        return { risk: "blocked", reason: "rename_paths cannot move reserved .forge app state" };
      }
    }
    return { risk: "confirm", reason: "rename touches multiple paths" };
  }

  if (name === "run_command") {
    return {
      risk: "confirm",
      reason: "run_command executes a shell process — always surface the command to the user before running.",
    };
  }

  if (CONFIRM_TOOLS.has(name)) {
    return { risk: "confirm", reason: `${name} is destructive or bulk-affecting` };
  }

  if (name === "write_asset_context_guide") {
    return {
      risk: "confirm",
      reason:
        "write_asset_context_guide edits a legacy hidden Asset Context file; normal asset guidance belongs in visible markdown or asset card notes.",
    };
  }

  // Create / edit tools on a safe path default to safe.
  if (["create_scene", "create_prompt", "create_asset_entry",
       "create_asset_entries",
       "update_asset_entry",
       "set_prompt_continuity",
       "add_memory_topic", "create_magic_doc", "update_magic_doc",
       "sync_assets_from_disk",
       "refresh_project_index", "run_safe_maintenance",
       "remember",
       "update_pinboard", "remove_pinboard",
       "attach_media",
       "tighten_scene",
       // Workshop NLE timeline mutations — non-destructive (no file deletes;
       // only project.timeline metadata changes).
       "timeline_add_clip", "timeline_remove_clip", "timeline_move_clip",
       "timeline_split_clip", "timeline_set_trim", "timeline_set_volume",
       "timeline_set_fade", "timeline_set_enabled", "timeline_set_label",
       // Atomic batch over the timeline_* primitives — same blast radius
       // as the per-op tools, just folded into one save.
       "apply_timeline_batch",
       // Take selection + orphan repair — pure project.json metadata
       // edits on existing VideoEntry rows. No files moved or deleted.
       "set_keeper", "clear_keeper", "reassign_orphan_video",
       "set_audio_kind"].includes(name)) {
    return { risk: "safe", reason: "non-destructive project-scoped action" };
  }

  // Unknown tool — default to confirm so we're not silently permissive.
  return { risk: "confirm", reason: `${name} is not in the classifier's whitelist — treating as 'confirm' by default.` };
}

module.exports = {
  classifyToolCall,
  SAFE_TOOLS,
  BLOCKED_TOOLS,
  CONFIRM_TOOLS,
  PROTECTED_PATH_PREFIXES,
};
