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
 *   - config.toml mtime change invalidates a cached MODEL_OK and a cached
 *                          MODEL_UNUSABLE (editing the pin IS the fix)
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin', 'gstack-codex-probe');

const STUB = `#!/usr/bin/env bash
echo "invoked" >> "$STUB_LOG"
printf '%s\\n' "$*" >> "$STUB_ARGS_LOG"
case "\${STUB_MODE:-ok}" in
  ok) echo "OK"; exit 0 ;;
  model400)
    echo 'warning: Model metadata for \`gpt-6-astra\` not found.' >&2
    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-6-astra'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2
    exit 1 ;;
  transient) echo "stream error: network unreachable" >&2; exit 7 ;;
  model404)
    # A retired model on the /responses path. Carries no 400 and no
    # "is not supported", which is why this used to fail open.
    echo 'ERROR: unexpected status 404 Not Found: The model \`gpt-6-astra\` does not exist or you do not have access to it., url: https://chatgpt.com/backend-api/codex/responses' >&2
    exit 1 ;;
  staleCli)
    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-6-astra'"'"' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}' >&2
    exit 1 ;;
  notfound404)
    # An unrelated 404 (bad base URL, proxy). Must KEEP the fail-open contract.
    echo 'ERROR: unexpected status 404 Not Found, url: https://example.invalid/v1/responses' >&2
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

function runProbe(f: Fixture, stubMode: string, extraEnv: Record<string, string> = {}): { stdout: string; status: number } {
  const result = spawnSync(
    'bash',
    ['-c', `set +e\nsource "${PROBE}"\n_gstack_codex_model_probe`],
    {
      env: {
        PATH: `${f.stubDir}:${process.env.PATH ?? ''}`,
        HOME: f.home,
        CODEX_HOME: f.codexHome,
        GSTACK_HOME: f.gstackHome,
        STUB_MODE: stubMode,
        STUB_LOG: f.stubLog,
        STUB_ARGS_LOG: f.stubArgsLog,
        _TEL: 'off',
        ...extraEnv,
      },
      timeout: 10000,
    },
  );
  return { stdout: (result.stdout ?? '').toString(), status: result.status ?? -1 };
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
      expect(lastArgs(f)).toContain('-c model="gpt-6-astra"');
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
      // Surfaces the actual rejection so the user sees WHICH model.
      expect(r.stdout).toContain('gpt-6-astra');
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

  test('a retired-model 404 is MODEL_UNUSABLE, not fail-open', () => {
    // Regression: the classifier matched only /is not supported/ and
    // /"status": *400/. A retired model answers 404 with neither, so the probe
    // fell through to MODEL_PROBE_INCONCLUSIVE (return 0) and the preflight
    // printed CODEX_MODE: ready while every codex invocation died. Measured
    // against codex-cli 0.153.4 with a retired pin.
    const f = makeFixture();
    try {
      const r = runProbe(f, 'model404');
      expect(r.stdout).toContain('MODEL_UNUSABLE');
      expect(r.stdout).not.toContain('MODEL_PROBE_INCONCLUSIVE');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('GSTACK_CODEX_MODEL');
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('"requires a newer version of Codex" points at the CLI, not the model pin', () => {
    // Same status class, different fix. Telling the user to change
    // GSTACK_CODEX_MODEL here sends them to edit config forever while every
    // model stays refused; the actual repair is upgrading the CLI.
    const f = makeFixture();
    try {
      const r = runProbe(f, 'staleCli');
      expect(r.stdout).toContain('MODEL_UNUSABLE');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('too old');
      expect(r.stdout).toContain('codex doctor');
      // The model-selection hint must NOT be the advice offered here.
      expect(r.stdout).not.toContain('set GSTACK_CODEX_MODEL=<supported-model>');
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('an unrelated 404 keeps the fail-open contract', () => {
    // The 404 signature is anchored on the model-not-found wording precisely
    // so a proxy or wrong-base-URL 404 stays a network-luck problem.
    const f = makeFixture();
    try {
      const r = runProbe(f, 'notfound404');
      expect(r.stdout).toContain('MODEL_PROBE_INCONCLUSIVE');
      expect(r.stdout).not.toContain('MODEL_UNUSABLE');
      expect(r.status).toBe(0);
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
});
