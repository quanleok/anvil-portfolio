// Canonical agent-action catalog — tailored to the currently selected item.
//
// Each entry is a pre-written user message the agent will receive when the
// user fires the action. The catalog used to live inside the HammerMenu
// component; it's lifted here so the in-editor ItemActionBar and any other
// surface can share it without duplicating copy. Keep labels short (pill
// fits in a narrow editor-head) and hints descriptive (tooltip readers).

import type { FormatKind, PromptEntry, SectionId } from "../types";
import { getEntryLabel, isAssetSection } from "./sections";
import type { PrimarySectionId, SectionEntry } from "./sections";

export interface AgentActionItem {
  icon: string;
  label: string;
  hint: string;
  message: string;
}

export interface AgentActionContext {
  activeSection: SectionId;
  activePrimary: PrimarySectionId;
  selectedItem: SectionEntry | null;
  projectContextSelected: boolean;
  sectionFormatSelected: FormatKind | null;
  /**
   * True when the user has selected a distilled magic doc (Character
   * Bible / Location Atlas / custom generated summaries). The magic-doc
   * view renders its own toolbar with Sync + Regenerate buttons whose
   * semantics differ from the agent-driven Regenerate below, so we drop
   * the duplicate label here to avoid the confusion of two
   * "Regenerate" buttons side-by-side that do different things.
   */
  selectedMagicDoc?: boolean;
  pinboardSelected?: boolean;
}

export function getAgentActions(ctx: AgentActionContext): AgentActionItem[] {
  const {
    activeSection,
    activePrimary,
    selectedItem,
    projectContextSelected,
    sectionFormatSelected,
    selectedMagicDoc = false,
    pinboardSelected = false,
  } = ctx;
  const itemLabel = selectedItem ? getEntryLabel(activeSection, selectedItem) : "";

  // Pinboard is agent memory, not a story doc. None of the
  // push/pull-to-script actions apply. Short-circuit first so no
  // downstream branch can leak canon-doc pills onto this view.
  if (pinboardSelected) {
    return [];
  }

  // 1. ANVIL.md (hidden agent protocol)
  if (projectContextSelected) {
    return [];
  }

  // 2. Section format conventions
  if (sectionFormatSelected) {
    const formatLabels: Record<FormatKind, string> = {
      script: "Master Script",
      prompts: "prompts",
    };
    const formatLabel = formatLabels[sectionFormatSelected];
    return [
      {
        icon: "⟳",
        label: "Apply format",
        hint: `Reformat all ${formatLabel} to match these conventions`,
        message: `I updated the ${formatLabel} format conventions. Scan all existing ${formatLabel} and reformat them to match the updated rules. Don't change content meaning — only adjust structure and formatting.`,
      },
    ];
  }

  // 3. Story docs
  if (activePrimary === "story") {
    // Asset-context magic docs (Character Bible / Location Atlas) are
    // live inventory views read straight from project.json — there's
    // nothing to push down or pull back. No actions.
    if (selectedMagicDoc) {
      return [];
    }
    return [
      {
        icon: "↓",
        label: "Apply to script",
        hint: "Update Master Script, scenes, and prompts to reflect this doc",
        message:
          "I updated this story document. Review the linked script files and apply the changes I requested. Preserve unrelated content and flag any ambiguous changes before editing.",
      },
      {
        icon: "↑",
        label: "Regenerate from script",
        hint: "Rewrite this doc from the current Master Script and prompts",
        message: selectedItem
          ? `Regenerate the ${itemLabel} from the current state of the Master Script, scenes, and prompts. Replace the current content with a fresh version that accurately reflects what's in the project now.`
          : "Update story/world-bible.md with a concise summary of the project files. Preserve user notes and identify conflicts instead of inventing missing information.",
      },
    ];
  }

  // 4. Scene / master script
  if (activeSection === "script" && selectedItem) {
    const isScene = "kind" in selectedItem && (selectedItem as { kind: string }).kind === "scene";
    if (isScene) {
      return [
        {
          icon: "✦",
          label: "Build prompts",
          hint: "Create prompts for this scene using the project settings",
          message: `Read scene "${itemLabel}" and its linked context. Help me create prompts for this scene using my instructions and the supported provider settings. Ask for missing choices before creating files. Preserve the scene parent link.`,
        },
      ];
    }
    // Master script
    return [
      {
        icon: "↑",
        label: "Update bible",
        hint: "Update the linked story notes with my changes",
        message:
          "I updated the master script. Reflect my changes in story/world-bible.md while preserving unrelated notes. Flag conflicts or unclear edits.",
      },
      {
        icon: "✦",
        label: "Build prompts",
        hint: "Help create prompts from the script",
        message:
          "Review the Master Script and help me create the prompts I need. Use my requested structure and the supported provider settings. Ask for the scope if I have not specified which parts to work on.",
      },
    ];
  }

  // 5. Shot
  if (activeSection === "shots" && selectedItem) {
    return [
      {
        icon: "◫",
        label: "Make prompts",
        hint: "Help create prompts for this item",
        message: `Help me create prompts for legacy shot "${itemLabel}" using its linked context. Follow my requested structure and provider settings. Ask for missing choices.`,
      },
      {
        icon: "✦",
        label: "Write prompt",
        hint: "Draft a prompt using my instructions",
        message: `Draft a prompt for legacy shot "${itemLabel}" using my instructions and its linked files. Preserve the existing project conventions and provider settings.`,
      },
    ];
  }

  // 6. Dialogue
  if (activeSection === "dialogue" && selectedItem) {
    return [
      {
        icon: "✎",
        label: "Write dialogue",
        hint: "Draft or continue the selected dialogue",
        message: `Read dialogue document "${itemLabel}" and its linked context. Draft or extend the dialogue according to my request, preserving the existing format.`,
      },
      {
        icon: "✦",
        label: "Polish",
        hint: "Revise the selected dialogue while preserving its meaning",
        message: `Revise dialogue document "${itemLabel}" for clarity. Preserve its meaning and format, and ask before making changes beyond my request.`,
      },
    ];
  }

  // 7. Prompt / segment
  if (activeSection === "prompts" && selectedItem) {
    const prompt = selectedItem as PromptEntry;
    const isLastSegment =
      prompt.segmentIndex != null &&
      prompt.segmentCount != null &&
      prompt.segmentIndex === prompt.segmentCount;

    const actions: AgentActionItem[] = [];

    if (isLastSegment || prompt.segmentCount == null) {
      actions.push({
        icon: "→",
        label: "Continue",
        hint: "Continue this prompt using my requested direction",
        message: `Help me continue this prompt. Use its linked context and my requested direction, and preserve relevant links. Ask what should happen next if I have not specified it.`,
      });
    }

    return actions;
  }

  // 8. Asset
  //
  // Asset sections have no ItemActionBar entries. The old Link /
  // Describe / Scan-refs row was replaced by the "Used in" panel
  // beneath the description (live AssetEntry.usedIn populated by
  // attachAssetUsages at project load). The inverse direction
  // (scene/shot/prompt → asset) is handled by the scene/prompt
  // editors directly.
  if (isAssetSection(activeSection) && selectedItem) {
    return [];
  }

  return [];
}
