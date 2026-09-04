import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// VAS-2660. `gstack-outside-voice exec` did not write round rows AT ALL, so every caller had to
// remember separately and most did not: 74 of 84 opencode rounds never reached the ledger, and a
// deliberate doctrine-aware invocation on 4 Sep ran two rounds, spent tokens on both, and left the
// lane holding one row — the preflight, written by hand. The cheap/frontier split this ticket
// exists to explain was being computed from a population that under-counted itself.
//
// WHY THESE TESTS STUB BOTH ENDS. The LEDGER is stubbed so the assertion is on the argv the
// adapter composes rather than on whatever lanes happen to exist on the runner — the same
// reasoning as outside-voice-phase-routing.test.ts. The BACKEND is stubbed because the paths
// under test are only reachable after a round runs, and a test that can reach a paid backend is
// a defect in the test, not a stronger assertion.

const ROOT = path.resolve(import.meta.dir, '..');
const ADAPTER = path.join(ROOT, 'bin', 'gstack-outside-voice');
const CONFIG = path.join(ROOT, 'bin', 'gstack-config');

function resolveTmpRoot(env: Record<string, string | undefined> = process.env): string {
  const candidates = [env.TMPDIR, env.TMP, path.join(ROOT, '.gstack', 'tmp')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.rmSync(fs.mkdtempSync(path.join(candidate, 'gstack-probe-')), { recursive: true, force: true });
      return candidate;
    } catch { continue; }
  }
  throw new Error('no writable temp root found (TMPDIR, TMP, .gstack/tmp all unusable)');
}

let tmp: string, repo: string, stateRoot: string, binDir: string, ledger: string, capture: string, prompt: string;

// Every ambient input neutralised, and the fixture spread AFTER process.env so it OUTRANKS the
// machine. CLAUDECODE in particular: this suite asserts caller DETECTION, and a runner that
// happens to be a Claude Code session would otherwise make half these assertions machine-dependent.
function env(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${binDir}:${process.env.PATH}`,
    GSTACK_STATE_ROOT: stateRoot,
    GSTACK_ROUND_LEDGER: ledger,
    OV_LEDGER_CAPTURE: capture,
    CODEX_API_KEY: 'test-fixture-not-a-real-key',
    OPENROUTER_API_KEY: 'test-fixture-not-a-real-key',
    GSTACK_OUTSIDE_VOICE_BASE_URL: '',
    ...extra,
  };
  delete e.CLAUDECODE;
  for (const [k, v] of Object.entries(extra)) if (v === '\0DELETE') delete e[k];
  return e;
}

function run(args: string[], extra: Record<string, string> = {}) {
  fs.writeFileSync(capture, '');
  return spawnSync(ADAPTER, args, { encoding: 'utf8', env: env(extra) });
}

// The rows the adapter WROTE, excluding the `--json` reads it makes to route and gate.
function rows(): string[] {
  return fs.readFileSync(capture, 'utf8').split('\n').filter(l => l.trim() && !l.includes('--json'));
}

function stubCodexExit(code: number) {
  fs.writeFileSync(path.join(binDir, 'codex'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(resolveTmpRoot(), 'ov-ledger-'));
  stateRoot = path.join(tmp, 'gstack-state');
  binDir = path.join(tmp, 'bin');
  capture = path.join(tmp, 'capture.txt');
  prompt = path.join(tmp, 'prompt.txt');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(prompt, 'review this\n');
  stubCodexExit(0);

  // The stub records argv verbatim and answers --json with a fresh lane, so resolve_phase routes
  // to `loop` and preflight_gate does not refuse round 1 for a missing sweep.
  ledger = path.join(binDir, 'stub-ledger.sh');
  fs.writeFileSync(ledger,
    '#!/bin/sh\n' +
    'printf "%s\\n" "$*" >> "$OV_LEDGER_CAPTURE"\n' +
    'case "$*" in *--json*) echo \'{"lane":"x","rounds_logged":0,"preflight_done":true}\';; esac\n' +
    'exit 0\n', { mode: 0o755 });

  spawnSync(CONFIG, ['set', 'outside_voice_loop', 'openrouter'],
    { encoding: 'utf8', env: env() });
  spawnSync(CONFIG, ['set', 'outside_voice_loop_model', 'minimax/minimax-m3'],
    { encoding: 'utf8', env: env() });

  // A real repo with a real diff: the adapter refuses an empty one, correctly, so a fixture
  // without a diff would make every case here fail for a reason that is not the subject.
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git('add', '-A'); git('commit', '-qm', 'seed');
  git('branch', '-f', 'origin/main', 'HEAD');
  fs.writeFileSync(path.join(repo, 'feature.js'), 'function a() { return 1 }\n');
  git('add', '-A'); git('commit', '-qm', 'feature');
});

beforeEach(() => stubCodexExit(0));
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const GATE = ['exec', '--explicit', '--gate-direct', '--phase', 'final_gate', '--codex-mode', 'review'];
const TARGET = (findings?: string) => [
  '--prompt-file', prompt, '--repo-root', repo, '--base', 'origin/main',
  ...(findings ? ['--findings-out', findings] : []),
];

describe('an undeclared --phase final_gate is refused, loudly and on the record', () => {
  test('it exits non-zero and names the bypass rather than the flag', () => {
    const r = run(['exec', '--explicit', '--phase', 'final_gate', '--codex-mode', 'review', ...TARGET()]);
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/--phase final_gate was passed without --gate-direct/);
    // The message has to say WHY, not just what: a caller reading only "flag required" learns
    // nothing about the routing decision it skipped.
    expect(`${r.stderr}`).toMatch(/bypasses --phase auto/);
    expect(`${r.stderr}`).toMatch(/--gate-direct/);
  });

  // A REFUSAL THAT ONLY EXITS NON-ZERO IS THE CREDITS-WALL FAILURE MODE WEARING A DIFFERENT HAT:
  // no findings and no row, so "refused before it started" is indistinguishable from "ran and
  // found nothing" to anyone reading the lane afterwards.
  test('it writes a round_blocked EVENT — never a round row', () => {
    run(['exec', '--explicit', '--phase', 'final_gate', '--codex-mode', 'review', ...TARGET()]);
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0]).toContain('--event round_blocked');
    expect(r[0]).toContain('cause=gate_direct_not_declared');
    // A review that never ran must not be representable as a round reporting zeroes.
    expect(r[0]).not.toContain('--voice');
    expect(r[0]).not.toMatch(/--p1\b/);
  });

  test('declaring it lets the round through', () => {
    const r = run([...GATE, ...TARGET()]);
    expect(r.status).toBe(0);
    expect(rows().join('\n')).not.toContain('round_blocked');
  });

  // The convergence branch sets phase=final_gate and re-enters _round, not cmd_exec. A guard
  // placed in _round would refuse the very gate round `auto` exists to reach.
  test('the refusal never fires on the promoted gate round', () => {
    const f = path.join(tmp, 'promote.json');
    const r = run(['exec', '--explicit', '--phase', 'auto', '--codex-mode', 'exec', ...TARGET(f)]);
    expect(`${r.stderr}`).not.toMatch(/was passed without --gate-direct/);
  });
});

describe('the round row records WHY the voice was chosen, not just which', () => {
  test('a codex gate round records severity-unknown, never zeroes', () => {
    run([...GATE, ...TARGET(path.join(tmp, 'gate.json'))]);
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0]).toContain('--voice codex');
    // The codex backend emits no structured findings block and this file deletes the findings
    // file on that path. Zeroes here would be byte-identical to a genuinely clean round, and the
    // convergence check reads exactly those numbers.
    expect(r[0]).toContain('--severity-unknown');
    expect(r[0]).not.toMatch(/--p1 0/);
  });

  test('the requested phase survives auto overwriting the resolved one', () => {
    run([...GATE, ...TARGET(path.join(tmp, 'req.json'))]);
    expect(rows()[0]).toContain('--phase-requested final_gate');
    expect(rows()[0]).toContain('--phase-resolved final_gate');
  });

  // THE QUESTION THE LEDGER COULD NOT ANSWER. Without both halves, a lane that asked for `auto`
  // and resolved to the gate is indistinguishable from a caller that hardcoded the gate — which
  // is this ticket's root cause, unreadable from its own record.
  test('an auto lane records requested=auto against the phase it resolved to', () => {
    const f = path.join(tmp, 'auto.json');
    run(['exec', '--explicit', '--phase', 'auto', '--codex-mode', 'exec', ...TARGET(f)]);
    const joined = rows().join('\n');
    // FORM-AGNOSTIC ON PURPOSE. There is no stub HTTP endpoint in this suite, so an openrouter
    // loop round fails and the provenance arrives as `--field phase_requested=auto` on a
    // round_failed EVENT rather than `--phase-requested auto` on a round row. Both are the same
    // fact honestly recorded, and pinning the assertion to one spelling would make it a test of
    // which branch happened to run rather than of whether the provenance survived at all —
    // which is the property that matters and the one that was missing before this change.
    expect(joined).toMatch(/phase[-_]requested[= ]auto/);
    expect(joined).toMatch(/phase[-_]resolved[= ](loop|final_gate)/);
  });

  test('the voice is the MODEL, not the gateway', () => {
    const f = path.join(tmp, 'voice.json');
    run(['exec', '--explicit', '--phase', 'auto', '--codex-mode', 'exec', ...TARGET(f)]);
    const joined = rows().join('\n');
    // `openrouter` is a gateway that can serve anything, so filing every round under it would
    // collapse the per-voice hit rate the ledger exists to build. The vendor prefix is stripped.
    if (joined.includes('--phase-resolved loop')) {
      expect(joined).toContain('--voice minimax-m3');
      expect(joined).not.toContain('--voice openrouter');
      expect(joined).not.toContain('minimax/minimax-m3');
    }
  });
});

describe('a round that did not complete is an EVENT, never a round row', () => {
  // rounds_logged counts COMPLETED rounds and feeds both the runaway cap and resolve_phase, so a
  // failed invocation recorded as a round would inflate the count that decides the NEXT round's
  // tier. It also must not vanish: it spent money.
  test('a failing backend records round_failed with its exit code', () => {
    stubCodexExit(7);
    const r = run([...GATE, ...TARGET(path.join(tmp, 'fail.json'))]);
    expect(r.status).toBe(7);
    const rr = rows();
    expect(rr.length).toBe(1);
    expect(rr[0]).toContain('--event round_failed');
    expect(rr[0]).toContain('cause=exit_7');
    expect(rr[0]).not.toContain('--severity-unknown');
    expect(rr[0]).not.toContain('--voice codex --p1');
  });

  test('...and it still carries the phase and caller provenance', () => {
    stubCodexExit(7);
    run([...GATE, ...TARGET(path.join(tmp, 'fail2.json'))]);
    expect(rows()[0]).toContain('phase_requested=final_gate');
    expect(rows()[0]).toContain('phase_resolved=final_gate');
    expect(rows()[0]).toMatch(/caller=\S+/);
  });
});

describe('caller detection — declared, then inherited, then honestly unknown', () => {
  test('an explicit declaration is honoured', () => {
    run([...GATE, ...TARGET()], { GSTACK_OV_CALLER: 'opencode' });
    expect(rows()[0]).toContain('--caller opencode');
  });

  test('a declaration outranks CLAUDECODE', () => {
    run([...GATE, ...TARGET()], { GSTACK_OV_CALLER: 'cron', CLAUDECODE: '1' });
    expect(rows()[0]).toContain('--caller cron');
  });

  // CLAUDECODE is an ENVIRONMENT variable, which is the property that matters: it survives into
  // the `nohup bash -c` child the loop launcher detaches. A process-tree walk does not — that
  // child is reparented to init the moment the launcher returns.
  test('CLAUDECODE identifies Claude Code', () => {
    run([...GATE, ...TARGET()], { CLAUDECODE: '1' });
    expect(rows()[0]).toContain('--caller cc');
  });

  // A DECLARATION THAT SANITISES TO NOTHING IS NOT A DECLARATION. Returning the empty string
  // emits `--caller` with no value; the ledger parses that with ${2:?} and DIES, so a caller
  // exporting punctuation would silently lose every round row on that lane — precisely the
  // invisibility this change exists to remove. Measured against the real ledger: exit 1,
  // "parameter null or not set".
  test('a caller declaration of pure punctuation falls through instead of emitting an empty value', () => {
    const r = run([...GATE, ...TARGET()], { GSTACK_OV_CALLER: '!!!', CLAUDECODE: '1' });
    expect(`${r.stderr}`).toMatch(/GSTACK_OV_CALLER held no usable characters/);
    expect(rows()[0]).toContain('--caller cc');
    expect(rows()[0]).not.toMatch(/--caller\s+--/);
    expect(rows()[0]).not.toMatch(/--caller\s*$/);
  });

  // The value lands in JSON and is grouped on later, so a stray quote or a 4KB blob would corrupt
  // the very rows it labels.
  test('a hostile caller declaration is reduced to the safe charset', () => {
    run([...GATE, ...TARGET()], { GSTACK_OV_CALLER: 'ab"; rm -rf /tmp/x; #' });
    const row = rows()[0];
    expect(row).toMatch(/--caller [A-Za-z0-9._-]+ /);
    expect(row).not.toContain('rm -rf');
    expect(row).not.toContain('"');
  });

  test('an over-long declaration is truncated rather than refused', () => {
    run([...GATE, ...TARGET()], { GSTACK_OV_CALLER: 'x'.repeat(200) });
    const m = rows()[0].match(/--caller (\S+)/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBeLessThanOrEqual(32);
  });

  test('the fallback is a real value, never an empty one', () => {
    run([...GATE, ...TARGET()]);
    expect(rows()[0]).toMatch(/--caller (cc|opencode|cron|codex|unknown)\b/);
  });

  // THE WALK'S DISCRIMINATING BRANCH, exercised through a process actually NAMED opencode rather
  // than through the declaration channel. Without this, deleting the opencode arm of the walk
  // passed every other case here — the declared-caller tests reach a different code path
  // entirely, so they look like coverage of the walk and are not.
  //
  // opencode is the harness this whole refusal exists to bring under the rule: it composes the
  // adapter command itself, at runtime, so it never sees our prompt and can only be identified
  // from the process tree until it declares itself.
  test('an opencode ancestor is identified from the process tree, with nothing declared', () => {
    const shim = path.join(binDir, 'opencode');
    // NO `exec`. exec REPLACES the shim, so the opencode-named process is gone by the time the
    // walk runs and the adapter's parent is bun again — measured: the assertion read `--caller
    // cc` and the case proved nothing. Running the adapter as a CHILD keeps the named parent in
    // the tree, which is the entire fixture. (The kernel does set comm from the script name for a
    // shebang script — verified directly — so the shim need not be a compiled binary.)
    fs.writeFileSync(shim, '#!/bin/sh\n"$@"\n', { mode: 0o755 });
    try {
      fs.writeFileSync(capture, '');
      const e = env();
      delete e.CLAUDECODE;
      delete e.GSTACK_OV_CALLER;
      const r = spawnSync(shim, [ADAPTER, ...GATE, ...TARGET()], { encoding: 'utf8', env: e });
      // Guard the fixture: a shim that failed to exec would leave an empty capture, and the
      // absence of a row must not be mistaken for a detection result.
      expect(r.status, `shim did not run: ${r.stderr}`).toBe(0);
      expect(rows().length).toBeGreaterThan(0);
      expect(rows()[0]).toContain('--caller opencode');
    } finally {
      fs.rmSync(shim, { force: true });
    }
  });

  // NEVER "cc" AS A DEFAULT — and this case had to be built rather than asserted, because it is
  // UNREACHABLE from an ordinary run of this suite. Inside a Claude Code session `claude` is a
  // genuine ancestor, so the walk finds it and the fallback never executes; a mutation replacing
  // `unknown` with `cc` passed every other test in this file. The branch that matters most is
  // the one the environment hides.
  //
  // `setsid` (without --wait) reparents the child to init, so the walk starts at pid 1, matches
  // nothing, and terminates — the only way to reach the fallback on this machine. The run is
  // detached, so completion is observed by polling the capture file rather than by exit status.
  test('a caller with no recognisable ancestor is recorded as unknown, never assumed to be cc', () => {
    fs.writeFileSync(capture, '');
    const e = env();
    delete e.CLAUDECODE;
    delete e.GSTACK_OV_CALLER;
    const inner = [ADAPTER, ...GATE, ...TARGET()].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    // --fork is load-bearing: setsid only forks when it is NOT already a process-group
    // leader, so a bare `setsid` here kept the bun -> ... -> claude chain intact and the walk
    // still found `claude`. Measured: the assertion read `--caller cc` and the case proved
    // nothing. With --fork the child is reparented to init and the walk starts at pid 1.
    spawnSync('setsid', ['--fork', 'sh', '-c', inner], { encoding: 'utf8', env: e, stdio: 'ignore' });

    const deadline = Date.now() + 20_000;
    let written = '';
    while (Date.now() < deadline) {
      written = fs.readFileSync(capture, 'utf8');
      if (written.split('\n').some(l => l.trim() && !l.includes('--json'))) break;
      spawnSync('sh', ['-c', 'sleep 0.2']);
    }
    const row = written.split('\n').find(l => l.trim() && !l.includes('--json'));
    // Guard the FIXTURE, not just the result: an empty capture would make the assertion below
    // vacuous, and "the detached run never completed" must not read as "the caller was unknown".
    expect(row, 'the detached run wrote no ledger row — the fixture failed, the assertion is meaningless').toBeDefined();
    expect(row!).toContain('--caller unknown');
  });
});

describe('a ledger that cannot be written is loud, and never fatal', () => {
  // The review already happened and was already billed, so losing the round to a ledger problem
  // would be strictly worse than losing the row. But a lane that quietly stopped recording looks
  // exactly like a lane where nothing ran, which is the defect this whole change removes.
  test('a failing ledger warns without failing the round', () => {
    fs.writeFileSync(ledger, '#!/bin/sh\ncase "$*" in *--json*) echo \'{"lane":"x","rounds_logged":0,"preflight_done":true}\'; exit 0;; esac\nexit 3\n', { mode: 0o755 });
    const r = run([...GATE, ...TARGET(path.join(tmp, 'led.json'))]);
    try {
      expect(r.status).toBe(0);
      expect(`${r.stderr}`).toMatch(/could not be recorded in the ledger/);
    } finally {
      fs.writeFileSync(ledger,
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OV_LEDGER_CAPTURE"\n' +
        'case "$*" in *--json*) echo \'{"lane":"x","rounds_logged":0,"preflight_done":true}\';; esac\nexit 0\n',
        { mode: 0o755 });
    }
  });

  // ⚠ HOME IS REDIRECTED, AND THAT IS THE WHOLE POINT OF THE SETUP. Pointing
  // GSTACK_ROUND_LEDGER at a nonexistent path is NOT enough: find_round_ledger takes the first
  // EXECUTABLE candidate, so a broken override silently falls through to the fleet ledger under
  // $HOME/Development/cfc-live — which exists on this machine, so the assertion passed for the
  // wrong reason and the note never fired. (That fall-through is pre-existing behaviour and
  // arguably wrong — a caller who NAMED a ledger gets a different one without being told — but
  // it is not this change's to alter. Recorded here so the next reader does not rediscover it.)
  // Redirecting HOME is what actually produces the no-ledger state. CODEX_API_KEY is set by the
  // fixture, so the codex probe does not need $HOME/.codex/auth.json to pass.
  test('no ledger at all says so rather than passing silently', () => {
    const r = run([...GATE, ...TARGET(path.join(tmp, 'noled.json'))],
      { GSTACK_ROUND_LEDGER: '\0DELETE', HOME: path.join(tmp, 'nohome') });
    expect(r.status).toBe(0);
    expect(`${r.stderr}`).toMatch(/no round ledger found, so this round was NOT recorded/);
  });
});
