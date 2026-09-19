const memory = require("../../memory.cjs");
const projectContext = require("../../project-context.cjs");
// worker-agent.cjs require removed — spawn_worker/spawn_workers_batch
// tools deleted in the 2026-05-04 bloat-cuts pass.
const { classifyToolCall } = require("../../permission-critic.cjs");

const API_PROVIDER_CAPABILITIES = new Set(["image", "video", "music", "voice", "code", "text", "custom"]);
const MEDIA_PROVIDER_CAPABILITIES = new Set(["image", "video", "music", "voice"]);

function providerCapabilities(entry) {
  const raw = Array.isArray(entry?.capabilities) && entry.capabilities.length
    ? entry.capabilities
    : typeof entry?.capability === "string"
      ? [entry.capability]
      : [];
  const out = [];
  for (const value of raw) {
    const clean = String(value || "").trim().toLowerCase();
    if (!API_PROVIDER_CAPABILITIES.has(clean) || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}

function primaryProviderCapability(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  return caps.find((cap) => MEDIA_PROVIDER_CAPABILITIES.has(cap)) || caps[0] || null;
}

module.exports = function registerMetaTools(api) {
  const { registerTool, listTools } = api;

  function compactToolCatalogEntry(tool) {
    const description = String(tool?.description || "");
    const args = {};
    for (const [key, value] of Object.entries(tool?.args || {})) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      args[key] = String(text || "").slice(0, 80);
    }
    return {
      name: tool?.name || "",
      description: description.length > 160 ? `${description.slice(0, 157).trimEnd()}...` : description,
      args,
    };
  }

  registerTool("list_more_tools", {
    tier: "meta",
    description:
      "Reveal the detailed args/descriptions of tools in a specific tier. Useful when you need a tool that wasn't in the core list. Available tiers: core, edit, domain, shell, meta, media, jobs, premium.",
    args: { tier: "one of: core | edit | domain | shell | meta | media | jobs | premium" },
    async run({ tier }, _ctx) {
      const allowed = ["core", "edit", "domain", "shell", "meta", "media", "jobs", "premium"];
      const requested = String(tier || "").trim();
      if (!allowed.includes(requested)) {
        return { available: allowed, error: `unknown tier '${requested}'` };
      }
      const tools = listTools({ tiers: [requested] }).map(compactToolCatalogEntry);
      return { tier: requested, count: tools.length, tools };
    },
  });

  registerTool("remember", {
    tier: "meta",
    mutation: true,
    description:
      "Remember a fact, preference, or constraint. Creates an unconfirmed pinboard entry — the user confirms it from the Pinboard UI before it becomes permanent.",
    args: { text: "short fact to remember (one sentence)" },
    async run({ text }, ctx) {
      return memory.appendToIndex(ctx.projectDir, text);
    },
  });

  registerTool("list_pinboard", {
    tier: "meta",
    description: "List all pinboard entries. Filter by category, scope, or confirmed status.",
    args: {
      category: "optional — filter by category string",
      scope: "optional — filter by scope string",
      confirmed: "optional boolean — filter by confirmed status",
    },
    async run({ category, scope, confirmed }, ctx) {
      let entries = await memory.readPinboard(ctx.projectDir);
      if (category !== undefined) {
        entries = entries.filter((e) => e.category === category);
      }
      if (scope !== undefined) {
        entries = entries.filter((e) => e.scope === scope);
      }
      if (confirmed !== undefined) {
        entries = entries.filter((e) => Boolean(e.confirmed) === Boolean(confirmed));
      }
      return { entries, count: entries.length };
    },
  });

  registerTool("update_pinboard", {
    tier: "meta",
    mutation: true,
    description: "Update an existing pinboard entry's text, category, or scope.",
    args: {
      id: "required — ID of the pinboard entry to update",
      text: "optional — new text for the entry",
      category: "optional — new category string",
      scope: "optional — new scope string",
    },
    async run({ id, text, category, scope }, ctx) {
      const patch = {};
      if (text !== undefined) patch.text = text;
      if (category !== undefined) patch.category = category;
      if (scope !== undefined) patch.scope = scope;
      // updatedAt is stamped inside updatePinboardEntry — don't double-stamp.
      return memory.updatePinboardEntry(ctx.projectDir, id, patch);
    },
  });

  registerTool("remove_pinboard", {
    tier: "meta",
    mutation: true,
    description: "Remove a single pinboard entry by ID.",
    args: {
      id: "required — ID of the pinboard entry to remove",
    },
    async run({ id }, ctx) {
      return memory.removePinboardEntry(ctx.projectDir, id);
    },
  });

  registerTool("list_memory_topics", {
    tier: "meta",
    description:
      "List all topic files under .forge/memory/topics/. Returns [{name, description, slug, path, size}]. Topics are on-demand — only read one when the current task references it.",
    args: {},
    async run(_args, ctx) {
      const topics = await memory.listTopics(ctx.projectDir);
      return { topics, count: topics.length };
    },
  });

  registerTool("read_memory_topic", {
    tier: "meta",
    description:
      "Read one topic file (.forge/memory/topics/<slug>.md). Use list_memory_topics first to discover available topics. Keeps heavy context out of the default prompt.",
    args: { name: "topic name (matches the 'name' field or slug)" },
    async run({ name }, ctx) {
      const text = await memory.readTopic(ctx.projectDir, name);
      return { name, text: text || "", empty: !text };
    },
  });

  registerTool("add_memory_topic", {
    tier: "meta",
    mutation: true,
    description:
      "Create a topic file (.forge/memory/topics/<slug>.md) with long-form context (style guide, character bible, world rules, pipeline notes). Content is capped at 16k chars. Refuses to overwrite an existing topic unless force:true — pass force:true when intentionally regenerating. Call delete_memory_topic first if you want a hard reset.",
    args: {
      name: "topic title (human readable)",
      description: "one-line summary for the index (optional)",
      content: "full markdown body",
      force: "optional boolean, default false — overwrite an existing topic with the same name",
    },
    async run({ name, description, content, force }, ctx) {
      return memory.writeTopic(ctx.projectDir, name, content, description, {
        force: Boolean(force),
      });
    },
  });

  registerTool("delete_memory_topic", {
    tier: "meta",
    mutation: true,
    description: "Delete one topic file from .forge/memory/topics/. Non-destructive if the file does not exist.",
    args: { name: "topic name or slug" },
    async run({ name }, ctx) {
      return memory.deleteTopic(ctx.projectDir, name);
    },
  });

  registerTool("search_chats", {
    tier: "meta",
    description:
      "Grep past chat transcripts (.forge/chats/*.json) for a literal substring. Returns [{session, role, timestamp, snippet}] with 60-char surrounding context. Use this to recall what the user said in earlier sessions.",
    args: { query: "literal substring to find", max: "optional hit cap (default 50, max 200)" },
    async run({ query, max }, ctx) {
      return memory.searchChats(ctx.projectDir, query, max);
    },
  });

  // spawn_worker / spawn_workers_batch were removed in the bloat-cuts
  // pass on 2026-05-04. Parallel sub-process workers added complexity
  // without clear user value for a single-user desktop app: most agent
  // work is sequential (the bottleneck is the LLM, not Anvil's code),
  // and the recursion guard / readonly tier filtering / session prefix
  // plumbing was more code than the speedup justified. The local
  // runtime now does ordinary sequential tool calls. If a need for
  // parallel research bursts comes back, dispatch parallel `Read` /
  // `Grep` calls inside one turn — that's what tool-batching is for.

  registerTool("check_action_risk", {
    tier: "meta",
    description:
      "Ask the permission critic to classify a planned tool call as safe | confirm | blocked BEFORE you invoke it. Use this when you're about to do something destructive, bulk-rename, or touch a user-authored canonical doc (ANVIL.md, conventions.md, scene-format.md, beat-format.md, shot-format.md, prompt-format.md). Returns { risk, reason }. The same classifier also runs automatically — blocked will refuse, confirm will emit a warning in the envelope.",
    args: {
      tool: "required — the tool name you plan to invoke",
      args: "optional — the args object you plan to pass (path, items, etc.)",
    },
    async run({ tool, args }, _ctx) {
      return classifyToolCall(String(tool || "").trim(), args || {});
    },
  });

  registerTool("read_project_context", {
    tier: "meta",
    description:
      "Read the project's hidden ANVIL.md agent protocol/workflow file (priority rules, hard constraints, directory rules, and SOP). It is already injected into your system prompt at every turn. Do not use this for user-facing project scope; read_story_bundle includes story/intake.md Project Scope.",
    args: {},
    async run(_args, ctx) {
      const text = await projectContext.readProjectContext(ctx.projectDir);
      return { text: text || "", empty: !text };
    },
  });

  registerTool("list_providers", {
    tier: "meta",
    description:
      "List every external API provider the user has registered (EvoLink, Suno, ElevenLabs, OpenAI, custom, etc.). Returns id, label, capability/capabilities, endpoint, defaultModel, envVar, hasKey (boolean), envKeyAvailable (boolean), and the byte-length of the user's docs. NEVER returns the API key value itself. If a provider is enabled and keyed for a capability, use that provider/tool before terminal-agent native generation for that capability. Call read_provider_docs(id) to read the user's notes/procedures for a specific provider before calling its endpoint.",
    args: {},
    async run(_args, ctx) {
      const providers = Array.isArray(ctx?.settings?.apiProviders)
        ? ctx.settings.apiProviders
        : [];
      return {
        ok: true,
        count: providers.length,
        providers: providers.map((entry) => {
          const capabilities = providerCapabilities(entry);
          const envVar = typeof entry?.envVar === "string" && entry.envVar.trim() ? entry.envVar.trim() : null;
          const envValue = envVar && typeof process.env[envVar] === "string" ? process.env[envVar].trim() : "";
          return {
            id: entry?.id || "",
            label: entry?.label || entry?.id || "",
            capability: primaryProviderCapability(capabilities),
            capabilities,
            endpoint: entry?.endpoint || null,
            defaultModel: entry?.defaultModel || null,
            envVar,
            envKeyAvailable: Boolean(envValue),
            hasKey: Boolean((typeof entry?.apiKey === "string" && entry.apiKey.trim()) || envValue),
            docsLength: typeof entry?.docs === "string" ? entry.docs.length : 0,
            notesLength: typeof entry?.notes === "string" ? entry.notes.length : 0,
            updatedAt: entry?.updatedAt || null,
          };
        }),
      };
    },
  });

  registerTool("read_provider_docs", {
    tier: "meta",
    description:
      "Return the user-pasted docs / procedure notes for a specific API provider (registered via Settings → Providers). Read this before calling the provider's HTTP endpoints — the user typically pastes the relevant cURL commands, model list, response shape, and per-endpoint gotchas here so you don't have to guess. Pass providerId from list_providers.",
    args: {
      providerId: "required — the provider's id (e.g. 'evolink', 'suno', 'elevenlabs').",
    },
    async run({ providerId }, ctx) {
      const id = String(providerId || "").trim();
      if (!id) throw new Error("read_provider_docs: providerId required.");
      const providers = Array.isArray(ctx?.settings?.apiProviders)
        ? ctx.settings.apiProviders
        : [];
      const entry = providers.find((p) => p && p.id === id);
      if (!entry) {
        throw new Error(`read_provider_docs: no provider with id '${id}'. Call list_providers to see available ids.`);
      }
      return {
        ok: true,
        id: entry.id,
        label: entry.label || entry.id,
        capability: primaryProviderCapability(providerCapabilities(entry)),
        capabilities: providerCapabilities(entry),
        endpoint: entry.endpoint || null,
        defaultModel: entry.defaultModel || null,
        envVar: entry.envVar || null,
        docs: typeof entry.docs === "string" ? entry.docs : "",
        notes: typeof entry.notes === "string" ? entry.notes : "",
        empty: !(entry.docs || entry.notes),
      };
    },
  });
};
