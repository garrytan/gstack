/**
 * _gstack_codex_model_probe — round-trip model readiness (#2477).
 *
 * The auth probe accepts "auth exists" as readiness, but a ChatGPT account
 * with a stale `model = "..."` pin in ~/.codex/config.toml passes auth and
 * then dies with an HTTP 400 on every invocation. The model probe does one
 * short `codex exec "reply OK"` round trip with the configured model.
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
case "\${STUB_MODE:-ok}" in
  ok) echo "OK"; exit 0 ;;
  model400)
    echo 'warning: Model metadata for \`gpt-5.4\` not found.' >&2
    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-5.4'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2
    exit 1 ;;
  transient) echo "stream error: network unreachable" >&2; exit 7 ;;
esac
`;

interface Fixture {
  home: string;
  stubDir: string;
  codexHome: string;
  gstackHome: string;
  stubLog: string;
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
  return { home, stubDir, codexHome, gstackHome, stubLog };
}

function runProbe(f: Fixture, stubMode: string): { stdout: string; status: number } {
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
        _TEL: 'off',
      },
      timeout: 10000,
    },
  );
  return { stdout: (result.stdout ?? '').toString(), status: result.status ?? -1 };
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
      expect(fs.existsSync(path.join(f.gstackHome, '.codex-model-probe'))).toBe(true);

      const second = runProbe(f, 'ok');
      expect(second.stdout.trim()).toBe('MODEL_OK (cached)');
      expect(second.status).toBe(0);
      expect(invocations(f)).toBe(1); // cache hit: stub not re-invoked
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('model 400 -> MODEL_UNUSABLE with config.toml hints, exit 1, negative-cached', () => {
    const f = makeFixture();
    try {
      const r = runProbe(f, 'model400');
      expect(r.stdout).toContain('MODEL_UNUSABLE');
      expect(r.stdout).toContain('config.toml');
      expect(r.stdout).toContain('model_migrations');
      // Surfaces the actual rejection so the user sees WHICH model.
      expect(r.stdout).toContain('gpt-5.4');
      expect(r.status).toBe(1);
      // The deterministic 400 is config-driven: re-probing every preflight
      // charged the user a 30s round trip + real tokens per review section.
      // A second run within the 15-min TTL must NOT re-invoke codex, and must
      // keep the exit-1 + hints contract so callers can't tell the difference.
      expect(invocations(f)).toBe(1);
      const second = runProbe(f, 'model400');
      expect(second.stdout).toContain('MODEL_UNUSABLE (cached)');
      expect(second.stdout).toContain('config.toml');
      expect(second.status).toBe(1);
      expect(invocations(f)).toBe(1);
    } finally {
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  });

  test('config.toml change re-probes past a cached MODEL_UNUSABLE (the recovery path)', () => {
    const f = makeFixture();
    try {
      runProbe(f, 'model400');
      expect(invocations(f)).toBe(1);
      // Fixing the model pin changes the mtime signature — the negative cache
      // must not outlive the config it condemned.
      fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-5.5"\n');
      const future = Date.now() / 1000 + 10;
      fs.utimesSync(path.join(f.codexHome, 'config.toml'), future, future);
      const r = runProbe(f, 'ok');
      expect(r.stdout.trim()).toBe('MODEL_OK');
      expect(r.status).toBe(0);
      expect(invocations(f)).toBe(2);
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
