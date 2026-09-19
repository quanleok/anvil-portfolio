const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteFile } = require("./atomic-write.cjs");

const INTAKE_DOC_PATH = "story/intake.md";
const PROJECT_SCOPE_FRONTMATTER = `---
id: project-scope
title: Project Scope
contextGroup: project
---`;

const PROJECT_SCOPE_INTRO = `User-editable project notes. Add the goals, context, and references you want
the assistant to use. These sections are optional and do not define a required
planning sequence. ANVIL.md contains workspace operating notes.`;

const INTAKE_DOC_TEMPLATE = `${PROJECT_SCOPE_FRONTMATTER}

# Project Scope

${PROJECT_SCOPE_INTRO}

<!-- intake:scope:start -->
## Core Brief

(empty - add your notes here)
<!-- intake:scope:end -->

<!-- intake:plot:start -->
## Story / Canon Seeds

(empty - add your notes here)
<!-- intake:plot:end -->

<!-- intake:visual:start -->
## Visual / Asset Seeds

(empty - add your notes here)
<!-- intake:visual:end -->
`;

function normalizeIntakeContent(content) {
  return String(content || "")
    .replace(/^#\s*(Project\s+intake|Intake)\s*$/im, "# Project Scope")
    .replace(/^##\s*Scope\s*$/im, "## Core Brief")
    .replace(/^##\s*Plot\s+Outline\s*$/im, "## Story / Canon Seeds")
    .replace(/^##\s*Visual\s+Intent\s*$/im, "## Visual / Asset Seeds");
}

function migrateIntakeDoc(raw) {
  const body = String(raw || "");
  if (!body.trim()) return body;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end === -1) return body;
    const content = body.slice(end + 5);
    const renamedContent = normalizeIntakeContent(content);
    const metaLines = body
      .slice(4, end)
      .split(/\r?\n/)
      .filter((line) => !/^\s*(id|title|contextGroup|context_group)\s*:/i.test(line));
    const next = [
      "---",
      "id: project-scope",
      "title: Project Scope",
      "contextGroup: project",
      ...metaLines.filter((line) => line.trim()),
      "---",
      "",
      renamedContent.trimStart(),
    ].join("\n");
    return next === body ? body : next;
  }
  const looksLikeGeneratedIntake =
    /<!--\s*intake:(scope|plot|visual):start\s*-->/.test(body) ||
    /^#\s*(Project\s+intake|Intake)\s*$/im.test(body);
  if (!looksLikeGeneratedIntake) return body;
  const renamed = normalizeIntakeContent(body);
  return `${PROJECT_SCOPE_FRONTMATTER}\n\n${renamed.trimStart()}`;
}

async function ensureIntakeDoc(projectDir) {
  const file = path.join(projectDir, INTAKE_DOC_PATH);
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, INTAKE_DOC_TEMPLATE);
    return;
  }

  const raw = await fs.readFile(file, "utf8");
  const migrated = migrateIntakeDoc(raw);
  if (migrated !== raw) {
    await atomicWriteFile(file, migrated);
  }
}

module.exports = {
  INTAKE_DOC_PATH,
  INTAKE_DOC_TEMPLATE,
  migrateIntakeDoc,
  ensureIntakeDoc,
};
