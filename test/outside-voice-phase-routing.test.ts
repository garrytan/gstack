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
    // OPENROUTER_API_KEY is supplied by the FIXTURE, never inherited (codex r4 P2). resolve_phase
    // probes the loop backend before returning `loop`, so on a runner without the developer's key
    // every `loop` assertion would silently get `final_gate` and the suite would pass for the
    // wrong reason on this machine and fail for the wrong reason on CI. A test that depends on an
    // ambient secret is not testing what it claims to.
    env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, ...env },
  });
  return (r.stdout ?? '').trim();
}

function setCfg(key: string, value: string) {
  spawnSync(CONFIG, ['set', key, value], {
    encoding: 'utf8',
    env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot },
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(resolveTmpRoot(), 'ov-phase-'));
  stateRoot = path.join(tmp, 'gstack-state');
  fs.mkdirSync(stateRoot, { recursive: true });
  // resolve_phase refuses to route to a loop backend that cannot emit a findings block, because
  // such a lane can never record a clean loop round and so can never promote to the gate. The
  // default is codex, so every test wanting `loop` has to configure a findings-emitting backend.
  spawnSync(CONFIG, ['set', 'outside_voice_loop', 'openrouter'], {
    encoding: 'utf8', env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot },
  });

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
  const key = spawnSync('sh', ['-c', `printf '%s|%s|%s' '${top}' '${branch}' ':' | cksum | tr -d ' \\t'`], { encoding: 'utf8' }).stdout.trim();
  return path.join(stateRoot, 'outside-voice', `last-loop-${key}`);
}
function headSha(): string {
  return spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
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
    setMarker(`clean ${headSha()}`);
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('a DIRTY loop round keeps the lane on the loop', () => {
    setMarker('dirty');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('the clean marker outranks the ledger — it works with no round count at all', () => {
    setMarker(`clean ${headSha()}`);
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
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').trim()).toBe('loop');
  });

  test('the runaway cap still bounds a lane it cannot key', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":19}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', detached], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect((r.stdout ?? '').trim()).toBe('final_gate');
  });
});

// REGRESSION (codex r1 P1). `outside_voice_loop` DEFAULTS to codex, and the codex branch of
// cmd_exec deletes the findings file by design — so a codex-backed loop round leaves no verdict
// to read, every clean round reads as "no clean loop recorded", and the lane grinds to the
// runaway cap without ever reaching the gate. On the default configuration the whole auto mode
// silently never converged. Routing there buys nothing anyway: it is a frontier round at
// frontier price wearing the loop's name.
describe('resolve-phase — a loop backend that cannot emit findings is never selected', () => {
  test('the default codex loop backend routes straight to the gate', () => {
    setMarker(null);
    setCfg('outside_voice_loop', 'codex');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
    setCfg('outside_voice_loop', 'openrouter');
  });

  test('a disabled loop backend routes to the gate rather than being enumerated optimistically', () => {
    setMarker(null);
    setCfg('outside_voice_loop', 'disabled');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
    setCfg('outside_voice_loop', 'openrouter');
  });
});

// REGRESSION (codex r2). Both of these were introduced by the r1 fixes, which is the reason
// they get their own tests rather than a comment: a fix is new code and earns the same scrutiny.
describe('resolve-phase — the size ceiling must not be bypassed by a base it cannot resolve', () => {
  test('an unresolvable base gates rather than falling through to insertions=0', () => {
    setMarker(null);
    setCfg('outside_voice_size_ceiling', '100');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo, '--base', 'origin/does-not-exist'], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect(r.status).toBe(0);
    // NOT 'loop': git failing must degrade toward the frontier reviewer, never quietly skip the
    // ceiling. The first fix here turned a loud abort into a silent bypass.
    expect((r.stdout ?? '').trim()).toBe('final_gate');
    setCfg('outside_voice_size_ceiling', '0');
  });
});

describe('exec — auto refuses without the file the mode depends on', () => {
  test('--phase auto without --findings-out fails loudly rather than never converging', () => {
    const r = spawnSync(ADAPTER, ['exec', '--phase', 'auto', '--prompt-file', __filename, '--repo-root', repo, '--explicit'], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot },
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/requires --findings-out/);
  });
});

// REGRESSION (codex r3 P2). A clean verdict is a statement about a REVISION. Keyed on branch
// alone, one clean round promoted every later round on that branch to the gate — including after
// new commits landed, which is exactly when fresh work most needs loop rounds.
describe('resolve-phase — a clean verdict expires when HEAD moves', () => {
  test('a verdict recorded against the current HEAD promotes', () => {
    setMarker(`clean ${headSha()}`);
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('a verdict recorded against a different HEAD does not', () => {
    setMarker('clean 0000000000000000000000000000000000000000');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('a bare legacy "clean" marker is not honoured', () => {
    setMarker('clean');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });
});

// REGRESSION (codex r3 P2). resolve_backend answers "which backend is named", not "can it run".
describe('resolve-phase — a named-but-unrunnable loop backend gates', () => {
  test('openrouter with no API key routes to the gate rather than dying later in probe', () => {
    setMarker(null);
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led, OPENROUTER_API_KEY: '' },
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').trim()).toBe('final_gate');
  });
});

// REGRESSION (codex r5 P1). Reached through the INTERSECTION of two earlier fixes rather than
// one bug: no ledger meant no runaway cap, and a detached HEAD meant no marker to persist a
// clean verdict — so such a lane looped forever with nothing able to promote it. Every
// `git worktree add --detach` lane on a non-fleet install was in that state.
describe('resolve-phase — a detached lane is keyable, so it can still converge', () => {
  let det: string;
  beforeAll(() => {
    det = path.join(tmp, 'det-conv');
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', '-q', det, head], { encoding: 'utf8' });
  });

  test('a clean verdict on a detached lane promotes to the gate', () => {
    const top = spawnSync('git', ['-C', det, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
    const head = spawnSync('git', ['-C', det, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const key = spawnSync('sh', ['-c', `printf '%s|detached|%s' '${top}' ':' | cksum | tr -d ' \\t'`], { encoding: 'utf8' }).stdout.trim();
    const mp = path.join(stateRoot, 'outside-voice', `last-loop-${key}`);
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, `clean ${head}`);
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', det], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: path.join(tmp, 'no-ledger') },
    });
    expect((r.stdout ?? '').trim()).toBe('final_gate');
    fs.rmSync(mp, { force: true });
  });
});

// REGRESSION (codex r5 P2). The ceiling must measure what the REVIEW measures. Scoped to the
// whole branch, a small focused slice was forced to the gate because unrelated files changed
// elsewhere — defeating the pathspec scoping the code's own comments name as the remedy.
describe('resolve-phase — the size ceiling measures the scoped diff', () => {
  test('a scoped slice under the ceiling loops even when the branch is over it', () => {
    setMarker(null);
    setCfg('outside_voice_size_ceiling', '20');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    // feature.txt is 40 lines; seed.txt is unchanged on the branch.
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo, '--pathspec', 'seed.txt'], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect((r.stdout ?? '').trim()).toBe('loop');
    setCfg('outside_voice_size_ceiling', '0');
  });
});

// REGRESSION (codex r6, found as a CLASS by the sweep the trigger demanded rather than one per
// round). Both gaps are the same shape: something the REVIEW is validated or scoped by, not
// applied to the ROUTING decision or the state it persists.
describe('resolve-phase — routing honours what the review honours', () => {
  test('an unresolvable base gates even with the ceiling OFF', () => {
    setMarker(null);
    setCfg('outside_voice_size_ceiling', '0');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo, '--base', 'origin/never-fetched'], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect((r.stdout ?? '').trim()).toBe('final_gate');
  });

  test("one scope's clean verdict does not promote a different scope", () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":2}\'\n');
    const top = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
    const branch = spawnSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
    const keyFor = (scope: string) =>
      spawnSync('sh', ['-c', `printf '%s|%s|%s' '${top}' '${branch}' '${scope}' | cksum | tr -d ' \\t'`], { encoding: 'utf8' }).stdout.trim();
    const mp = path.join(stateRoot, 'outside-voice', `last-loop-${keyFor('seed.txt:')}`);
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, `clean ${headSha()}`);
    const run = (spec: string) => spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo, '--pathspec', spec], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect((run('seed.txt').stdout ?? '').trim()).toBe('final_gate');
    // feature.txt has never had a clean pass and must not inherit seed.txt's verdict.
    expect((run('feature.txt').stdout ?? '').trim()).toBe('loop');
    fs.rmSync(mp, { force: true });
  });
});

// THE POLARITY IS THE POINT. Every degraded path must land on final_gate — the frontier
// reviewer, i.e. pre-adapter behaviour. Landing on `loop` would silently downgrade the
// reviewer, which is the mirror image of the "refusing to silently fall back to a paid
// frontier backend" rule the adapter already enforces in the other direction.
describe('resolve-phase — fallback polarity', () => {
  beforeEach(() => setMarker(null));

  // THE LEDGER GOVERNS THE CAP, NOT THE REVIEWER (codex r4 P2). An absent or broken ledger costs
  // the runaway cap and nothing else — the convergence guard still holds and the gate still
  // reviews the converged artefact, so the lane stays bounded by convergence. Gating here instead
  // made `auto` self-extinguishing on exactly the non-fleet installs this adapter avoids
  // hard-depending on: a fresh lane has no marker, so it never reached the loop, and only a loop
  // round can create the marker that would let it.
  test('an absent ledger costs the cap, not the loop — and says so', () => {
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo], {
      encoding: 'utf8',
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: path.join(tmp, 'does-not-exist'), HOME: path.join(tmp, 'no-home') },
    });
    expect((r.stdout ?? '').trim()).toBe('loop');
    expect(`${r.stderr}`).toMatch(/runaway cap is not enforced/);
  });

  test('a ledger that exits non-zero is treated the same way', () => {
    const led = stubLedger(tmp, '#!/bin/sh\nexit 1\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
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
      env: { OPENROUTER_API_KEY: 'test-fixture-not-a-real-key', ...process.env, GSTACK_STATE_ROOT: stateRoot },
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/unknown phase/i);
  });
});
