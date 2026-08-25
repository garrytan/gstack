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

// EVERY ambient input the loop probe reads is neutralised, not just the API key (codex r8 P3).
// The first attempt fixtured OPENROUTER_API_KEY alone and still failed 17 assertions under a
// runner carrying an invalid GSTACK_OUTSIDE_VOICE_BASE_URL: probe returned misconfigured and
// every `loop` expectation silently became `final_gate` for environment reasons. Spread AFTER
// process.env so the fixture outranks the machine rather than the machine outranking it.

const LOOP_FIXTURE_ENV = {
  OPENROUTER_API_KEY: 'test-fixture-not-a-real-key',
  GSTACK_OUTSIDE_VOICE_BASE_URL: '',
};

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
    // ambient secret is not testing what it claims to. The fixture is spread AFTER process.env
    // so it OUTRANKS an ambient value — placed before, a runner holding an empty or invalid key
    // would still win and the assertions would be machine-dependent in the other direction.
    env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot, ...env },
  });
  return (r.stdout ?? '').trim();
}

function setCfg(key: string, value: string) {
  spawnSync(CONFIG, ['set', key, value], {
    encoding: 'utf8',
    env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot },
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
    encoding: 'utf8', env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot },
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


describe('resolve-phase — loop is the default, the gate is for the converged artefact', () => {
  test('with no clean loop round recorded, routes to the loop', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

  test('stays on the loop deep into a lane — the round count is not the mechanism', () => {
    // The superseded design gated from round 4 onward, which sent only 14% of the rounds on
    // long lanes to the cheap tier. Round 12 of a lane must still be a loop round.
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":11}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });

});

describe('resolve-phase — runaway cap', () => {
  test('a lane at the cap is forced to the gate even with no clean round', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":19}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
  });

  test('defaults to 20, matching the runaway breaker rather than disagreeing with it', () => {
    const below = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":18}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: below })).toBe('loop');
  });

  test('is configurable', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    setCfg('outside_voice_runaway_cap', '1');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
    setCfg('outside_voice_runaway_cap', '20');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('loop');
  });
});

// REGRESSION (VAS-2371). Kept, and its ROOT CAUSE is now gone rather than guarded — which is
// worth saying, because the original bug no longer has a mechanism to reproduce it. A detached
// HEAD could not be KEYED, and the keying function's non-zero return killed the script under
// `set -e`, so `resolve-phase` exited 1 printing NOTHING: no phase, no error. VAS-2373 deleted
// the keying entirely, so there is nothing left to fail that way.
//
// The test stays because the PROPERTY still matters and is cheap to hold: every worktree made
// with `git worktree add --detach` takes this path, including the ones this project's own study
// harness creates. A detached lane must still route sanely and print a phase, whatever the
// mechanism underneath.
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
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').trim()).toBe('loop');
  });

  test('the runaway cap still bounds a lane it cannot key', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":19}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', detached], {
      encoding: 'utf8',
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
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
    setCfg('outside_voice_loop', 'codex');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
    setCfg('outside_voice_loop', 'openrouter');
  });

  test('a disabled loop backend routes to the gate rather than being enumerated optimistically', () => {
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
    setCfg('outside_voice_size_ceiling', '100');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo, '--base', 'origin/does-not-exist'], {
      encoding: 'utf8',
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
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
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot },
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/requires --findings-out/);
  });
});

// REGRESSION (codex r3 P2). resolve_backend answers "which backend is named", not "can it run".
describe('resolve-phase — a named-but-unrunnable loop backend gates', () => {
  test('openrouter with no API key routes to the gate rather than dying later in probe', () => {
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo], {
      encoding: 'utf8',
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led, OPENROUTER_API_KEY: '' },
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').trim()).toBe('final_gate');
  });
});

// REGRESSION (codex r5 P2). The ceiling must measure what the REVIEW measures. Scoped to the
// whole branch, a small focused slice was forced to the gate because unrelated files changed
// elsewhere — defeating the pathspec scoping the code's own comments name as the remedy.
describe('resolve-phase — the size ceiling measures the scoped diff', () => {
  test('a scoped slice under the ceiling loops even when the branch is over it', () => {
    setCfg('outside_voice_size_ceiling', '20');
    const led = stubLedger(tmp, '#!/bin/sh\necho \'{"lane":"x","rounds_logged":0}\'\n');
    // feature.txt is 40 lines; seed.txt is unchanged on the branch.
    expect(resolvePhase({ GSTACK_ROUND_LEDGER: led })).toBe('final_gate');
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo, '--pathspec', 'seed.txt'], {
      encoding: 'utf8',
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: led },
    });
    expect((r.stdout ?? '').trim()).toBe('loop');
    setCfg('outside_voice_size_ceiling', '0');
  });
});

describe('exec — a disabled install no-ops rather than erroring on auto', () => {
  // ITS OWN STATE ROOT, not a set-then-restore on the shared one. The first version toggled
  // codex_reviews on `stateRoot` and restored it afterwards, which made every other test in the
  // file order-dependent on that restore — and it flaked exactly once before being caught. A
  // test that mutates shared state and puts it back is a race with a cleanup step, not isolation.
  test('codex_reviews=disabled short-circuits before the findings-out requirement', () => {
    const ownRoot = fs.mkdtempSync(path.join(tmp, 'disabled-state-'));
    spawnSync(CONFIG, ['set', 'codex_reviews', 'disabled'], {
      encoding: 'utf8', env: { ...process.env, GSTACK_STATE_ROOT: ownRoot },
    });
    const r = spawnSync(ADAPTER, ['exec', '--phase', 'auto', '--prompt-file', __filename, '--repo-root', repo], {
      encoding: 'utf8',
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: ownRoot },
    });
    expect(r.status).toBe(3);
    expect(`${r.stderr}`).toMatch(/OUTSIDE_VOICE_DISABLED/);
    expect(`${r.stderr}`).not.toMatch(/requires --findings-out/);
  });
});

// REGRESSION (codex r10 P2).
// REGRESSION — closes the VAS-2371 r13 P2 AT THE CHOKEPOINT.
//
// The refusal used to live in the `auto` branch alone, so an EXPLICIT `--phase loop` or
// `--phase final_gate` with --repo-context none still ran a round that reviewed nothing and
// reported success. It has now been placed three times one call site at a time — auto at r10,
// resolve-phase at r12, explicit exec still open at r13 — which is the pattern, not the fix.
//
// EVERY PHASE IS ASSERTED, not just the one a round happened to report. A guard that covers the
// reported call site and not its siblings is the defect this closes, so a test that checked only
// `auto` would be the same mistake in test form.
describe('exec — --repo-context none is refused for every openrouter-backed phase', () => {
  // BOTH phases are pointed at openrouter on a state root of this test's own. On the SHARED
  // root the gate is codex, and codex ignores --repo-context entirely — so `--phase final_gate`
  // would fall past the guard (correctly) and start a REAL, BILLED codex round against the
  // fixture repo. It did exactly that once while this test was being written. A test that can
  // reach a paid backend is a defect in the test, not a stronger assertion.
  //
  // The refusal fires immediately after the backend is resolved and before any probe or
  // dispatch, so none of these cases touches the network at all.
  let orRoot: string;
  beforeAll(() => { orRoot = freshStateRoot('openrouter', ''); });

  for (const phase of ['auto', 'loop', 'final_gate']) {
    test(`--phase ${phase} with --repo-context none is refused`, () => {
      const r = spawnSync(ADAPTER, ['exec', '--phase', phase, '--prompt-file', __filename,
        '--repo-root', repo, '--repo-context', 'none', '--findings-out', path.join(tmp, 'f.json'), '--explicit'], {
        encoding: 'utf8',
        env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: orRoot },
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stderr}`).toMatch(/--repo-context none cannot be used with the openrouter backend/);
    });
  }
});

// REGRESSION (codex r10 P2). The pre-flight sweep gate was scoped to `loop` back when only the
// loop could start a lane. `auto` can send a FRESH lane straight to the gate, and that round is
// still the lane's round 1.
describe('exec — an auto-resolved round is pre-flight gated whichever phase it lands on', () => {
  test('a fresh auto lane routed to final_gate still requires the sweep', () => {
    const led = path.join(tmp, 'fresh-ledger');
    const r = spawnSync(ADAPTER, ['exec', '--phase', 'auto', '--prompt-file', __filename,
      '--repo-root', repo, '--findings-out', path.join(tmp, 'g.json'), '--explicit'], {
      encoding: 'utf8',
      // No OpenRouter key -> the loop is unrunnable -> auto resolves to final_gate on a lane
      // that has never recorded a sweep.
      env: { ...process.env, ...LOOP_FIXTURE_ENV, OPENROUTER_API_KEY: '', GSTACK_STATE_ROOT: stateRoot, CODEX_ROUND_DIR: led },
    });
    expect(`${r.stderr}`).toMatch(/pre-flight|sweep/i);
  });
});

// THE POLARITY IS THE POINT. Every degraded path must land on final_gate — the frontier
// reviewer, i.e. pre-adapter behaviour. Landing on `loop` would silently downgrade the
// reviewer, which is the mirror image of the "refusing to silently fall back to a paid
// frontier backend" rule the adapter already enforces in the other direction.
describe('resolve-phase — fallback polarity', () => {

  // THE LEDGER GOVERNS THE CAP, NOT THE REVIEWER (codex r4 P2). An absent or broken ledger costs
  // the runaway cap and nothing else — the convergence guard still holds and the gate still
  // reviews the converged artefact, so the lane stays bounded by convergence. Gating here instead
  // made `auto` self-extinguishing on exactly the non-fleet installs this adapter avoids
  // hard-depending on: a fresh lane has no marker, so it never reached the loop, and only a loop
  // round can create the marker that would let it.
  test('an absent ledger costs the cap, not the loop — and says so', () => {
    const r = spawnSync(ADAPTER, ['resolve-phase', '--repo-root', repo], {
      encoding: 'utf8',
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot, GSTACK_ROUND_LEDGER: path.join(tmp, 'does-not-exist'), HOME: path.join(tmp, 'no-home') },
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
      env: { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: stateRoot },
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/unknown phase/i);
  });
});

// ===========================================================================================
// CONVERGENCE HAPPENS IN THIS INVOCATION (VAS-2373, Fork A reading (c2))
//
// These are the tests the redesign is FOR, and they replace every test that asserted the marker
// key carried some input. There is no marker and no key, so those tests have no subject; these
// assert the property that replaced them — one `exec --phase auto` call runs the loop, reads the
// findings file IT JUST WROTE, and runs the gate itself when that round reported nothing.
//
// They drive the REAL request layer against a loopback stub rather than mocking the adapter's
// own functions. GSTACK_OUTSIDE_VOICE_BASE_URL is an existing, documented seam (https, or http
// on loopback for exactly this purpose), so the code under test is the shipped path — including
// the findings-block contract and its per-request nonce, which the stub has to honour by
// echoing the fence back. A stub that invented its own fence would be ignored by the parser and
// the round would read as failed, so this also pins the contract end to end.
//
// EACH TEST BUILDS ITS OWN STATE ROOT. Toggling `outside_voice_gate` on the shared one and
// restoring it afterwards is a race with a cleanup step rather than isolation — that flaked
// once already on this branch (r9) and was fixed the same way.
// ===========================================================================================

function startStubBackend() {
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      // The request layer HEADs the endpoint to detect a redirecting gateway before it will
      // send the key. Answer it plainly, or every round dies before it starts.
      if (req.method === 'HEAD') return new Response(null, { status: 200 });
      posts += 1;
      const body = await req.text();
      // COPY THE FENCE BACK CHARACTER FOR CHARACTER. It is a per-request nonce and a block
      // under any other fence is ignored entirely — which the parser reports as a failed
      // review, never as a clean one. Echoing it is what makes this stub a valid reviewer.
      const m = body.match(/findings-json-[0-9a-f]+/);
      const fence = m ? m[0] : 'findings-json-missing';
      const content = '```' + fence + '\n' + JSON.stringify(STUB_VERDICT) + '\n```\n\nStub review.';
      return Response.json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/v1`, posts: () => posts };
}

// Mutable so a test can choose what the stub reviewer "finds" without a second server.
let STUB_VERDICT: Record<string, unknown> = { p1: 0, p2: 0, p3: 0, findings: [] };

function freshStateRoot(gate: string, base: string): string {
  const sr = fs.mkdtempSync(path.join(tmp, 'sr-'));
  const env = { ...process.env, ...LOOP_FIXTURE_ENV, GSTACK_STATE_ROOT: sr };
  spawnSync(CONFIG, ['set', 'outside_voice_loop', 'openrouter'], { encoding: 'utf8', env });
  spawnSync(CONFIG, ['set', 'outside_voice_gate', gate], { encoding: 'utf8', env });
  spawnSync(CONFIG, ['set', 'outside_voice_loop_model', 'stub/stub-model'], { encoding: 'utf8', env });
  return sr;
}

// Bun.spawn (ASYNC), never spawnSync — and this is not a style preference. spawnSync BLOCKS the
// Bun event loop, so a Bun.serve stub cannot respond while it is waiting: every request hits the
// adapter's own timeout instead of round-tripping, and the test reads as "the backend was never
// called" when in fact the server was never allowed to answer. This repo already documents it in
// test/gbrain-supabase-provision.test.ts; it cost one run here before that note was found.
async function runAuto(sr: string, baseUrl: string, findings: string) {
  const proc = Bun.spawn([ADAPTER, 'exec', '--phase', 'auto', '--prompt-file', __filename,
    '--repo-root', repo, '--findings-out', findings, '--explicit', '--timeout', '30'], {
    env: {
      ...process.env, ...LOOP_FIXTURE_ENV,
      GSTACK_STATE_ROOT: sr,
      GSTACK_OUTSIDE_VOICE_BASE_URL: baseUrl,
      // A STUBBED ledger reporting the sweep as done. Pointing this at a nonexistent path does
      // NOT disable the gate — find_round_ledger falls back to a search path and finds the real
      // fleet tool on a developer machine, so the round dies at the pre-flight gate with exit 5
      // and the test reads as "the backend was never called". rounds_logged stays 0 so the
      // runaway cap is not what any of these tests are measuring.
      GSTACK_ROUND_LEDGER: stubLedger(fs.mkdtempSync(path.join(tmp, 'led-')),
        '#!/bin/sh\necho \'{"lane":"stub","rounds_logged":0,"preflight_done":true}\'\n'),
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stderr, status] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, status };
}

describe('exec --phase auto — the gate runs in THIS invocation when the loop converges', () => {
  test('a clean loop round is followed by a gate round, in one call', async () => {
    STUB_VERDICT = { p1: 0, p2: 0, p3: 0, findings: [] };
    const stub = startStubBackend();
    try {
      const sr = freshStateRoot('openrouter', stub.url);
      const r = await runAuto(sr, stub.url, path.join(tmp, 'conv-clean.json'));
      // TWO backend calls from ONE invocation is the whole property. One would mean the loop
      // ran and the lane was left to remember its verdict for next time — which is the design
      // that produced seven findings.
      expect(stub.posts()).toBe(2);
      expect(`${r.stderr}`).toMatch(/running the final_gate round now, in this same invocation/);
      expect(r.status).toBe(0);
    } finally { stub.server.stop(true); }
  }, 30000);

  test('a loop round WITH findings does not run the gate', async () => {
    STUB_VERDICT = { p1: 0, p2: 1, p3: 0, findings: [{ severity: 'P2', title: 'x', location: 'a.ts:1' }] };
    const stub = startStubBackend();
    try {
      const sr = freshStateRoot('openrouter', stub.url);
      await runAuto(sr, stub.url, path.join(tmp, 'conv-dirty.json'));
      // Exactly one call: the lane has not converged, so the gate is not owed a round.
      expect(stub.posts()).toBe(1);
    } finally { stub.server.stop(true); }
  }, 30000);
});

// REGRESSION — closes the VAS-2371 r13 P1 BY THE DESIGN, not by a guard at bin/gstack-outside-voice:608.
//
// The superseded code fell back to `loop` when a converged lane met an unavailable gate, calling
// that the recoverable side. It removed a permanent dead end and installed a permanent TREADMILL:
// the same unchanged artefact reviewed again on every invocation, the same verdict written again,
// no forward progress and no signal, until the runaway cap. Both are one missing idea — a
// two-state machine has to spell "cannot proceed" as one of its two PRODUCTIVE states.
describe('exec --phase auto — a converged lane with an unavailable gate is BLOCKED, not looped', () => {
  test('exits 6, says why, and does NOT run a second loop round', async () => {
    STUB_VERDICT = { p1: 0, p2: 0, p3: 0, findings: [] };
    const stub = startStubBackend();
    try {
      const sr = freshStateRoot('disabled', stub.url);
      const r = await runAuto(sr, stub.url, path.join(tmp, 'conv-blocked.json'));
      expect(r.status).toBe(6);
      expect(`${r.stderr}`).toMatch(/BLOCKED/);
      // The one behaviour the r13 P1 was about: it must not silently become another loop round.
      expect(stub.posts()).toBe(1);
      // And the remediation must name the actual cause rather than a generic config hint.
      expect(`${r.stderr}`).toMatch(/switched OFF/);
    } finally { stub.server.stop(true); }
  }, 30000);
});
