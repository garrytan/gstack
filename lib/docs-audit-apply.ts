/**
 * docs-audit-apply — gstack-docs-candidate apply: the parent's mechanical half of the
 * Step 14.5 packet audit (lib/review-packet-docs.ts). The read-only reader writes one
 * JSON finding per line and a LAST-line object; apply makes each \`edit\` whose \`old\`
 * text occurs exactly once in a doc the candidate lists (an edit whose \`new\` text the doc
 * already holds once, with no \`old\` outside it, is already applied and skipped), refuses protected, generated,
 * out-of-tree and read-only-mode edits as blockers, turns \`block\` findings into
 * blockers and \`note\` findings into decisions, and prints the audit result in the
 * schema a /document-release child returns (ship/sections/documentation.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Files a documentation edit never touches: release metadata, manifests and lockfiles the parent owns. */
const PROTECTED = [/^CHANGELOG\.md$/, /^TODOS\.md$/, /^VERSION$/, /(^|\/)package(-lock)?\.json$/, /(^|\/)(bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock)$/, /(^|\/)sections\/manifest\.json$/, /^agents-digest\//];
const GENERATED = /^(?:---\n[\s\S]*?\n---\n)?(?:[^\n]*\n){0,2}<!-- AUTO-GENERATED/;

export interface DocsAuditResult {
  schema_version: 1; audit_id: string; status: 'updated' | 'current' | 'blocked';
  files_updated: string[]; files_reviewed: string[]; blockers: string[]; decisions: string[]; documentation_section: string;
}

const strings = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.length > 0))] : [];

/** Apply the reader's findings in root; exit 0 updated/current, 3 blocked, 1 when the output is not a usable audit result. */
export function applyDocsFindings(root: string, candidate: { audit_id: string; mode: string; docs: string[] }, text: string): { lines: string[]; result?: DocsAuditResult; exit: number } {
  const rows = text.split('\n').map(l => l.trim()).filter(Boolean);
  let last: any;
  try { last = JSON.parse(rows.at(-1) ?? ''); } catch { last = undefined; }
  if (!last || typeof last !== 'object' || last.schema_version !== 1 || last.audit_id !== candidate.audit_id || typeof last.documentation_section !== 'string' || !last.documentation_section.trim()) {
    return { lines: [`DOCS_AUDIT_UNUSABLE: the LAST line is not {"schema_version":1,"audit_id":"${candidate.audit_id}",…,"documentation_section":"…"}; the audit is blocked (Blocked recovery)`], exit: 1 };
  }
  const realRoot = fs.realpathSync(root);
  const blockers: string[] = [];
  const decisions: string[] = [];
  const edited = new Map<string, { before: string; now: string; edits: number }>();
  rows.slice(0, -1).forEach((row, i) => {
    let f: any;
    try { f = JSON.parse(row); } catch { f = undefined; }
    if (!f || typeof f !== 'object' || typeof f.path !== 'string' || typeof f.summary !== 'string' || !['edit', 'block', 'note'].includes(f.action)) {
      blockers.push(`finding line ${i + 1} is not a finding object (path, action edit|block|note, summary)`);
      return;
    }
    const where = `${f.path}${Number.isInteger(f.line) ? `:${f.line}` : ''}`;
    if (f.action === 'note') { decisions.push(`${where}: ${f.summary}`); return; }
    if (f.action === 'block') { blockers.push(`${where}: ${f.summary}`); return; }
    const refuse = (why: string) => blockers.push(`${where}: ${f.summary} (edit not applied: ${why})`);
    if (candidate.mode === 'read-only') return refuse('read-only mode');
    if (typeof f.old !== 'string' || !f.old || typeof f.new !== 'string') return refuse('an edit needs nonempty old and a new string');
    if (!candidate.docs.includes(f.path)) return refuse('not a doc in the candidate');
    if (PROTECTED.some(r => r.test(f.path))) return refuse('protected file; the parent owns it');
    let file: string;
    try { file = fs.realpathSync(path.join(realRoot, f.path)); } catch { return refuse('file not found'); }
    if (!file.startsWith(realRoot + path.sep)) return refuse('resolves outside the repository');
    const entry = edited.get(f.path) ?? (() => { const before = fs.readFileSync(file, 'utf8'); return { before, now: before, edits: 0 }; })();
    if (GENERATED.test(entry.before)) return refuse('generated file; edit its template');
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    if (f.new && count(entry.now, f.new) === 1 && count(entry.now, f.old) === count(f.new, f.old)) return;
    const at = entry.now.indexOf(f.old);
    if (at < 0 || entry.now.indexOf(f.old, at + 1) >= 0) return refuse(at < 0 ? 'old text not found' : 'old text occurs more than once');
    entry.now = entry.now.slice(0, at) + f.new + entry.now.slice(at + f.old.length);
    entry.edits++;
    edited.set(f.path, entry);
  });
  const files_updated: string[] = [];
  const lines: string[] = [];
  for (const [p, e] of [...edited].sort(([a], [b]) => a.localeCompare(b))) {
    if (e.now === e.before) continue;
    fs.writeFileSync(path.join(realRoot, p), e.now);
    files_updated.push(p);
    lines.push(`APPLIED: ${p} edits=${e.edits}`);
  }
  for (const b of blockers) lines.push(`BLOCKER: ${b}`);
  const status = blockers.length ? 'blocked' : files_updated.length ? 'updated' : 'current';
  const summary = status === 'updated' ? `updated ${files_updated.join(', ')}` : status === 'current' ? 'current, no edits needed' : `blocked: ${blockers.length} blocker(s)${files_updated.length ? `; edited ${files_updated.join(', ')}` : ''}`;
  const section = `**Status:** ${status} (${summary})\n\n${String(last.documentation_section).replace(/^\*\*Status:\*\*[^\n]*\n+/, '').trim()}`;
  const result: DocsAuditResult = { schema_version: 1, audit_id: candidate.audit_id, status, files_updated, files_reviewed: strings(last.files_reviewed), blockers, decisions, documentation_section: section };
  lines.push(`DOCS_AUDIT: status=${status} applied=${files_updated.length} blockers=${blockers.length} notes=${decisions.length}`, JSON.stringify(result));
  return { lines, result, exit: status === 'blocked' ? 3 : 0 };
}
