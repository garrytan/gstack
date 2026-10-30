/**
 * review-packet-docs — the Step 14.5 documentation audit as one read-only packet
 * (gstack-review-packet build --audit docs; docs/review-policy.md#reviewer-packets).
 * The packet holds the auditor prompt (the generated documentation section's text
 * fence), the doc surfaces of the gstack-docs-candidate snapshot, the doc lines that
 * name a changed code path, and the diff of the changed docs plus the code they
 * describe. The reader proposes edits as findings; gstack-docs-candidate apply
 * makes them (lib/docs-audit-apply.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyPath } from './review-depth';
import { auditPrompt, detectStack, reviewerDiff, type BuildContext, type PacketDraft } from './review-packet';

/** Doc lines naming a changed code path the packet quotes, at most. */
export const DOCS_NAMED_LINES = 120;
/** Diff bytes of code no doc names that the packet still shows; past this the stat lists them. */
export const DOCS_CODE_DIFF_BYTES = 80_000;
const DOCS_LIST_CAP = 300;
const DOC_SCAN_BYTES = 512 * 1024;

export interface DocsCandidate { audit_id: string; mode: 'edit' | 'read-only'; base: string; docs: string[] }

/** The candidate record gstack-docs-candidate snapshot wrote, or why it cannot be used. */
export function readCandidate(file: string | undefined): DocsCandidate | { error: string } {
  if (!file) return { error: '--audit docs needs --candidate <the Prepare snapshot record>' };
  let r: any;
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: `--candidate ${file} is not a readable gstack-docs-candidate record` }; }
  if (r?.schema_version !== 1 || typeof r.audit_id !== 'string' || !['edit', 'read-only'].includes(r.mode) || typeof r.base !== 'string' || !Array.isArray(r.docs)) {
    return { error: `--candidate ${file} lacks schema_version 1, audit_id, mode, base or docs: rerun the Prepare snapshot` };
  }
  return { audit_id: r.audit_id, mode: r.mode, base: r.base, docs: r.docs.filter((d: unknown): d is string => typeof d === 'string') };
}

const runArtifact = (ctx: BuildContext) => (p: string) => /^\.gstack\/[^/]+\//.test(p) || path.resolve(ctx.root, p).startsWith(path.resolve(ctx.outDir) + path.sep);

/** Tokens a doc line names a code path by: the path, its file name, and the name without its extension when distinctive. */
function namesOf(p: string): string[] {
  const file = path.basename(p);
  const stem = file.replace(/\.[^.]+$/, '');
  return [...new Set([p, file, ...(stem.length >= 5 && stem !== file ? [stem] : [])])];
}

/** Each doc line that names a changed code path, and which code paths some doc names. */
export function namedLines(root: string, docs: readonly string[], code: readonly string[]): { lines: string[]; total: number; named: Set<string> } {
  const lines: string[] = [];
  const named = new Set<string>();
  let total = 0;
  const tokens = code.map(p => ({ p, names: namesOf(p) }));
  for (const doc of docs) {
    const file = path.join(root, doc);
    let text: string;
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(root) + path.sep) || fs.statSync(real).size > DOC_SCAN_BYTES) continue;
      text = fs.readFileSync(real, 'utf8');
    } catch { continue; }
    text.split('\n').forEach((line, i) => {
      const hit = tokens.filter(t => t.names.some(n => line.includes(n)));
      if (!hit.length) return;
      hit.forEach(t => named.add(t.p));
      total++;
      if (lines.length < DOCS_NAMED_LINES) lines.push(`${doc}:${i + 1}: ${line.trim().slice(0, 200)}`);
    });
  }
  return { lines, total, named };
}

const fenced = (s: string) => { const f = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${f}\n${s.replace(/\n?$/, '\n')}${f}`; };

export function docsAuditDraft(ctx: BuildContext, base: string, effort: string, cand: DocsCandidate): PacketDraft {
  const { stack } = detectStack(ctx.root);
  const diff = reviewerDiff(ctx.root, ctx.diffBase, [], false, runArtifact(ctx));
  const isDoc = (p: string) => cand.docs.includes(p) || classifyPath(p, ctx.root) === 'docs';
  const code = diff.paths.filter(p => !isDoc(p) && classifyPath(p, ctx.root) === 'code');
  const found = namedLines(ctx.root, cand.docs, code);
  let budget = DOCS_CODE_DIFF_BYTES;
  const shown = diff.chunks.filter((c, i) => {
    const p = diff.paths[i]!;
    if (isDoc(p) || found.named.has(p)) return true;
    if (!code.includes(p) || Buffer.byteLength(c) > budget) return false;
    budget -= Buffer.byteLength(c);
    return true;
  });
  const left = diff.chunks.length - shown.length;
  const changed = new Set(diff.paths);
  const surfaces = cand.docs.slice(0, DOCS_LIST_CAP).map(d => `- ${d}${changed.has(d) ? ' (changed)' : ''}`);
  if (cand.docs.length > DOCS_LIST_CAP) surfaces.push(`- … ${cand.docs.length - DOCS_LIST_CAP} more in the candidate record`);
  const prompt = auditPrompt(ctx.skillRoot, 'docs', base, ctx.baseRef).replaceAll('<audit-id>', cand.audit_id).replaceAll('<mode>', cand.mode);
  const head = [`Role: docs audit (effort=${effort}). Audit id: ${cand.audit_id}. Mode: ${cand.mode}.`, '',
    `## Instructions\n\n${prompt}`, '',
    `## Output\n\nWrite your findings and the LAST-line JSON object the instructions name to the output path below in one write. Then reply with exactly one line, \`DONE <NAME>\`.`, '',
    `## Context\n\nStack: ${stack}. Diff base: \`${ctx.diffBase}\` (the candidate's base); head \`${ctx.head}\`.`, '',
    `## Doc surfaces (${cand.docs.length}, from the candidate)\n\n${surfaces.join('\n') || '- none: no documentation file is in scope; describe that scope in documentation_section'}`, '',
    `## Doc lines that name a changed code path (${found.total}${found.total > found.lines.length ? `, first ${found.lines.length}` : ''})\n\n${fenced(found.lines.join('\n') || '(none)')}`, '',
    ...(left ? [`${left} changed file(s) are in the stat but not the diff below (tests, data, or code no doc names past ${DOCS_CODE_DIFF_BYTES} bytes); read a named range of one only if a doc line above depends on it.`, ''] : [])];
  return { role: 'audit', name: 'docs', effort, checklists: [], summary: false, head, tail: [], diff: { ...diff, chunks: shown },
    diffLabel: 'Diff of the changed docs and the code they describe', diffCmd: `git diff -U8 ${ctx.diffBase}` };
}
