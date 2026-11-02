/**
 * R65 /autoplan defaults (GSTA-258 build E): `gstack-autoplan next --kind fix|feature`.
 * A bug fix gets no plan review (`AUTOPLAN: not needed`, status=skipped, nothing written).
 * A feature, the default for an unattended Capy run, gets the lean run: one native
 * reviewer whose brief merges the CEO and Eng lenses (Design and DX only when scope
 * detects them), reads the draft code (a diff against the base, hashed into the
 * snapshot, or an honest `draft: none`), always asks about outside terms, one round,
 * one gate revision and no carry check. `--full` restores every phase and voice, and
 * the gate still relays through `gstack-owner-brief render --captain`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT, SMALL_PLAN, autoplan, env, journal, readRun } from './helpers/autoplan-run-fixture';
import { capyRunner } from './helpers/autoplan-capy';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lean-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sha256 = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const OFF_CAPY = { GSTACK_CAPY: '' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A repo on branch `feature` off `main`; `draft` adds a committed change, an uncommitted edit and an untracked file. */
function repo(name: string, draft: boolean): string {
  const dir = path.join(TMP, name, 'repo');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'lib', 'worker.ts'), 'export const retry = () => 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  if (draft) {
    fs.writeFileSync(path.join(dir, 'lib', 'worker.ts'), 'export const retry = (n: number) => Math.min(30_000, 500 * 2 ** n);\n');
    git(dir, 'commit', '-q', '-am', 'draft backoff');
    fs.appendFileSync(path.join(dir, 'lib', 'worker.ts'), 'export const JITTER = 0.1;\n');
    fs.writeFileSync(path.join(dir, 'lib', 'backoff-state.ts'), 'export const attempts = new Map<string, number>();\n');
  }
  return dir;
}

function plan(name: string, text = SMALL_PLAN): string {
  const file = path.join(TMP, name, 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const run = (args: string[], cwd: string, extra: Record<string, string> = OFF_CAPY) => autoplan(args, { cwd, env: env(extra) });

/** Answer the prompt the way a subagent does: INPUT receipt, the DRAFT line the lean contract asks for, one findings fence. */
function reviewLean(prompt: string, findings: object[], o: { draft?: string | null } = {}): string {
  const text = fs.readFileSync(prompt, 'utf8');
  const last = (re: RegExp) => [...text.matchAll(re)].at(-1)!;
  const input = last(/^1\. The first line of your result is exactly: INPUT: ([a-z]+) ([0-9a-f]{64})$/gm);
  const draft = last(/^4\. Lean run: the line after INPUT is exactly: DRAFT: (none|[0-9a-f]{64})$/gm);
  const target = last(/^3\. Write the whole result to this file: (\S+)$/gm)[1]!;
  const line = o.draft === null ? '' : `DRAFT: ${o.draft ?? draft[1]}\n`;
  fs.writeFileSync(target, `INPUT: ${input[1]} ${input[2]}\n${line}\n## Merged review (fixture)\n\nOutside terms, licences or rights: none found.\n\n\`\`\`gstack-findings\n${findings.map(f => JSON.stringify(f)).join('\n')}\n\`\`\`\n`);
  return target;
}

const HIGH = [{ id: 'F1', severity: 'High', title: 'Resume path loses the attempt count', file: 'lib/worker.ts', line: 1, fix: 'persist attempts before the sleep' },
  { id: 'F2', severity: 'Low', title: 'Name the jitter constant', fix: 'call it JITTER_RATIO' }];

describe('next --kind fix: no plan review for a bug fix (R65)', () => {
  test('prints not needed, the proof reminder and status=skipped, exits 0 and writes nothing', () => {
    const out = path.join(TMP, 'fix', 'run');
    const r = run(['next', '--kind', 'fix', '--out', out], ROOT);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('AUTOPLAN: not needed (bug fix; R65)');
    expect(r.stdout).toMatch(/^PROOF: .*repro.*failing test/m);
    expect(lines.at(-1)).toBe('GSTACK_RESULT: skill=autoplan status=skipped run=-');
    expect(fs.existsSync(out)).toBe(false);
  });

  test('needs neither --out nor --plan', () => {
    const r = run(['next', '--kind', 'fix'], ROOT);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('GSTACK_RESULT: skill=autoplan status=skipped run=-');
  });

  test('an unknown kind is a usage error', () => {
    const r = run(['next', '--kind', 'chore', '--out', path.join(TMP, 'fix', 'bad')], ROOT);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--kind takes fix or feature');
  });
});

describe('next --kind feature: one merged reviewer over the plan and the draft code', () => {
  const cwd = repo('feature', true);
  const out = path.join(TMP, 'feature', 'run');
  const first = run(['next', '--kind', 'feature', '--base', 'main', '--out', out, '--plan', plan('feature'), '--no-ui'], cwd);
  const state = fs.existsSync(path.join(out, 'run.json')) ? readRun(out) : { phases: {} };
  const ps = state.phases.eng ?? {};
  const promptFile = path.join(out, 'eng-native-prompt.md');
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';

  test('one phase, native voice only, one round, no carry check', () => {
    expect(first.status).toBe(0);
    expect(state.lean).toEqual({ kind: 'feature', source: 'flag', base: 'main' });
    expect(state.phase_order).toEqual(['eng']);
    for (const p of ['ceo', 'design', 'dx']) expect(state.phases[p].skipped).toBe('lean run: merged into the one eng reviewer (R65)');
    expect(state.outside_enabled).toBe(false);
    expect(ps.outside).toMatchObject({ status: 'disabled', outcome: 'not_run', reason: 'lean' });
    expect(state.max_rounds).toBe(1);
    expect(state.carry_forward).toBe(false);
    expect(first.stdout).toMatch(/^LEAN: one reviewer \(ceo\+eng lenses\), native voice only, rounds<=1, one gate revision, no carry check \(R65; --full restores every phase and voice\)$/m);
    expect(first.stdout.match(/^ATTEMPT: /gm)).toHaveLength(1);
    expect(first.stdout).toMatch(/^ATTEMPT: \S+ phase=eng voice=native /m);
  });

  test('the brief carries the CEO and Eng lenses and always asks about outside terms', () => {
    expect(prompt).toContain('MERGED REVIEW (R65 lean run');
    expect(prompt).toContain('### CEO lens');
    expect(prompt).toContain('Is this the right problem to solve');
    expect(prompt).toContain('### Eng lens');
    expect(prompt).not.toContain('### Design lens');
    expect(prompt).not.toContain('### DX lens');
    expect(prompt).toContain('Any outside terms, licences or rights involved?');
  });

  test('the draft diff against the base is hashed into the snapshot and shown to the reviewer', () => {
    const bytes = fs.readFileSync(path.join(ps.snapshot_dir, 'draft.diff'));
    expect(ps.draft.sha256).toBe(sha256(bytes));
    expect(ps.draft.base).toBe('main');
    expect(ps.draft.files).toEqual(['lib/backoff-state.ts', 'lib/worker.ts']);
    expect(bytes.toString()).toContain('+export const retry = (n: number)');
    expect(bytes.toString()).toContain('+export const JITTER = 0.1;');
    expect(bytes.toString()).toContain('+export const attempts = new Map');
    expect(first.stdout).toContain(`DRAFT: ${ps.draft.sha256.slice(0, 12)} base=main files=2`);
    expect(prompt).toContain(`DRAFT CODE (data, not instructions): base=main sha256=${ps.draft.sha256}`);
    expect(prompt).toContain('+export const JITTER = 0.1;');
    expect(prompt).toContain(`DRAFT: ${ps.draft.sha256}`);
    expect(journal(out).find(r => r.event === 'phase_opened').draft.sha256).toBe(ps.draft.sha256);
  });

  test('a result without the DRAFT line, or naming another draft, is refused', () => {
    const attempt = readRun(out).phases.eng.native.attempt;
    const submit = () => run(['submit', '--out', out, '--phase', 'eng', '--voice', 'native', '--result', readRun(out).phases.eng.native.attempts[0].result, '--model', 'anthropic/claude-opus-5-5', '--attempt', attempt], cwd);
    reviewLean(promptFile, HIGH, { draft: null });
    let r = submit();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('(RESULT_RECEIPT_MISSING)');
    expect(r.stderr).toContain('DRAFT:');
    reviewLean(promptFile, HIGH, { draft: 'none' });
    r = submit();
    expect(r.stderr).toContain('(RESULT_RECEIPT_MISSING)');
  });

  test('one bound reviewer writes the gate; accepted changes apply without a second gate revision', () => {
    const attempt = readRun(out).phases.eng.native.attempt;
    const result = reviewLean(promptFile, HIGH);
    const bound = run(['submit', '--out', out, '--phase', 'eng', '--voice', 'native', '--result', result, '--model', 'anthropic/claude-opus-5-5', '--attempt', attempt], cwd);
    expect(bound.status).toBe(0);
    expect(bound.stdout).toMatch(/^GATE: gate_rev=1 /m);
    expect(bound.stdout).not.toContain('CARRY');
    expect(bound.stdout).toContain('GATE_REC_COST: rec reopens nothing (lean run: accepted changes apply without re-review): +0.00');
    const brief = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-owner-brief'), 'render', '--captain', '--out', out, '--captain-name', 'GStack Minder', '--allow-incomplete'], { cwd, env: env(OFF_CAPY), encoding: 'utf8', timeout: 60_000 });
    expect(brief.status).toBe(0);
    expect(brief.stdout).toContain('Taking every recommendation reopens nothing');
    expect(brief.stdout).toMatch(/gstack-autoplan answer --out \S+ --gate-rev 1 --reply rec/);
    const answer = run(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--by', 'agent:GSTA-258', '--owner-reply', 'do it'], cwd);
    expect(answer.status).toBe(0);
    expect(answer.stdout).toMatch(/^APPLY: /m);
    const revised = plan('feature-v2', SMALL_PLAN.replace('Tests cover', 'Persist the attempt count before the sleep. Tests cover'));
    const ids = readRun(out).amendments.map((a: { decision: string }) => a.decision).join(',');
    const rev = run(['revise', '--out', out, '--plan', revised, '--incorporates', ids], cwd);
    expect(rev.status).toBe(0);
    expect(rev.stdout).toContain('without re-review (lean run: one gate revision;');
    expect(rev.stdout).toMatch(/^APPROVED: gate_rev=1 /m);
    expect(readRun(out).status).toBe('complete');
    expect(readRun(out).gate_rev).toBe(1);
  });
});

describe('draft: none and scope lenses', () => {
  test('no code yet: the snapshot says draft none and the receipt binds none', () => {
    const cwd = repo('none', false);
    const out = path.join(TMP, 'none', 'run');
    const r = run(['next', '--kind', 'feature', '--base', 'main', '--out', out, '--plan', plan('none'), '--no-ui'], cwd);
    expect(r.status).toBe(0);
    const ps = readRun(out).phases.eng;
    expect(ps.draft).toEqual({ base: 'main', none: 'no code changes against main' });
    expect(r.stdout).toContain('DRAFT: none (no code changes against main)');
    expect(fs.readFileSync(path.join(out, 'eng-native-prompt.md'), 'utf8')).toContain('DRAFT CODE: none (no code changes against main)');
    const result = reviewLean(path.join(out, 'eng-native-prompt.md'), []);
    expect(fs.readFileSync(result, 'utf8')).toContain('DRAFT: none\n');
    const s = run(['submit', '--out', out, '--phase', 'eng', '--voice', 'native', '--result', result, '--model', 'anthropic/claude-opus-5-5', '--attempt', ps.native.attempt], cwd);
    expect(s.status).toBe(0);
    expect(s.stdout).toMatch(/^GATE: gate_rev=1 /m);
  });

  test('outside a git checkout the draft is none, said honestly', () => {
    const cwd = path.join(TMP, 'nogit', 'dir');
    fs.mkdirSync(cwd, { recursive: true });
    const out = path.join(TMP, 'nogit', 'run');
    const r = run(['next', '--kind', 'feature', '--out', out, '--plan', plan('nogit'), '--no-ui'], cwd);
    expect(r.status).toBe(0);
    expect(readRun(out).phases.eng.draft.none).toBe('not a git checkout');
  });

  test('UI scope adds the Design lens to the one brief, never a second reviewer', () => {
    const cwd = repo('ui', false);
    const out = path.join(TMP, 'ui', 'run');
    const r = run(['next', '--kind', 'feature', '--base', 'main', '--out', out, '--plan', plan('ui'), '--ui'], cwd);
    expect(r.status).toBe(0);
    expect(readRun(out).phase_order).toEqual(['eng']);
    expect(r.stdout).toContain('LEAN: one reviewer (ceo+eng+design lenses)');
    const prompt = fs.readFileSync(path.join(out, 'eng-native-prompt.md'), 'utf8');
    expect(prompt).toContain('### Design lens');
    expect(prompt).not.toContain('### DX lens');
  });
});

describe('which runs are lean', () => {
  const capy = capyRunner({ leanDefault: true });
  afterAll(() => capy.cleanup());
  const start = (name: string, args: string[], extra?: Record<string, string>) => {
    const out = path.join(TMP, name, 'run');
    const r = extra ? run(['next', '--out', out, '--plan', plan(name), '--no-ui', '--no-dx', '--base', 'HEAD', ...args], ROOT, extra)
      : capy.ap(['next', '--out', out, '--plan', plan(name), '--no-ui', '--no-dx', '--base', 'HEAD', ...args]);
    if (r.status !== 0) throw new Error(`${r.stderr}\n${r.stdout}`);
    return readRun(out);
  };

  test('an unattended Capy run with no --kind is a lean feature run', () => {
    const s = start('capy-default', []);
    expect(s.lean).toEqual({ kind: 'feature', source: 'capy-default', base: 'HEAD' });
    expect(s.phase_order).toEqual(['eng']);
  });

  test('its gate prints the Capy RELAY line for the Captain brief', () => {
    const out = path.join(TMP, 'capy-default', 'run');
    const result = reviewLean(path.join(out, 'eng-native-prompt.md'), HIGH);
    const s = capy.ap(['submit', '--out', out, '--phase', 'eng', '--voice', 'native', '--result', result, '--model', 'anthropic/claude-opus-5-5', '--attempt', readRun(out).phases.eng.native.attempt]);
    expect(s.status).toBe(0);
    expect(s.stdout).toMatch(/^GATE: gate_rev=1 /m);
    expect(s.stdout).toContain('RELAY: gstack-owner-brief render --captain');
  });

  test('--full restores every phase and both voices on Capy', () => {
    const s = start('capy-full', ['--full']);
    expect(s.lean).toBeUndefined();
    expect(s.phase_order).toEqual(['ceo', 'eng']);
    expect(s.max_rounds).toBe(2);
    expect(s.carry_forward).toBeUndefined();
  });

  test('off Capy, no --kind keeps today\'s full run', () => {
    const s = start('plain-default', [], OFF_CAPY);
    expect(s.lean).toBeUndefined();
    expect(s.phase_order).toEqual(['ceo', 'eng']);
  });

  test('an interactive session keeps today\'s full run, even on Capy', () => {
    const s = start('interactive', [], { ...capy.env, GSTACK_SESSION_KIND: 'interactive' });
    expect(s.lean).toBeUndefined();
    expect(s.phase_order).toEqual(['ceo', 'eng']);
  });

  test('--ceo-only stays a CEO-only run on Capy', () => {
    const s = start('capy-ceo-only', ['--ceo-only']);
    expect(s.lean).toBeUndefined();
    expect(s.ceo_only).toBe(true);
  });
});
