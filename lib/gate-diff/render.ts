/**
 * gate-diff render — the stdout contract of bin/gstack-gate-diff.
 *
 * First line, always: `GATE_SUMMARY: listed=N eligible=N inspected=N unread=N
 * tagged={RH-1:2,RH-15:1} unmatched=N coverage=RH-1,… languages_unlisted=<csv|none>
 * candidate=<fingerprint> artifact=<abs path>`. Then either the table (read-level
 * hunks only: `[<id>] <tags|untagged> <path> @@ <hunk header> @@`, the removed/added
 * lines indented, optional `note:` lines, then `citation: <text|none>`) or jsonl
 * (one object per LISTED hunk). The artifact file always holds the full jsonl.
 */
import type { ListedHunk, ScanResult, ScanSummary } from './types';

export function renderSummaryLine(s: ScanSummary): string {
  const tagged = Object.keys(s.tagged).sort(compareTagKeys).map((k) => `${k}:${s.tagged[k]}`).join(',');
  return [
    'GATE_SUMMARY:',
    `listed=${s.listed}`, `eligible=${s.eligible}`, `inspected=${s.inspected}`, `unread=${s.unread}`,
    `tagged={${tagged}}`, `unmatched=${s.unmatched}`, `coverage=${s.coverage.join(',')}`,
    `languages_unlisted=${s.languagesUnlisted.length ? s.languagesUnlisted.join(',') : 'none'}`,
    `candidate=${s.candidate}`, `artifact=${s.artifact}`,
  ].join(' ');
}

function compareTagKeys(a: string, b: string): number {
  const num = (t: string) => Number.parseInt(t.replace(/^RH-/, ''), 10);
  return num(a) - num(b) || a.localeCompare(b);
}

export function renderHunkBlock(h: ListedHunk): string {
  const out: string[] = [`[${h.id}] ${h.tags.length ? h.tags.join(',') : 'untagged'} ${h.path} ${h.header}`];
  if (h.unsupported) out.push(`  (unsupported: ${h.unsupported})`);
  for (const l of h.old) out.push(`  -${l}`);
  for (const l of h.new) out.push(`  +${l}`);
  for (const n of h.notes) out.push(`  note: ${n}`);
  out.push(`  citation: ${h.citation ?? 'none'}`);
  return out.join('\n');
}

export function renderTable(r: ScanResult): string {
  const lines = [renderSummaryLine(r.summary)];
  for (const h of r.hunks) if (h.level === 'read') lines.push(renderHunkBlock(h));
  return lines.join('\n') + '\n';
}

export function toJsonRecord(h: ListedHunk): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    id: h.id, path: h.path, level: h.level, tags: h.tags, old: h.old, new: h.new, citation: h.citation,
  };
  if (h.oldPath !== h.path) rec.old_path = h.oldPath;
  if (h.notes.length) rec.notes = h.notes;
  if (h.unsupported) rec.unsupported = h.unsupported;
  return rec;
}

/** One JSON object per listed hunk, newline-terminated; the artifact body. */
export function renderJsonlBody(r: ScanResult): string {
  return r.hunks.map((h) => JSON.stringify(toJsonRecord(h)) + '\n').join('');
}

export function renderJsonl(r: ScanResult): string {
  return renderSummaryLine(r.summary) + '\n' + renderJsonlBody(r);
}

/** stderr diagnostics: unsupported paths and a bounded unmatched list. */
export function renderDiagnostics(r: ScanResult, cap = 50): string[] {
  const out: string[] = [];
  for (const u of r.unsupportedPaths) out.push(`gstack-gate-diff: unsupported (${u.reason}): ${u.path}`);
  for (const p of r.unmatchedPaths.slice(0, cap)) out.push(`gstack-gate-diff: unmatched: ${p}`);
  if (r.unmatchedPaths.length > cap) out.push(`gstack-gate-diff: unmatched: … ${r.unmatchedPaths.length - cap} more`);
  if (r.summary.unread > 0) out.push(`gstack-gate-diff: partial — ${r.summary.inspected} of ${r.summary.eligible} eligible hunks read (cap ${r.summary.inspected} reached)`);
  return out;
}
