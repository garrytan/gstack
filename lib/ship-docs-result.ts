/**
 * ship-docs-result — the deterministic check of /ship Step 14.5's documentation-audit result: the one JSON object a
 * /document-release child ends with (ship/sections/documentation.md, "Return one JSON object on the LAST nonempty line").
 * Whitespace around a key is trimmed (GST-1843: a reader ended with `" documentation_section": "x"`), and every other rule
 * of the contract stays: all eight fields with their types, the exact audit id, schema 1, the status invariants, unique
 * repo-relative paths, and a section that is real Markdown rather than empty or a placeholder. A result that fails names
 * each bad key and carries a retry note quoting the exact keys, so the one re-audit is told what to correct.
 */
export const DOCS_RESULT_KEYS = ['schema_version', 'audit_id', 'status', 'files_updated', 'files_reviewed', 'blockers', 'decisions', 'documentation_section'] as const;
const LISTS = ['files_updated', 'files_reviewed', 'blockers', 'decisions'] as const;

export interface DocsResult {
  schema_version: 1; audit_id: string; status: 'updated' | 'current' | 'blocked';
  files_updated: string[]; files_reviewed: string[]; blockers: string[]; decisions: string[]; documentation_section: string;
}
export type DocsResultCheck = { ok: true; result: DocsResult; trimmed: string[] } | { ok: false; problems: string[]; trimmed: string[] };

const badPath = (p: string) => p.startsWith('/') || p.includes('\\') || /[*?[\]]/.test(p) || p.split('/').some(part => !part || part === '.' || part === '..');
const isPlaceholder = (s: string) => /^[!-~]+$/.test(s) || /^<[^<>]*>$/.test(s);
const shown = (x: unknown) => { const s = JSON.stringify(x) ?? String(x); return s.length > 40 ? `${s.slice(0, 40)}…` : s; };

export function checkDocsResult(output: string, auditId: string): DocsResultCheck {
  const last = output.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
  let parsed: unknown;
  try { parsed = JSON.parse(last); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, problems: ['the last nonempty line is not one JSON object'], trimmed: [] };
  const problems: string[] = [];
  const trimmed: string[] = [];
  const v: Record<string, unknown> = Object.create(null);
  for (const [raw, value] of Object.entries(parsed)) {
    const key = raw.trim();
    if (key !== raw) trimmed.push(raw);
    if (Object.hasOwn(v, key)) problems.push(`${shown(key)} appears twice once whitespace around keys is trimmed`);
    v[key] = value;
  }
  const unknown = Object.keys(v).filter(key => !(DOCS_RESULT_KEYS as readonly string[]).includes(key));
  for (const key of unknown.slice(0, 5)) problems.push(`unknown key ${shown(key)}`);
  if (unknown.length > 5) problems.push(`${unknown.length - 5} more unknown keys`);
  for (const key of DOCS_RESULT_KEYS) if (!Object.hasOwn(v, key)) problems.push(`"${key}" is missing`);
  if (Object.hasOwn(v, 'schema_version') && v.schema_version !== 1) problems.push(`"schema_version" is ${shown(v.schema_version)}, not 1`);
  if (Object.hasOwn(v, 'audit_id') && v.audit_id !== auditId) problems.push(`"audit_id" is ${shown(v.audit_id)}, not the audit id this audit was given`);
  if (Object.hasOwn(v, 'status') && !['updated', 'current', 'blocked'].includes(v.status as string)) problems.push(`"status" is ${shown(v.status)}, not updated, current or blocked`);
  for (const key of LISTS) {
    if (!Object.hasOwn(v, key)) continue;
    const list = v[key];
    if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !x.trim())) { problems.push(`"${key}" is not a list of nonempty strings`); continue; }
    if (key.startsWith('files_') && (new Set(list).size !== list.length || list.some(badPath))) problems.push(`"${key}" must list unique repo-relative files, not globs`);
  }
  const section = v.documentation_section;
  if (Object.hasOwn(v, 'documentation_section')) {
    if (typeof section !== 'string' || !section.trim()) problems.push('"documentation_section" is empty; it must be the complete Markdown section');
    else if (isPlaceholder(section.trim())) problems.push(`"documentation_section" is a placeholder (${shown(section.trim())}); it must be the complete Markdown section`);
    else if (/^\s*##\s+Documentation\s*$/m.test(section)) problems.push('"documentation_section" carries a ## Documentation heading');
  }
  const updated = Array.isArray(v.files_updated) ? v.files_updated.length : 0;
  const blockers = Array.isArray(v.blockers) ? v.blockers.length : 0;
  if (v.status === 'blocked' && !blockers) problems.push('status blocked needs at least one blocker');
  if ((v.status === 'updated' || v.status === 'current') && blockers) problems.push(`status ${v.status} cannot carry blockers; a blocker means status blocked`);
  if (v.status === 'current' && updated) problems.push('status current cannot list files_updated; an edit means status updated');
  if (v.status === 'updated' && !updated) problems.push('status updated needs files_updated');
  if (problems.length) return { ok: false, problems, trimmed };
  return { ok: true, result: v as unknown as DocsResult, trimmed };
}

/** The sentence a re-audit's prompt ends with, verbatim, after a DOCS_RESULT_INVALID result. */
export function docsRetryNote(problems: readonly string[]): string {
  return `Your previous audit's last line was rejected (DOCS_RESULT_INVALID): ${problems.join('; ')}. End this audit with one JSON object on the last nonempty line whose keys are exactly ${DOCS_RESULT_KEYS.map(k => JSON.stringify(k)).join(', ')}, spelled as here with no spaces inside the quotes; "documentation_section" holds the complete Markdown section itself, never a placeholder such as "x".`;
}
