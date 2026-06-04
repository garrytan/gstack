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

// --- Group 3.5: Update check ------------------------------------------------
// _gstack_codex_update_check compares the installed Codex CLI to npm `latest`
// and prints one INFO line when an upgrade is available. 24h cache lives at
// ${GSTACK_HOME:-$HOME/.gstack}/.codex-version-check.
//
// All tests pre-warm the cache so no network is needed — the cache hit path
// is also the path /ship hits 99% of the time in practice (first /ship per
// day pays the 5s curl tax; everything else reads the cache).

function writeCache(home: string, latest: string): string {
  const dir = path.join(home, '.gstack');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.codex-version-check');
  fs.writeFileSync(file, `${latest}\n`);
  return file;
}

describe('gstack-codex-probe: update check', () => {
  test('stale local + fresh cache → INFO line with both versions', () => {
    const home = tempHome();
    const stub = tempStubCodex('codex-cli 0.100.0\n');
    try {
      writeCache(home, '0.140.0');
      const r = runProbe({
        snippet: '_gstack_codex_update_check',
        env: { PATH: `${stub.pathEntry}:${process.env.PATH}`, GSTACK_HOME: path.join(home, '.gstack') },
        home,
      });
      expect(r.stdout).toContain('INFO:');
      expect(r.stdout).toContain('0.100.0');
      expect(r.stdout).toContain('0.140.0');
      expect(r.stdout).toContain('npm install -g @openai/codex@latest');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  test('local == latest → silent (no INFO)', () => {
    const home = tempHome();
    const stub = tempStubCodex('codex-cli 0.140.0\n');
    try {
      writeCache(home, '0.140.0');
      const r = runProbe({
        snippet: '_gstack_codex_update_check',
        env: { PATH: `${stub.pathEntry}:${process.env.PATH}`, GSTACK_HOME: path.join(home, '.gstack') },
        home,
      });
      expect(r.stdout).not.toContain('INFO:');
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  test('local ahead of cached latest (pre-release dev build) → silent', () => {
    // If a user is running a dev build that's ahead of npm latest, don't badger
    // them. sort -V puts them on top, so update check is silent.
    const home = tempHome();
    const stub = tempStubCodex('codex-cli 0.200.0\n');
    try {
      writeCache(home, '0.140.0');
      const r = runProbe({
        snippet: '_gstack_codex_update_check',
        env: { PATH: `${stub.pathEntry}:${process.env.PATH}`, GSTACK_HOME: path.join(home, '.gstack') },
        home,
      });
      expect(r.stdout).not.toContain('INFO:');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  test('codex --version fails (binary present but unusable) → silent', () => {
    // tempStubCodex(..., true) writes a stub that exits 1, simulating a broken
    // / corrupt / unauthenticated codex binary. _local stays empty → silent
    // return. Equivalent observable outcome to "no codex on PATH" without
    // breaking the bash environment by narrowing PATH on Windows.
    const home = tempHome();
    const stub = tempStubCodex('', true);
    try {
      writeCache(home, '0.140.0');
      const r = runProbe({
        snippet: '_gstack_codex_update_check',
        env: { PATH: `${stub.pathEntry}:${process.env.PATH}`, GSTACK_HOME: path.join(home, '.gstack') },
        home,
      });
      expect(r.stdout).not.toContain('INFO:');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  test('network fetch fails (curl exits non-zero) → silent + no cache written', () => {
    // Stub curl to exit 1 (offline, DNS fail, registry 5xx). The function must
    // not write a bogus cache, and must not print an INFO line. The stub takes
    // precedence over the real curl via PATH ordering.
    const home = tempHome();
    const stub = tempStubCodex('codex-cli 0.100.0\n');
    const curlStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-curl-fail-'));
    try {
      const curlBin = path.join(curlStubDir, 'curl');
      fs.writeFileSync(curlBin, '#!/bin/bash\nexit 1\n');
      fs.chmodSync(curlBin, 0o755);
      const r = runProbe({
        snippet: '_gstack_codex_update_check',
        env: {
          PATH: `${curlStubDir}:${stub.pathEntry}:${process.env.PATH}`,
          GSTACK_HOME: path.join(home, '.gstack'),
        },
        home,
      });
      expect(r.stdout).not.toContain('INFO:');
      expect(r.status).toBe(0);
      // Critical: a failed fetch must NOT create a cache file. Otherwise the
      // next run would read empty/garbage and think it's a valid version.
      const cacheFile = path.join(home, '.gstack/.codex-version-check');
      expect(fs.existsSync(cacheFile)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
      fs.rmSync(curlStubDir, { recursive: true, force: true });
    }
  });

  test('stale cache (>24h old mtime) is ignored — re-fetches from network', () => {
    // Pre-warm cache with 0.140.0, then backdate mtime to 48h ago. Stub curl
    // to fail so the function can't re-fetch. If the function trusted the
    // stale cache, it would print INFO (0.100.0 vs 0.140.0). It must not.
    const home = tempHome();
    const stub = tempStubCodex('codex-cli 0.100.0\n');
    const curlStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-curl-stale-'));
    try {
      const cache = writeCache(home, '0.140.0');
      const past = (Date.now() / 1000) - 48 * 3600;
      fs.utimesSync(cache, past, past);
      const curlBin = path.join(curlStubDir, 'curl');
      fs.writeFileSync(curlBin, '#!/bin/bash\nexit 1\n');
      fs.chmodSync(curlBin, 0o755);
      const r = runProbe({
        snippet: '_gstack_codex_update_check',
        env: {
          PATH: `${curlStubDir}:${stub.pathEntry}:${process.env.PATH}`,
          GSTACK_HOME: path.join(home, '.gstack'),
        },
        home,
      });
      expect(r.stdout).not.toContain('INFO:');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
      fs.rmSync(curlStubDir, { recursive: true, force: true });
    }
  });

  test('version_check + update_check are independent — bad version AND outdated both fire', () => {
    // 0.120.0 hits the known-bad list AND is older than the cached 0.140.0.
    // Both messages must surface; one does not eat the other.
    const home = tempHome();
    const stub = tempStubCodex('codex-cli 0.120.0\n');
    try {
      writeCache(home, '0.140.0');
      const r = runProbe({
        snippet: '_gstack_codex_version_check; _gstack_codex_update_check',
        env: { PATH: `${stub.pathEntry}:${process.env.PATH}`, GSTACK_HOME: path.join(home, '.gstack') },
        home,
      });
      expect(r.stdout).toContain('WARN:');
      expect(r.stdout).toContain('INFO:');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  test('cache miss writes the fetched version to the cache file', () => {
    // Stub curl to return canned npm registry JSON; stub jq stays the real one.
    // Verifies the side effect (file write) the cache-hit tests assume.
    const home = tempHome();
    const stub = tempStubCodex('codex-cli 0.100.0\n');
    const curlStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-curl-stub-'));
    try {
      const curlBin = path.join(curlStubDir, 'curl');
      // Fake curl ignores all args and prints the smallest npm 'latest' JSON.
      fs.writeFileSync(curlBin, '#!/bin/bash\nprintf \'{"version":"0.150.0"}\'\n');
      fs.chmodSync(curlBin, 0o755);
      const r = runProbe({
        snippet: '_gstack_codex_update_check',
        env: {
          PATH: `${curlStubDir}:${stub.pathEntry}:${process.env.PATH}`,
          GSTACK_HOME: path.join(home, '.gstack'),
        },
        home,
      });
      expect(r.stdout).toContain('INFO:');
      expect(r.stdout).toContain('0.150.0');
      const cacheFile = path.join(home, '.gstack/.codex-version-check');
      expect(fs.existsSync(cacheFile)).toBe(true);
      expect(fs.readFileSync(cacheFile, 'utf-8').trim()).toBe('0.150.0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
      fs.rmSync(curlStubDir, { recursive: true, force: true });
    }
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
