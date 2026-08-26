import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin/gstack-codex-probe');

// Run a bash snippet that sources the probe and evaluates one of its functions.
// Controlled env + optional tempdir for HOME isolation.
function runProbe(opts: {
  snippet: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {
    // Start from a clean env so test-env vars from the parent don't leak in.
    PATH: process.env.PATH ?? '',
    _TEL: 'off',
  };
  if (opts.home) env.HOME = opts.home;
  // Apply overrides; undefined means "remove".
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) {
        delete env[k];
      } else {
        env[k] = v;
      }
    }
  }
  const script = `set +e\nsource "${PROBE}"\n${opts.snippet}\n`;
  const result = spawnSync('bash', ['-c', script], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    status: result.status ?? -1,
  };
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-probe-home-'));
}

describe('gstack-codex-probe: auth probe', () => {
  test('CODEX_API_KEY set → AUTH_OK', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: '_gstack_codex_auth_probe',
        env: { CODEX_API_KEY: 'sk-test' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('OPENAI_API_KEY set → AUTH_OK', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: '_gstack_codex_auth_probe',
        env: { OPENAI_API_KEY: 'sk-openai' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('${CODEX_HOME:-~/.codex}/auth.json exists → AUTH_OK', () => {
    const home = tempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
      const r = runProbe({ snippet: '_gstack_codex_auth_probe', home });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('no env + no file → AUTH_FAILED with exit 1', () => {
    const home = tempHome();
    try {
      const r = runProbe({ snippet: '_gstack_codex_auth_probe', home });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('both CODEX_API_KEY and OPENAI_API_KEY set → AUTH_OK', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: '_gstack_codex_auth_probe',
        env: { CODEX_API_KEY: 'k1', OPENAI_API_KEY: 'k2' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('empty-string env vars + no file → AUTH_FAILED', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: '_gstack_codex_auth_probe',
        env: { CODEX_API_KEY: '', OPENAI_API_KEY: '' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('whitespace-only env vars + no file → AUTH_FAILED', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: '_gstack_codex_auth_probe',
        env: { CODEX_API_KEY: '   ', OPENAI_API_KEY: '\t\n' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('alternate $CODEX_HOME → checks the alternate path', () => {
    const home = tempHome();
    const altCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alt-codex-'));
    try {
      fs.writeFileSync(path.join(altCodex, 'auth.json'), '{}');
      const r = runProbe({
        snippet: '_gstack_codex_auth_probe',
        env: { CODEX_HOME: altCodex },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(altCodex, { recursive: true, force: true });
    }
  });
});

// --- Group 2: Version check -------------------------------------------------
// Stub `codex --version` by putting a fake `codex` executable on PATH.
function tempStubCodex(versionOutput: string, bool_command_fails = false): {
  dir: string;
  pathEntry: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-stub-'));
  const bin = path.join(dir, 'codex');
  const script = bool_command_fails
    ? '#!/bin/bash\nexit 1\n'
    : `#!/bin/bash\nif [ "$1" = "--version" ]; then printf '%s' ${JSON.stringify(versionOutput)}; fi\n`;
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { dir, pathEntry: dir };
}

function runVersionCheck(versionOutput: string): string {
  const stub = tempStubCodex(versionOutput);
  try {
    const r = runProbe({
      snippet: '_gstack_codex_version_check',
      env: { PATH: `${stub.pathEntry}:${process.env.PATH}` },
    });
    return r.stdout + r.stderr;
  } finally {
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
}

describe('gstack-codex-probe: version check (anchored regex per Tension I)', () => {
  // Matches (should WARN)
  test('codex-cli 0.120.0 → WARN', () => {
    const out = runVersionCheck('codex-cli 0.120.0\n');
    expect(out).toContain('WARN:');
    expect(out).toContain('0.120.0');
  });

  test('codex-cli 0.120.1 → WARN', () => {
    const out = runVersionCheck('codex-cli 0.120.1\n');
    expect(out).toContain('WARN:');
  });

  test('codex-cli 0.120.2 → WARN', () => {
    const out = runVersionCheck('codex-cli 0.120.2\n');
    expect(out).toContain('WARN:');
  });

  // Does NOT match (should be silent)
  test('codex-cli 0.116.0 → OK (no warn)', () => {
    const out = runVersionCheck('codex-cli 0.116.0\n');
    expect(out).not.toContain('WARN:');
  });

  test('codex-cli 0.121.0 → OK (no warn)', () => {
    const out = runVersionCheck('codex-cli 0.121.0\n');
    expect(out).not.toContain('WARN:');
  });

  test('codex-cli 0.120.10 → OK (anchored regex prevents substring match)', () => {
    const out = runVersionCheck('codex-cli 0.120.10\n');
    expect(out).not.toContain('WARN:');
  });

  test('codex-cli 0.120.20 → OK (anchored regex prevents substring match)', () => {
    const out = runVersionCheck('codex-cli 0.120.20\n');
    expect(out).not.toContain('WARN:');
  });

  test('codex-cli 0.120.2-beta → WARN (still a bad release family)', () => {
    // 0.120.2-beta: regex (^|[^0-9.])0\.120\.(0|1|2)([^0-9.]|$) treats '-' as a
    // non-digit/non-dot boundary → matches.
    const out = runVersionCheck('codex-cli 0.120.2-beta\n');
    expect(out).toContain('WARN:');
  });

  test('empty output → OK (silent, no crash)', () => {
    const out = runVersionCheck('');
    expect(out).not.toContain('WARN:');
  });

  test('v-prefixed and multiline handled', () => {
    const out = runVersionCheck('codex-cli v0.116.0\nsome debug line\n');
    expect(out).not.toContain('WARN:');
  });
});

// --- Group 3: Timeout wrapper + namespace hygiene ---------------------------

describe('gstack-codex-probe: timeout wrapper + namespace hygiene', () => {
  test('bin/gstack-codex-probe is syntactically valid bash (bash -n)', () => {
    const result = spawnSync('bash', ['-n', PROBE], { timeout: 5000 });
    expect(result.status).toBe(0);
  });

  test('timeout wrapper executes command directly when neither binary present', () => {
    // Clear PATH to simulate no timeout/gtimeout. Use only /bin for `echo`.
    const r = runProbe({
      snippet: `_gstack_codex_timeout_wrapper 5 echo hello_world`,
      env: { PATH: '/bin:/usr/bin' }, // these usually lack gtimeout; timeout may exist on linux
    });
    // Regardless of whether timeout is on this PATH, echo hello_world should succeed.
    expect(r.stdout.trim()).toBe('hello_world');
  });

  test('timeout wrapper resolves gtimeout preferentially when on PATH', () => {
    // Create a stub gtimeout that prints a sentinel so we can verify it was chosen.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gto-stub-'));
    try {
      const stub = path.join(dir, 'gtimeout');
      fs.writeFileSync(stub, '#!/bin/bash\necho gtimeout_chosen_$1\n');
      fs.chmodSync(stub, 0o755);
      const r = runProbe({
        snippet: `_gstack_codex_timeout_wrapper 5 echo nope`,
        env: { PATH: `${dir}:/bin:/usr/bin` },
      });
      expect(r.stdout.trim()).toBe('gtimeout_chosen_5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bash-native watchdog kills a hung command at the deadline (exit 124, no timeout binary)', () => {
    // Stock macOS ships neither gtimeout nor timeout(1) — the old fallback ran
    // the command unwrapped, so a hung `codex exec` blocked the calling
    // workflow forever. Force the fallback everywhere (Linux /bin has timeout
    // via usrmerge) with a PATH holding ONLY bash and sleep, then prove a
    // 30s sleep dies at the 1s deadline with timeout(1)'s exit code. The
    // runProbe 5s spawnSync cap doubles as the "actually killed fast" bound.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-watchdog-'));
    try {
      const which = (tool: string) =>
        spawnSync('bash', ['-c', `command -v ${tool}`]).stdout.toString().trim() || `/bin/${tool}`;
      fs.symlinkSync(which('bash'), path.join(dir, 'bash'));
      fs.symlinkSync(which('sleep'), path.join(dir, 'sleep'));
      const r = runProbe({
        snippet: `_gstack_codex_timeout_wrapper 1 sleep 30; echo "rc=$?"`,
        env: { PATH: dir },
      });
      expect(r.stdout).toContain('rc=124');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sourcing probe does NOT set errexit/trap/IFS in caller shell (namespace hygiene)', () => {
    // Capture `set -o` output before and after sourcing. Any drift means the
    // probe polluted the caller.
    const r = runProbe({
      snippet: `
BEFORE=$(set -o | sort)
source "${PROBE}"   # source again to catch accumulation
AFTER=$(set -o | sort)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "CLEAN"
else
  echo "POLLUTED"
  diff <(echo "$BEFORE") <(echo "$AFTER")
fi
`,
    });
    expect(r.stdout).toContain('CLEAN');
  });
});

// --- Group 4: Telemetry event emission --------------------------------------

describe('gstack-codex-probe: telemetry event emission', () => {
  test('_gstack_codex_log_event writes jsonl when _TEL != off', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: `_gstack_codex_log_event "codex_test_event" "42"; cat "$HOME/.gstack/analytics/skill-usage.jsonl"`,
        env: { _TEL: 'community' },
        home,
      });
      expect(r.stdout).toContain('"event":"codex_test_event"');
      expect(r.stdout).toContain('"duration_s":"42"');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('_gstack_codex_log_event skips write when _TEL = off', () => {
    const home = tempHome();
    try {
      runProbe({
        snippet: `_gstack_codex_log_event "codex_test_event" "99"`,
        env: { _TEL: 'off' },
        home,
      });
      const jsonl = path.join(home, '.gstack/analytics/skill-usage.jsonl');
      expect(fs.existsSync(jsonl)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('payload never contains prompt content, env values, or auth tokens (schema check)', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: `_gstack_codex_log_event "codex_test_event" "1"; cat "$HOME/.gstack/analytics/skill-usage.jsonl"`,
        env: {
          _TEL: 'community',
          CODEX_API_KEY: 'SECRET_TOKEN_SHOULD_NOT_LEAK',
          OPENAI_API_KEY: 'ANOTHER_SECRET',
        },
        home,
      });
      // The emitted JSON payload should ONLY have {skill, event, duration_s, ts}.
      // Specifically, it must not contain any env values or auth material.
      expect(r.stdout).not.toContain('SECRET_TOKEN_SHOULD_NOT_LEAK');
      expect(r.stdout).not.toContain('ANOTHER_SECRET');
      // Schema: exactly these keys, in any order.
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
      expect(Object.keys(parsed).sort()).toEqual(['duration_s', 'event', 'skill', 'ts']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── Step 2A argv guard ─────────────────────────────────────────────────────
// Regression test for #1428: Codex CLI >=0.130.0 rejects passing a quoted
// prompt argument together with `--base <branch>`. Step 2A must never combine
// the two on the same line. Asserts across both the .tmpl source and the
// generated SKILL.md so template drift can't silently re-introduce the bug.

describe('codex SKILL.md.tmpl Step 2A: PROMPT + --base mutual exclusion guard', () => {
  function extractStep2A(filePath: string): string {
    const content = fs.readFileSync(filePath, 'utf-8');
    const startIdx = content.indexOf('## Step 2A: Review Mode');
    expect(startIdx).toBeGreaterThan(-1);
    // End at next `## ` heading (skill section boundary).
    const tail = content.slice(startIdx);
    const nextHeading = tail.slice(2).search(/\n## /);
    return nextHeading === -1 ? tail : tail.slice(0, nextHeading + 2);
  }

  for (const relPath of ['codex/SKILL.md.tmpl', 'codex/SKILL.md']) {
    test(`${relPath}: no \`codex review\` line combines a quoted prompt argument with --base`, () => {
      const section = extractStep2A(path.join(ROOT, relPath));
      // Find all lines invoking `codex review` (any prefix wrapper allowed).
      const lines = section.split('\n');
      const offendingLines: string[] = [];
      for (const line of lines) {
        // Skip prose lines that just discuss codex review. Only inspect lines
        // that look like an actual shell invocation (codex review followed by
        // a non-prose token).
        const match = line.match(/\bcodex\s+review\b(.*)$/);
        if (!match) continue;
        const rest = match[1];
        // Two regression patterns:
        //   codex review "..." --base <foo>
        //   codex review $VAR --base <foo>
        //   codex review -- "..." --base <foo>
        // Acceptable: codex review --base <foo>   (bare, no prompt arg)
        const hasBase = /--base\b/.test(rest);
        if (!hasBase) continue;
        // Strip --base <token> and any trailing -c/--enable flags so they
        // don't look like positional args. Anything that remains BEFORE
        // --base and looks like a positional is the regression.
        const beforeBase = rest.split(/--base\b/)[0].trim();
        // Empty (or just whitespace) before --base => bare review, safe.
        if (beforeBase === '') continue;
        // Allow `--` separator that introduces nothing else (rare). Anything
        // that looks like a quoted string OR variable expansion is the bug.
        if (/^["'$]|^--\s*["']/.test(beforeBase)) {
          offendingLines.push(line);
        }
      }
      expect(offendingLines).toEqual([]);
    });

    test(`${relPath}: Step 2A still contains at least one fix-path invocation`, () => {
      const section = extractStep2A(path.join(ROOT, relPath));
      // At least one of: bare `codex review --base` OR `codex exec ...` must
      // remain. Guards against accidental deletion of both fix paths.
      const bareReview = /codex\s+review\s+--base\b/.test(section);
      const execRoute = /codex\s+exec\b/.test(section);
      expect(bareReview || execRoute).toBe(true);
    });
  }
});

// Regression guard for #1036. The wrapper added in #1056 was wired into
// codex/SKILL.md but not into the /review and /ship diff passes, which kept
// running under a bare 5-minute Bash gate. Measured on codex-cli 0.145.0: a
// pass was killed at 287s of a 300s budget mid-tool-call, and the same prompt
// completed in 336s. An unwrapped stall returns no exit code and no output,
// which downstream reads as "Codex reviewed and found nothing".
describe('codex timeout wrapper: /review + /ship diff passes', () => {
  const WRAPPED_SITES = [
    'scripts/resolvers/review.ts', // generator (source of truth)
    'review/SKILL.md', // generated
    'ship/sections/adversarial.md', // ship section source
  ];

  // Outer Bash gate for the wrapped passes. The wrapper must be strictly
  // shorter so IT fires first and the failure is a diagnosable exit 124.
  const BASH_GATE_MS = 600000;

  for (const relPath of WRAPPED_SITES) {
    const read = () => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

    test(`${relPath}: both diff-review Codex calls run under the wrapper`, () => {
      const wrapped =
        read().match(/_gstack_codex_timeout_wrapper\s+\d+\s+codex\s+(exec|review)\b/g) ?? [];
      // Adversarial pass + structured review pass.
      expect(wrapped.length).toBeGreaterThanOrEqual(2);
    });

    test(`${relPath}: does not claim \`timeout\` is unavailable on macOS`, () => {
      // _gstack_codex_timeout_wrapper resolves gtimeout -> timeout -> unwrapped,
      // so the coreutils-less case is already handled. The old claim is what
      // steered these call sites away from the wrapper in the first place.
      expect(read()).not.toMatch(/doesn't exist on macOS/);
    });

    test(`${relPath}: wrapper budget stays under the outer Bash gate`, () => {
      const budgets = [...read().matchAll(/_gstack_codex_timeout_wrapper\s+(\d+)\s+codex\b/g)].map(
        (m) => Number(m[1]) * 1000,
      );
      expect(budgets.length).toBeGreaterThan(0);
      for (const ms of budgets) {
        // Inverting this makes the wrapper unreachable: the harness kills the
        // call first and the exit-124 branch below it becomes dead code.
        expect(ms).toBeLessThan(BASH_GATE_MS);
      }
    });
  }
});

// Regression guards for #2496 / #2524 / #2477 — three "guard reports success
// while doing nothing" defects in codex/SKILL.md:
//   (a) the default `codex review` path set NO sandbox override, inheriting
//       whatever ~/.codex/config.toml grants (write access on trusted
//       projects) while the skill's Important Rules claimed read-only;
//   (b) the severity-tag verdict gate could not fail on the default path — a
//       non-zero exit, empty output, or untagged output all satisfied the
//       "no [P1] found → PASS" branch as written;
//   (c) Step 2A's Bash tool gate (300000 ms) sat BELOW the 330s wrapper
//       budget, so the harness killed the call before the wrapper could emit
//       its diagnosable exit-124 message — the same inversion #1036 fixed for
//       /review and /ship.
// Asserted across both the .tmpl source and the generated SKILL.md so a regen
// or hand-edit of one but not the other can't silently reopen any of them.
describe('codex SKILL.md.tmpl: review sandbox + fail-closed gate + timeout ordering', () => {
  for (const relPath of ['codex/SKILL.md.tmpl', 'codex/SKILL.md']) {
    const read = () => fs.readFileSync(path.join(ROOT, relPath), 'utf-8');

    test(`${relPath}: (a) every scoped codex review invocation pins sandbox_mode="read-only"`, () => {
      const invocations = read()
        .split('\n')
        .filter((l) => /_gstack_codex_timeout_wrapper\s+\d+\s+codex\s+review\b/.test(l));
      expect(invocations.length).toBeGreaterThanOrEqual(1);
      for (const line of invocations) {
        expect(line).toContain('sandbox_mode="read-only"');
        // `codex review` has no -s/--sandbox flag (verified 0.147.0) — the
        // config override is the only lever. `-s read-only` here would fail
        // at argv parsing, which check (b) would then read as a gate FAIL.
        expect(line).not.toMatch(/\s-s\s+read-only\b/);
      }
    });

    test(`${relPath}: (b) the verdict gate fails closed — no default-PASS path`, () => {
      const content = read();
      // The old rule inferred PASS from the absence of a substring:
      expect(content).not.toContain(
        'If no `[P1]` markers are found (only `[P2]` or no findings) — the gate is **PASS**',
      );
      // The new rule: FAIL on non-zero exit, empty output, and untagged
      // output; [P0] recognized as blocking; PASS reachable only through the
      // explicit tagged-advisory-only branch.
      expect(content).toContain('The gate FAILS CLOSED');
      expect(content).toContain('`_CODEX_EXIT` is non-zero (including 124) → **GATE: FAIL**');
      expect(content).toContain('empty or whitespace-only → **GATE: FAIL**');
      expect(content).toContain('untagged output');
      expect(content).toContain('`[P0]`');
      expect(content).toContain('PASS is only reachable through check 5');
    });

    test(`${relPath}: (c) every Bash gate sits strictly above its section's wrapper budgets`, () => {
      // Split on `## ` headings; within any section that declares BOTH a Bash
      // tool gate (`timeout: N` in ms) and a wrapper budget
      // (`_gstack_codex_timeout_wrapper S codex`), every gate must be strictly
      // greater than every wrapper budget so the wrapper fires first.
      const sections = read().split(/\n## /);
      const inspected: string[] = [];
      for (const section of sections) {
        const gates = [...section.matchAll(/timeout:\s*(\d{4,})/g)].map((m) => Number(m[1]));
        const wrappers = [...section.matchAll(/_gstack_codex_timeout_wrapper\s+(\d+)\s+codex\b/g)].map(
          (m) => Number(m[1]) * 1000,
        );
        if (gates.length === 0 || wrappers.length === 0) continue;
        inspected.push(section.split('\n')[0]);
        for (const gate of gates) {
          for (const wrapper of wrappers) {
            expect(gate).toBeGreaterThan(wrapper);
          }
        }
      }
      // Review (2A), Challenge (2B), and Consult (2C) must all have been
      // inspected — each declares both numbers. If a refactor drops either
      // number from a section, this count catches the silent skip.
      expect(inspected.length).toBeGreaterThanOrEqual(3);
    });
  }
});
