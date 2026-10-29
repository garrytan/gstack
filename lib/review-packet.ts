/**
 * review-packet — one file per /ship reviewer (docs/review-policy.md#reviewer-packets).
 * A packet is everything a reviewer reads: the role's instructions and findings
 * contract (lib/review-prompts.ts, the text the generated prose renders), its
 * checklists inlined, its DIFF_CMD diff at -U8 against the literal diff base with
 * a stat, at most 8 KB of the plan, a read budget, and the output path its result
 * goes to. A reviewer packet over PACKET_CAP_BYTES is sharded by path, never
 * truncated; a Step 7/8 audit is one packet (one verdict, one generation allowance).
 * Selection is lib/review-depth.ts planReview's (through lib/review-plan-live.ts);
 * collect is lib/review-packet-collect.ts.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Dispatch, Role } from './review-depth';
import * as P from './review-prompts';

export const PACKET_CAP_BYTES = 200_000;
export const PLAN_EXCERPT_BYTES = 8 * 1024;
/** One read-tool call's share of a packet: Capy's read returns ~37.8K chars and drops the rest silently, so packets are read as parallel ranges under this. */
export const READ_CHUNK_BYTES = 30_000;
/** A data-format file (.json/.jsonl/.ndjson/.csv/.tsv, not a package or config manifest) past this many changed lines reaches reviewers as a summary. */
export const DATA_SUMMARY_LINES = 400;
export const MANIFEST = 'manifest.json';
export const AUDITS = ['test-coverage', 'plan-completion'] as const;
export type AuditName = (typeof AUDITS)[number];
export type PacketRole = Role | 'audit';

export interface PacketEntry {
  role: PacketRole; name: string; reviewer: string; effort: string; file: string; out: string; bytes: number;
  checklists: string[]; fixtures: 'full' | 'summary'; shard: { index: number; total: number; oversize: boolean } | null;
  /** Line ranges (`from-to`, comma-joined) that read the packet whole, each under READ_CHUNK_BYTES. */
  read?: string;
  /** The Red Team before collect: listed so collect reports it pending until its packet is built. */
  deferred?: boolean;
}
export interface Manifest { version: 1; head: string; diff_base: string; fingerprint: string; content?: string; packets: PacketEntry[] }

export interface BuildContext {
  root: string; skillRoot: string; binDir: string; outDir: string; head: string; diffBase: string; fingerprint: string;
  /** The ref `origin/<base>` stands for in prompt text (lib/review-collect.ts resolveBaseRef). */
  baseRef?: string;
  plan?: { path: string; text: string };
  /** Merged findings for the Red Team (collect's merged.jsonl), one summary line each. */
  findings?: string[];
  /** Specialist reviewers that produced those findings (the Red Team's N). */
  specialists?: number;
  fixCheck?: { fixList: string; tests: string; callers: string };
  /** Parent-supplied context for an audit (framework decision, permitted paths, caps). */
  context?: string;
  learnings: (domain: string) => string;
  cap?: number;
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const fence = (s: string) => '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1)));
const block = (s: string, lang = '') => { const f = fence(s); return `${f}${lang}\n${s.replace(/\n?$/, '\n')}${f}`; };

function git(root: string, args: string[], okCodes = [0]): string {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 512 * 1024 * 1024 });
  if (r.status === null || !okCodes.includes(r.status)) throw new Error(`git ${args.slice(0, 4).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
  return r.stdout;
}

/** The stack and test framework lines the review-army selection detects, read the same way. */
export function detectStack(root: string): { stack: string; testFw: string } {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const stack = [has('Gemfile') && 'ruby', has('package.json') && 'node', (has('requirements.txt') || has('pyproject.toml')) && 'python', has('go.mod') && 'go', has('Cargo.toml') && 'rust', has('pubspec.yaml') && 'dart'].filter(Boolean).join(' ');
  let testFw = '';
  if (has('jest.config.ts') || has('jest.config.js')) testFw = 'jest';
  if (has('vitest.config.ts')) testFw = 'vitest';
  if (has('spec/spec_helper.rb') || has('.rspec')) testFw = 'rspec';
  if (has('pytest.ini') || has('conftest.py')) testFw = 'pytest';
  if (has('go.mod')) testFw = 'go-test';
  if (has('pubspec.yaml')) testFw = /^ +sdk: *.?flutter/m.test(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8')) ? 'flutter-test' : 'dart-test';
  return { stack: stack || 'unknown', testFw: testFw || 'unknown' };
}

export function checklistPath(skillRoot: string, name: string): string {
  return path.join(skillRoot, 'review', name === 'design' ? 'design-checklist.md' : path.join('specialists', `${name}.md`));
}

export interface ReviewerDiff { stat: string; chunks: string[]; fixtureStat: string | null; paths: string[] }

/** The reviewer's DIFF_CMD at -U8 (tracked and untracked, exclusions honored) split per file; fixtures go to a stat in summary mode. */
const DATA_FILE = /\.(json|jsonl|ndjson|csv|tsv)$/i;
const MANIFEST_FILE = /^(package(-lock)?\.json|composer\.json|deno\.jsonc?|tsconfig[^/]*\.json|[^/]*\.config\.json)$/i;

/** Keys or columns read from the diff's own lines (added, else removed), never from the working tree, which a symlink can point outside the diff. */
function topLevelKeys(file: string, changed: string[]): string {
  const side = changed.some(l => l.startsWith('+')) ? '+' : '-';
  const text = changed.filter(l => l.startsWith(side)).map(l => l.slice(1)).join('\n');
  try {
    if (/\.(csv|tsv)$/i.test(file)) return `columns: ${text.split('\n')[0]!.slice(0, 300)}`;
    const v = /\.json$/i.test(file) ? JSON.parse(text) : JSON.parse(text.split('\n').find(l => l.trim()) ?? 'null');
    const keys = (o: unknown) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 30).join(', ') : '');
    return Array.isArray(v) ? `array of ${v.length}; first item keys: ${keys(v[0]) || '(none)'}` : `top-level keys: ${keys(v) || '(none)'}`;
  } catch { return 'top-level keys: (not parsed)'; }
}

/** A large data-format file's chunk as a summary: its changed-line count, keys, and the first and last 40 changed lines. */
function dataSummary(p: string, chunk: string): string | null {
  if (!DATA_FILE.test(p) || MANIFEST_FILE.test(path.basename(p))) return null;
  const changed = chunk.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  if (changed.length <= DATA_SUMMARY_LINES) return null;
  return [`diff --git a/${p} b/${p}`, `DATA SUMMARY: ${p} (${changed.length} changed lines, a data file shown as a summary; ask the parent for a line range if a finding needs one)`,
    topLevelKeys(p, changed), 'first 40 changed lines:', ...changed.slice(0, 40), '…', 'last 40 changed lines:', ...changed.slice(-40), ''].join('\n');
}

export function reviewerDiff(root: string, diffBase: string, exclude: readonly string[], summary: boolean, skip: (p: string) => boolean, keepData: (p: string) => boolean = () => false): ReviewerDiff {
  const fixtureSpecs = summary ? P.FIXTURE_PATHSPECS.map(p => `:(exclude)${p}`) : [];
  const spec = ['--', '.', ...exclude, ...fixtureSpecs];
  const diff = git(root, ['diff', '-U8', '--no-color', '--no-ext-diff', '--no-renames', diffBase, ...spec]);
  let stat = git(root, ['diff', '--stat=200', '--no-renames', diffBase, ...spec]).trimEnd();
  const chunks = diff ? diff.split(/^(?=diff --git )/m).filter(Boolean) : [];
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', ...spec]).split('\0').filter(p => p && !skip(p)).sort();
  for (const p of untracked) {
    const c = git(root, ['diff', '--no-index', '-U8', '--no-color', '--', '/dev/null', p], [0, 1]);
    if (c) chunks.push(c);
    stat += `${stat ? '\n' : ''} ${p} | untracked`;
  }
  let fixtureStat: string | null = null;
  if (summary) {
    const fx = ['--', ...P.FIXTURE_PATHSPECS, ...exclude];
    const listed = git(root, ['ls-files', '--others', '--exclude-standard', '-z', ...fx]).split('\0').filter(p => p && !skip(p));
    fixtureStat = [git(root, ['diff', '--stat=200', '--no-renames', diffBase, ...fx]).trimEnd(), ...listed.map(p => ` ${p} | untracked`)].filter(Boolean).join('\n') || '(no test or fixture changes)';
  }
  const paths = chunks.map(c => /^diff --git a\/(.*?) b\//.exec(c)?.[1] ?? '?');
  const shown = chunks.map((c, i) => (keepData(paths[i]!) ? c : dataSummary(paths[i]!, c) ?? c));
  return { stat: stat || '(empty diff)', chunks: shown, fixtureStat, paths };
}

/** Diff pieces packed into shards under `budget` bytes; a file over it splits at hunks; a hunk over it is its own oversize shard. */
export function shardChunks(chunks: readonly string[], budget: number): { text: string; oversize: boolean }[] {
  const shards: { text: string; oversize: boolean }[] = [];
  let cur = '';
  const flush = () => { if (cur) shards.push({ text: cur, oversize: false }); cur = ''; };
  const add = (piece: string) => { if (cur && bytes(cur) + bytes(piece) > budget) flush(); cur += piece; };
  for (const chunk of chunks) {
    if (bytes(chunk) <= budget) { add(chunk); continue; }
    flush();
    const at = chunk.search(/^@@/m);
    const header = at < 0 ? chunk : chunk.slice(0, at);
    const hunks = at < 0 ? [] : chunk.slice(at).split(/^(?=@@)/m);
    if (!hunks.length) { shards.push({ text: chunk, oversize: true }); continue; }
    let part = '';
    for (const h of hunks) {
      if (bytes(header) + bytes(h) > budget) { if (part) shards.push({ text: header + part, oversize: false }); part = ''; shards.push({ text: header + h, oversize: true }); continue; }
      if (part && bytes(header) + bytes(part) + bytes(h) > budget) { shards.push({ text: header + part, oversize: false }); part = ''; }
      part += h;
    }
    if (part) cur = header + part;
  }
  flush();
  return shards.length ? shards : [{ text: '', oversize: false }];
}

interface RoleText { title: string; instructions: string[]; contract: string; checklists: string[]; summary: boolean; extra: string[]; diffLabel: string; reply: string }

const doneLine = (name: string) => `DONE ${name} crit=<n> info=<n>`;

function roleText(d: Dispatch, ctx: BuildContext, testFw: string): RoleText {
  const jsonOut = (name: string) => `Write your result to the output path below with your file-write tool: \`NO FINDINGS\` alone, or the JSON lines and nothing else. Then reply with exactly one line, \`${doneLine(name)}\`, counting the CRITICAL and INFORMATIONAL findings you wrote. The parent reads only that file.`;
  const contract = P.SPECIALIST_CONTRACT.replace('{TEST_FW}', testFw);
  const base = { extra: [] as string[], diffLabel: 'Diff', summary: false, checklists: [] as string[] };
  switch (d.role) {
    case 'specialist': {
      if (d.checklists) return { ...base, title: 'batched specialist', checklists: d.checklists,
        instructions: [P.DEFENSIVE_REVIEW_FRAMING, `${P.SPECIALIST_INTRO} Apply every checklist below against the diff below; the red-team checklist goes last and looks for what the others missed.`],
        contract: `${contract}\n\nTag each finding with the checklist that found it: \`"specialist":"<checklist name>"\`.`, reply: jsonOut(d.name) };
      const framed = d.name === 'security';
      const extra = d.name === 'state-machines' ? [`Your output file is also the matrix record file: write the matrix record(s) the checklist describes there with your findings; the parent runs \`gstack-state-matrix check\` on it.`] : [];
      return { ...base, title: `${d.name} specialist`, checklists: [d.name], summary: framed, extra,
        instructions: [...(framed ? [P.DEFENSIVE_REVIEW_FRAMING, P.FIXTURE_SUMMARY_PACKET] : []), `${P.SPECIALIST_INTRO} Apply the checklist below against the diff below.`],
        contract: `${contract}\n\nTag every finding \`"specialist":"${d.name}"\`.`, reply: jsonOut(d.name) };
    }
    case 'red-team': {
      const summary = ctx.findings?.length ? ctx.findings.join('\n') : 'none';
      return { ...base, title: 'Red Team', checklists: ['red-team'], summary: true,
        instructions: [P.DEFENSIVE_REVIEW_FRAMING, P.FIXTURE_SUMMARY_PACKET, P.RED_TEAM_INTRO.replace('N specialists', `${ctx.specialists ?? 0} specialists`).replace('{merged findings summary}', 'the merged findings listed under "Already found" below'), 'Apply the red-team checklist below against the diff below and look for gaps.', P.RED_TEAM_OUTPUT],
        contract: `${contract}\n\nTag every finding \`"specialist":"red-team"\`.`, extra: [`## Already found\n\n${block(summary)}`], reply: jsonOut(d.name) };
    }
    case 'adversarial-native':
      return { ...base, title: 'native adversarial pass', summary: true, instructions: [P.DEFENSIVE_REVIEW_FRAMING, P.FIXTURE_SUMMARY_PACKET, P.ADVERSARIAL_NATIVE], contract: P.ADVERSARIAL_CONTRACT, reply: jsonOut('adversarial') };
    case 'outside-voice':
      return { ...base, title: 'outside voice', instructions: [P.CODEX_BOUNDARY_TEXT, 'Review the changes on this branch against the base branch. Use the supplied branch diff.', P.OUTSIDE_ADVERSARIAL], contract: P.OUTSIDE_CONTRACT,
        reply: 'Your reply is your result: answer in the format above; the parent saves it verbatim to the output path below.' };
    case 'fix-check': {
      const fc = ctx.fixCheck!;
      return { ...base, title: 'fix-check', diffLabel: 'Touched hunks', instructions: [P.FIX_CHECK_INSTRUCTIONS], contract: 'Rate and format findings exactly as the instructions say.',
        extra: [`## Fix list\n\n${block(fc.fixList.trim())}`, `## Callers of changed symbols\n\n${block(fc.callers.trim() || '(none found)')}`, `## Test results after the fixes\n\n${block(fc.tests.trim())}`], reply: jsonOut(d.name) };
    }
  }
}

export interface PacketDraft { role: PacketRole; name: string; effort: string; checklists: string[]; summary: boolean; head: string[]; diff: ReviewerDiff; diffLabel: string; diffCmd: string; tail: string[] }

function render(draft: PacketDraft, name: string, out: string, shard: { index: number; total: number; oversize: boolean } | null, diffText: string): string {
  const shardNote = shard ? [`This is shard ${shard.index} of ${shard.total} of reviewer ${draft.name}: the diff below holds some of its paths, the stat lists all of them. Review only this shard's diff.${shard.oversize ? ' SHARD_OVERSIZE: one hunk alone exceeds the packet cap; it is whole here, never truncated.' : ''}`] : [];
  return [`# Review packet: ${name}`, '', ...draft.head.map(s => s.replaceAll('<OUT>', out).replaceAll('<NAME>', name)), ...shardNote.map(s => s + '\n'),
    `## Output\n\nOutput path: \`${out}\``, '', ...draft.tail,
    `## Diff stat\n\n${block(draft.diff.stat)}`, '',
    ...(draft.diff.fixtureStat !== null ? [`## Tests and fixtures (summary mode)\n\n${block(draft.diff.fixtureStat)}`, ''] : []),
    `## ${draft.diffLabel} (\`${draft.diffCmd}\`, untracked files included)\n\n${block(diffText, 'diff')}`, '', `END OF PACKET ${name}`, ''].join('\n');
}

/** Line ranges that read `text` whole, each at most READ_CHUNK_BYTES (a single longer line is its own range). */
export function readRanges(text: string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let from = 1, size = 0;
  lines.forEach((l, i) => {
    const b = bytes(l) + 1;
    if (size && size + b > READ_CHUNK_BYTES) { out.push(`${from}-${i}`); from = i + 1; size = 0; }
    size += b;
  });
  out.push(`${from}-${lines.length}`);
  return out.join(',');
}

/** One reviewer's packet files (one, or k shards), written under outDir; returns their manifest entries. */
export function writePackets(draft: PacketDraft, ctx: BuildContext): PacketEntry[] {
  const cap = ctx.cap ?? PACKET_CAP_BYTES;
  const outOf = (name: string) => path.join(ctx.outDir, `${name}.out`);
  const fileOf = (name: string) => path.join(ctx.outDir, `${name}.packet.md`);
  const fixed = bytes(render(draft, `${draft.name}.99of99`, outOf(`${draft.name}.99of99`), { index: 99, total: 99, oversize: true }, ''));
  const budget = Math.max(cap - fixed - 64, 1);
  let shards = draft.role === 'audit' ? [{ text: draft.diff.chunks.join(''), oversize: false }] : shardChunks(draft.diff.chunks, budget);
  const total = draft.diff.chunks.reduce((n, c) => n + bytes(c), 0);
  for (let b = Math.ceil((total / shards.length) * 1.02); shards.length > 1 && b < budget; b = Math.ceil(b * 1.05)) {
    const even = shardChunks(draft.diff.chunks, b);
    if (even.length <= shards.length) { shards = even; break; }
  }
  return shards.map((s, i) => {
    const shard = shards.length > 1 ? { index: i + 1, total: shards.length, oversize: s.oversize } : (s.oversize ? { index: 1, total: 1, oversize: true } : null);
    const name = shards.length > 1 ? `${draft.name}.${i + 1}of${shards.length}` : draft.name;
    const text = render(draft, name, outOf(name), shard, s.text);
    fs.writeFileSync(fileOf(name), text, { mode: 0o600 });
    fs.rmSync(outOf(name), { force: true });
    return { role: draft.role, name, reviewer: draft.name, effort: draft.effort, file: fileOf(name), out: outOf(name), bytes: bytes(text), checklists: draft.checklists, fixtures: draft.summary ? 'summary' : 'full', shard, read: readRanges(text) };
  });
}

const diffCmd = (base: string, exclude: readonly string[], summary: boolean) => {
  const specs = [...exclude, ...(summary ? P.FIXTURE_PATHSPECS.map(p => `:(exclude)${p}`) : [])];
  return `git diff -U8 ${base}${specs.length ? ` -- . ${specs.map(x => `'${x}'`).join(' ')}` : ''}`;
};
const underTests = (p: string) => /(^|\/)(tests?|fixtures?|__tests__)\//.test(p);
const insideOut = (ctx: BuildContext) => (p: string) => p.startsWith('.gstack/tmp/') || path.resolve(ctx.root, p).startsWith(path.resolve(ctx.outDir) + path.sep);

function common(ctx: BuildContext, stack: string, testFw: string, learnings: string | null, budget: string): string[] {
  return [`## Context\n\nStack: ${stack}. Test framework: ${testFw}. Diff base: \`${ctx.diffBase}\`; head \`${ctx.head}\`.${learnings === null ? '' : ` Past learnings: ${learnings || 'none'}`}`, '',
    `## Read budget\n\n${budget}`, '',
    ...(ctx.plan ? [`## Plan (first ${PLAN_EXCERPT_BYTES / 1024} KB of \`${ctx.plan.path}\`)\n\n${block(Buffer.from(ctx.plan.text).subarray(0, PLAN_EXCERPT_BYTES).toString('utf8'))}`, ''] : [])];
}

/** The packet draft of one DISPATCH line: everything but the diff split. */
export function draftFor(d: Dispatch, ctx: BuildContext): PacketDraft {
  const { stack, testFw } = detectStack(ctx.root);
  const t = roleText(d, ctx, testFw);
  const learnings = d.role === 'specialist' ? ctx.learnings(t.checklists.filter(c => c !== 'red-team').join(' ')) : null;
  const checklists = t.checklists.map(c => {
    const file = checklistPath(ctx.skillRoot, c);
    return `## Checklist: ${c}\n\n${block(fs.readFileSync(file, 'utf8'))}`;
  });
  const head = [`Role: ${t.title} (\`${d.role}\`, effort=${d.effort}).${d.reason ? ` Dispatched because: ${d.reason}.` : ''}`, '',
    `## Instructions\n\n${t.instructions.join('\n\n')}`, '', `## Findings contract\n\n${t.contract}\n\n${t.reply}`, '',
    ...t.extra.flatMap(s => [s, '']), ...common(ctx, stack, testFw, learnings, P.READ_BUDGET), ...checklists.flatMap(s => [s, ''])];
  return { role: d.role, name: d.name.split(' ')[0]!, effort: d.effort, checklists: t.checklists, summary: t.summary, head, tail: [],
    diff: reviewerDiff(ctx.root, ctx.diffBase, d.exclude, t.summary, insideOut(ctx), d.role === 'specialist' && !d.checklists && d.name === 'testing' ? underTests : undefined), diffLabel: t.diffLabel, diffCmd: diffCmd(ctx.diffBase, d.exclude, t.summary) };
}

/** An audit's prompt is the generated section's text fence: the packet and the SKILL.md prose are one text. */
export function auditPrompt(skillRoot: string, audit: AuditName, base: string, baseRef = `origin/${base}`): string {
  const section = fs.readFileSync(path.join(skillRoot, 'ship', 'sections', `${audit}.md`), 'utf8');
  const m = /^(`{4,})text\n([\s\S]*?)\n\1$/m.exec(section);
  if (!m) throw new Error(`ship/sections/${audit}.md has no prompt fence`);
  return m[2]!.replaceAll('origin/<base>', baseRef).replaceAll('<base>', base);
}

export function auditDraft(audit: AuditName, ctx: BuildContext, base: string, effort: string): PacketDraft {
  const { stack, testFw } = detectStack(ctx.root);
  const budget = 'The diff is below; do not rerun git diff. Read only files in the diff, their tests and the files the plan names, in named line ranges of at most 200 lines; no whole-repository search, no other packets, no transcript. Writes and test runs only as the audit instructions permit.';
  const plan = audit === 'plan-completion' && ctx.plan ? [`## Plan (whole, \`${ctx.plan.path}\`)\n\n${block(ctx.plan.text)}`, ''] : [];
  const head = [`Role: ${audit} audit (effort=${effort}).`, '', `## Instructions\n\n${auditPrompt(ctx.skillRoot, audit, base, ctx.baseRef)}`, '',
    `## Output\n\nWrite your whole final answer to the output path below, its LAST line the JSON object the instructions name. Then reply with exactly one line, \`DONE <NAME>\`.`, '',
    ...(ctx.context ? [`## Parent context\n\n${block(ctx.context.trim())}`, ''] : []),
    ...common({ ...ctx, plan: audit === 'plan-completion' ? undefined : ctx.plan }, stack, testFw, null, budget), ...plan];
  return { role: 'audit', name: audit, effort, checklists: [], summary: false, head, tail: [], diff: reviewerDiff(ctx.root, ctx.diffBase, [], false, insideOut(ctx), audit === 'test-coverage' ? underTests : undefined), diffLabel: 'Diff', diffCmd: diffCmd(ctx.diffBase, [], false) };
}

/** The reviewed content's identity: the whole diff a reviewer could be shown, hashed; a partial build keeps other reviewers only when it is unchanged. */
export function contentKey(ctx: BuildContext): string {
  return createHash('sha256').update(reviewerDiff(ctx.root, ctx.diffBase, [], false, insideOut(ctx), () => true).chunks.join('')).digest('hex').slice(0, 16);
}

export function readManifest(dir: string): Manifest | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as Manifest; } catch { return null; }
}

/** Write the manifest; a partial build (--only) at the same head, diff base and content replaces entries of the same reviewer and keeps the rest; any other build starts over. */
export function writeManifest(dir: string, m: Omit<Manifest, 'packets'>, packets: PacketEntry[], partial: boolean): Manifest {
  const old = readManifest(dir);
  const prior = partial && old && old.head === m.head && old.diff_base === m.diff_base && old.content === m.content ? old : null;
  const rebuilt = new Set(packets.map(p => p.reviewer));
  if (!prior) for (const old of readManifest(dir)?.packets ?? []) { if (old.deferred) continue; fs.rmSync(old.out, { force: true }); if (!packets.some(p => p.file === old.file)) fs.rmSync(old.file, { force: true }); }
  const kept = (prior?.packets ?? []).filter(p => !rebuilt.has(p.reviewer));
  const manifest: Manifest = { ...m, packets: [...kept, ...packets] };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}

export function packetLine(p: PacketEntry): string {
  return `PACKET: ${p.role} ${p.name} effort=${p.effort} bytes=${p.bytes} tokens~=${Math.ceil(p.bytes / 4)} budget_role=${budgetRole(p.role)} read=${p.read ?? '1-1'} file=${p.file} out=${p.out}`;
}

/** The gstack-ship-budget dispatch role a packet reserves as: audits as a specialist reader, shards as their parent role. */
export function budgetRole(role: PacketRole): Exclude<PacketRole, 'audit'> {
  return role === 'audit' ? 'specialist' : role;
}
