// Minimal YAML-frontmatter extractor for the browser side. Only
// supports flat scalar keys (the spec calls out `durationSec` as the
// load-bearing field). Doesn't try to be a full parser — anything
// fancier and we should pull in `js-yaml`.

export function parseFrontmatter(source: string): Record<string, string> {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};
  const body = source.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

export function frontmatterDurationSec(source: string): number | null {
  const fm = parseFrontmatter(source);
  const raw = fm.durationSec ?? fm.duration_sec ?? fm.durationSeconds;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null;
}
