import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Regression tests for #1947: the community security dashboard must FAIL CLOSED.
// A backend error, an unreachable backend, or unparseable data must render
// "unknown", never a reassuring "0 attacks / Good news" — reporting 0
// when the real state is unknown is a fail-open on a security-signaling surface
// (the same class the project's "4 security guards failing open" wave corrected).
//
// The dashboard fetches `${GSTACK_SUPABASE_URL}/functions/v1/community-pulse` via
// curl. Tests put a fake curl first on PATH: when a fixture exists it writes the
// body and prints HTTP 200; when no fixture exists it prints HTTP 000.

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-security-dashboard');
const HAS_JQ = (() => {
  try {
    execSync('command -v jq', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let tmpDir: string;
let fixtureFile: string;
let fakeBin: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-secdash-'));
  const fnDir = path.join(tmpDir, 'functions', 'v1');
  fs.mkdirSync(fnDir, { recursive: true });
  fixtureFile = path.join(fnDir, 'community-pulse');
  fakeBin = path.join(tmpDir, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const curl = path.join(fakeBin, 'curl');
  fs.writeFileSync(
    curl,
    `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift
done
if [ -f "${fixtureFile}" ]; then
  cp "${fixtureFile}" "$out"
  printf "200"
  exit 0
fi
: > "$out"
printf "000"
exit 7
`,
  );
  fs.chmodSync(curl, 0o755);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(args: string, env: Record<string, string>): string {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      GSTACK_SUPABASE_ANON_KEY: 'test-anon-key',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 20000,
  };
  // The dashboard exits 0 in every state (unknown included), so no try/catch.
  return execSync(`bash ${BIN} ${args}`, execOpts);
}

function writeFixture(json: object) {
  fs.writeFileSync(fixtureFile, JSON.stringify(json));
}

const reachableUrl = () => 'https://community.test';
const unreachableUrl = () => 'https://community.test';

describe('gstack-security-dashboard fail-closed (#1947)', () => {
  test('unreachable backend reports "unknown", not "0 attacks"', () => {
    const out = run('', { GSTACK_SUPABASE_URL: unreachableUrl() });
    expect(out).toContain('Attacks detected last 7 days: unknown');
    expect(out).toMatch(/backend error/i);
    // The fail-open strings must NOT appear.
    expect(out).not.toContain('Attacks detected last 7 days: 0');
    expect(out).not.toContain('Good news');
  });

  test('backend error body without security data reports unknown instead of zero', () => {
    writeFixture({ error: 'pulse_unavailable' });
    const out = run('', { GSTACK_SUPABASE_URL: reachableUrl() });
    expect(out).toContain('Attacks detected last 7 days: unknown');
    expect(out).toMatch(/backend error/i);
    expect(out).not.toContain('Good news');
  });

  test('--json surfaces an explicit error, not a fake all-zero security object', () => {
    const out = run('--json', { GSTACK_SUPABASE_URL: unreachableUrl() }).trim();
    const parsed = JSON.parse(out);
    expect(parsed.security).toBeNull();
    expect(parsed.status).toBe('unknown');
    expect(parsed.reason).toBe('backend_error');
    // Must NOT emit the old reassuring zero payload.
    expect(out).not.toContain('"attacks_last_7_days":0');
  });

  test.if(HAS_JQ)('a GENUINE zero still reads as "0 / Good news" (no over-classify)', () => {
    writeFixture({
      status: 'ok',
      security: { attacks_last_7_days: 0, top_attack_domains: [], top_attack_layers: [], verdict_distribution: [] },
    });
    const out = run('', { GSTACK_SUPABASE_URL: reachableUrl() });
    expect(out).toContain('Attacks detected last 7 days: 0');
    expect(out).toContain('Good news');
    expect(out).not.toMatch(/unknown/i);
  });

  test.if(HAS_JQ)('a non-zero count from a healthy backend is reported verbatim', () => {
    writeFixture({
      status: 'ok',
      security: {
        attacks_last_7_days: 4,
        top_attack_domains: [{ domain: 'evil.test', count: 4 }],
        top_attack_layers: [],
        verdict_distribution: [],
      },
    });
    const out = run('', { GSTACK_SUPABASE_URL: reachableUrl() });
    expect(out).toContain('Attacks detected last 7 days: 4');
    expect(out).not.toMatch(/unknown/i);
  });
});
