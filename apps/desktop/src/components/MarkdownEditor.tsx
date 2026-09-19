import { useEffect, useRef } from "react";
import { EditorState, Compartment, Annotation } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  Decoration,
  ViewPlugin,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  compileDetector,
  type CompiledDetector,
  type DetectorTier,
  type EntityCatalog,
} from "../lib/entity-detector";

// Anvil's dark-violet palette. All color values flow through the :root
// CSS custom properties so a palette change in styles.css applies here
// uniformly — no more isolated hex literals to keep in sync.
//
// The two literals that remain (selection 0.22, active-line 0.04) are
// editor-specific opacities that don't have a matching shared token;
// promoting them would expand the token surface for two single-use values.
const anvilTheme = EditorView.theme(
  {
    "&": {
      color: "inherit",
      backgroundColor: "transparent",
      fontFamily: "ui-monospace, monospace",
      fontSize: "13px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "ui-monospace, monospace",
      lineHeight: "1.65",
      padding: "18px 22px",
    },
    ".cm-content": {
      caretColor: "var(--brand)",
      padding: 0,
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--brand)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground":
      {
        backgroundColor: "rgba(167, 139, 250, 0.22)",
      },
    ".cm-activeLine": { backgroundColor: "rgba(167, 139, 250, 0.04)" },
    ".cm-line": { padding: 0 },
  },
  { dark: true },
);

// Anvil rule: plain body text stays WHITE — only structural tokens and
// hierarchy signals get tinted so color carries real meaning:
//   - heading levels cascade from soft → deep violet (hierarchy at a glance)
//   - **strong** goes bright white, *emphasis* fades slightly + italic
//   - links/urls = sky blue (clearly distinct from violet)
//   - `inline code` = amber (same motif as <placeholder> hints)
//   - blockquote content = muted gray italic (the "comment" register)
//   - markers (#, >, -, *, _, ~, `) fade to muted gray so they recede
// Markers come last in the list so `#` inside a heading stays gray instead
// of taking the heading's color.
const anvilHighlight = HighlightStyle.define([
  { tag: t.processingInstruction, color: "var(--ink-subtle)" },
  { tag: t.meta, color: "var(--ink-subtle)" },
  { tag: t.heading1, fontWeight: "700" },
  { tag: t.heading2, fontWeight: "700" },
  { tag: t.heading3, fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.quote, color: "var(--ink-subtle)", fontStyle: "italic" },
]);

// Anvil-specific decorations:
//   - <placeholder> hints get amber highlight (replace-me markers)
//   - Lines starting with `>` get muted gray italic styling — lezer-markdown
//     tags only the `>` mark, not the content, so we apply a line decoration
//     to catch the whole blockquote row.
const placeholderRe = /<[^>\n]{1,80}?>/g;
const quoteLineRe = /^\s*>/;

function anvilDecorations(view: EditorView): DecorationSet {
  // Separate the two passes so we can add line decorations first (required
  // to come before mark decorations at the same position per CM's sort rules).
  const lineDecos: { from: number; deco: Decoration }[] = [];
  const markDecos: { from: number; to: number; deco: Decoration }[] = [];

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    let m: RegExpExecArray | null;
    placeholderRe.lastIndex = 0;
    while ((m = placeholderRe.exec(text)) !== null) {
      markDecos.push({
        from: from + m.index,
        to: from + m.index + m[0].length,
        deco: Decoration.mark({ class: "cm-anvil-placeholder" }),
      });
    }
    // Walk lines in the visible range to find blockquote starters.
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (quoteLineRe.test(line.text)) {
        lineDecos.push({
          from: line.from,
          deco: Decoration.line({ class: "cm-anvil-quote-line" }),
        });
      }
      pos = line.to + 1;
    }
  }

  const all = [
    ...lineDecos.map((d) => d.deco.range(d.from)),
    ...markDecos.map((d) => d.deco.range(d.from, d.to)),
  ];
  // sort=true — let Decoration.set handle stable ordering including side
  // rules. Hand-sorting by `from` alone isn't sufficient because line decos
  // and mark decos at the same pos need the line deco first.
  return Decoration.set(all, true);
}

// Marks transactions created by our external-value sync so the update
// listener can skip the onChange callback for those. Without this, every
// sync dispatch fires onChange with the same string we just inserted,
// parents then round-trip that through their save+reread pipeline, and
// any subtle whitespace/frontmatter normalization in that round-trip
// produces a "new" value next render → another sync → onChange loop =
// visible flicker on entries whose saved form differs from the parsed
// body (e.g. master-script.md once it got durationSec frontmatter).
const syncAnnotation = Annotation.define<boolean>();

const anvilDecorationsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = anvilDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = anvilDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// -----------------------------------------------------------------------
// Entity-mention highlighter (opt-in via `promptHighlight` prop, classified
// into tiers via `highlightTier` prop).
//
// Detection logic lives in lib/entity-detector.ts so multiple surfaces can
// share it (master script editor, scene/shot/prompt editors, future agent
// message renderers, sidebar previews). This file is just the CodeMirror
// plumbing — viewport scan + Decoration.mark per match.
//
// Tiers:
//   - "narrative" (master script, scenes, story docs) — entity tints only.
//     Avoids over-highlighting "wide shot" / "cinematic depth" as
//     production tokens when they're written as prose description.
//   - "production" (shots, prompts) — entity tints PLUS camera, style,
//     constraint patterns so a video prompt's shape reads at a glance.

// Re-export for callers that build the catalog inline.
export type PromptHighlight = EntityCatalog;
export type { DetectorTier } from "../lib/entity-detector";

const CSS_CLASS: Record<string, string> = {
  character: "cm-prompt-character",
  location: "cm-prompt-location",
  prop: "cm-prompt-prop",
  keyframe: "cm-prompt-keyframe", // fuchsia — distinct from amber props
  audio: "cm-prompt-audio",
  library: "cm-prompt-prop", // loose library files read as "some asset" → prop tint
  camera: "cm-prompt-camera",
  style: "cm-prompt-style",
  constraint: "cm-prompt-constraint",
  "scene-heading": "cm-prompt-scene-heading",
  transition: "cm-prompt-transition",
  speaker: "cm-prompt-speaker",
  parenthetical: "cm-prompt-parenthetical",
};

function promptDecorations(
  view: EditorView,
  detector: CompiledDetector | null,
): DecorationSet {
  if (!detector) return Decoration.set([], true);
  const ranges: { from: number; to: number; cls: string }[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const match of detector.detect(text, from)) {
      const cls = CSS_CLASS[match.category];
      if (!cls) continue;
      ranges.push({ from: match.from, to: match.to, cls });
    }
  }
  return Decoration.set(
    ranges.map((r) => Decoration.mark({ class: r.cls }).range(r.from, r.to)),
    true,
  );
}

export type MarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  spellCheck?: boolean;
  readOnly?: boolean;
  promptHighlight?: PromptHighlight;
  // Detector tier — narrative (default) for master script, scenes, story
  // docs; production for shots and prompts (also tints camera/style/
  // constraint patterns).
  highlightTier?: DetectorTier;
  // Cmd/Ctrl+click on a tinted entity name → navigate to that asset. The
  // detector resolves the clicked text to its canonical entity; the parent
  // looks up the asset id and routes via jumpToAsset.
  onEntityClick?: (
    category: "character" | "location" | "prop" | "keyframe" | "audio" | "library",
    entityName: string,
  ) => void;
};

// Annotation used to trigger the prompt-highlight plugin to re-scan when
// the external entity dictionary changes (e.g. user added a character).
const refreshAnnotation = Annotation.define<boolean>();

function editorContentAttributes(spellCheck: boolean, ariaLabel?: string) {
  const attributes: Record<string, string> = {
    "aria-multiline": "true",
    spellcheck: spellCheck ? "true" : "false",
  };
  const label = ariaLabel?.trim();
  if (label) attributes["aria-label"] = label;
  return attributes;
}

export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  onFocus,
  onBlur,
  placeholder,
  className,
  spellCheck = false,
  readOnly = false,
  promptHighlight,
  highlightTier = "narrative",
  onEntityClick,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onFocusRef = useRef(onFocus);
  const onBlurRef = useRef(onBlur);
  const onEntityClickRef = useRef(onEntityClick);
  // Compile the detector once per (catalog, tier) and stash on a ref so
  // the CodeMirror plugin closes over the latest without re-mounting the
  // editor. compileDetector builds per-category regex indexes — non-trivial
  // work that we don't want to repeat on every keystroke. Triggered to
  // refresh via the refreshAnnotation when the catalog or tier changes.
  const detectorRef = useRef<CompiledDetector | null>(
    promptHighlight ? compileDetector(promptHighlight, highlightTier) : null,
  );
  const readOnlyCompartment = useRef(new Compartment());
  const contentAttributesCompartment = useRef(new Compartment());
  const placeholderCompartment = useRef(new Compartment());
  onChangeRef.current = onChange;
  onFocusRef.current = onFocus;
  onBlurRef.current = onBlur;
  onEntityClickRef.current = onEntityClick;

  useEffect(() => {
    if (!hostRef.current) return;

    // Built inline so the plugin closes over `detectorRef` — lets the
    // scan pick up the current detector without recreating the editor
    // instance on every prop change.
    const promptHighlightPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = promptDecorations(view, detectorRef.current);
        }
        update(update: ViewUpdate) {
          const refreshed = update.transactions.some((tr) =>
            tr.annotation(refreshAnnotation),
          );
          if (update.docChanged || update.viewportChanged || refreshed) {
            this.decorations = promptDecorations(update.view, detectorRef.current);
          }
        }
      },
      { decorations: (v) => v.decorations },
    );

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        indentOnInput(),
        bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown(),
        syntaxHighlighting(anvilHighlight),
        anvilDecorationsPlugin,
        promptHighlightPlugin,
        anvilTheme,
        placeholderCompartment.current.of(placeholder ? cmPlaceholder(placeholder) : []),
        EditorView.lineWrapping,
        contentAttributesCompartment.current.of(
          EditorView.contentAttributes.of(editorContentAttributes(spellCheck, ariaLabel)),
        ),
        readOnlyCompartment.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        // Cmd/Ctrl+click on a tinted entity name → resolve + fire
        // onEntityClick so the parent can jumpToAsset. Plain clicks fall
        // through as normal (cursor positioning, selection) — this is the
        // standard "follow link" interaction (VSCode "go to definition"
        // pattern). CSS class on the clicked DOM node tells us the
        // entity category; textContent gives us the clicked alias; the
        // detector resolves it back to the canonical entity name.
        EditorView.domEventHandlers({
          mousedown: (event) => {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const target = event.target;
            if (!(target instanceof HTMLElement)) return false;
            const detector = detectorRef.current;
            if (!detector) return false;
            for (const cls of target.classList) {
              const category = cls.startsWith("cm-prompt-") ? cls.slice("cm-prompt-".length) : null;
              if (!category) continue;
              if (!["character", "location", "prop", "keyframe", "audio", "library"].includes(category)) continue;
              const text = target.textContent || "";
              const resolved = detector.resolveEntity(text);
              if (resolved) {
                onEntityClickRef.current?.(resolved.category as "character" | "location" | "prop" | "keyframe" | "audio" | "library", resolved.name);
                event.preventDefault();
                return true;
              }
            }
            return false;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const fromSync = update.transactions.some((tr) =>
              tr.annotation(syncAnnotation),
            );
            if (!fromSync) {
              onChangeRef.current(update.state.doc.toString());
            }
          }
          if (update.focusChanged) {
            if (update.view.hasFocus) onFocusRef.current?.();
            else onBlurRef.current?.();
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value sync: only overwrite when the incoming value differs from
  // the view's current doc. Prevents cursor resets while the user types.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: syncAnnotation.of(true),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: contentAttributesCompartment.current.reconfigure(
        EditorView.contentAttributes.of(editorContentAttributes(spellCheck, ariaLabel)),
      ),
    });
  }, [ariaLabel, spellCheck]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // Placeholder reconfigure — without this the placeholder is baked
  // into the EditorState at init and never refreshes when the prop
  // changes. Symptom: switching from World Bible to Master Script
  // would leave "Edit World Bible…" stuck inside the script editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure(
        placeholder ? cmPlaceholder(placeholder) : [],
      ),
    });
  }, [placeholder]);

  // Recompile the detector when the catalog or tier changes, then ping
  // the plugin so newly-added entities (or a tier change) recolor without
  // requiring the user to type. Skipping recompile when both are nullish
  // avoids work on entity-less editors (skills/looks pages, etc.).
  useEffect(() => {
    detectorRef.current = promptHighlight
      ? compileDetector(promptHighlight, highlightTier)
      : null;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ annotations: refreshAnnotation.of(true) });
  }, [promptHighlight, highlightTier]);

  return (
    <div
      ref={hostRef}
      className={className}
      data-placeholder={placeholder || ""}
    />
  );
}
