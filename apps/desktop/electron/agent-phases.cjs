// Phase verbs for the agent loop. Maps a tool call to a short English
// label + mood. The label appears in the chat activity feed; the mood
// drives animation hooks (passive | active | long | done).
//
// Replaced the older branded vocabulary (Stoking / Pondering / Casting /
// Smelting / etc.) with plain English on 2026-05-04 — the cute verbs
// were decorative, not informative, and the user reads them for two
// hours then gets bored. The activity feed already shows the actual
// tool name; the phase label only needs to convey "what kind of work
// is happening" at a glance.

const PHASES = {
  reading:    { verb: "Reading",    mood: "passive" },
  searching:  { verb: "Searching",  mood: "passive" },
  thinking:   { verb: "Thinking",   mood: "passive" },
  writing:    { verb: "Writing",    mood: "active"  },
  editing:    { verb: "Editing",    mood: "active"  },
  organizing: { verb: "Organizing", mood: "active"  },
  generating: { verb: "Generating", mood: "long"    },
  analyzing:  { verb: "Analyzing",  mood: "long"    },
  running:    { verb: "Running",    mood: "long"    },
  done:       { verb: "Done",       mood: "done"    },
};

// Coarse keyword routing — no big hand-curated map. The tool name's
// verb prefix is enough signal; everything unmatched falls through to
// "thinking" (passive). Keeps this file boring on purpose.
function phaseForTool(name) {
  const t = String(name || "").toLowerCase();
  let id = "thinking";
  if (
    t.startsWith("read_")
    || t.startsWith("list_")
    || t.startsWith("get_")
    || t.startsWith("inspect")
    || t.startsWith("describe_")
    || t.startsWith("compare_")
    || t.startsWith("summarize_")
    || t.startsWith("pick_")
    || t.startsWith("prefetch_")
    || t.startsWith("recall_")
  ) {
    id = "reading";
  } else if (t.startsWith("search")) {
    id = "searching";
  } else if (t.startsWith("generate_")) {
    id = "generating";
  } else if (
    t.startsWith("delete_")
    || t.startsWith("remove_")
    || t.startsWith("clear_")
    || t.startsWith("detach_")
    || t.startsWith("rename_")
    || t.startsWith("move_")
    || t.startsWith("forget_")
    || t.startsWith("normalize_")
  ) {
    id = "editing";
  } else if (
    t.startsWith("create_")
    || t.startsWith("update_")
    || t.startsWith("set_")
    || t.startsWith("write_")
    || t.startsWith("edit_")
    || t.startsWith("attach_")
    || t.startsWith("add_")
    || t.startsWith("remember")
    || t.startsWith("group_")
    || t.startsWith("split_")
    || t.startsWith("tighten_")
    || t.startsWith("timeline_")
  ) {
    id = "writing";
  } else if (
    t.startsWith("run_")
    || t.startsWith("refresh_")
    || t.startsWith("sync_")
    || t.startsWith("scan_")
  ) {
    id = "running";
  } else if (t.includes("analyze") || t === "check_action_risk") {
    id = "analyzing";
  }
  return { id, ...PHASES[id] };
}

module.exports = { PHASES, phaseForTool };
