import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const LOG = path.join(ROOT, 'bin', 'gstack-learnings-log');
const FEEDBACK = path.join(ROOT, 'bin', 'gstack-learnings-feedback');
const SEARCH = path.join(ROOT, 'bin', 'gstack-learnings-search');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-reinforce-home-'));
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-reinforce-cwd-'));
const slug = path.basename(tmpCwd).replace(/[^a-zA-Z0-9._-]/g, '');
const projDir = path.join(tmpHome, 'projects', slug);
const trusted = path.join(projDir, 'learnings.jsonl');
const candidates = path.join(projDir, 'learnings-candidates.jsonl');

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { env: { ...process.env, GSTACK_HOME: tmpHome }, cwd: tmpCwd, encoding: 'utf-8' });
}
const log = (obj: any, ...flags: string[]) => run(LOG, [JSON.stringify(obj), ...flags]);
const readJsonl = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  fs.rmSync(projDir, { recursive: true, force: true });
  fs.mkdirSync(projDir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

const OBSERVED = { skill: 'test', type: 'pitfall', key: 'k-observed', insight: 'an observed pitfall', confidence: 9, source: 'observed', files: [] };

describe('gstack-learnings-log signal-gating', () => {
  test('a reliable signal routes to the trusted store, with the signal recorded', () => {
    log(OBSERVED, '--signal', 'tests-passed');
    const rows = readJsonl(trusted);
    expect(rows.find((r) => r.key === 'k-observed')).toBeTruthy();
    expect(rows[0].signal).toBe('tests-passed');
    expect(fs.existsSync(candidates)).toBe(false);
  });

  test('no signal at all preserves historical behavior (trusted)', () => {
    log(OBSERVED); // no --signal
    expect(readJsonl(trusted).find((r) => r.key === 'k-observed')).toBeTruthy();
  });

  test('--signal none parks an AI lesson as a candidate with confidence capped to 4', () => {
    log({ ...OBSERVED, key: 'k-hunch', source: 'inferred' }, '--signal', 'none');
    expect(readJsonl(trusted).find((r) => r.key === 'k-hunch')).toBeUndefined();
    const cand = readJsonl(candidates).find((r) => r.key === 'k-hunch');
    expect(cand).toBeTruthy();
    expect(cand.confidence).toBe(4); // was 9
  });

  test('user-stated is always trusted, even with --signal none', () => {
    log({ ...OBSERVED, key: 'k-pref', type: 'preference', source: 'user-stated' }, '--signal', 'none');
    expect(readJsonl(trusted).find((r) => r.key === 'k-pref')).toBeTruthy();
  });

  test('an invalid signal is rejected (nothing written)', () => {
    let threw = false;
    try { log(OBSERVED, '--signal', 'vibes'); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(fs.existsSync(trusted)).toBe(false);
  });
});

describe('gstack-learnings-feedback + reinforced ranking', () => {
  test('helpful feedback lifts a learning above its stated confidence in search', () => {
    log(OBSERVED, '--signal', 'tests-passed');
    run(FEEDBACK, ['k-observed', 'pitfall', '--helpful', '--signal', 'tests-passed']);
    run(FEEDBACK, ['k-observed', 'pitfall', '--helpful']);
    const out = run(SEARCH, ['--limit', '10']);
    expect(out).toContain('feedback +2');
  });

  test('net-negative feedback sinks a learning and flags it for prune', () => {
    log(OBSERVED, '--signal', 'tests-passed');
    run(FEEDBACK, ['k-observed', 'pitfall', '--harmful']);
    run(FEEDBACK, ['k-observed', 'pitfall', '--harmful']);
    const out = run(SEARCH, ['--limit', '10']);
    expect(out).toContain('feedback -2');
    expect(out).toContain('PRUNE: more harmful than helpful');
  });

  test('feedback is append-only (events accumulate, learning row untouched)', () => {
    log(OBSERVED, '--signal', 'tests-passed');
    const before = fs.readFileSync(trusted, 'utf-8');
    run(FEEDBACK, ['k-observed', 'pitfall', '--helpful']);
    expect(fs.readFileSync(trusted, 'utf-8')).toBe(before); // row unchanged
    expect(fs.existsSync(path.join(projDir, 'learnings-feedback.jsonl'))).toBe(true);
  });

  test('feedback requires a key, type, and a delta', () => {
    let threw = false;
    try { run(FEEDBACK, ['k-observed', 'pitfall']); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe('gstack-learnings-search --candidates', () => {
  test('lists the gated-out pool, not the trusted store', () => {
    log(OBSERVED, '--signal', 'tests-passed'); // trusted
    log({ ...OBSERVED, key: 'k-parked', source: 'inferred' }, '--signal', 'none'); // candidate
    const out = run(SEARCH, ['--candidates', '--limit', '50']);
    expect(out).toContain('CANDIDATES:');
    expect(out).toContain('k-parked');
    expect(out).not.toContain('k-observed');
  });
});
