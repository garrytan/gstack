import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
const ROOT = path.resolve(import.meta.dir, '..');
const ADAPTER = path.join(ROOT, 'bin', 'gstack-outside-voice');
const CONFIG = path.join(ROOT, 'bin', 'gstack-config');

// Local copy rather than an import from outside-voice-config.test. Importing a *.test.ts file
// for a helper makes bun execute that file's suite a second time on every full run — 76 extra
// tests here — and a test that runs twice is a test whose failures are reported twice and
// whose state assumptions are no longer its own. Same resolution chain as bin/gstack-paths
// (TMPDIR -> TMP -> project-local .gstack/tmp), and writability is PROBED rather than assumed,
// because a directory named by $TMPDIR is a claim and an existing-but-read-only dir makes
// `mkdir -p` a no-op success.
function resolveTmpRoot(env: Record<string, string | undefined> = process.env): string {
  const candidates = [env.TMPDIR, env.TMP, path.join(ROOT, '.gstack', 'tmp')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.rmSync(fs.mkdtempSync(path.join(candidate, 'gstack-probe-')), { recursive: true, force: true });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('no writable temp root found (TMPDIR, TMP, .gstack/tmp all unusable)');
}

// The ledger is STUBBED rather than read from the machine's real one (VAS-2371). A test that
// asserted against `~/.claude/codex-rounds` would pass or fail on whatever lanes happen to
// exist on the runner, and would read as a routing bug the first time someone logged a round
// on the branch under test. The stub makes rounds_logged an input.
let tmp: string;
let repo: string;
let stateRoot: string;

function stubLedger(dir: string, body: string): string {
  const p = path.join(dir, 'stub-ledger.sh');
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

function resolvePhase(env: Record<string, string> = {}): string {
  const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo], {
    encoding: 'utf8',
    env: { ...process.env, GSTACK_STATE_ROOT: stateRoot, ...env },
  });
  return (r.stdout ?? '').trim();
}

function setCfg(key: string, value: string) {
  spawnSync(CONFIG, ['set', key, value], {
    encoding: 'utf8',
    env: { ...process.env, GSTACK_STATE_ROOT: stateRoot },
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(resolveTmpRoot(), 'ov-phase-'));
  stateRoot = path.join(tmp, 'gstack-state');
  fs.mkdirSync(stateRoot, { recursive: true });

  // A real git repo with a real branch diff, so the size axis has something to measure.
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  git('branch', '-f', 'origin/main', 'HEAD'); // a local ref named like the default base
  fs.writeFileSync(path.join(repo, 'feature.txt'), Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n');
  git('add', '-A');
  git('commit', '-qm', 'feature');
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// The lane marker is keyed on `<toplevel>|<branch>` through cksum, the same pair the skill's
// own tempfiles use. Recomputed here rather than hardcoded so a change to the keying breaks
// these tests loudly instead of leaving them asserting against a file nothing writes.
function markerPath(): string {
  const top = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const branch = spawnSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
  const key = spawnSync('sh', ['-c', `printf '%s|%s' '${top}' '${branch}' | cksum | tr -d ' \\t'`], { encoding: 'utf8' }).stdout.trim();
  return path.join(stateRoot, 'outside-voice', `last-loop-${key}`);
}
function setMarker(v: string | null) {
  const p = markerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (v === null) fs.rmSync(p, { force: true });
  else fs.writeFileSync(p, v);
}

describe('resolve-phase — loop is the default, the gate is for the converged artefact', () => {
  test('with no clean loop round recorded, routes to the loop', () => {
    setMarker(null);
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('stays on the loop deep into a lane — the round count is not the mechanism', () => {
    // The superseded design gated from round 4 onward, which sent only 14% of the rounds on
    // long lanes to the cheap tier. Round 12 of a lane must still be a loop round.
    setMarker(null);
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":11}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('a CLEAN loop round promotes the next round to the gate', () => {
    setMarker('clean');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('a DIRTY loop round keeps the lane on the loop', () => {
    setMarker('dirty');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('the clean marker outranks the ledger — it works with no round count at all', () => {
    setMarker('clean');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: path.join(tmp, 'nope'), HOME: path.join(tmp, 'no-home') })).toBe('final_gate');
  });
});

describe('resolve-phase — runaway cap', () => {
  test('a lane at the cap is forced to the gate even with no clean round', () => {
    setMarker(null);
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":19}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('defaults to 20, matching the runaway breaker rather than disagreeing with it', () => {
    setMarker(null);
    const below = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":18}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: below })).toBe('loop');
  });

  test('is configurable', () => {
    setMarker(null);
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    setCfg('outside_voice_runaway_cap', '1');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
    setCfg('outside_voice_runaway_cap', '20');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });
});

// REGRESSION (VAS-2371). A detached HEAD has no branch, so the lane cannot be keyed. Before
// this was guarded, the non-zero return from lane_marker_path killed the script under `set -e`
// and `resolve-phase` exited 1 printing NOTHING — no phase, no error. Every worktree made with
// `git worktree add --detach` hits this, including the ones this project's own study harness
// creates, so it is a live path rather than a corner case. It must degrade to `loop` (bounded
// by the runaway cap), never die and never silently reach for the frontier tier.
describe('resolve-phase — unidentifiable lane (detached HEAD)', () => {
  let detached: string;

  beforeAll(() => {
    detached = path.join(tmp, 'detached');
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', '-q', detached, head], { encoding: 'utf8' });
  });

  test('exits 0 and prints a phase rather than dying silently', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', detached], {
      encoding: 'utf8',
      env: { ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').trim()).toBe('loop');
  });

  test('the runaway cap still bounds a lane it cannot key', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":19}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', detached], {
      encoding: 'utf8',
      env: { ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect((r.stdout ?? '').trim()).toBe('final_gate');
  });
});

// THE POLARITY IS THE POINT. Every degraded path must land on final_gate — the frontier
// reviewer, i.e. pre-adapter behaviour. Landing on `loop` would silently downgrade the
// reviewer, which is the mirror image of the "refusing to silently fall back to a paid
// frontier backend" rule the adapter already enforces in the other direction.
describe('resolve-phase — fallback polarity', () => {
  beforeEach(() => setMarker(null));
  test('no ledger on the machine falls back to the gate, never the loop', () => {
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: path.join(tmp, 'does-not-exist'), HOME: path.join(tmp, 'no-home') })).toBe('final_gate');
  });

  test('a ledger that exits non-zero falls back to the gate', () => {
    const led = stubLedger(tmp, '#!/bin/sh\nexit 1\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('a ledger emitting unparseable output falls back to the gate', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho "not json at all"\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('a ledger emitting valid JSON with no rounds_logged falls back to the gate', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x"}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });
});

describe('resolve-phase — size ceiling', () => {
  beforeEach(() => setMarker(null));
  test('is OFF by default: a large diff still routes to the loop', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    setCfg('outside_voice_gate_threshold', '4');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('when set below the diff size, routes to the gate', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    setCfg('outside_voice_size_ceiling', '5');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('when set above the diff size, routes to the loop', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    setCfg('outside_voice_size_ceiling', '99999');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('a non-numeric ceiling is treated as OFF rather than crashing the routing', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    setCfg('outside_voice_size_ceiling', 'banana');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
    setCfg('outside_voice_size_ceiling', '0');
  });
});

// `--phase auto` must never reach resolve_backend unresolved: resolve_backend dies on an
// unknown phase, so an unresolved 'auto' fails LOUDLY rather than resolving to some default.
// Asserted here because the failure is the safe behaviour and a future refactor could quietly
// turn it into a fallback.
describe('unresolved phase fails loudly', () => {
  test('backend rejects the literal string auto', () => {
    const r = spawnSync(ADAPTER, ['backend', '--phase', 'auto'], {
      encoding: 'utf8',
      env: { ...process.env, GSTACK_STATE_ROOT: stateRoot },
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/unknown phase/i);
  });
});
