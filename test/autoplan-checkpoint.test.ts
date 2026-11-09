/**
 * Durable checkpoint (next-wave B12, integration fixes): with
 * GSTACK_AUTOPLAN_CHECKPOINT_DIR set, a run at rest publishes an immutable,
 * hash-listed generation under <dir>/<run>/generations/ and switches
 * current.json to it; journal paths are run-relative, so `resume --from`
 * restores the run on a new directory (even with the owner's plan file gone,
 * twice over), takes ownership, and the run answers, revises and exports a
 * directory `gstack-artifact validate` accepts. A checkpoint never replaces
 * or deletes the live run, never replaces a newer generation, and a failure
 * after a committed command is a warning. Restore picks the newest valid
 * generation and refuses tampered, escaping (by path or symlink), invalid or
 * overlapping input, writing nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT, SMALL_PLAN, autoplan, env, journal, readRun, resultOf, review, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-checkpoint-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const validate = (out: string) => spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-artifact'), 'validate', path.join(out, 'run.json')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const current = (collection: string) => JSON.parse(fs.readFileSync(path.join(collection, 'current.json'), 'utf8'));
const generations = (collection: string) => fs.readdirSync(path.join(collection, 'generations')).sort();

/**
 * A small run brought to gate_pending with the checkpoint env on for the last submit only, so the collection holds one
 * generation (field list 2, W7: a bound voice or a phase transition with the env on publishes one too; see
 * test/autoplan-durability.test.ts).
 */
function checkpointed(name: string): { dir: string; out: string; root: string; collection: string; run: string; e: Record<string, string> } {
  const dir = path.join(TMP, name);
  const root = path.join(dir, 'drive');
  const e = env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: root });
  const out = startSmallRun(dir);
  runPhase(out, 'ceo');
  expect(autoplan(['next', '--out', out]).status).toBe(0);
  for (const voice of ['native', 'outside'] as const) review(path.join(out, `eng-${voice}-prompt.md`));
  expect(autoplan(['submit', '--out', out, '--phase', 'eng', '--voice', 'native', '--result', resultOf(out, 'eng', 'native'), '--model', 'anthropic/claude-opus-4-7']).status).toBe(0);
  const gated = autoplan(['submit', '--out', out, '--phase', 'eng', '--voice', 'outside', '--result', resultOf(out, 'eng', 'outside'), '--model', 'openai/gpt-6-astra'], { env: e });
  expect(gated.stdout).toContain('status=gate_pending');
  const run = readRun(out).run;
  const collection = path.join(root, run);
  expect(gated.stderr).toMatch(new RegExp(`^CHECKPOINT: ${esc(path.join(collection, 'generations'))}/g\\d{6}-\\S+ status=gate_pending gate_rev=1 revision=\\d+ files=\\d+$`, 'm'));
  return { dir, out, root, collection, run, e };
}

describe('checkpoint and restore', () => {
  test('write at gate_pending, delete the run and the plan file, restore twice, answer, revise and export: validate passes', () => {
    const c = checkpointed('roundtrip');
    const [gen] = generations(c.collection);
    expect(current(c.collection)).toMatchObject({ generation: gen, run: c.run, status: 'gate_pending', gate_rev: 1 });
    const manifest = JSON.parse(fs.readFileSync(path.join(c.collection, 'generations', gen!, 'checkpoint.json'), 'utf8'));
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(['run.json', 'attempts.jsonl', 'gate.json', 'decisions.jsonl']));
    expect(Object.keys(manifest.files)).not.toContain('run.lock');
    expect(fs.readFileSync(path.join(c.collection, 'restore.md'), 'utf8')).toContain(`gstack-autoplan resume --out <new run dir> --from ${c.collection}`);
    for (const r of journal(c.out)) for (const k of ['prompt', 'result', 'staging']) if (typeof r[k] === 'string') expect(path.isAbsolute(r[k])).toBe(false);
    fs.rmSync(c.out, { recursive: true, force: true });
    fs.rmSync(path.join(c.dir, 'plan.md'));
    const first = path.join(c.dir, 'first', 'run');
    const resumed = autoplan(['resume', '--out', first, '--from', c.collection], { env: c.e });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toMatch(new RegExp(`^RESTORED: run=${c.run} from=.* status=gate_pending gate_rev=1 revision=\\d+ files=\\d+ `, 'm'));
    expect(resumed.stdout).toMatch(/^PLAN_INPUT: .*plan\.md is missing; restored the checkpoint copy to .*first\/run\/plan-input\/plan\.md$/m);
    expect(resumed.stdout).toContain(`GSTACK_RESULT: skill=autoplan status=gate_pending run=${first}`);
    expect(journal(first).find(r => r.event === 'restored')).toMatchObject({ host: os.hostname() });
    expect(resumed.stderr).toMatch(/^CHECKPOINT: .* status=gate_pending /m);
    fs.rmSync(first, { recursive: true, force: true });
    const second = path.join(c.dir, 'second', 'run');
    expect(autoplan(['resume', '--out', second, '--from', c.collection]).status).toBe(0);
    const state = readRun(second);
    expect(state.plan_input).toBe(path.join(second, 'plan-input', 'plan.md'));
    expect(state.plan_source.startsWith(second + path.sep)).toBe(true);
    expect(state.active_plan).toBe(path.join(second, 'plan-active.md'));
    const answered = autoplan(['answer', '--out', second, '--gate-rev', '1', '--reply', 'p1d', '--by', 'human'], { env: c.e });
    expect(answered.status, answered.stderr).toBe(0);
    fs.writeFileSync(state.plan_input, SMALL_PLAN.replace('Tests cover', 'Ship behind RETRY_BACKOFF=1. Tests cover'));
    const revised = autoplan(['revise', '--out', second, '--plan', state.plan_input]);
    expect(revised.status, revised.stderr).toBe(0);
    runPhase(second, 'ceo');
    runPhase(second, 'eng');
    expect(autoplan(['answer', '--out', second, '--gate-rev', '2', '--reply', 'as-is', '--by', 'human']).stdout).toContain('status=complete');
    expect(autoplan(['export', '--out', second]).status).toBe(0);
    const v = validate(second);
    expect(v.status, v.stdout + v.stderr).toBe(0);
  });

  test('`checkpoints` lists every generation; a corrupt newest is skipped for the newest valid; an interrupted publish keeps the previous current', () => {
    const c = checkpointed('generations');
    const [older] = generations(c.collection);
    const faulted = autoplan(['export', '--out', c.out], { env: { ...c.e, GSTACK_AUTOPLAN_FAULT: 'checkpoint-before-pointer' } });
    expect(faulted.status, faulted.stderr).toBe(0);
    expect(faulted.stderr).toMatch(/^CHECKPOINT: failed for .*fault injected: checkpoint interrupted before switching current\.json.*; the command's result stands, the previous checkpoint stays current$/m);
    expect(current(c.collection).generation).toBe(older);
    const newer = generations(c.collection).find(g => g !== older)!;
    const listed = autoplan(['checkpoints', '--from', c.root]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.trim().split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^CHECKPOINT: \\S+/${newer} run=${c.run} gate_rev=1 status=gate_pending revision=\\d+ at=\\S+ hash=ok$`)),
      expect.stringMatching(new RegExp(`^CHECKPOINT: \\S+/${older} run=${c.run} gate_rev=1 status=gate_pending revision=\\d+ at=\\S+ hash=ok current$`)),
    ]);
    fs.appendFileSync(path.join(c.collection, 'generations', newer, 'run', 'gate.json'), ' ');
    expect(autoplan(['checkpoints', '--from', c.collection]).stdout).toMatch(new RegExp(`${newer} .* hash=bad \\(gate\\.json does not match its sha256 in checkpoint\\.json\\)$`, 'm'));
    const target = path.join(c.dir, 'restored');
    const explicit = autoplan(['resume', '--out', target, '--from', path.join(c.collection, 'generations', newer)]);
    expect(explicit.status).toBe(3);
    expect(explicit.stderr).toMatch(/gate\.json does not match its sha256.*\(CHECKPOINT_INVALID\)/);
    expect(fs.existsSync(target)).toBe(false);
    const newest = autoplan(['resume', '--out', target, '--from', c.collection]);
    expect(newest.status, newest.stderr).toBe(0);
    expect(newest.stdout).toMatch(new RegExp(`^CHECKPOINT: skipped \\S+/${newer} \\(gate\\.json does not match`, 'm'));
    expect(newest.stdout).toMatch(new RegExp(`^RESTORED: run=${c.run} from=\\S+/${older} `, 'm'));
  });

  test('a stale copy never replaces a newer generation', () => {
    const c = checkpointed('newer');
    const stale = path.join(c.dir, 'stale');
    fs.cpSync(c.out, stale, { recursive: true });
    for (let i = 0; i < 3; i++) expect(autoplan(['export', '--out', c.out], { env: c.e }).status).toBe(0);
    const before = current(c.collection);
    const r = autoplan(['export', '--out', stale], { env: c.e });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/^CHECKPOINT: skipped .*: it holds a newer checkpoint \(revision \d+ > \d+\); nothing replaced$/m);
    expect(current(c.collection)).toEqual(before);
  });

  test('a checkpoint directory that is, contains or aliases the live run is refused before anything moves; the command still succeeds', () => {
    const c = checkpointed('overlap');
    const root = path.join(c.dir, 'root');
    fs.mkdirSync(root);
    const live = path.join(root, c.run);
    fs.renameSync(c.out, live);
    const same = autoplan(['export', '--out', live], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: root }) });
    expect(same.status, same.stderr).toBe(0);
    expect(same.stderr).toMatch(/^CHECKPOINT: failed for .*\(CHECKPOINT_OVERLAP\); the command's result stands/m);
    expect(readRun(live).run).toBe(c.run);
    const inner = autoplan(['export', '--out', live], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: path.join(live, 'ckpt') }) });
    expect(inner.stderr).toMatch(/\(CHECKPOINT_OVERLAP\)/);
    expect(fs.existsSync(path.join(live, 'ckpt'))).toBe(false);
    const aliasRoot = path.join(c.dir, 'alias');
    fs.mkdirSync(aliasRoot);
    fs.symlinkSync(live, path.join(aliasRoot, c.run));
    const alias = autoplan(['export', '--out', live], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: aliasRoot }) });
    expect(alias.stderr).toMatch(/\(CHECKPOINT_OVERLAP\)/);
    expect(readRun(live).run).toBe(c.run);
    expect(fs.existsSync(path.join(live, 'run.json'))).toBe(true);
    const restoreInto = autoplan(['resume', '--out', path.join(c.collection, 'inside'), '--from', c.collection]);
    expect(restoreInto.status).toBe(3);
    expect(restoreInto.stderr).toMatch(/\(CHECKPOINT_OVERLAP\)/);
  });

  // Value: protects=GSTACK_AUTOPLAN_CHECKPOINT_DIR set to one run's folder (its checkpoint collection, a run directory, or a
  // folder named after the run) no longer nests a second copy under <dir>/<run>; fails_when=checkpointRun joins the run
  // name onto any directory it is given; why_new=the overlap test covers only the live run's own directory; seam=none
  test('a checkpoint directory that is one run\'s folder is skipped with the folder to use, and nothing nests inside it', () => {
    const c = checkpointed('nest');
    const before = generations(c.collection);
    const inCollection = autoplan(['export', '--out', c.out], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: c.collection }) });
    expect(inCollection.status, inCollection.stderr).toBe(0);
    expect(inCollection.stderr).toContain(`CHECKPOINT: skipped ${c.collection}: it is the checkpoint folder of run ${c.run}, so a checkpoint would nest inside it; nothing written (point GSTACK_AUTOPLAN_CHECKPOINT_DIR at the checkpoints folder that holds one folder per run: ${c.root})`);
    expect(fs.existsSync(path.join(c.collection, c.run))).toBe(false);
    expect(generations(c.collection)).toEqual(before);
    const named = path.join(c.dir, 'elsewhere', c.run);
    const inNamed = autoplan(['export', '--out', c.out], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: named }) });
    expect(inNamed.stderr).toMatch(new RegExp(`^CHECKPOINT: skipped ${esc(named)}: it is named after this run \\(${esc(c.run)}\\), so a checkpoint would nest inside it; nothing written`, 'm'));
    expect(fs.existsSync(named)).toBe(false);
    const other = startSmallRun(path.join(c.dir, 'other'));
    const inRun = autoplan(['export', '--out', c.out], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: other }) });
    expect(inRun.stderr).toMatch(/^CHECKPOINT: skipped .*: it is an autoplan run directory \(it holds run\.json\), so a checkpoint would nest inside it; nothing written/m);
    expect(fs.existsSync(path.join(other, c.run))).toBe(false);
    const right = autoplan(['export', '--out', c.out], { env: env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: c.root }) });
    expect(right.stderr).toMatch(new RegExp(`^CHECKPOINT: ${esc(path.join(c.collection, 'generations'))}/g\\d{6}-`, 'm'));
  });

  test('tampered, escaping, symlink-escaping and non-validating checkpoints and a non-empty target are refused and write nothing', () => {
    const c = checkpointed('refusals');
    const gen = path.join(c.collection, 'generations', generations(c.collection)[0]!);
    const target = path.join(c.dir, 'restored');
    const refused = (pattern: RegExp, code = 'CHECKPOINT_INVALID') => {
      const r = autoplan(['resume', '--out', target, '--from', gen]);
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(new RegExp(`${pattern.source}.*\\(${code}\\)`));
      expect(fs.existsSync(target)).toBe(false);
    };
    const nonEmpty = path.join(c.dir, 'busy');
    fs.mkdirSync(nonEmpty, { recursive: true });
    fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'x');
    const busy = autoplan(['resume', '--out', nonEmpty, '--from', gen]);
    expect(busy.stderr).toMatch(/\(CHECKPOINT_TARGET_EXISTS\)/);
    expect(fs.readdirSync(nonEmpty)).toEqual(['keep.txt']);
    const manifestFile = path.join(gen, 'checkpoint.json');
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const snapDir = Object.keys(m.files).find(f => f.includes('/'))!.split('/')[0]!;
    const outsideCopy = path.join(c.dir, 'outside-copy');
    fs.cpSync(path.join(gen, 'run', snapDir), outsideCopy, { recursive: true });
    fs.rmSync(path.join(gen, 'run', snapDir), { recursive: true });
    fs.symlinkSync(outsideCopy, path.join(gen, 'run', snapDir));
    refused(/escapes the checkpoint through a symlinked directory/);
    fs.rmSync(path.join(gen, 'run', snapDir));
    fs.cpSync(outsideCopy, path.join(gen, 'run', snapDir), { recursive: true });
    fs.writeFileSync(manifestFile, JSON.stringify({ ...m, files: { ...m.files, '../../escape.md': m.files['run.json'] } }));
    refused(/escapes the checkpoint/);
    const gateFile = path.join(gen, 'run', 'gate.json');
    fs.appendFileSync(gateFile, '\n');
    fs.writeFileSync(manifestFile, JSON.stringify({ ...m, files: { ...m.files, 'gate.json': require('node:crypto').createHash('sha256').update(fs.readFileSync(gateFile)).digest('hex') } }));
    refused(/the staged run does not validate: ARTIFACT_STALE gate\.json/);
  });
});
