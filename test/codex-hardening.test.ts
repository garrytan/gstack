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

// ── Pattern-guard: security hooks (issue #1329) ────────────────────────────
// These tests guard against re-introducing patterns that trigger Claude Code
// PreToolUse security hooks in the /codex and /autoplan skill templates.
//
// Pattern 1: `source ~/.claude/...` with a tilde path
// Pattern 3: bare `cd "$_REPO_ROOT"` (without being wrapped in a subshell)
// Pattern 4: inline `python3 -u -c "..."` multi-line blocks with comments

describe('codex/autoplan templates: security hook trigger patterns (issue #1329)', () => {
  const CODEX_TMPL = path.join(ROOT, 'codex/SKILL.md.tmpl');
  const CODEX_SKILL = path.join(ROOT, 'codex/SKILL.md');
  const AUTOPLAN_TMPL = path.join(ROOT, 'autoplan/SKILL.md.tmpl');
  const AUTOPLAN_SKILL = path.join(ROOT, 'autoplan/SKILL.md');

  for (const [label, filePath] of [
    ['codex/SKILL.md.tmpl', CODEX_TMPL],
    ['codex/SKILL.md', CODEX_SKILL],
    ['autoplan/SKILL.md.tmpl', AUTOPLAN_TMPL],
    ['autoplan/SKILL.md', AUTOPLAN_SKILL],
  ] as [string, string][]) {
    test(`${label}: Pattern 1 — no 'source ~/...' with tilde path to gstack-codex-probe`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Match any line that does `source ~/` (tilde-relative sourcing)
      const offending = content.split('\n').filter(
        (l) => /\bsource\s+~\//.test(l) && l.includes('gstack-codex-probe'),
      );
      expect(offending).toEqual([]);
    });

    test(`${label}: Pattern 3 — no bare 'cd "\$_REPO_ROOT"' on its own line`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Flag lines where cd "$_REPO_ROOT" is the main command (not inside `( ... )`)
      const offending = content.split('\n').filter((l) => {
        const trimmed = l.trim();
        return /^cd\s+"?\$_REPO_ROOT"?/.test(trimmed);
      });
      expect(offending).toEqual([]);
    });

    test(`${label}: Pattern 4 — no inline python3 -u -c with multi-line comment blocks`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Detect the pattern: python3 (or "$PYTHON_CMD") -u -c "..." spanning multiple
      // lines with Python-style # comments inside the heredoc block.
      // Inline python is replaced by gstack-codex-jsonl-parser.
      const inlinePythonRe = /\$PYTHON_CMD.*-u\s+-c\s+"/;
      expect(inlinePythonRe.test(content)).toBe(false);
    });
  }
});

// ── Standalone probe binaries (issue #1329) ────────────────────────────────
// These tests verify the standalone probe executables exist, are valid bash/python,
// and behave identically to the functions they replace from gstack-codex-probe.

describe('standalone probe binaries: existence and syntax', () => {
  const BINS = [
    'bin/gstack-codex-auth-probe',
    'bin/gstack-codex-version-check',
    'bin/gstack-codex-log-event',
    'bin/gstack-codex-log-hang',
    'bin/gstack-codex-timeout-wrapper',
  ];

  for (const rel of BINS) {
    const full = path.join(ROOT, rel);
    test(`${rel} exists and is executable`, () => {
      expect(fs.existsSync(full)).toBe(true);
      const stat = fs.statSync(full);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    });

    test(`${rel} is syntactically valid bash (bash -n)`, () => {
      const result = spawnSync('bash', ['-n', full], { timeout: 5000 });
      expect(result.status).toBe(0);
    });
  }

  test('bin/gstack-codex-jsonl-parser exists and is executable', () => {
    const p = path.join(ROOT, 'bin/gstack-codex-jsonl-parser');
    expect(fs.existsSync(p)).toBe(true);
    const stat = fs.statSync(p);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  test('bin/gstack-codex-jsonl-parser is syntactically valid Python', () => {
    const p = path.join(ROOT, 'bin/gstack-codex-jsonl-parser');
    const result = spawnSync('python3', ['-c', `import ast; ast.parse(open(${JSON.stringify(p)}).read())`], { timeout: 5000 });
    expect(result.status).toBe(0);
  });
});

describe('standalone probe binaries: gstack-codex-auth-probe behaviour', () => {
  function runAuthProbe(opts: {
    env?: Record<string, string | undefined>;
    home?: string;
  }): { stdout: string; stderr: string; status: number } {
    const BIN = path.join(ROOT, 'bin/gstack-codex-auth-probe');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (opts.home) env.HOME = opts.home;
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
    const result = spawnSync('bash', [BIN], {
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

  test('CODEX_API_KEY set → AUTH_OK with exit 0', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sab-'));
    try {
      const r = runAuthProbe({ env: { CODEX_API_KEY: 'sk-test' }, home });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('no auth → AUTH_FAILED with exit 1', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sab-'));
    try {
      const r = runAuthProbe({ home });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('auth.json exists → AUTH_OK', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sab-'));
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
      const r = runAuthProbe({ home });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('standalone probe binaries: gstack-codex-timeout-wrapper behaviour', () => {
  const BIN = path.join(ROOT, 'bin/gstack-codex-timeout-wrapper');

  test('executes command directly when no timeout binary on PATH', () => {
    const result = spawnSync('bash', [BIN, '5', 'echo', 'hello_wrapper'], {
      env: { PATH: '/bin:/usr/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    expect((result.stdout ?? '').toString().trim()).toBe('hello_wrapper');
  });

  test('prefers gtimeout when on PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gtostub-'));
    try {
      const stub = path.join(dir, 'gtimeout');
      fs.writeFileSync(stub, '#!/bin/bash\necho "gtimeout_wrapper_$1"\n');
      fs.chmodSync(stub, 0o755);
      const result = spawnSync('bash', [BIN, '7', 'echo', 'nope'], {
        env: { PATH: `${dir}:/bin:/usr/bin` },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      expect((result.stdout ?? '').toString().trim()).toBe('gtimeout_wrapper_7');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('gstack-codex-jsonl-parser: streaming output', () => {
  const PARSER = path.join(ROOT, 'bin/gstack-codex-jsonl-parser');

  function runParser(input: string, args: string[] = []): { stdout: string; stderr: string } {
    const result = spawnSync('python3', [PARSER, ...args], {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return {
      stdout: (result.stdout ?? '').toString(),
      stderr: (result.stderr ?? '').toString(),
    };
  }

  test('extracts agent_message text from item.completed', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Hello from codex' },
    });
    const { stdout } = runParser(line + '\n');
    expect(stdout).toContain('Hello from codex');
  });

  test('extracts SESSION_ID from thread.started in consult mode', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'tid-abc123' });
    const { stdout } = runParser(line + '\n', ['--mode', 'consult']);
    expect(stdout).toContain('SESSION_ID:tid-abc123');
  });

  test('does NOT emit SESSION_ID in challenge mode', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'tid-xyz' });
    const { stdout } = runParser(line + '\n', ['--mode', 'challenge']);
    expect(stdout).not.toContain('SESSION_ID:');
  });

  test('emits turn.completed disconnect warning to stderr in challenge mode', () => {
    const { stderr } = runParser('', ['--mode', 'challenge']);
    expect(stderr).toContain('No turn.completed event received');
  });

  test('no disconnect warning in consult mode when no events', () => {
    const { stderr } = runParser('', ['--mode', 'consult']);
    expect(stderr).not.toContain('No turn.completed');
  });

  test('emits token count from turn.completed', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const { stdout } = runParser(line + '\n');
    expect(stdout).toContain('tokens used: 150');
  });

  test('emits [codex thinking] for reasoning items', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', text: 'Thinking about X' },
    });
    const { stdout } = runParser(line + '\n');
    expect(stdout).toContain('[codex thinking] Thinking about X');
  });

  test('emits [codex ran] for command_execution items', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'git diff HEAD' },
    });
    const { stdout } = runParser(line + '\n');
    expect(stdout).toContain('[codex ran] git diff HEAD');
  });

  test('ignores malformed JSON lines without crashing', () => {
    const input = 'not-json\n{"broken":}\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n';
    const { stdout } = runParser(input);
    expect(stdout).toContain('ok');
  });
});
