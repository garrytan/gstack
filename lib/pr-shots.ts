/**
 * pr-shots — before/after images of a change for a PR body (Capy's merge ask,
 * capy/skill/gstack/captain.md; /ship's Capy section). Input is text only:
 * two capture files (terminal output, a rendered prompt) or a tracked file
 * (optionally one heading's section) at a base commit and in the working
 * tree. Nothing is executed. Inputs are bounded, ANSI-stripped, refused when
 * binary, and secret-scanned before anything is rendered, because PR images
 * are public.
 *
 * The page stacks Before above After at 880 CSS px (GitHub's column), shows
 * only the changed hunks with three lines of context, marks lines with a
 * −/+ gutter as well as colour, and says how many unchanged lines each gap
 * hides, so a change at line 240 of 300 is always on screen. It is rendered
 * once to pair.png through lib/aside-render.ts; with no browser the HTML and
 * the text fallback (text.md, a collapsed unified diff) are still written.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBase } from './gate-diff/git';
import { findSection } from './markdown-sections';
import { scan } from './redact-engine';
import type { ResultCodeName } from './result-codes';

export const MAX_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 2000;
const CONTEXT = 3;
const MAX_ROWS = 90;

export type ShotKind = 'terminal' | 'prompt';
/** One side; `text` null means the side does not exist (a new file, a removed file, a section only on one side). */
export interface Side { text: string | null; label: string; absent?: string }
export interface ShotError { code: ResultCodeName; message: string }
export type Op = { t: ' ' | '-' | '+'; a?: number; b?: number; line: string };

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * MAX_BYTES });

/** ANSI-free LF text, or an error for binary or oversize input. */
export function cleanText(raw: string | Buffer, what: string): string | ShotError {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  if (buf.length > MAX_BYTES) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `${what} is ${buf.length} bytes (cap ${MAX_BYTES})` };
  if (buf.includes(0)) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `${what} is binary` };
  return buf.toString('utf8').replace(/\r\n?/g, '\n').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A capture file: must exist and resolve inside the repository or the state root. */
export function readCapture(file: string, roots: string[], what: string): string | ShotError {
  if (!fs.existsSync(file)) return { code: 'PR_SHOTS_INPUT_NOT_FOUND', message: `${what} file ${file}` };
  const real = fs.realpathSync(file);
  if (!roots.some(r => fs.existsSync(r) && inside(fs.realpathSync(r), real))) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `${what} file ${file} is outside the repository and the state root` };
  return cleanText(fs.readFileSync(real), `${what} file`);
}

/** Resolve `ref` to a commit sha without letting it be read as an option; a bare branch name reads origin's tracking branch first (resolveBase, GST-1036). */
export function resolveCommit(cwd: string, ref: string): string | ShotError {
  if (!ref || ref.startsWith('-') || /\s/.test(ref)) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `ref ${JSON.stringify(ref)} is not a plain ref` };
  const base = resolveBase(ref, cwd, 'HEAD');
  if (base) return base.sha;
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : { code: 'PR_SHOTS_INPUT_NOT_FOUND', message: `base ref ${ref}` };
}

/** The default base: where this branch left origin's default branch. */
export function defaultBase(cwd: string): string | ShotError {
  for (const ref of ['origin/HEAD', 'origin/main', 'main']) {
    const r = git(cwd, ['merge-base', 'HEAD', ref]);
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return { code: 'PR_SHOTS_INPUT_NOT_FOUND', message: 'no merge base with origin/HEAD, origin/main or main; pass --base <ref>' };
}

/** Both sides of a tracked file (or one heading's section of it) at `base` and in the working tree. */
export function pathSides(cwd: string, rel: string, base: string, heading?: string): { before: Side; after: Side } | ShotError {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { code: 'PR_SHOTS_INPUT_NOT_FOUND', message: 'not a git repository' };
  const root = top.stdout.trim();
  const abs = path.resolve(cwd, rel);
  if (!inside(root, abs) || abs === root) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `--path ${rel} is outside the repository` };
  const relPath = path.relative(root, abs).split(path.sep).join('/');
  const short = base.slice(0, 7);
  const atBase = git(root, ['cat-file', 'blob', `${base}:${relPath}`]);
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', relPath]).status === 0;
  const beforeRaw = atBase.status === 0 ? cleanText(atBase.stdout, `${relPath} at ${short}`) : null;
  const afterRaw = tracked && fs.existsSync(abs) ? cleanText(fs.readFileSync(abs), relPath) : null;
  if (beforeRaw === null && afterRaw === null) return { code: 'PR_SHOTS_INPUT_NOT_FOUND', message: `${relPath} is neither at ${short} nor tracked in the working tree` };
  for (const s of [beforeRaw, afterRaw]) if (s !== null && typeof s !== 'string') return s;
  let before = beforeRaw as string | null; let after = afterRaw as string | null;
  let beforeAbsent = before === null ? 'new in this change' : undefined;
  let afterAbsent = after === null ? 'removed in this change' : undefined;
  if (heading) {
    const pick = (t: string | null) => (t === null ? undefined : findSection(t, [heading]));
    const b = pick(before); const a = pick(after);
    if (!b && !a) return { code: 'PR_SHOTS_INPUT_NOT_FOUND', message: `heading ${JSON.stringify(heading)} in ${relPath} on both sides` };
    if (!b) beforeAbsent = beforeAbsent ?? 'section not present before';
    if (!a) afterAbsent = afterAbsent ?? 'section not present after';
    before = b ? `${'#'.repeat(b.heading.level)} ${b.heading.title}\n${b.body}` : null;
    after = a ? `${'#'.repeat(a.heading.level)} ${a.heading.title}\n${a.body}` : null;
  }
  const where = heading ? `${relPath} § ${heading}` : relPath;
  return {
    before: { text: before, label: `Before · ${where} at ${short} · source text`, absent: before === null ? beforeAbsent : undefined },
    after: { text: after, label: `After · ${where} on this branch · source text`, absent: after === null ? afterAbsent : undefined },
  };
}

/** Refuse a side or caption that matches the secret scanner; the message names the side, line and rule, never the text. */
export function scanSides(sides: Array<[string, string | null]>): ShotError | undefined {
  for (const [what, text] of sides) {
    if (!text) continue;
    const s = scan(text, { maxBytes: MAX_BYTES * 2 });
    const hits = s.findings.filter(f => f.severity === 'HIGH' || f.severity === 'MEDIUM');
    if (s.oversize) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `${what} is too large to scan` };
    if (hits.length) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `${what} matched the secret scanner: ${hits.slice(0, 5).map(f => `line ${f.line} ${f.id}`).join(', ')}` };
  }
  return undefined;
}

/** Line diff: common prefix and suffix trimmed, LCS on the middle (bounded). */
export function diffLines(a: string[], b: string[]): Op[] | ShotError {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf); const bm = b.slice(pre, b.length - suf);
  if (am.length > MAX_DIFF_LINES || bm.length > MAX_DIFF_LINES) return { code: 'PR_SHOTS_INPUT_REFUSED', message: `the changed region is over ${MAX_DIFF_LINES} lines; picture a section (--heading) instead` };
  const n = am.length; const m = bm.length; const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', a: k + 1, b: k + 1, line: a[k]! });
  let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) { ops.push({ t: ' ', a: pre + i + 1, b: pre + j + 1, line: am[i]! }); i++; j++; }
    else if (j < m && (i >= n || L[i * w + j + 1]! >= L[(i + 1) * w + j]!)) { ops.push({ t: '+', b: pre + j + 1, line: bm[j]! }); j++; }
    else { ops.push({ t: '-', a: pre + i + 1, line: am[i]! }); i++; }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', a: a.length - suf + k + 1, b: b.length - suf + k + 1, line: a[a.length - suf + k]! });
  return ops;
}

/** Changed regions with CONTEXT lines around them; gaps report how many unchanged lines they hide. */
export function hunks(ops: Op[]): Array<{ gapBefore: number; ops: Op[] }> {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => { if (o.t !== ' ') for (let d = -CONTEXT; d <= CONTEXT; d++) if (ops[k + d]) keep[k + d] = true; });
  const out: Array<{ gapBefore: number; ops: Op[] }> = [];
  let gap = 0;
  ops.forEach((o, k) => {
    if (!keep[k]) { gap++; return; }
    if (!out.length || gap > 0 || !keep[k - 1]) out.push({ gapBefore: gap, ops: [] });
    out[out.length - 1]!.ops.push(o); gap = 0;
  });
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function paneRows(hs: Array<{ gapBefore: number; ops: Op[] }>, side: 'a' | 'b', total: number, whole: boolean): string[] {
  const rows: string[] = [];
  if (whole) rows.push(`<div class="gap">rewritten entirely: every line ${side === 'a' ? 'is removed (−)' : 'is new (+)'}</div>`);
  let shown = 0; let hidden = 0;
  for (const h of hs) {
    const mine = h.ops.filter(o => o.t === ' ' || (side === 'a' ? o.t === '-' : o.t === '+'));
    if (!mine.length) continue;
    if (h.gapBefore) rows.push(`<div class="gap">⋯ ${h.gapBefore} unchanged line${h.gapBefore === 1 ? '' : 's'}</div>`);
    for (const o of mine) {
      if (shown >= MAX_ROWS) { hidden++; continue; }
      const cls = o.t === ' ' || whole ? 'ctx' : side === 'a' ? 'del' : 'add';
      const mark = o.t === ' ' ? ' ' : side === 'a' ? '−' : '+';
      rows.push(`<div class="row ${cls}"><span class="n">${(side === 'a' ? o.a : o.b) ?? ''}</span><span class="m">${mark}</span><span class="t">${esc(o.line) || ' '}</span></div>`);
      shown++;
    }
  }
  if (hidden) rows.push(`<div class="gap">… ${hidden} more line${hidden === 1 ? '' : 's'} in the text version below the image</div>`);
  const last = hs.at(-1); const end = last ? Math.max(...last.ops.map(o => (side === 'a' ? o.a : o.b) ?? 0)) : 0;
  if (total > end && end > 0) rows.push(`<div class="gap">⋯ ${total - end} unchanged line${total - end === 1 ? '' : 's'}</div>`);
  return rows;
}

export interface ShotPage { html: string; text: string; changed: number }

export function buildPage(o: { before: Side; after: Side; title: string; caption: string; kind: ShotKind }): ShotPage | ShotError {
  const a = o.before.text === null ? [] : o.before.text.split('\n');
  const b = o.after.text === null ? [] : o.after.text.split('\n');
  if (o.before.text !== null && o.before.text === o.after.text) return { code: 'PR_SHOTS_IDENTICAL', message: 'before and after are the same text' };
  const ops = diffLines(a, b);
  if (!Array.isArray(ops)) return ops;
  const hs = hunks(ops);
  const changed = ops.filter(x => x.t !== ' ').length;
  const whole = a.length > 0 && b.length > 0 && !ops.some(x => x.t === ' ' && x.line.trim());
  const pane = (s: Side, side: 'a' | 'b', total: number) => `<section class="pane"><div class="label">${esc(s.label)}</div>${s.text === null ? `<div class="absent">(${esc(s.absent ?? 'absent')})</div>` : `<div class="code">${paneRows(hs, side, total, whole).join('')}</div>`}</section>`;
  const dark = o.kind === 'terminal';
  const css = [
    "*{box-sizing:border-box}body{margin:0;background:#f6f7f9}",
    `#shot{width:880px;padding:16px;background:#ffffff;border:1px solid #d0d7de;font-family:'DM Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328}`,
    "h1{font-size:16px;margin:0 0 4px}p.cap{font-size:13px;margin:0 0 12px;color:#57606a}",
    `.pane{margin:0 0 12px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}.label{font-size:12px;font-weight:600;padding:6px 10px;background:#eaeef2;color:#24292f}`,
    `.code{background:${dark ? '#0f1115' : '#ffffff'};color:${dark ? '#e6e6e6' : '#1f2328'};font:14px/1.45 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:6px 0}`,
    ".row{display:flex;white-space:pre-wrap;word-break:break-word}.n{flex:0 0 44px;text-align:right;padding-right:8px;opacity:.55}.m{flex:0 0 18px;font-weight:700}.t{flex:1;padding-right:10px}",
    `.del{background:${dark ? 'rgba(248,81,73,.22)' : 'rgba(255,129,130,.25)'}}.add{background:${dark ? 'rgba(255,180,0,.24)' : 'rgba(255,196,0,.30)'}}`,
    `.gap{font:12px 'DM Sans',sans-serif;padding:3px 10px;opacity:.7;background:${dark ? '#171a21' : '#f6f8fa'}}.absent{font-size:13px;padding:10px;font-style:italic;color:#57606a}`,
  ].join('');
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">",
    `<title>${esc(o.title)}</title><style>${css}</style></head><body><div id="shot">`,
    `<h1>${esc(o.title)}</h1><p class="cap">${esc(o.caption)} · ${changed} changed line${changed === 1 ? '' : 's'} (− before, + after)</p>`,
    pane(o.before, 'a', a.length), pane(o.after, 'b', b.length),
    '</div></body></html>',
  ].join('\n');
  const unified = hs.flatMap(h => [...(h.gapBefore ? [`@@ ⋯ ${h.gapBefore} unchanged ⋯ @@`] : []), ...h.ops.map(x => `${x.t}${x.line}`)]).join('\n');
  const fence = '~'.repeat(Math.max(3, ...[...unified.matchAll(/~{3,}/g)].map(m => m[0].length + 1)));
  const summary = `Before/after as text: ${o.caption}`.replace(/[<>]/g, '');
  const text = [`<details><summary>${summary}</summary>`, '', `${fence}diff`, `--- ${o.before.label}${o.before.absent ? ` (${o.before.absent})` : ''}`, `+++ ${o.after.label}${o.after.absent ? ` (${o.after.absent})` : ''}`, unified, fence, '', '</details>', ''].join('\n');
  return { html, text, changed };
}
