/**
 * review-pass — one staged dispatch manifest per /ship review pass (GSTA-167 calls PR 2).
 *
 * gstack-review-dispatch pass turns gstack-review-plan's dispatches into a manifest: stage `first`
 * (audit readers that may write tests, so they settle before any reviewer reads the tree), stage
 * `specialists` (the specialists, plus the other audit and QA readers), stage `red-team` and stage
 * `voices` (Step 11). Each reviewer keeps its plan entry (role, effort, exclusions) and is rendered
 * once, when its inputs exist, by lib/review-brief.ts; the Red Team's findings file is the
 * specialists' merged.jsonl lines, byte for byte. Briefs travel to the dispatch program in bounded
 * indexed chunks, so no tool output line carries a whole brief. Every reader's dispatch intent is
 * persisted before its subagent is created and its path right after, so a resumed program
 * reconciles by deterministic title and never doubles a reader.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BriefError, briefFile, checkoutRoot, checkoutTree, promptHash, renderBrief, withWorkspace, type BriefRole, type SectionTexts, type Slots } from './review-brief';
import { appendEvent, readerKey } from './review-ledger';
import { diffCommand, type Dispatch } from './review-depth';
import { TARGETED_RULES, parseClassList, targetedBriefSha, targetedPatchId } from './review-targeted';

export const STAGES = ['first', 'specialists', 'red-team', 'voices'] as const;
export type Stage = typeof STAGES[number];
export type ReaderState = 'planned' | 'rendered' | 'intent' | 'created' | 'queued' | 'collected' | 'failed';

export interface PassModel { model_id: string; reasoning_mode?: string }
export interface PassReader {
  reader: string; stage: Stage; title: string; state: ReaderState;
  role?: BriefRole; name?: string; effort?: string; exclude?: string; checklists?: string[];
  /** The targeted reader: the plan's TARGETED classes and the merge base it reads on every pass. */
  classes?: string[]; diff_base?: string;
  /** An audit or QA reader: its prompt is a file the parent wrote from its section; its output is returned, never collected. */
  prompt_file?: string; model?: PassModel;
  file?: string; sha256?: string; bytes?: number; chunks?: number; findings_sha256?: string;
  /** The fingerprint the reader's reply must report: the checkout's HEAD^{tree} and toplevel when its brief was rendered (GST-482). */
  tree?: string | null;
  path?: string; output?: string; error?: string; state_at?: string;
}
export interface Manifest {
  version: 1; pass: string; out: string; ledger: string; merged: string; base: string; diff_base: string;
  stack: string; test_fw: string; learnings: string | null; checklist_root: string;
  next: string; plan_lines: string[]; readers: PassReader[]; before?: { tokens: number; credits: number };
  log_starts?: Record<string, string>;
}
export interface Extra { name: string; prompt_file: string; first?: boolean; model?: PassModel }

/** Brief characters per transport chunk: even with every character escaped, one chunk line stays far under 1 MiB. */
export const CHUNK_CHARS = 65_536;

/** STACK from Step 9.1's detection block in ship/sections/review-army.md, trimmed. */
export function detectStack(root: string): string {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const s = [has('Gemfile') && 'ruby', has('package.json') && 'node', (has('requirements.txt') || has('pyproject.toml')) && 'python',
    has('go.mod') && 'go', has('Cargo.toml') && 'rust', has('pubspec.yaml') && 'dart'].filter(Boolean).join(' ');
  return s || 'unknown';
}

/** TEST_FW from the same block: the last matching rule wins. */
export function detectTestFw(root: string): string {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  let fw = '';
  if (has('jest.config.ts') || has('jest.config.js')) fw = 'jest';
  if (has('vitest.config.ts')) fw = 'vitest';
  if (has('spec/spec_helper.rb') || has('.rspec')) fw = 'rspec';
  if (has('pytest.ini') || has('conftest.py')) fw = 'pytest';
  if (has('go.mod')) fw = 'go-test';
  if (has('pubspec.yaml')) fw = /^ +sdk: *.?flutter/m.test(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8')) ? 'flutter-test' : 'dart-test';
  return fw || 'unknown';
}

const safe = (reader: string) => reader.replace(/[^a-zA-Z0-9._-]/g, '_');
const STAGE_OF: Record<string, Stage> = { specialist: 'specialists', 'red-team': 'red-team', 'adversarial-native': 'voices', 'outside-voice': 'voices', targeted: 'voices' };

/** The manifest for one pass from the plan's dispatches. A fix-check is not part of a pass, so it is refused. */
export function buildManifest(o: {
  pass: string; out: string; ledger: string; base: string; diffBase: string; root: string; checklistRoot: string;
  dispatches: Dispatch[]; next: string; planLines: string[]; learnings?: string | null; extras?: Extra[];
  targetedClasses?: readonly string[]; mergeBase?: string; rangeBase?: string;
}): Manifest {
  const readers: PassReader[] = [];
  for (const d of o.dispatches) {
    const stage = STAGE_OF[d.role];
    if (!stage) throw new BriefError(`a pass dispatches no ${d.role} reader (fix-check runs on its own)`);
    const role: BriefRole = d.role === 'specialist' && d.checklists ? 'specialist-batched' : d.role as BriefRole;
    const name = role === 'specialist' ? d.name : undefined;
    const reader = readerKey(role, name);
    const exclude = d.exclude.length ? diffCommand(d).slice('git diff <diff-base> '.length) : undefined;
    readers.push({ reader, stage, title: `ship ${o.pass} ${reader}`, state: 'planned', role, name, effort: d.effort, exclude, checklists: d.checklists,
      ...(role === 'targeted' ? { classes: [...(o.targetedClasses ?? [])], diff_base: o.mergeBase ?? o.diffBase } : {}),
      ...(role === 'red-team' && o.rangeBase ? { diff_base: o.rangeBase } : {}) });
  }
  for (const e of o.extras ?? []) {
    if (!/^[a-z0-9-]+$/.test(e.name)) throw new BriefError(`an audit reader's name is lowercase letters, digits and dashes: ${e.name}`);
    readers.push({ reader: `audit/${e.name}`, stage: e.first ? 'first' : 'specialists', title: `ship ${o.pass} audit/${e.name}`, state: 'planned', prompt_file: path.resolve(e.prompt_file), model: e.model });
  }
  if (new Set(readers.map(r => r.reader)).size !== readers.length) throw new BriefError('two readers share a key in this pass');
  const out = path.resolve(o.out);
  return {
    version: 1, pass: o.pass, out, ledger: path.resolve(o.ledger), merged: path.join(out, 'merged.jsonl'), base: o.base, diff_base: o.diffBase,
    stack: detectStack(o.root), test_fw: detectTestFw(o.root), learnings: o.learnings ?? null, checklist_root: o.checklistRoot,
    next: o.next, plan_lines: o.planLines, readers,
  };
}

export const manifestPath = (out: string) => path.join(path.resolve(out), 'pass-manifest.json');
export function readManifest(file: string): Manifest {
  let m: Manifest;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest; } catch { throw new BriefError(`cannot read the pass manifest ${file}`); }
  if (m.version !== 1) throw new BriefError(`pass manifest ${file} has version ${String(m.version)}; this gstack reads version 1`);
  return m;
}
export function writeManifest(file: string, m: Manifest): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The Red Team's findings file: the specialists' merged lines exactly as collect wrote them. */
export function specialistFindings(mergedFile: string): string {
  let text = '';
  try { text = fs.readFileSync(mergedFile, 'utf8'); } catch { return ''; }
  const lines = text.split('\n').filter(l => l.trim() && String((JSON.parse(l) as { reader?: unknown }).reader ?? '').startsWith('specialist'));
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Render every planned reader of a stage. The Red Team renders only after every earlier reader is collected. */
export function renderStage(m: Manifest, stage: Stage, t: SectionTexts, diffFor: (base: string) => string): PassReader[] {
  const open = m.readers.filter(r => (r.stage === 'first' || r.stage === 'specialists') && r.state !== 'collected');
  if (stage === 'red-team' && open.length) throw new BriefError(`the Red Team renders after every earlier reader is collected; still open: ${open.map(r => r.reader).join(', ')}`);
  const briefs = path.join(m.out, 'briefs');
  fs.mkdirSync(briefs, { recursive: true, mode: 0o700 });
  const done: PassReader[] = [];
  const workdir = checkoutRoot();
  const tree = checkoutTree(workdir);
  if (!tree) throw new BriefError(`cannot read HEAD^{tree} and the toplevel of ${workdir}; a brief names the checkout its reply must prove`);
  for (const r of m.readers.filter(x => x.stage === stage && x.state === 'planned')) {
    if (r.prompt_file) {
      let text: string;
      try { text = withWorkspace(fs.readFileSync(r.prompt_file, 'utf8'), workdir); } catch { throw new BriefError(`cannot read ${r.reader}'s prompt file ${r.prompt_file}`); }
      const file = path.join(briefs, `${safe(r.reader)}.prompt.md`);
      fs.writeFileSync(file, text, { mode: 0o600 });
      Object.assign(r, { file, sha256: promptHash(text), bytes: Buffer.byteLength(text), chunks: chunkCount(text), state: 'rendered', tree });
      done.push(r);
      continue;
    }
    const role = r.role!;
    const slots: Slots = { name: r.name, diff_base: r.diff_base ?? m.diff_base, exclude: r.exclude, stack: m.stack, test_fw: m.test_fw, learnings: m.learnings ?? undefined,
      checklists: r.checklists?.map(n => path.join(m.checklist_root, 'review/specialists', `${n}.md`)).join(',') };
    if (role === 'specialist') slots.checklist = path.join(m.checklist_root, 'review/specialists', `${r.name}.md`);
    let findingsSha: string | undefined;
    if (role === 'red-team') {
      const findings = specialistFindings(m.merged);
      fs.writeFileSync(path.join(briefs, 'specialist-findings.jsonl'), findings, { mode: 0o600 });
      findingsSha = promptHash(findings);
      const specialists = m.readers.reduce((n, x) => n + (x.role === 'specialist' ? 1 : x.role === 'specialist-batched' ? (x.checklists ?? []).filter(c => c !== 'red-team').length : 0), 0);
      Object.assign(slots, { checklist: path.join(m.checklist_root, 'review/specialists/red-team.md'), findings, specialists: String(specialists) });
    }
    if (role === 'outside-voice') slots.diff = diffFor(m.diff_base);
    let targeted = {};
    if (role === 'targeted') {
      const checklist = path.join(m.checklist_root, 'review/specialists/targeted.md');
      let brief: string;
      try { brief = fs.readFileSync(checklist, 'utf8'); } catch { throw new BriefError(`cannot read the targeted brief ${checklist}`); }
      Object.assign(slots, { checklist, brief, classes: (r.classes ?? []).join(','), diff_base: r.diff_base ?? m.diff_base });
      targeted = { classes: parseClassList(slots.classes!), rules: TARGETED_RULES, brief_sha: targetedBriefSha(checklist), diff_base: slots.diff_base, patch_id: targetedPatchId(process.cwd(), slots.diff_base!) };
    }
    const text = withWorkspace(renderBrief(role, slots, t), workdir);
    const file = path.join(briefs, briefFile(role, r.name));
    fs.writeFileSync(file, text, { mode: 0o600 });
    const sha = promptHash(text);
    const bytes = Buffer.byteLength(text);
    appendEvent(m.ledger, { event: 'rendered', reader: r.reader, role, name: r.name ?? null, file, sha256: sha, bytes, pass: m.pass, stage, workdir, tree, ...(findingsSha ? { findings_sha256: findingsSha } : {}), ...targeted });
    Object.assign(r, { file, sha256: sha, bytes, chunks: chunkCount(text), state: 'rendered', tree, ...(findingsSha ? { findings_sha256: findingsSha } : {}) });
    done.push(r);
  }
  return done;
}

export const chunkCount = (text: string) => Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
export function chunkOf(text: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount(text)) throw new BriefError(`chunk index ${index} is outside 0..${chunkCount(text) - 1}`);
  return text.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS);
}

const NEXT_STATE: Record<ReaderState, ReaderState[]> = {
  planned: [], rendered: ['intent'], intent: ['created', 'queued'], queued: ['created'], created: ['collected', 'failed'], collected: [], failed: [],
};

/** Record one transition: intent before create, a subagent path with created or queued, never backward. */
export function markReader(m: Manifest, reader: string, to: ReaderState, extra: { path?: string; output?: string; error?: string } = {}): PassReader {
  const r = m.readers.find(x => x.reader === reader);
  if (!r) throw new BriefError(`no reader ${reader} in pass ${m.pass}`);
  if (!NEXT_STATE[r.state].includes(to)) throw new BriefError(`${reader} is ${r.state}; it cannot become ${to}`);
  if ((to === 'created' || to === 'queued') && !extra.path && !r.path) throw new BriefError(`${reader} becomes ${to} only with its subagent path`);
  Object.assign(r, { state: to, state_at: new Date().toISOString() }, extra.path ? { path: extra.path } : {}, extra.output ? { output: extra.output } : {}, extra.error ? { error: extra.error } : {});
  return r;
}

export const sentFile = (m: Manifest, reader: string) => path.join(m.out, 'sent', `${safe(reader)}.txt`);
export const outputFile = (m: Manifest, reader: string) => path.join(m.out, 'out', `${safe(reader)}.txt`);
