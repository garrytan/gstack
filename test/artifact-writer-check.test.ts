/**
 * GST-3090: `gstack-artifact validate` refuses a run.json that gstack-autoplan
 * never wrote. A day-one eval session hand-built run.json from the reference
 * fixture (no plan_input, no journal) and got ARTIFACT_VALID. A run written by
 * the CLI still validates; a tampered journal, review output or checkpoint is
 * refused.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT, autoplan, env, recCarrying, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const BIN = path.join(ROOT, 'bin', 'gstack-artifact');
const REFERENCE = path.join(ROOT, 'test', 'fixtures', 'multi-agent-wave', 'reference-run');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-writer-check-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function validate(runJson: string, extra: Record<string, string> = {}): { code: number | null; valid: boolean; codes: string[]; paths: string[] } {
  const r = spawnSync(BIN, ['validate', runJson, '--json'], { encoding: 'utf8', timeout: 60_000, env: env(extra) });
  const parsed = JSON.parse(r.stdout);
  return { code: r.status, valid: parsed.valid, codes: parsed.errors.map((e: any) => e.code), paths: parsed.errors.map((e: any) => e.path) };
}

/** One complete ceo → eng run driven only through gstack-autoplan, then exported; each test copies it. */
let built: string | undefined;
function realRun(): string {
  if (built) return built;
  const out = startSmallRun(path.join(TMP, 'built'));
  runPhase(out, 'ceo');
  runPhase(out, 'eng');
  const answer = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', recCarrying(out)]);
  if (answer.status !== 0) throw new Error(`answer failed: ${answer.stderr}\n${answer.stdout}`);
  const exported = autoplan(['export', '--out', out]);
  if (exported.status !== 0) throw new Error(`export failed: ${exported.stderr}\n${exported.stdout}`);
  return (built = out);
}
let n = 0;
function copyOf(src: string): string {
  const dir = path.join(TMP, `copy${++n}`, 'run');
  fs.cpSync(src, dir, { recursive: true });
  return dir;
}
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const editJournal = (dir: string, edit: (rows: any[]) => any[]) => {
  const file = path.join(dir, 'attempts.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  fs.writeFileSync(file, edit(rows).map(r => JSON.stringify(r)).join('\n') + '\n');
};

describe('gstack-artifact validate refuses a run gstack-autoplan never wrote', () => {
  test('the eval shape: a hand-built run.json with no plan_input and no journal is refused', () => {
    const forged = copyOf(REFERENCE);
    const v = validate(path.join(forged, 'run.json'));
    expect(v.code).toBe(1);
    expect(v.valid).toBe(false);
    expect(v.codes).toContain('ARTIFACT_NOT_AUTOPLAN_RUN');
    expect(v.paths).toContain('run.json.plan_input');
    expect(v.paths).toContain('attempts.jsonl');
  });

  test('a real run with plan_input removed, or with its journal gone, is refused', () => {
    const noInput = copyOf(realRun());
    const m = readJson(path.join(noInput, 'run.json'));
    delete m.plan_input;
    fs.writeFileSync(path.join(noInput, 'run.json'), JSON.stringify(m, null, 2) + '\n');
    const a = validate(path.join(noInput, 'run.json'));
    expect(a.codes).toEqual(['ARTIFACT_NOT_AUTOPLAN_RUN']);
    expect(a.paths).toEqual(['run.json.plan_input']);

    const noJournal = copyOf(realRun());
    fs.rmSync(path.join(noJournal, 'attempts.jsonl'));
    const b = validate(path.join(noJournal, 'run.json'));
    expect(b.codes).toEqual(['ARTIFACT_NOT_AUTOPLAN_RUN']);
    expect(b.paths).toEqual(['attempts.jsonl']);
  });

  test('control: a run written by gstack-autoplan in a temp dir validates', () => {
    const v = validate(path.join(copyOf(realRun()), 'run.json'));
    expect(v.codes).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.code).toBe(0);
  });
});

describe('the journal must match run.json', () => {
  test('a submitted row whose result hash was changed is refused', () => {
    const dir = copyOf(realRun());
    editJournal(dir, rows => rows.map(r => (r.event === 'submitted' && r.phase === 'eng' && r.voice === 'native' ? { ...r, result_sha256: 'f'.repeat(64) } : r)));
    const v = validate(path.join(dir, 'run.json'));
    expect(v.codes).toEqual(['ARTIFACT_JOURNAL_MISMATCH']);
    expect(v.paths).toEqual(['attempts.jsonl']);
  });

  test('a journal with no init row for this run, or a dispatch row that names another attempt, is refused', () => {
    const noInit = copyOf(realRun());
    editJournal(noInit, rows => rows.filter(r => r.event !== 'init'));
    expect(validate(path.join(noInit, 'run.json')).codes).toEqual(['ARTIFACT_JOURNAL_MISMATCH']);

    const renamed = copyOf(realRun());
    editJournal(renamed, rows => rows.map(r => (r.event === 'dispatched' && r.phase === 'ceo' && r.voice === 'outside' ? { ...r, attempt: `${r.attempt}x` } : r)));
    expect(validate(path.join(renamed, 'run.json')).codes).toContain('ARTIFACT_JOURNAL_MISMATCH');
  });

  test('a bound review output edited after submit is refused, even with its artifact hash rebound', () => {
    const dir = copyOf(realRun());
    const m = readJson(path.join(dir, 'run.json'));
    const output = m.phases.eng.outside.output;
    fs.chmodSync(path.join(dir, output), 0o644);
    fs.appendFileSync(path.join(dir, output), '\nNo findings.\n');
    m.artifacts[output].sha256 = createHash('sha256').update(fs.readFileSync(path.join(dir, output))).digest('hex');
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(m, null, 2) + '\n');
    const v = validate(path.join(dir, 'run.json'));
    expect(v.codes).toEqual(['ARTIFACT_JOURNAL_MISMATCH']);
    expect(v.paths).toEqual([output]);
  });
});

describe('a checkpoint must match run.json', () => {
  test('a journal rewritten after its checkpoint is refused; the untouched run validates', () => {
    const dir = copyOf(realRun());
    const checkpoints = path.join(TMP, 'checkpoints');
    const ck = { GSTACK_AUTOPLAN_CHECKPOINT_DIR: checkpoints };
    const exported = autoplan(['export', '--out', dir], { env: env(ck) });
    expect(exported.status, exported.stderr + exported.stdout).toBe(0);
    expect(exported.stderr).toMatch(/^CHECKPOINT: \S+ status=complete/m);
    expect(validate(path.join(dir, 'run.json'), ck).codes).toEqual([]);

    editJournal(dir, rows => rows.map(r => (r.event === 'plan_reality' ? { ...r, verdict: 'pass' } : r)));
    const v = validate(path.join(dir, 'run.json'), ck);
    expect(v.codes).toEqual(['ARTIFACT_JOURNAL_MISMATCH']);
    expect(v.paths[0]).toContain(checkpoints);
  });

  test('a run.json older than its own checkpoint is refused', () => {
    const dir = copyOf(realRun());
    const ck = { GSTACK_AUTOPLAN_CHECKPOINT_DIR: path.join(TMP, 'checkpoints-rollback') };
    expect(autoplan(['export', '--out', dir], { env: env(ck) }).status).toBe(0);
    const m = readJson(path.join(dir, 'run.json'));
    m.revision -= 1;
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(m, null, 2) + '\n');
    expect(validate(path.join(dir, 'run.json'), ck).codes).toEqual(['ARTIFACT_JOURNAL_MISMATCH']);
  });
});
