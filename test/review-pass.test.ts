/**
 * GSTA-167 calls PR 2: the staged pass manifest (lib/review-pass.ts), its bin commands, and the
 * checked-in Capy pass program (lib/capy-review-pass.js) run against a fake host whose shell is real.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promptHash, sectionTexts, withWorkspace } from '../lib/review-brief';
import { CHUNK_CHARS, buildManifest, chunkCount, chunkOf, markReader, renderStage, specialistFindings, type Manifest } from '../lib/review-pass';
import type { Dispatch } from '../lib/review-depth';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const texts = sectionTexts(ROOT);
const SHA = 'a'.repeat(40);
const spec = (name: string, exclude: string[] = []): Dispatch => ({ role: 'specialist', name, effort: 'full', exclude });

function tmp(prefix: string) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function manifest(dispatches: Dispatch[], o: Partial<Parameters<typeof buildManifest>[0]> = {}): Manifest {
  const out = tmp('rp-out-');
  const root = tmp('rp-root-');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return buildManifest({ pass: 'p1', out, ledger: path.join(out, 'ledger.jsonl'), base: 'main', diffBase: SHA, root, checklistRoot: ROOT, dispatches, next: 'full', planLines: [], ...o });
}
const collectAll = (m: Manifest, stage: string) => { for (const r of m.readers.filter(x => x.stage === stage)) { markReader(m, r.reader, 'intent'); markReader(m, r.reader, 'created', { path: '9' }); markReader(m, r.reader, 'collected'); } };

describe('pass manifest', () => {
  test('stages follow the plan: specialists, Red Team, voices; batched light depth keeps its checklists and exclusions; fix-check is refused', () => {
    const m = manifest([spec('testing'), { role: 'red-team', name: 'red-team', effort: 'full', exclude: [] }, { role: 'adversarial-native', name: 'adversarial', effort: 'full', exclude: [] }, { role: 'outside-voice', name: 'outside-voice', effort: 'host', exclude: [] }]);
    expect(m.readers.map(r => [r.reader, r.stage, r.title])).toEqual([
      ['specialist/testing', 'specialists', 'ship p1 specialist/testing'], ['red-team', 'red-team', 'ship p1 red-team'],
      ['adversarial-native', 'voices', 'ship p1 adversarial-native'], ['outside-voice', 'voices', 'ship p1 outside-voice']]);
    expect(m.stack).toBe('node');
    expect(m.test_fw).toBe('unknown');
    const light = manifest([{ role: 'specialist', name: 'batched', effort: 'full', exclude: [':(exclude)docs/a.md'], checklists: ['testing', 'red-team'] }]);
    expect(light.readers[0]).toMatchObject({ reader: 'specialist-batched', role: 'specialist-batched', exclude: "-- . ':(exclude)docs/a.md'", checklists: ['testing', 'red-team'] });
    expect(() => manifest([{ role: 'fix-check', name: 'fix-check', effort: 'full', exclude: [] }])).toThrow(/fix-check runs on its own/);
    // PR #3665 review: the batched reviewer reads each checklist by path, as the render CLI is given them, never by bare name.
    renderStage(light, 'specialists', texts, () => '');
    expect(fs.readFileSync(light.readers[0]!.file!, 'utf8')).toContain(`Read each checklist at ${path.join(ROOT, 'review/specialists/testing.md')}, ${path.join(ROOT, 'review/specialists/red-team.md')} (tag each finding`);
  });

  test('a manifest render is byte for byte the render CLI\'s brief for the same slots', () => {
    const m = manifest([spec('security', [':(exclude)test/x.ts'])]);
    renderStage(m, 'specialists', texts, () => '');
    const out = tmp('rp-cli-');
    const r = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['render', '--role', 'specialist', '--name', 'security', '--out', out, '--diff-base', SHA, '--stack', 'node', '--test-fw', 'unknown', '--exclude', "-- . ':(exclude)test/x.ts'"], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('sha256=' + m.readers[0]!.sha256);
    expect(fs.readFileSync(m.readers[0]!.file!, 'utf8')).toBe(fs.readFileSync(path.join(out, 'specialist-security.prompt.md'), 'utf8'));
  });

  test('the Red Team renders only after every earlier reader is collected, from the specialists\' merged lines byte for byte', () => {
    const m = manifest([spec('testing'), spec('security'), { role: 'red-team', name: 'red-team', effort: 'full', exclude: [] }]);
    renderStage(m, 'specialists', texts, () => '');
    expect(() => renderStage(m, 'red-team', texts, () => '')).toThrow(/still open: specialist\/testing, specialist\/security/);
    const lines = [{ id: 'specialist/testing#1', reader: 'specialist/testing', label: 'High', raw: 'High: a — ü', output_sha256: 'x' }, { id: 'red-team#1', reader: 'red-team', label: 'Low', raw: 'Low: b', output_sha256: 'y' }];
    fs.writeFileSync(m.merged, lines.map(l => JSON.stringify(l) + '\n').join(''));
    collectAll(m, 'specialists');
    renderStage(m, 'red-team', texts, () => '');
    const findings = fs.readFileSync(path.join(m.out, 'briefs/specialist-findings.jsonl'), 'utf8');
    expect(findings).toBe(JSON.stringify(lines[0]) + '\n');
    expect(findings).toBe(specialistFindings(m.merged));
    const rt = m.readers.find(r => r.reader === 'red-team')!;
    expect(rt.findings_sha256).toBe(promptHash(findings));
    const brief = fs.readFileSync(rt.file!, 'utf8');
    expect(brief).toContain('reviewed by 2 specialists');
    const batched = manifest([{ role: 'specialist', name: 'batched', effort: 'medium', exclude: [], checklists: ['testing', 'security', 'state-machines'] }, { role: 'red-team', name: 'red-team', effort: 'full', exclude: [] }]);
    renderStage(batched, 'specialists', texts, () => '');
    collectAll(batched, 'specialists');
    renderStage(batched, 'red-team', texts, () => '');
    expect(fs.readFileSync(batched.readers[1]!.file!, 'utf8')).toContain('reviewed by 3 specialists');
    expect(brief).toContain(findings.trim());
  });

  test('reader states move forward only: intent before create, a path with created or queued', () => {
    const m = manifest([spec('testing')]);
    renderStage(m, 'specialists', texts, () => '');
    expect(() => markReader(m, 'specialist/testing', 'created', { path: '1' })).toThrow(/cannot become created/);
    markReader(m, 'specialist/testing', 'intent');
    expect(() => markReader(m, 'specialist/testing', 'created')).toThrow(/only with its subagent path/);
    markReader(m, 'specialist/testing', 'queued', { path: '4' });
    markReader(m, 'specialist/testing', 'created');
    expect(() => markReader(m, 'specialist/testing', 'intent')).toThrow(/cannot become intent/);
    expect(m.readers[0]).toMatchObject({ state: 'created', path: '4' });
  });

  test('a brief over 1 MiB with invalid UTF-8 in its diff travels in bounded chunks that rejoin to the rendered sha', () => {
    const m = manifest([{ role: 'outside-voice', name: 'outside-voice', effort: 'host', exclude: [] }]);
    const diff = Buffer.concat([Buffer.from('+line \u00e9\n'.repeat(90_000)), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('+"quoted" \\ back\n'.repeat(20_000))]).toString('utf8');
    renderStage(m, 'voices', texts, () => diff);
    const r = m.readers[0]!;
    const text = fs.readFileSync(r.file!, 'utf8');
    expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
    expect(r.chunks).toBe(chunkCount(text));
    let joined = '';
    for (let i = 0; i < r.chunks!; i++) {
      const c = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['chunk', '--manifest', writeManifestFile(m), '--reader', 'outside-voice', '--index', String(i)], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      expect(c.status, c.stderr).toBe(0);
      const [head, body] = c.stdout.split('\n');
      expect(head).toBe('BRIEF_CHUNK: reader=outside-voice index=' + i + ' of=' + r.chunks + ' sha256=' + r.sha256);
      expect(Buffer.byteLength(body!)).toBeLessThan(1024 * 1024);
      joined += JSON.parse(body!);
    }
    expect(promptHash(joined)).toBe(r.sha256!);
    expect(() => chunkOf(text, r.chunks!)).toThrow(/outside/);
    expect(chunkOf(text, 0).length).toBe(CHUNK_CHARS);
  });
});

function writeManifestFile(m: Manifest): string {
  const f = path.join(m.out, 'pass-manifest.json');
  fs.writeFileSync(f, JSON.stringify(m));
  return f;
}

/** A repository on a feature branch with enough runtime lines for a full plan. */
function repo(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmp('rp-repo-');
  const env = { ...process.env, PATH: BIN + path.delimiter + process.env.PATH, GSTACK_STATE_ROOT: path.join(dir, '.state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); };
  sh("git init -q -b main && echo '{}' > package.json && mkdir src && echo 'export const a = 1;' > src/a.ts && echo .state > .gitignore && git add -A && git commit -qm base && git checkout -qb feat");
  sh('for i in $(seq 1 80); do echo "export const v$i = $i;" >> src/a.ts; done && git commit -qam feat');
  return { dir, env };
}

interface Sub { title: string; prompt: string; status: string; polls: number; model?: unknown; summary?: string; late?: boolean }
/** A fake Capy host: the shell is real (the repository's bins), subagents are scripted. */
const cleanReply = (title: string) => (title.endsWith('outside-voice') ? 'Recommendation: ship as-is because no finding survived' : 'NO FINDINGS');
/** The REVIEWED_TREE line a reader prints from dir (its brief's checkout when it follows the workspace paragraph); '' outside a checkout. */
function treeLine(dir: string): string {
  if (!dir) return '';
  const git = (a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 30_000 });
  const tree = git(['rev-parse', 'HEAD^{tree}']), top = git(['rev-parse', '--show-toplevel']);
  return tree.status === 0 && top.status === 0 ? `REVIEWED_TREE: ${tree.stdout.trim()} ${top.stdout.trim()}\n` : '';
}
const briefDir = (prompt: string) => /Workspace: the checkout under review is (.+?)\. Your shell and file tools/.exec(prompt)?.[1] ?? '';
function host(dir: string, env: NodeJS.ProcessEnv, o: { output?: (title: string) => string; reportFrom?: (title: string) => string; fail?: (title: string) => boolean; reject?: (title: string) => boolean; createThrows?: (title: string) => 'before' | 'after' | undefined; pollsToFinish?: number; lateSummary?: boolean } = {}) {
  let clock = 0;
  const subs = new Map<string, Sub>();
  const creates: Sub[] = [];
  const starts: number[][] = [];
  const reply = (s: Sub) => treeLine(o.reportFrom?.(s.title) ?? briefDir(s.prompt)) + (o.output?.(s.title) ?? cleanReply(s.title));
  const advance = () => {
    for (const s of subs.values()) {
      if (s.late && !s.summary) { s.summary = reply(s); continue; }
      if (s.status !== 'working') continue;
      if (++s.polls < (o.pollsToFinish ?? 1)) continue;
      if (o.fail?.(s.title)) s.status = 'failed';
      else if (o.lateSummary && !s.late) { s.status = 'done'; s.late = true; }
      else { s.status = 'done'; s.summary = reply(s); }
    }
  };
  const tools = {
    capy: {
      bash: async ({ command }: { command: string }) => {
        const r = spawnSync('bash', ['-c', command], { cwd: dir, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
        return { exit_code: r.status ?? 1, output: (r.stdout ?? '') + (r.stderr ?? '') };
      },
      write: async ({ path: p, content }: { path: string; content: string }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return { path: p }; },
    },
    subagent: {
      create: async ({ tasks, start }: { tasks: Array<{ title: string; prompt: string }>; start: { machine: string; model?: unknown } }) => {
        const t = tasks[0]!;
        const mode = o.createThrows?.(t.title);
        if (mode === 'before') throw new Error('create lost before it ran');
        expect(start.machine).toBe('shared');
        const index = subs.size + 1;
        const rejected = !!o.reject?.(t.title) && !creates.some(c => c.title === t.title);
        const s: Sub = { title: t.title, prompt: t.prompt, status: rejected ? 'draft' : 'working', polls: 0, model: start.model };
        subs.set(String(index), s);
        creates.push(s);
        if (mode === 'after') throw new Error('create result lost');
        return { tasks: [{ index, title: t.title }], ...(rejected ? { rejected: [{ index, error: 'cap' }] } : {}) };
      },
      start: async ({ indices }: { indices: number[] }) => { starts.push(indices); for (const i of indices) subs.get(String(i))!.status = 'working'; return { started: indices.map(index => ({ index })), rejected: [] }; },
      list: async () => { advance(); return { tasks: [...subs].map(([p, s]) => ({ path: p, title: s.title, status: s.status })), total: subs.size }; },
      get: async ({ path: p }: { path: string }) => ({ path: p, status: subs.get(p)!.status, summary: subs.get(p)!.summary }),
    },
    thread: { get: async () => ({ cost: { tokens: 1000 + clock, credits: 1 + clock / 1000 } }) },
  };
  return { tools, subs, creates, starts, sleep: async (ms: number) => { clock += ms; }, now: async () => 1_000_000 + clock };
}

const PROGRAM = fs.readFileSync(path.join(ROOT, 'lib/capy-review-pass.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...v: unknown[]) => Promise<string>;
async function runPass(h: ReturnType<typeof host>, input: Record<string, unknown>): Promise<string> {
  return new AsyncFunction('tools', 'sleep', 'now', 'input', PROGRAM)(h.tools, h.sleep, h.now, { startedAt: await h.now(), laneModel: 'anthropic/claude-opus-5-5', ...input });
}
const bin = (dir: string, env: NodeJS.ProcessEnv, a: string[]) => spawnSync(path.join(BIN, 'gstack-review-dispatch'), a, { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });

describe('the targeted reader in a pass (GST-257 on main)', () => {
  // Value: protects=a pass whose plan dispatches the targeted reader stages it with Step 11's voices on the merge base, its brief byte for byte the render CLI's, and its ledger row carrying the classes, rules, brief and patch the receipt's review_targeted record reads; fails_when=the manifest refuses or drops the targeted role, renders it on another base, or writes a rendered row verify --targeted-out cannot use;
  //   why_new=#3671 added the targeted reader after PR 2's manifest; seam=none; no_claim=the reader's findings
  test('a secret-path diff stages the targeted reader with the voices, identical to the render CLI, with its targeted ledger fields', () => {
    const { dir, env } = repo();
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
    sh("echo 'export const apiKeyName = \"X\";' > src/secrets.ts && git add -A && git commit -qm secret");
    const out = path.join(dir, '.state/run/p1');
    const p = bin(dir, env, ['pass', '--base', 'main', '--out', out, '--pass', 't1p1', '--', '--depth-floor', 'full']);
    expect(p.status, p.stdout + p.stderr).toBe(0);
    expect(p.stdout).toMatch(/^DISPATCH: targeted /m);
    const mf = path.join(out, 'pass-manifest.json');
    let m = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
    const t = m.readers.find(r => r.role === 'targeted')!;
    expect(t).toMatchObject({ reader: 'targeted', stage: 'voices', classes: ['secret'] });
    const mergeBase = sh('git merge-base main HEAD').trim();
    expect(t.diff_base).toBe(mergeBase);
    for (const st of ['specialists', 'red-team']) {
      if (st === 'red-team') expect(bin(dir, env, ['stage', '--manifest', mf, '--stage', st]).status).toBe(0);
      m = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
      for (const r of m.readers.filter(x => x.stage === st)) for (const [s, extra] of [['intent', []], ['created', ['--path', '1']], ['collected', []]] as const) expect(bin(dir, env, ['mark', '--manifest', mf, '--reader', r.reader, '--state', s, ...extra]).status).toBe(0);
    }
    const v = bin(dir, env, ['stage', '--manifest', mf, '--stage', 'voices']);
    expect(v.status, v.stdout + v.stderr).toBe(0);
    m = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
    const staged = m.readers.find(r => r.role === 'targeted')!;
    const cli = bin(dir, env, ['render', '--role', 'targeted', '--classes', 'secret', '--base', 'main', '--diff-base', mergeBase, '--out', path.join(dir, '.state/cli'), '--stack', m.stack, '--test-fw', m.test_fw, ...(staged.exclude ? ['--exclude', staged.exclude] : [])]);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toContain('sha256=' + staged.sha256);
    const row = fs.readFileSync(m.ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.event === 'rendered' && e.reader === 'targeted');
    const cliRow = fs.readFileSync(path.join(dir, '.state/cli/review-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
    for (const k of ['classes', 'rules', 'brief_sha', 'diff_base', 'patch_id', 'sha256']) expect(row[k]).toEqual(cliRow[k]);
  }, 180_000);
});

describe('a large diff (GST-507)', () => {
  // Value: protects=a pass on a results PR with thousands of files reads gstack-review-plan's whole JSON plan through the pipe and stages its readers; fails_when=either bin exits before its stdout drains, so the plan JSON arrives cut short and pass dies on JSON.parse;
  //   why_new=HARN-1 hit it on a 4,000-file receipt tree (a 1.39 MB plan); seam=none; no_claim=what reviewers read on a large diff (GST-508)
  test('a 4,000-file diff round-trips a plan JSON over 1 MB and pass stages its readers', () => {
    const { dir, env } = repo();
    const files = 4000;
    const made = spawnSync('bash', ['-c', `for d in $(seq 1 40); do p=receipts/harness-evals-lane-b-results-run-$d/per-case-receipts/skill-behavior-panel; mkdir -p $p; for i in $(seq 1 100); do echo "{\\"case\\":$i}" > $p/receipt-for-case-number-$i-trial-a.json; done; done && git add -A && git commit -qm receipts`], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
    expect(made.status, made.stderr).toBe(0);
    const plan = spawnSync(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout.length).toBeGreaterThan(1_000_000);
    expect((JSON.parse(plan.stdout) as { paths: string[] }).paths.filter(p => p.startsWith('receipts/'))).toHaveLength(files);
    const out = path.join(dir, '.state/run/p1');
    const p = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['pass', '--base', 'main', '--out', out, '--pass', 'big-p1'], { cwd: dir, env, encoding: 'utf8', timeout: 180_000 });
    expect(p.status, p.stdout + p.stderr).toBe(0);
    expect(p.stdout).toMatch(/^MANIFEST: file=.* pass=big-p1 readers=[1-9]/m);
  }, 300_000);
});

describe('Capy pass program (fake host, real bins)', () => {
  test('gstack-review-dispatch program serves the checked-in file verbatim with its sha', () => {
    const r = spawnSync(path.join(BIN, 'gstack-review-dispatch'), ['program'], { encoding: 'utf8', timeout: 30_000 });
    const [head, body] = r.stdout.split('\n');
    expect(head).toBe('PROGRAM: v1 sha256=' + promptHash(PROGRAM) + ' bytes=' + Buffer.byteLength(PROGRAM));
    expect(JSON.parse(body!)).toBe(PROGRAM);
  });

  test('one pass: specialists, then the Red Team on their collected lines; every prompt is the rendered brief; the ledger verifies clean', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env, { output: t => (t.endsWith('specialist-batched') ? 'High: src/a.ts:3 the export is untested' : 'NO FINDINGS') });
    const medium = { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'medium' };
    const res = await runPass(h, { base: 'main', out, pass: 'x1p1', planFlags: ['--depth-floor', 'full'], models: { specialist: medium, 'red-team': medium } });
    expect(h.creates.every(c => JSON.stringify(c.model) === JSON.stringify(medium))).toBe(true);
    expect(res).toContain('NEXT: judge (Phase 4)');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    const active = m.readers.filter(r => r.stage !== 'voices');
    expect(h.creates.map(c => c.title)).toEqual(active.map(r => r.title));
    expect(h.creates.at(-1)!.title).toBe('ship x1p1 red-team');
    for (const r of active) expect(h.creates.find(c => c.title === r.title)!.prompt).toBe(fs.readFileSync(r.file!, 'utf8'));
    expect(h.creates.at(-1)!.prompt).toContain('the export is untested');
    expect(active.every(r => r.state === 'collected')).toBe(true);
    const merged = fs.readFileSync(m.merged, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string; label: string });
    fs.writeFileSync(path.join(out, 'judged.jsonl'), merged.map(l => JSON.stringify({ id: l.id, severity: l.label }) + '\n').join(''));
    expect(bin(dir, env, ['judge', '--ledger', m.ledger, '--merged', m.merged, '--judged', path.join(out, 'judged.jsonl')]).status).toBe(0);
    const v = bin(dir, env, ['verify', '--ledger', m.ledger]);
    expect(v.stdout).toContain('VERIFY: clean briefs=' + active.length);
  }, 180_000);

  test('a pass past its 200 s window returns NEXT: poll and the rerun resumes without creating any reader twice', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env, { pollsToFinish: 30 });
    const first = await runPass(h, { base: 'main', out, pass: 'x2p1', planFlags: ['--depth-floor', 'full'], logStart: ['review'] });
    expect(first).toContain('NEXT: poll');
    expect(first).toMatch(/REVIEW_LOG_START: review token=\S+/);
    expect(first).toMatch(/RUNNING: specialist-batched state=created path=1/);
    const created = h.creates.length;
    let res = '';
    for (let i = 0; i < 6 && !res.includes('NEXT: judge'); i++) res = await runPass(h, { base: 'main', out, pass: 'x2p1', planFlags: ['--depth-floor', 'full'], logStart: ['review'] });
    expect(res).toContain('NEXT: judge');
    expect(res).not.toContain('REVIEW_PLAN:');
    expect(res).not.toContain('REVIEW_LOG_START:');
    expect(new Set(h.creates.map(c => c.title)).size).toBe(h.creates.length);
    expect(h.creates.length).toBe(created + 1);
  }, 240_000);

  test('a create whose result was lost is reconciled by title on resume; a create that never ran stops the pass as ambiguous', async () => {
    const { dir, env } = repo();
    let lost = true;
    const h = host(dir, env, { createThrows: t => (t.endsWith('specialist-batched') && lost ? (lost = false, 'after') : undefined) });
    const input = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x3p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, input)).toContain('STOP: pass program error: create result lost');
    expect(await runPass(h, input)).toContain('NEXT: judge');
    expect(h.creates.filter(c => c.title === 'ship x3p1 specialist-batched')).toHaveLength(1);

    const b = repo();
    const h2 = host(b.dir, b.env, { createThrows: t => (t.endsWith('specialist-batched') ? 'before' : undefined) });
    const input2 = { ...input, out: path.join(b.dir, '.state/run/p1'), pass: 'x4p1' };
    expect(await runPass(h2, input2)).toContain('create lost before it ran');
    const again = await runPass(h2, input2);
    expect(again).toContain('STOP: specialist-batched was being created when the last program ended and 0 subagents carry its title');
  }, 240_000);

  test('a failed reader stops the pass before the Red Team; a reader refused at the cap is queued and started later', async () => {
    const { dir, env } = repo();
    const h = host(dir, env, { fail: t => t.endsWith('specialist-batched') });
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x5p1', planFlags: ['--depth-floor', 'full'] });
    expect(res).toMatch(/STOP: specialist-batched \(subagent \d+\) failed/);
    expect(h.creates.some(c => c.title.endsWith('red-team'))).toBe(false);

    const b = repo();
    const h2 = host(b.dir, b.env, { reject: t => t.endsWith('specialist-batched') });
    const res2 = await runPass(h2, { base: 'main', out: path.join(b.dir, '.state/run/p1'), pass: 'x6p1', planFlags: ['--depth-floor', 'full'] });
    expect(res2).toContain('DISPATCHED: specialist-batched path=1 queued');
    expect(res2).toContain('NEXT: judge');
    expect(h2.starts).toEqual([[1]]);
  }, 240_000);

  test('Step 11 voices run from the same manifest; the outside voice needs a model of another family', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env);
    const base = { base: 'main', out, pass: 'x7p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    expect(await runPass(h, { ...base, stage: 'voices' })).toContain("STOP: the outside voice needs input.models['outside-voice']");
    expect(h.creates.some(c => c.title.startsWith('ship x7p1 ') && /adversarial|outside/.test(c.title))).toBe(false);
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.1-sol' }, 'adversarial-native': { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'high' } };
    expect(await runPass(h, { ...base, stage: 'voices', models })).toContain('NEXT: judge the voices');
    expect(h.creates.find(c => c.title === 'ship x7p1 outside-voice')!.model).toEqual(models['outside-voice']);
    expect(h.creates.find(c => c.title === 'ship x7p1 adversarial-native')!.model).toEqual(models['adversarial-native']);
  }, 240_000);

  test('an audit reader marked first settles before any specialist starts; its output is returned, never merged', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'coverage.prompt.md'), 'Run Step 7 as written.\n');
    fs.writeFileSync(path.join(out, 'extras.json'), JSON.stringify([{ name: 'coverage', prompt_file: path.join(out, 'coverage.prompt.md'), first: true, model: { model_id: 'anthropic/claude-sonnet-5-5', reasoning_mode: 'low' } }]));
    const h = host(dir, env, { output: t => (t.endsWith('audit/coverage') ? 'Coverage: 80% (one test added)' : 'NO FINDINGS') });
    const res = await runPass(h, { base: 'main', out, pass: 'x8p1', planFlags: ['--depth-floor', 'full'], extras: path.join(out, 'extras.json') });
    expect(h.creates[0]!.title).toBe('ship x8p1 audit/coverage');
    expect(h.creates[0]!.prompt).toBe(withWorkspace('Run Step 7 as written.\n', fs.realpathSync(dir)));
    expect(res).toContain('Coverage: 80% (one test added)');
    expect(fs.readFileSync(path.join(out, 'merged.jsonl'), 'utf8')).not.toContain('Coverage');
  }, 240_000);

  test('a rerun after a failed review-log start runs the start again before any reader is sent', async () => {
    const { dir, env } = repo();
    const shim = path.join(dir, '.state/shim');
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'gstack-review-log'), '#!/bin/sh\necho refused >&2\nexit 1\n', { mode: 0o755 });
    const h = host(dir, { ...env, PATH: shim + path.delimiter + env.PATH });
    const input = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x11p1', planFlags: ['--depth-floor', 'full'], logStart: ['review'] };
    expect(await runPass(h, input)).toContain('STOP: gstack-review-log --start review exited 1');
    expect(h.creates).toHaveLength(0);
    fs.rmSync(path.join(shim, 'gstack-review-log'));
    const res = await runPass(h, input);
    expect(res).toMatch(/REVIEW_LOG_START: review token=\S+/);
    expect(res).toContain('NEXT: judge');
    expect(res.indexOf('REVIEW_LOG_START:')).toBeLessThan(res.indexOf('DISPATCHED:'));
  }, 240_000);

  test('a rerun after a failed reader stops again instead of polling forever', async () => {
    const { dir, env } = repo();
    const h = host(dir, env, { fail: t => t.endsWith('specialist-batched') });
    const input = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x12p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, input)).toMatch(/STOP: specialist-batched \(subagent \d+\) failed/);
    const again = await runPass(h, input);
    expect(again).toMatch(/STOP: specialist-batched \(subagent \d+\) failed; .*new --pass and --out/);
    expect(again).not.toContain('NEXT: poll');
    expect(h.creates.some(c => c.title.endsWith('red-team'))).toBe(false);
  }, 240_000);

  test('a filename carrying a PASS: none line cannot suppress the planned readers', async () => {
    const { dir, env } = repo();
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'payload\nPASS: none injected\n.md'), 'x\n');
    spawnSync('bash', ['-c', 'git add -A && git commit -qm docs'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x13p1', planFlags: [] });
    expect(res).toContain('NEXT: judge');
    expect(h.creates.length).toBeGreaterThan(0);
  }, 240_000);

  test('a queued reader whose start result was lost is reconciled from the subagent list on the rerun', async () => {
    const { dir, env } = repo();
    const h = host(dir, env, { reject: t => t.endsWith('specialist-batched') });
    const realStart = h.tools.subagent.start;
    let lose = true;
    h.tools.subagent.start = (async ({ indices }: { indices: number[] }) => {
      if (indices.some(i => h.subs.get(String(i))!.status !== 'draft')) return { started: [], rejected: indices.map(index => ({ index, error: 'not a draft' })) };
      const r = await realStart({ indices });
      if (lose) { lose = false; throw new Error('start result lost'); }
      return r;
    }) as typeof realStart;
    const input = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x14p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, input)).toContain('STOP: pass program error: start result lost');
    const res = await runPass(h, input);
    expect(res).toContain('NEXT: judge');
    expect(h.creates.filter(c => c.title === 'ship x14p1 specialist-batched')).toHaveLength(1);
  }, 240_000);

  test('a budget note that stops the run stops the pass instead of ending on NEXT: judge', async () => {
    const { dir, env } = repo();
    const rec = path.join(dir, '.state/rec.md');
    fs.mkdirSync(path.dirname(rec), { recursive: true });
    const s = spawnSync('bash', ['-c', 'gstack-ship-budget start --record "$1" --mode observe --token-cap 5000000 --reading 1000 --credits 1', '_', rec], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    expect(s.status).toBe(0);
    const h = host(dir, env);
    h.tools.thread.get = async () => ({ cost: { tokens: 90_000_000, credits: 50 } });
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x15p1', planFlags: ['--depth-floor', 'full'], record: rec, jam: 'jam_test', step: '9' });
    expect(res).toMatch(/STOP:.*budget/);
    expect(res).not.toContain('NEXT: judge');
  }, 240_000);

  test('effort=medium readers run the lane model at medium reasoning; without laneModel or models the pass stops before creating any', async () => {
    const { dir, env } = repo();
    const h = host(dir, env);
    const base = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x11p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, { ...base, laneModel: undefined })).toMatch(/STOP: specialist\S* runs at effort=medium, which needs input.laneModel/);
    expect(h.creates).toHaveLength(0);
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const m = JSON.parse(fs.readFileSync(path.join(base.out, 'pass-manifest.json'), 'utf8')) as Manifest;
    for (const r of m.readers.filter(x => x.stage !== 'voices')) {
      const want = r.effort === 'medium' ? { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'medium' } : undefined;
      expect(h.creates.find(c => c.title === r.title)!.model).toEqual(want);
    }
    expect(m.readers.some(r => r.effort === 'medium')).toBe(true);
  }, 180_000);

  // Value: protects=the loader's input is filled as SKILL.md reads it: extras as JSON, the checkout named by cwd, and a reader whose summary lands a tick after its done status is collected, not stopped; fails_when=extras must be a file path (replay C2-34: BRIEF_RENDER_FAILED [object Object]), the bins run in the jam's directory instead of the checkout (C2-34: a wrapper launch file), or a done reader without its summary yet stops the pass (C2-34: "finished with no output", one extra call);
  //   why_new=replay C2-34 (GSTA-193) on PR 2; seam=none; no_claim=the host's status timing beyond one late summary
  test('extras as JSON, the checkout as cwd, and a late summary all run through without a STOP', async () => {
    const { dir, env } = repo();
    const elsewhere = tmp('rp-cwd-');
    const out = path.join(dir, '.state/run/p1');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'qa.prompt.md'), 'QA brief');
    const h = host(elsewhere, env, { lateSummary: true });
    const res = await runPass(h, { base: 'main', out, pass: 'x13p1', cwd: dir, planFlags: ['--depth-floor', 'full'],
      extras: [{ name: 'qa', prompt_file: path.join(out, 'qa.prompt.md'), model: { model_id: 'anthropic/claude-haiku-5-5', reasoning_mode: 'low' } }] });
    expect(res).not.toContain('STOP:');
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.find(c => c.title === 'ship x13p1 audit/qa')!.prompt).toBe(withWorkspace('QA brief', fs.realpathSync(dir)));
  }, 180_000);

  test('a plan with no reviewer pass dispatches nothing and passes NEXT through', async () => {
    const { dir, env } = repo();
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out: path.join(dir, '.state/run/p2'), pass: 'x9p2', planFlags: ['--pass', '1', '--last', 'full'] });
    expect(res).toContain('PASS: none next=');
    expect(h.creates).toHaveLength(0);
  }, 120_000);
});

describe('the Capy skill loader', () => {
  // The loader is copied from capy/skill/gstack/SKILL.md with only its placeholders filled, so a drift in either breaks here.
  test('runs the served program unchanged and the pass notes its readers in the budget', async () => {
    const skill = fs.readFileSync(path.join(ROOT, 'capy/skill/gstack/SKILL.md'), 'utf8');
    const at = skill.indexOf('one call to the checked-in pass program');
    const open = skill.indexOf('(fill only `input`): `', at) + '(fill only `input`): `'.length;
    const code = skill.slice(open, skill.indexOf('`', open));
    const { dir, env } = repo();
    const launch = path.join(dir, '.state/launch.env');
    const rec = path.join(dir, '.state/rec.md');
    fs.mkdirSync(path.dirname(launch), { recursive: true });
    fs.writeFileSync(launch, '');
    expect(spawnSync('bash', ['-c', 'gstack-ship-budget start --record "$1" --mode observe --reading 1000 --credits 1', '_', rec], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    const filled = code.split('<launch file>').join(launch).split('<base>').join('main').split('<run dir>/p<n>').join(path.join(dir, '.state/run/p1'))
      .split('<run>-p<n>').join('x10p1').split('<jam id>').join('jam_test').split('<rec>').join(rec).split('<your model id>').join('anthropic/claude-opus-5-5').split('<repo>').join(dir);
    expect(filled).not.toMatch(/<[a-z ]+>/);
    const h = host(dir, env);
    const res = await new AsyncFunction('tools', 'sleep', 'now', filled)(h.tools, h.sleep, h.now);
    expect(res.split('\n')[0]).toBe('PROGRAM: v1 sha256=' + promptHash(PROGRAM) + ' bytes=' + Buffer.byteLength(PROGRAM));
    expect(res).toMatch(/REVIEW_LOG_START: review token=\S+/);
    expect(res).toMatch(/NOTE: \S+ used=\d+ credits=\S+ readers=\d+/);
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.length).toBeGreaterThan(0);
  }, 180_000);
});


describe('a scoped pass after a blocker fix (GST-619)', () => {
  // Value: protects=the pass command accepts the scoped plan gstack-review-plan writes after a blocking fix, invoked as GEVA-2 ran it: the Red Team reviews the fix range, Step 11's voices still pending keep the whole branch, the fix-check is named outside the manifest for Step 3.5, and a resumed pass names it again; fails_when=pass refuses the scoped plan, stages the Red Team on the merge base, stages pending Step 11 voices on the range, drops the fix-check silently, or puts it in the manifest;
  //   why_new=GEVA-82 on 1.91.379.0 hit BRIEF_RENDER_FAILED on every scoped pass and rendered briefs by hand; seam=none; no_claim=the fix-check's own brief
  function scoped(flags: string[]) {
    const { dir, env } = repo();
    const sh = (c: string) => { const r = spawnSync('bash', ['-c', c], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    const mergeBase = sh('git merge-base main HEAD');
    const rangeBase = sh('git rev-parse HEAD');
    sh('for i in $(seq 1 24); do echo "export const f$i = $i;" >> src/fix.ts; done && git add -A && git commit -qm "fix: pre-landing review fixes"');
    const out = path.join(dir, '.state/run/p2');
    const extras = path.join(dir, '.state/extras.json');
    fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.state/qa.md'), 'QA the fix.\n');
    fs.writeFileSync(extras, JSON.stringify([{ name: 'qa', prompt_file: path.join(dir, '.state/qa.md') }]));
    const args = ['pass', '--base', 'main', '--out', out, '--pass', 'p2', '--extras', extras, '--', '--pass', '1', '--last', 'full', '--pass1-depth', 'standard', '--fixed-blocking', ...flags, '--range-base', rangeBase.slice(0, 7)];
    const p = bin(dir, env, args);
    expect(p.status, p.stdout + p.stderr).toBe(0);
    expect(p.stdout).toMatch(/^NEXT: scoped /m);
    expect(p.stdout).toMatch(/^FIX_CHECK: planned effort=full \(Step 3\.5 runs it on its own; not in this manifest\)$/m);
    const mf = path.join(out, 'pass-manifest.json');
    return { dir, env, args, mf, mergeBase, rangeBase, m: JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest };
  }
  const settle = (s: ReturnType<typeof scoped>, stage: string) => {
    if (stage !== 'specialists') expect(bin(s.dir, s.env, ['stage', '--manifest', s.mf, '--stage', stage]).status).toBe(0);
    const m = JSON.parse(fs.readFileSync(s.mf, 'utf8')) as Manifest;
    const reply = path.join(s.dir, '.state/reply.txt');
    fs.writeFileSync(reply, treeLine(s.dir) + 'NO FINDINGS\n');
    for (const r of m.readers.filter(x => x.stage === stage)) for (const [st, extra] of [['intent', []], ['created', ['--path', '1']], ['collected', r.reader.startsWith('audit/') ? ['--output', reply] : []]] as const) expect(bin(s.dir, s.env, ['mark', '--manifest', s.mf, '--reader', r.reader, '--state', st, ...extra]).status).toBe(0);
    return JSON.parse(fs.readFileSync(s.mf, 'utf8')) as Manifest;
  };

  test('GEVA-2\'s invocation: the Red Team reads the fix range, the pending Step 11 voices read the whole branch, and the fix-check is named outside the manifest', () => {
    const s = scoped([]);
    expect(s.m.next).toBe('scoped');
    expect(s.m.diff_base).toBe(s.mergeBase);
    expect(s.m.readers.map(r => [r.reader, r.diff_base ?? null])).toEqual([['red-team', s.rangeBase], ['adversarial-native', null], ['outside-voice', null], ['audit/qa', null]]);
    settle(s, 'specialists');
    const m = settle(s, 'red-team');
    const redTeam = fs.readFileSync(m.readers.find(r => r.reader === 'red-team')!.file!, 'utf8');
    expect(redTeam).toContain(s.rangeBase);
    expect(redTeam).not.toContain(s.mergeBase);
    expect(bin(s.dir, s.env, ['stage', '--manifest', s.mf, '--stage', 'voices']).status).toBe(0);
    const voices = JSON.parse(fs.readFileSync(s.mf, 'utf8')) as Manifest;
    expect(fs.readFileSync(voices.readers.find(r => r.reader === 'outside-voice')!.file!, 'utf8')).toContain('+export const v1 = 1;');
    const again = bin(s.dir, s.env, s.args);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^FIX_CHECK: planned effort=full /m);
    expect(again.stdout).toContain('readers=4 resumed');
  }, 120_000);

  test('after Step 11 ran (--adversarial-ran), the whole scoped pass reads the fix range', () => {
    const s = scoped(['--adversarial-ran']);
    expect(s.m.diff_base).toBe(s.rangeBase);
    expect(s.m.readers.map(r => [r.reader, r.diff_base ?? null])).toEqual([['red-team', s.rangeBase], ['adversarial-native', null], ['audit/qa', null]]);
  }, 120_000);
});

describe('readers on a shared machine review the checkout the pass ships (GST-482)', () => {
  /** The primary checkout on feat, and a worktree of it on another branch with one more commit: the GBRA-218 layout. */
  function worktree() {
    const { dir, env } = repo();
    const wt = path.join(tmp('rp-wt-'), 'wt');
    const sh = (c: string, cwd = dir) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(c + ': ' + r.stderr); return r.stdout.trim(); };
    sh(`git worktree add -q -b allow ${JSON.stringify(wt)} feat`);
    sh('for i in $(seq 1 20); do echo "export const w$i = $i;" >> src/a.ts; done && git commit -qam allow', wt);
    return { dir, env, wt: fs.realpathSync(wt) };
  }
  // Value: protects=a reader that never left the machine's default checkout cannot hand /ship a review of another tree; fails_when=collect merges a reply whose REVIEWED_TREE names the primary checkout while the pass ships a worktree, or a reply with no such line;
  //   why_new=GBRA-218: pass 1's specialist reviewed /workspace/gbrain while /ship shipped ~/.capy/work/wt-allow; seam=gstack-review-dispatch collect; no_claim=a reader that fingerprints the right checkout but reads another
  test('a reader that reviews the primary checkout instead of the worktree is refused and nothing it said is merged', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const h = host(dir, env, { reportFrom: () => dir, output: t => (t.includes('specialist') ? '[CRITICAL] (confidence: 9/10) src/other.ts:3 a file outside this PR' : cleanReply(t)) });
    const res = await runPass(h, { base: 'main', out, pass: 'w1p1', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=');
    expect(res).toContain(`reported="${treeLine(dir).slice(15).trim()}"`);
    expect(res).toMatch(/STOP: collect \S+ exited 1/);
    expect(res).not.toContain('NEXT: judge');
    expect(fs.existsSync(path.join(out, 'merged.jsonl')) ? fs.readFileSync(path.join(out, 'merged.jsonl'), 'utf8') : '').toBe('');
    const v = bin(wt, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout;
    expect(v).toMatch(/^OUTPUT \S+ NOT_REVIEWED .*wrong_tree/m);
    expect(v).toContain('VERIFY: dirty');
  }, 240_000);

  test('a reply that names no checkout is refused the same way', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const res = await runPass(host(dir, env, { reportFrom: () => '' }), { base: 'main', out, pass: 'w2p1', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=');
    expect(res).toContain('reported="none"');
    expect(res).not.toContain('NEXT: judge');
  }, 240_000);

  // Value: protects=/ship from a worktree on a shared machine works when readers follow their brief, though they start in another checkout; fails_when=a brief does not name the shipped checkout, or a correct reply is refused;
  //   why_new=GBRA-218 (no brief named a directory); seam=lib/review-pass.ts renderStage and the Capy pass program; no_claim=model compliance with the paragraph
  test('a reader that works in the checkout its brief names passes, and every brief names the worktree', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'coverage.prompt.md'), 'Run Step 7 as written.\n');
    const h = host(dir, env);
    const res = await runPass(h, { base: 'main', out, pass: 'w3p1', cwd: wt, planFlags: ['--depth-floor', 'full'],
      extras: [{ name: 'coverage', prompt_file: path.join(out, 'coverage.prompt.md'), first: true }] });
    expect(res).not.toContain('STOP:');
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.length).toBeGreaterThan(2);
    for (const c of h.creates) expect(c.prompt.endsWith('\n\n' + withWorkspaceTail(wt)), c.title).toBe(true);
    expect(bin(wt, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout).not.toContain('wrong_tree');
  }, 240_000);

  test('an audit reader that worked in the primary checkout is refused when it is collected', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'docs.prompt.md'), 'Run the Step 14.5 audit as written.\n');
    const h = host(dir, env, { reportFrom: t => (t.endsWith('audit/docs') ? dir : briefDirOf(h, t)) });
    const res = await runPass(h, { base: 'main', out, pass: 'w4p1', cwd: wt, planFlags: ['--depth-floor', 'full'],
      extras: [{ name: 'docs', prompt_file: path.join(out, 'docs.prompt.md'), first: true }] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=audit/docs');
    expect(res).not.toContain('NEXT: judge');
    expect(h.creates.map(c => c.title)).toEqual(['ship w4p1 audit/docs']);
  }, 240_000);

  test('a rerun after a wrong-tree STOP stops on the failed reader and never collects its reply twice', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const h = host(dir, env, { reportFrom: () => dir });
    const input = { base: 'main', out, pass: 'w5p1', cwd: wt, planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, input)).toContain('COLLECT_WRONG_TREE: reader=');
    const again = await runPass(h, input);
    expect(again).toMatch(/STOP: \S+ \(subagent \d+\) reviewed another tree: [0-9a-f]{40} /);
    const outputs = fs.readFileSync(path.join(out, 'review-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'output');
    expect(outputs.length).toBe(1);
  }, 240_000);

  test('a worktree at the same commit as the primary checkout is still told apart by its toplevel', async () => {
    const { dir, env } = repo();
    const wt = path.join(tmp('rp-wt-'), 'same');
    expect(spawnSync('git', ['worktree', 'add', '-q', '--detach', wt, 'feat'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    const out = path.join(wt, '.state/run/p1');
    const res = await runPass(host(dir, env, { reportFrom: () => dir }), { base: 'main', out, pass: 'w6p1', cwd: fs.realpathSync(wt), planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=');
    expect(res).not.toContain('COLLECT_TREE_MOVED');
  }, 240_000);

  test('a commit between render and reply is COLLECT_TREE_MOVED, not a pass', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    let moved = false;
    const h = host(dir, env, { reportFrom: t => {
      if (!moved) { moved = true; spawnSync('bash', ['-c', 'echo "export const late = 1;" >> src/a.ts && git commit -qam late'], { cwd: wt, env, encoding: 'utf8', timeout: 60_000 }); }
      return briefDirOf(h, t);
    } });
    const res = await runPass(h, { base: 'main', out, pass: 'w7p1', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_TREE_MOVED: reader=');
    expect(res).not.toContain('NEXT: judge');
  }, 240_000);

  test('an outside voice that reviewed another tree is recorded as unavailable coverage, never clean, and the voices still finish', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const h = host(dir, env, { reportFrom: t => (t.endsWith('outside-voice') ? dir : briefDirOf(h, t)) });
    const base = { base: 'main', out, pass: 'w8p1', cwd: wt, planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.1-sol' }, 'adversarial-native': { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'high' } };
    const res = await runPass(h, { ...base, stage: 'voices', models });
    expect(res).toContain('COLLECT_UNAVAILABLE: reader=outside-voice');
    expect(res).toContain('reviewed another tree');
    expect(res).toContain('NEXT: judge the voices');
    const v = bin(wt, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout;
    expect(v).toMatch(/^BRIEF outside-voice UNAVAILABLE /m);
  }, 240_000);
});
const withWorkspaceTail = (dir: string) => withWorkspace('', dir).slice(2);
const briefDirOf = (h: ReturnType<typeof host>, title: string) => briefDir(h.creates.find(c => c.title === title)?.prompt ?? '');
