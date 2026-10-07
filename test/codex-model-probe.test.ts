/**
 * _gstack_codex_model_probe — round-trip model readiness (#2477).
 *
 * The auth probe accepts "auth exists" as readiness, but a ChatGPT account
 * with a model it cannot use passes auth and then dies with an HTTP 400 on
 * every invocation. The model probe does one short `codex exec "reply OK"`
 * round trip with gstack's selected model.
 *
 * Contract pinned here (all runs use a STUBBED codex binary):
 *   - exit 0            -> MODEL_OK, result cached (1h TTL + config/auth
 *                          mtime signature), second call does NOT re-invoke
 *   - model 400 output  -> MODEL_UNUSABLE (exit 1) + config.toml HINT lines,
 *                          negative-cached 15 min (same exit-1 + hints from
 *                          cache; re-probing every preflight charged the
 *                          affected user 30s + real tokens per section)
 *   - transient failure -> MODEL_PROBE_INCONCLUSIVE, FAIL-OPEN (exit 0),
 *                          never cached
 *   - usage limit / insufficient_quota on a failed call -> MODEL_QUOTA_EXHAUSTED
 *                          (exit 4), cached 15 min; GSTACK_CODEX_PROBE_RETRY=1
 *                          skips the cache. A plain 429 -> MODEL_PROBE_RATE_LIMITED
 *                          (exit 0, state rate_limited), never cached. Only
 *                          Codex's trailing ERROR / stream error lines count.
 *   - config.toml mtime change invalidates a cached MODEL_OK and a cached
 *                          MODEL_UNUSABLE (editing the pin IS the fix)
 *   - the probed model is the runtime selection (#2914): explicit request,
 *     GSTACK_CODEX_MODEL, config.toml (review_model first for native review),
 *     then gpt-6-astra; an invalid choice never falls back to the default
 *   - the cache key also covers the resolved codex binary, its mtime and the
 *     auth mode (#2787), and never stores a credential
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexPreflight } from '../scripts/resolvers/constants';
import { withoutDeprecation } from './helpers/codex-probe-sourcing';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin', 'gstack-codex-probe');

const SANDBOX_FIXTURES = path.join(ROOT, 'test', 'fixtures', 'codex-sandbox');
const STUB = `#!/usr/bin/env bash
if [ "$1" = sandbox ]; then
  echo "$*" >> "$STUB_LOG.sandbox"
  case "\${STUB_SANDBOX:-ok}" in
    ok) exit 0 ;;
    userns) cat "$SANDBOX_FIXTURES/sandbox-userns-denied.stderr" >&2; exit 1 ;;
    missing) cat "$SANDBOX_FIXTURES/sandbox-bwrap-missing.stderr" >&2; exit 101 ;;
    unknown) echo "error: unrecognized subcommand 'sandbox'" >&2; exit 2 ;;
  esac
fi
echo "invoked" >> "$STUB_LOG"
printf '%s\\n' "$*" >> "$STUB_ARGS_LOG"
case "\${STUB_MODE:-ok}" in
  ok) echo "OK"; exit 0 ;;
  model400)
    echo 'warning: Model metadata for \`gpt-6-astra\` not found.' >&2
    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-6-astra'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2
    exit 1 ;;
  transient) echo "stream error: network unreachable" >&2; exit 7 ;;
  quota)
    echo "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 10th, 2026 2:55 AM." >&2
    exit 1 ;;
  ratelimit429) echo 'ERROR: {"type":"error","status":429,"error":{"type":"rate_limit_exceeded","message":"Rate limit reached"}}' >&2; exit 1 ;;
  insufficientquota) echo 'ERROR: Quota exceeded. Check your plan and billing details. (insufficient_quota)' >&2; exit 1 ;;
  quota429)
    echo 'stream error: exceeded retry limit, last status: 429 Too Many Requests; retrying 1/5' >&2
    echo 'ERROR: {"type":"error","status":429,"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}' >&2
    exit 1 ;;
  echoedquota)
    printf 'user\nexplain why the usage limit and insufficient_quota (429) paths differ\n' >&2
    echo 'ERROR: unexpected status 500 Internal Server Error' >&2
    exit 1 ;;
  quotaok) echo "OK (note: you are close to your usage limit)"; exit 0 ;;
  ratelimitok) echo "OK"; echo "ERROR: rate limit warning from a retried request" >&2; exit 0 ;;
  quotatimeout) echo "ERROR: You've hit your usage limit. Try again at 3 AM." >&2; exit 124 ;;
  retired404)
    echo 'ERROR: unexpected status 404 Not Found: The model \`gpt-5.2-codex\` does not exist or you do not have access to it., url: https://chatgpt.com/backend-api/codex/responses' >&2
    exit 1 ;;
  baseurl404) echo 'ERROR: unexpected status 404 Not Found: <html><body>Not Found</body></html>, url: http://localhost:9999/v1/responses' >&2; exit 1 ;;
  outdated400)
    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-6-astra'"'"' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}' >&2
    exit 1 ;;
esac
`;

interface Fixture {
  home: string;
  stubDir: string;
  codexHome: string;
  gstackHome: string;
  stubLog: string;
  stubArgsLog: string;
}

function makeFixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-model-probe-'));
  const stubDir = path.join(home, 'stub-bin');
  const codexHome = path.join(home, '.codex');
  const gstackHome = path.join(home, '.gstack');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(gstackHome, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'codex'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  const stubLog = path.join(home, 'stub.log');
  const stubArgsLog = path.join(home, 'stub-args.log');
  return { home, stubDir, codexHome, gstackHome, stubLog, stubArgsLog };
}

function runProbe(f: Fixture, stubMode: string, extraEnv: Record<string, string> = {}, call = '_gstack_codex_model_probe'): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    'bash',
    ['-c', `set +e\nsource "${PROBE}"\n${call}`],
    {
      env: {
        PATH: `${f.stubDir}:${process.env.PATH ?? ''}`,
        HOME: f.home,
        CODEX_HOME: f.codexHome,
        GSTACK_HOME: f.gstackHome,
        STUB_MODE: stubMode,
        STUB_LOG: f.stubLog,
        STUB_ARGS_LOG: f.stubArgsLog,
        SANDBOX_FIXTURES,
        _TEL: 'off',
        ...extraEnv,
      },
      timeout: 10000,
    },
  );
  return { stdout: (result.stdout ?? '').toString(), stderr: withoutDeprecation((result.stderr ?? '').toString()), status: result.status ?? -1 };
}

function lastArgs(f: Fixture): string {
  try {
    const lines = fs.readFileSync(f.stubArgsLog, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.at(-1) ?? '';
  } catch {
    return '';
  }
}

function invocations(f: Fixture): number {
  try {
    return fs.readFileSync(f.stubLog, 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe('codex model probe (#2477)', () => {
  test('successful round trip -> MODEL_OK, cached, no re-invocation', () => {
    const f = makeFixture();
    try {
      const first = runProbe(f, 'ok');
      expect(first.stdout.trim()).toBe('MODEL_OK');
      expect(first.status).toBe(0);
      expect(invocations(f)).toBe(1);
      // #2914: the fixture's config.toml chooses gpt-5.4; gstack must not override it.
      expect(lastArgs(f)).toContain('-c model="gpt-5.4"');
      expect(lastArgs(f)).toContain("-c skills.include_instructions=false");
      expect(first.stderr).toContain(`CODEX_MODEL: gpt-5.4 (exec; source: ${path.join(f.codexHome, 'config.toml')} model)`);
      expect(fs.existsSync(path.join(f.gstackHome, '.codex-model-probe'))).toBe(true);

      const second = runProbe(f, 'ok');
      expect(second.stdout.trim()).toBe('MODEL_OK (cached)');
      expect(second.status).toBe(0);
      expect(invocations(f)).toBe(1); // cache hit: stub not re-invoked
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('model 400 -> MODEL_UNUSABLE with selected-model hints, exit 1, negative-cached', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'model400');
      expect(r.stdout).toContain('MODEL_UNUSABLE');
      expect(r.stdout).toContain('gstack requested model');
      expect(r.stdout).toContain('GSTACK_CODEX_MODEL');
      // Surfaces the actual rejection so the user sees WHICH model and why it was chosen.
      expect(r.stdout).toContain("gstack requested model 'gpt-5.4'");
      expect(r.stdout).toContain('config.toml model');
      expect(r.status).toBe(1);
      // The deterministic 400 is config-driven: re-probing every preflight
      // charged the user a 30s round trip + real tokens per review section.
      // A second run within the 15-min TTL must NOT re-invoke codex, and must
      // keep the exit-1 + hints contract so callers can't tell the difference.
      expect(invocations(f)).toBe(1);
      const second = runProbe(f, 'model400');
      expect(second.stdout).toContain('MODEL_UNUSABLE (cached)');
      expect(second.stdout).toContain('GSTACK_CODEX_MODEL');
      expect(second.status).toBe(1);
      expect(invocations(f)).toBe(1);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('GSTACK_CODEX_MODEL change re-probes past a cached MODEL_UNUSABLE (the recovery path)', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'model400');
      expect(invocations(f)).toBe(1);
      // Fixing the gstack model override changes the cache signature — the
      // negative cache must not outlive the model it condemned.
      const r = runProbe(f, 'ok', { GSTACK_CODEX_MODEL: 'gpt-5.6-sol' });
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(r.status).toBe(0);
      expect(invocations(f)).toBe(2);
      expect(lastArgs(f)).toContain('-c model="gpt-5.6-sol"');
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('transient failure -> inconclusive, FAIL-OPEN exit 0', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'transient');
      expect(r.stdout).toContain('MODEL_PROBE_INCONCLUSIVE');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('TTL expiry: a cached MODEL_OK older than 3600s re-probes (T5)', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(invocations(f)).toBe(1);
      // Backdate the cache line's timestamp past the 1h TTL, keeping the
      // signature valid — TTL alone must force the re-probe.
      const cachePath = path.join(f.gstackHome, '.codex-model-probe');
      const [status, ts, sig] = fs.readFileSync(cachePath, 'utf-8').trim().split(' ');
      expect(status).toBe('MODEL_OK');
      fs.writeFileSync(cachePath, `MODEL_OK ${Number(ts) - 3700} ${sig}\n`);
      const r = runProbe(f, 'ok');
      expect(r.stdout.trim()).toBe('MODEL_OK'); // not "(cached)"
      expect(invocations(f)).toBe(2); // re-probed
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('auth.json mtime change invalidates the cached MODEL_OK (T5: re-login re-probes)', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(invocations(f)).toBe(1);
      // A re-login rewrites auth.json; the mtime signature must invalidate
      // the cache even though config.toml is untouched.
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(path.join(f.codexHome, 'auth.json'), future, future);
      const r = runProbe(f, 'ok');
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2); // re-probed
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('config.toml change invalidates the cached MODEL_OK', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(invocations(f)).toBe(1);
      // Change the model pin; mtime signature must invalidate the cache.
      fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-5.5"\n');
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(path.join(f.codexHome, 'config.toml'), future, future);
      const r = runProbe(f, 'ok');
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2); // re-probed
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('#2914: precedence is explicit request, GSTACK_CODEX_MODEL, config.toml, then gpt-6-astra', () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-5.6-terra"\nreview_model = "gpt-5.6-luna"\n');
      const sel = (env: Record<string, string>, call: string) =>
        runProbe(f, 'ok', env, `${call}; printf '%s|%s\\n' "$_GSTACK_CODEX_SEL" "$_GSTACK_CODEX_SEL_SRC"`).stdout.trim();
      const config = path.join(f.codexHome, 'config.toml');
      expect(sel({}, '_gstack_codex_select_model exec')).toBe(`gpt-5.6-terra|${config} model`);
      expect(sel({}, '_gstack_codex_select_model review')).toBe(`gpt-5.6-luna|${config} review_model`);
      expect(sel({ GSTACK_CODEX_MODEL: 'gpt-6-sol' }, '_gstack_codex_select_model review')).toBe('gpt-6-sol|GSTACK_CODEX_MODEL');
      expect(sel({ GSTACK_CODEX_MODEL: 'gpt-6-sol' }, "_gstack_codex_select_model exec 'gpt-6-luna'")).toBe('gpt-6-luna|explicit request');
      // An id with no dedicated prompt overlay is still passed through unchanged.
      fs.writeFileSync(config, 'model = "acme/custom-model:2026-09"\n');
      expect(sel({}, '_gstack_codex_select_model review')).toBe(`acme/custom-model:2026-09|${config} model`);
      fs.rmSync(config);
      expect(sel({}, '_gstack_codex_select_model exec')).toBe(`gpt-6-astra|gstack default (no ${config})`);
      expect(invocations(f)).toBe(0); // selection alone never spends a call
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('#2914: native review probes its own review_model selection', () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-5.6-terra"\nreview_model = "gpt-5.6-luna"\n');
      const r = runProbe(f, 'ok', {}, '_gstack_codex_model_probe review');
      expect(r.status).toBe(0);
      expect(lastArgs(f)).toContain('-c model="gpt-5.6-luna"');
      expect(r.stderr).toContain('CODEX_MODEL: gpt-5.6-luna (review; source:');
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  for (const [label, env, config] of [
    ['an injection-shaped GSTACK_CODEX_MODEL', { GSTACK_CODEX_MODEL: 'gpt"; touch PWNED; "' }, 'model = "gpt-5.4"\n'],
    ['an invalid config.toml model', {}, 'model = "has space"\n'],
    ['an unparseable config.toml', {}, 'model = \n'],
  ] as const) {
    test(`#2914: ${label} is a repair message, never a silent frontier fallback`, () => {
      const f = makeFixture();
      try {
        fs.writeFileSync(path.join(f.codexHome, 'config.toml'), config);
        const r = runProbe(f, 'ok', { ...env });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('MODEL_UNUSABLE');
        expect(r.stderr).toContain('GSTACK_CODEX_MODEL=<model>');
        expect(r.stderr).toContain('No Codex call was made');
        expect(r.stderr).not.toContain('CODEX_MODEL: gpt-6-astra');
        expect(invocations(f)).toBe(0);
        expect(fs.existsSync(path.join(f.home, 'PWNED'))).toBe(false);
      } finally {
        fs.rmSync(f.home, { recursive: true, force: true });
      }
    });
  }

  test('#2787: swapping the codex binary or its mtime invalidates a cached MODEL_OK', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      expect(runProbe(f, 'ok').stdout.trim()).toBe('MODEL_OK (cached)');
      // A different codex earlier on PATH (an upgrade or a second install).
      const other = path.join(f.home, 'other-bin');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'codex'), STUB, { mode: 0o755 });
      const swapped = runProbe(f, 'ok', { PATH: `${other}:${f.stubDir}:${process.env.PATH ?? ''}` });
      expect(swapped.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2);
      // Reinstalling in place keeps the path but moves the mtime.
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(path.join(f.stubDir, 'codex'), future, future);
      expect(runProbe(f, 'ok').stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(3);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('#2787: switching to env-var auth invalidates the cache without persisting the key', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'ok');
      const secret = 'sk-test-SHOULD-NOT-PERSIST-abcdefghij';
      const r = runProbe(f, 'ok', { OPENAI_API_KEY: secret });
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(2);
      expect(runProbe(f, 'ok', { OPENAI_API_KEY: secret }).stdout.trim()).toBe('MODEL_OK (cached)');
      expect(fs.readFileSync(path.join(f.gstackHome, '.codex-model-probe'), 'utf-8')).not.toContain(secret);
      // A different Codex home is a different configuration identity.
      const otherHome = path.join(f.home, 'codex-two');
      fs.cpSync(f.codexHome, otherHome, { recursive: true, preserveTimestamps: true });
      expect(runProbe(f, 'ok', { OPENAI_API_KEY: secret, CODEX_HOME: otherHome }).stdout.trim()).toBe('MODEL_OK');
      expect(invocations(f)).toBe(3);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });
});

describe('B1: codex sandbox preflight and unverified readiness', () => {
  const unavailable = (detail: string) =>
    `Codex outside review unavailable: Codex's sandbox could not start here (${detail}). No review ran; this is missing coverage, not a pass. Fix: enable unprivileged user namespaces for this container, or set GSTACK_CODEX_NO_SANDBOX=1.`;

  for (const [mode, detail] of [
    ['userns', 'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.'.slice(0, 240)],
    ['missing', 'bubblewrap is unavailable: no system bwrap was found on PATH and no bundled codex-resources/bwrap binary was found next to the Codex executable'],
  ] as const) {
    test(`captured ${mode} failure -> sandbox unavailable (exit 3), named like the gate outcome`, () => {
      const f = makeFixture();
      try {
        const r = runProbe(f, 'ok', { STUB_SANDBOX: mode }, '_gstack_codex_sandbox_preflight; echo "rc=$?"');
        expect(r.stdout).toBe('CODEX_SANDBOX: unavailable\nrc=3\n');
        expect(r.stderr.trim()).toBe(unavailable(detail));
        expect(fs.readFileSync(`${f.stubLog}.sandbox`, 'utf-8')).toBe(`sandbox -c sandbox_mode="read-only" true\n`);
        expect(invocations(f)).toBe(0);
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    });
  }

  test('a healthy sandbox, an older CLI without the subcommand, or a timeout defers to the post-run check', () => {
    const f = makeFixture();
    try {
      for (const mode of ['ok', 'unknown']) {
        const r = runProbe(f, 'ok', { STUB_SANDBOX: mode }, '_gstack_codex_sandbox_preflight; echo "rc=$?"');
        expect(r.stdout).toBe('rc=0\n');
        expect(r.stderr).toBe('');
      }
      const timedOut = runProbe(f, 'ok', { STUB_SANDBOX: 'userns' },
        '_gstack_codex_timeout_wrapper() { return 124; }; _gstack_codex_sandbox_preflight; echo "rc=$?"');
      expect(timedOut.stdout).toBe('rc=0\n');
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('GSTACK_CODEX_NO_SANDBOX: exactly 1 selects full access with a warning each use; other values keep read-only', () => {
    const f = makeFixture();
    try {
      const warning = 'WARNING: GSTACK_CODEX_NO_SANDBOX=1: Codex runs this review without a sandbox and can read and write anything your user can. Use it only inside a container you trust.';
      const on = runProbe(f, 'ok', { GSTACK_CODEX_NO_SANDBOX: '1', STUB_SANDBOX: 'userns' },
        '_gstack_codex_select_model exec; echo "sandbox=$_GSTACK_CODEX_SANDBOX"; _gstack_codex_select_model exec; _gstack_codex_sandbox_preflight; echo "rc=$?"');
      expect(on.stdout).toBe('sandbox=danger-full-access\nrc=0\n');
      expect(on.stderr.split(warning).length - 1).toBe(2);
      expect(fs.existsSync(`${f.stubLog}.sandbox`)).toBe(false);
      for (const value of ['', 'true', 'yes', '0', '1 ']) {
        const off = runProbe(f, 'ok', { GSTACK_CODEX_NO_SANDBOX: value }, '_gstack_codex_select_model exec; echo "sandbox=$_GSTACK_CODEX_SANDBOX"');
        expect(off.stdout).toBe('sandbox=read-only\n');
        expect(off.stderr).not.toContain('WARNING');
      }
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('the preflight runs only on Linux', () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.stubDir, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
      const r = runProbe(f, 'ok', { STUB_SANDBOX: 'userns' }, '_gstack_codex_sandbox_preflight; echo "rc=$?"');
      expect(r.stdout).toBe('rc=0\n');
      expect(fs.existsSync(`${f.stubLog}.sandbox`)).toBe(false);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('an inconclusive model probe marks readiness unverified without blocking stale callers', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'transient', {}, '_gstack_codex_model_probe; echo "rc=$? state=${_GSTACK_CODEX_PROBE_STATE:-}"');
      expect(r.stdout).toContain('CODEX_MODE: unverified');
      expect(r.stdout).toContain('rc=0 state=inconclusive');
      const ok = runProbe(f, 'ok', {}, '_gstack_codex_model_probe; echo "state=${_GSTACK_CODEX_PROBE_STATE:-none}"');
      expect(ok.stdout).toContain('state=none');
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('the rendered preflight reports sandbox_unavailable before any paid probe, and unverified on an inconclusive probe', () => {
    const block = codexPreflight({ disabledBehavior: 'codex-only' }).match(/```bash\n([\s\S]*?)\n```/)![1];
    for (const [sandbox, model, mode, probed] of [
      ['userns', 'ok', 'sandbox_unavailable', 0],
      ['ok', 'transient', 'unverified', 1],
      ['ok', 'ok', 'ready', 1],
      ['ok', 'model400', 'model_unusable', 1],
      ['ok', 'quota', 'quota_exhausted', 1],
      ['ok', 'ratelimit429', 'unverified (rate_limited)', 1],
    ] as const) {
      const f = makeFixture();
      try {
        fs.mkdirSync(path.join(f.home, '.claude', 'skills'), { recursive: true });
        fs.symlinkSync(ROOT, path.join(f.home, '.claude', 'skills', 'gstack'));
        const r = spawnSync('bash', ['-c', block], { encoding: 'utf8', timeout: 20000, env: {
          PATH: `${f.stubDir}:${process.env.PATH ?? ''}`, HOME: f.home, CODEX_HOME: f.codexHome, GSTACK_HOME: f.gstackHome,
          STUB_MODE: model, STUB_SANDBOX: sandbox, STUB_LOG: f.stubLog, STUB_ARGS_LOG: f.stubArgsLog, SANDBOX_FIXTURES } });
        expect(r.stdout).toContain(`CODEX_MODE: ${mode}`);
        const paid = fs.existsSync(f.stubArgsLog) ? fs.readFileSync(f.stubArgsLog, 'utf-8').split('\n').filter(l => l.includes('reply OK')).length : 0;
        expect(paid).toBe(probed);
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    }
  });
});

const QUOTA_LINE = "try again at Oct 10th, 2026 2:55 AM";
const DOCS = 'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md';

describe('a Codex usage limit is quota_exhausted; a plain 429 is rate_limited', () => {
  for (const mode of ['quota', 'insufficientquota', 'quota429'] as const) {
    test(`${mode} -> MODEL_QUOTA_EXHAUSTED, exit 4, Codex's own line relayed, cached 15 min, event logged`, () => {
      const f = makeFixture();
      try {
        const r = runProbe(f, mode, { _TEL: 'community' }, '_gstack_codex_model_probe; echo "rc=$?"');
        expect(r.stdout).toContain('MODEL_QUOTA_EXHAUSTED');
        expect(r.stdout).toContain('rc=4');
        expect(r.stdout).not.toContain('MODEL_PROBE_INCONCLUSIVE');
        expect(r.stdout).not.toContain('RATE_LIMITED');
        expect(r.stdout).not.toContain('MODEL_UNUSABLE');
        if (mode === 'quota') expect(r.stdout).toContain(QUOTA_LINE);
        expect(r.stdout).toContain('gstack skips Codex for 15 minutes. Retry now: GSTACK_CODEX_PROBE_RETRY=1');
        expect(r.stdout).toContain(`${DOCS}#codex-quota-exhausted`);
        expect(fs.readFileSync(path.join(f.gstackHome, 'analytics', 'skill-usage.jsonl'), 'utf-8')).toContain('"event":"codex_quota_exhausted"');
        const again = runProbe(f, 'ok', {}, '_gstack_codex_model_probe; echo "rc=$?"');
        expect(again.stdout).toContain('MODEL_QUOTA_EXHAUSTED (cached)');
        expect(again.stdout).toContain('rc=4');
        expect(again.stdout).toMatch(/gstack skips Codex for 1[45] more minute\(s\)\. Retry now: GSTACK_CODEX_PROBE_RETRY=1, or delete \S+\.codex-model-probe\./);
        if (mode === 'quota') expect(again.stdout).toContain(QUOTA_LINE);
        expect(invocations(f)).toBe(1);
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    });
  }

  test('a plain 429 -> MODEL_PROBE_RATE_LIMITED: exit 0, state rate_limited, line relayed, never cached', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'ratelimit429', { _TEL: 'community' }, '_gstack_codex_model_probe; echo "rc=$? state=${_GSTACK_CODEX_PROBE_STATE:-}"');
      expect(r.stdout).toContain('MODEL_PROBE_RATE_LIMITED — CODEX_MODE: unverified (rate_limited)');
      expect(r.stdout).toContain('"status":429');
      expect(r.stdout).toContain(`${DOCS}#codex-rate-limited`);
      expect(r.stdout).toContain('rc=0 state=rate_limited');
      expect(r.stdout).not.toContain('QUOTA');
      expect(fs.readFileSync(path.join(f.gstackHome, 'analytics', 'skill-usage.jsonl'), 'utf-8')).toContain('"event":"codex_rate_limited"');
      const again = runProbe(f, 'ok', {}, '_gstack_codex_model_probe; echo "rc=$?"');
      expect(again.stdout).toContain('MODEL_OK');
      expect(again.stdout).not.toContain('cached');
      expect(invocations(f)).toBe(2);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test("an echoed prompt that names usage limit, insufficient_quota and 429 is not Codex's error", () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'echoedquota', {}, '_gstack_codex_model_probe; echo "rc=$? state=${_GSTACK_CODEX_PROBE_STATE:-}"');
      expect(r.stdout).toContain('MODEL_PROBE_INCONCLUSIVE');
      expect(r.stdout).toContain('rc=0 state=inconclusive');
      expect(r.stdout).not.toContain('QUOTA');
      expect(r.stdout).not.toContain('RATE_LIMITED');
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  for (const mode of ['quotaok', 'ratelimitok'] as const) {
    test(`a successful call that mentions a limit (${mode}) stays MODEL_OK`, () => {
      const f = makeFixture();
      try {
        const r = runProbe(f, mode, {}, '_gstack_codex_model_probe; echo "rc=$?"');
        expect(r.stdout).toContain('MODEL_OK');
        expect(r.stdout).toContain('rc=0');
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    });
  }

  test('a timeout that printed a usage-limit line keeps the inconclusive contract', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'quotatimeout', {}, '_gstack_codex_model_probe; echo "rc=$? state=${_GSTACK_CODEX_PROBE_STATE:-}"');
      expect(r.stdout).toContain('MODEL_PROBE_INCONCLUSIVE (exit 124)');
      expect(r.stdout).toContain('rc=0 state=inconclusive');
      expect(r.stdout).not.toContain('QUOTA');
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('GSTACK_CODEX_PROBE_RETRY=1 re-checks past a cached quota result without touching model, config or credentials', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'quota');
      const before = ['config.toml', 'auth.json'].map(name => fs.statSync(path.join(f.codexHome, name)).mtimeMs);
      expect(runProbe(f, 'ok', {}, '_gstack_codex_model_probe; echo "rc=$?"').stdout).toContain('MODEL_QUOTA_EXHAUSTED (cached)');
      const r = runProbe(f, 'ok', { GSTACK_CODEX_PROBE_RETRY: '1' }, '_gstack_codex_model_probe; echo "rc=$?"');
      expect(r.stdout).toContain('MODEL_OK');
      expect(r.stdout).toContain('rc=0');
      expect(invocations(f)).toBe(2);
      expect(lastArgs(f)).toContain('model="gpt-5.4"');
      expect(['config.toml', 'auth.json'].map(name => fs.statSync(path.join(f.codexHome, name)).mtimeMs)).toEqual(before);
      expect(runProbe(f, 'ok', {}, '_gstack_codex_model_probe').stdout).toContain('MODEL_OK (cached)');
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('re-login (auth.json change) re-probes past a cached quota result', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'quota');
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(f.codexHome, 'auth.json'), future, future);
      const r = runProbe(f, 'ok', {}, '_gstack_codex_model_probe; echo "rc=$?"');
      expect(r.stdout).toContain('MODEL_OK');
      expect(invocations(f)).toBe(2);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('two fresh-shell preflight blocks in one run: the second makes no paid Codex call after a quota refusal', () => {
    const block = codexPreflight({ disabledBehavior: 'skip-all' }).match(/```bash\n([\s\S]*?)\n```/)![1]!;
    const f = makeFixture();
    try {
      fs.mkdirSync(path.join(f.home, '.claude', 'skills'), { recursive: true });
      fs.symlinkSync(ROOT, path.join(f.home, '.claude', 'skills', 'gstack'));
      const env = { PATH: `${f.stubDir}:${process.env.PATH ?? ''}`, HOME: f.home, CODEX_HOME: f.codexHome, GSTACK_HOME: f.gstackHome,
        STUB_LOG: f.stubLog, STUB_ARGS_LOG: f.stubArgsLog, SANDBOX_FIXTURES };
      const first = spawnSync('bash', ['-c', block], { encoding: 'utf8', timeout: 20000, env: { ...env, STUB_MODE: 'quota' } });
      expect(first.stdout).toContain('CODEX_MODE: quota_exhausted');
      expect(invocations(f)).toBe(1);
      const second = spawnSync('bash', ['-c', block], { encoding: 'utf8', timeout: 20000, env: { ...env, STUB_MODE: 'ok' } });
      expect(second.stdout).toContain('MODEL_QUOTA_EXHAUSTED (cached)');
      expect(second.stdout).toContain(QUOTA_LINE);
      expect(second.stdout).toContain('CODEX_MODE: quota_exhausted');
      expect(invocations(f)).toBe(1);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });
});

describe('B2: a 404 model rejection is unusable, never ready (#2843)', () => {
  for (const [mode, hint, event] of [
    ['retired404', "Codex answered 404: either the model is retired or not visible to this account, or a custom provider's base_url", 'codex_model_retired'],
    ['baseurl404', "a custom provider's base_url", 'codex_model_retired'],
    ['outdated400', 'this Codex CLI is too old', 'codex_cli_outdated'],
  ] as const) {
    test(`${mode} -> MODEL_UNUSABLE with a hint naming the cause and a ${event} event`, () => {
      const f = makeFixture();
      try {
        const r = runProbe(f, mode, { _TEL: 'community' }, '_gstack_codex_model_probe; echo "rc=$?"');
        expect(r.stdout).toContain('MODEL_UNUSABLE');
        expect(r.stdout).toContain('rc=1');
        expect(r.stdout).not.toContain('MODEL_PROBE_INCONCLUSIVE');
        expect(r.stdout).toContain(hint);
        expect(fs.readFileSync(path.join(f.gstackHome, 'analytics', 'skill-usage.jsonl'), 'utf-8')).toContain(`"event":"${event}"`);
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    });
  }
});

describe('Q2: one-time outside-review notice (#965)', () => {
  test('names the account source per auth mode, never the credential, and shows once per state root', () => {
    for (const [env, files, account] of [
      [{ CODEX_API_KEY: 'sk-codex-secret' }, {}, 'the API key in CODEX_API_KEY'],
      [{ OPENAI_API_KEY: 'sk-openai-secret' }, {}, 'the API key in OPENAI_API_KEY'],
      [{}, { 'auth.json': '{"auth_mode":"chatgpt","tokens":{"id_token":"secret-token"}}' }, 'the ChatGPT account Codex is logged in with'],
      [{}, { 'auth.json': '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-file-secret"}' }, 'the API key saved by codex login'],
      [{}, { 'config.toml': 'model_provider = "mimo"\n[model_providers.mimo]\nenv_key = "MIMO_API_KEY"\n' }, 'Codex (provider: mimo) using the credentials your Codex config.toml provider names'],
    ] as const) {
      const f = makeFixture();
      try {
        fs.rmSync(path.join(f.codexHome, 'auth.json'));
        fs.rmSync(path.join(f.codexHome, 'config.toml'));
        for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(f.codexHome, name), body);
        const first = runProbe(f, 'ok', { ...env }, '_gstack_codex_first_use_notice; echo "rc=$?"');
        expect(first.stdout).toBe('rc=0\n');
        expect(first.stderr).toContain(account);
        expect(first.stderr).toContain('To turn them off: gstack-config set codex_reviews disabled');
        expect(first.stderr).not.toMatch(/secret/);
        expect(fs.existsSync(path.join(f.gstackHome, '.codex-review-notice-shown'))).toBe(true);
        expect(runProbe(f, 'ok', { ...env }, '_gstack_codex_first_use_notice').stderr).toBe('');
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    }
  });
});
