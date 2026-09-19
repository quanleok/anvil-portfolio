function normalizeDialogueText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function hasWrittenDialogueLines(content) {
  return normalizeDialogueText(content)
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      return Boolean(trimmed) && !trimmed.startsWith("#");
    });
}

function makeShotSectionKey(sceneTitle, shotTitle) {
  return `${String(sceneTitle || "").trim()}::${String(shotTitle || "").trim()}`;
}

function parseShotSections(content) {
  const normalized = normalizeDialogueText(content);
  const lines = normalized ? normalized.split("\n") : [];
  const headingIndices = [];
  const sections = [];
  let currentSceneTitle = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const shotMatch = line.match(/^###\s+(.+)$/);
    if (shotMatch) {
      const shotTitle = shotMatch[1].trim();
      headingIndices.push(index);
      sections.push({
        headingIndex: index,
        key: makeShotSectionKey(currentSceneTitle, shotTitle),
        sceneTitle: currentSceneTitle,
        shotTitle,
      });
      continue;
    }
    const sceneMatch = line.match(/^##\s+(.+)$/);
    if (sceneMatch) {
      currentSceneTitle = sceneMatch[1].trim();
      headingIndices.push(index);
    }
  }

  for (const section of sections) {
    const nextHeadingIndex = headingIndices.find((index) => index > section.headingIndex) ?? lines.length;
    section.bodyStartIndex = section.headingIndex + 1;
    section.nextHeadingIndex = nextHeadingIndex;
    section.bodyLines = lines.slice(section.bodyStartIndex, nextHeadingIndex);
    section.hasWrittenLines = hasWrittenDialogueLines(section.bodyLines.join("\n"));
  }

  return { lines, normalized, sections };
}

function buildLegacyDialogueBlock(sceneTitle, shotTitle, content) {
  const parts = [];
  const normalizedSceneTitle = String(sceneTitle || "").trim();
  const normalizedShotTitle = String(shotTitle || "").trim();
  const normalizedContent = normalizeDialogueText(content);

  if (normalizedSceneTitle) parts.push(`## ${normalizedSceneTitle}`);
  if (normalizedShotTitle) parts.push(`### ${normalizedShotTitle}`);
  if (hasWrittenDialogueLines(normalizedContent)) parts.push(normalizedContent);

  return parts.join("\n\n").trim();
}

function contentContainsWholeBlock(content, block) {
  const normalizedContent = normalizeDialogueText(content);
  const normalizedBlock = normalizeDialogueText(block);
  if (!normalizedContent || !normalizedBlock) return false;
  return (
    normalizedContent === normalizedBlock ||
    normalizedContent.startsWith(`${normalizedBlock}\n\n`) ||
    normalizedContent.includes(`\n\n${normalizedBlock}\n\n`) ||
    normalizedContent.endsWith(`\n\n${normalizedBlock}`)
  );
}

function mergeLegacyDialogueContent(canonicalContent, legacyEntries = []) {
  const { lines, normalized, sections } = parseShotSections(canonicalContent);
  const sectionByKey = new Map(sections.map((section) => [section.key, section]));
  const replacements = new Map();
  const appendBlocks = [];
  const seenAppendBlocks = new Set();

  for (const entry of legacyEntries) {
    const sceneTitle = String(entry?.sceneTitle || "").trim();
    const shotTitle = String(entry?.shotTitle || "").trim();
    const content = normalizeDialogueText(entry?.content);
    const hasLegacyWrittenLines = hasWrittenDialogueLines(content);
    const key = makeShotSectionKey(sceneTitle, shotTitle);
    const targetSection = key ? sectionByKey.get(key) || null : null;

    if (targetSection) {
      if (!targetSection.hasWrittenLines && hasLegacyWrittenLines) {
        replacements.set(targetSection.headingIndex, ["", ...content.split("\n")]);
      }
      continue;
    }

    if (!hasLegacyWrittenLines) continue;
    const block = buildLegacyDialogueBlock(sceneTitle, shotTitle, content);
    const normalizedBlock = normalizeDialogueText(block);
    if (!normalizedBlock || seenAppendBlocks.has(normalizedBlock)) continue;
    seenAppendBlocks.add(normalizedBlock);
    appendBlocks.push(block);
  }

  const out = [];
  let cursor = 0;
  for (const section of sections) {
    out.push(...lines.slice(cursor, section.bodyStartIndex));
    if (replacements.has(section.headingIndex)) {
      out.push(...replacements.get(section.headingIndex));
    } else {
      out.push(...lines.slice(section.bodyStartIndex, section.nextHeadingIndex));
    }
    cursor = section.nextHeadingIndex;
  }
  out.push(...lines.slice(cursor));

  let merged = normalizeDialogueText(out.join("\n"));
  if (!merged) {
    merged = normalized;
  }
  for (const block of appendBlocks) {
    if (contentContainsWholeBlock(merged, block)) continue;
    merged = merged ? `${merged}\n\n${block}` : block;
  }

  return merged;
}

module.exports = {
  buildLegacyDialogueBlock,
  hasWrittenDialogueLines,
  mergeLegacyDialogueContent,
  normalizeDialogueText,
};
