/**
 * gstack-gbrain-supabase-verify + gstack-gbrain-lib.sh — Slice 3 of /setup-gbrain.
 *
 * verify: structural URL check (scheme, userinfo, host, port). No network
 * call; pure regex. Rejects direct-connection URLs with a distinct exit
 * code + UX because that's the most common paste mistake.
 *
 * lib.sh: shared secret-read helper (read_secret_to_env) sourced by the
 * skill template and by gstack-gbrain-supabase-provision. Validates var
 * name, handles stdin=TTY and stdin=pipe (CI) paths, supports optional
 * redacted-preview echo.
 *
 * Not tested here: TTY path with stty manipulation. `bun test` runs under
 * pipe stdin so [ -t 0 ] is false and the stty branches skip. That's the
 * right test matrix for CI; TTY behavior is covered by the manual test
 * matrix on a real terminal.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const VERIFY = path.join(ROOT, 'bin', 'gstack-gbrain-supabase-verify');
const LIB = path.join(ROOT, 'bin', 'gstack-gbrain-lib.sh');

function runVerify(arg: string, stdin?: string) {
  const res = spawnSync(VERIFY, arg === '' ? [] : [arg], {
    input: stdin,
    encoding: 'utf-8',
  });
  return {
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    status: res.status ?? -1,
  };
}

// Invoke a bash snippet that sources the lib and runs something against it.
// Returns stdout + stderr + exit code. Stdin is piped so [ -t 0 ] = false.
function runLibSnippet(snippet: string, stdin: string = '') {
  const script = `set -euo pipefail\n. ${JSON.stringify(LIB)}\n${snippet}`;
  const res = spawnSync('bash', ['-c', script], {
    input: stdin,
    encoding: 'utf-8',
  });
  return {
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    status: res.status ?? -1,
  };
}

describe('gstack-gbrain-supabase-verify', () => {
  const VALID =
    'postgresql://postgres.abcdefghijklmnopqrst:secretpass@aws-0-us-east-1.pooler.supabase.com:6543/postgres';

  test('accepts canonical Session Pooler URL', () => {
    const r = runVerify(VALID);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('ok');
  });

  test('accepts postgres:// scheme (without ql)', () => {
    const r = runVerify(VALID.replace('postgresql://', 'postgres://'));
    expect(r.status).toBe(0);
  });

  test('accepts URL via stdin with "-"', () => {
    const r = runVerify('-', VALID);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('ok');
  });

  test('accepts URL via stdin with no argv', () => {
    const r = runVerify('', VALID);
    expect(r.status).toBe(0);
  });

  test('rejects direct-connection URL with exit code 3', () => {
    const url = 'postgresql://postgres:secret@db.abcdefghijk.supabase.co:5432/postgres';
    const r = runVerify(url);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('rejected direct-connection URL');
    expect(r.stderr).toContain('Session Pooler');
    // Error message should not echo the URL back (it contains a password)
    expect(r.stderr).not.toContain('secret');
  });

  test('rejects wrong scheme', () => {
    const r = runVerify('mysql://user:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('bad scheme');
  });

  test('rejects non-6543 port', () => {
    const r = runVerify(
      'postgresql://postgres.ref:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('6543');
  });

  test('rejects empty password', () => {
    const r = runVerify(
      'postgresql://postgres.ref:@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('empty password');
  });

  test('rejects missing userinfo', () => {
    const r = runVerify('postgresql://aws-0-us-east-1.pooler.supabase.com:6543/postgres');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing userinfo');
  });

  test('rejects plain "postgres" user (no .ref) to catch direct-URL paste mistakes', () => {
    const r = runVerify(
      'postgresql://postgres:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("user portion 'postgres'");
  });

  test('rejects wrong host (not *.pooler.supabase.com)', () => {
    const r = runVerify('postgresql://postgres.ref:pass@example.com:6543/postgres');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('pooler.supabase.com');
  });

  test('rejects empty URL', () => {
    const r = runVerify('-', '');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('empty URL');
  });

  test('case-insensitive host match (POOLER.SUPABASE.COM passes)', () => {
    const r = runVerify(
      'postgresql://postgres.ref:pass@AWS-0-US-EAST-1.POOLER.SUPABASE.COM:6543/postgres'
    );
    expect(r.status).toBe(0);
  });

  test('error messages never echo the URL password', () => {
    // Supply a URL with a distinctive password; verify none of the errors
    // leak the password to stderr.
    const r = runVerify(
      'mysql://user:VERY-DISTINCT-SECRET-dk3984@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    );
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('VERY-DISTINCT-SECRET');
  });
});

describe('gstack-gbrain-lib.sh read_secret_to_env', () => {
  test('reads secret from piped stdin into the named env var', () => {
    const r = runLibSnippet(
      `
      read_secret_to_env MY_SECRET "Enter: "
      echo "captured=[$MY_SECRET]"
      echo "len=\${#MY_SECRET}"
      `,
      'hello-world-123'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('captured=[hello-world-123]');
    expect(r.stdout).toContain('len=15');
  });

  test('exports the var so sub-processes see it', () => {
    const r = runLibSnippet(
      `
      read_secret_to_env TEST_VAR "Enter: "
      bash -c 'echo "child-sees=[$TEST_VAR]"'
      `,
      'child-test-value'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('child-sees=[child-test-value]');
  });

  test('redacted preview uses the provided sed expression (password masked)', () => {
    const r = runLibSnippet(
      `
      read_secret_to_env MY_URL "URL: " --echo-redacted 's#://[^@]*@#://***@#'
      echo "ok"
      `,
      'postgresql://user:SECRET123@host:5432/db'
    );
    expect(r.status).toBe(0);
    // Redacted preview goes to stderr
    expect(r.stderr).toContain('Got: postgresql://***@host:5432/db');
    // Password must not appear in the preview
    expect(r.stderr).not.toContain('SECRET123');
  });

  test('rejects invalid var names (must match [A-Z_][A-Z0-9_]*)', () => {
    const r = runLibSnippet(
      `
      read_secret_to_env "lower-case" "Prompt: " || echo "correctly-rejected"
      `,
      'anything'
    );
    expect(r.status).toBe(0); // snippet returns 0 via the || fallback
    expect(r.stdout).toContain('correctly-rejected');
    expect(r.stderr).toContain('invalid var name');
  });

  test('rejects var names that start with a digit', () => {
    const r = runLibSnippet(
      `
      read_secret_to_env "1VAR" "Prompt: " || echo "correctly-rejected"
      `,
      'x'
    );
    expect(r.stdout).toContain('correctly-rejected');
  });

  test('rejects missing args', () => {
    const r = runLibSnippet(
      `
      read_secret_to_env || echo "correctly-rejected"
      `
    );
    expect(r.stdout).toContain('correctly-rejected');
    expect(r.stderr).toContain('usage');
  });

  test('rejects unknown flags', () => {
    const r = runLibSnippet(
      `
      read_secret_to_env MY_VAR "Prompt: " --unknown-flag xxx || echo "correctly-rejected"
      `,
      'x'
    );
    expect(r.stdout).toContain('correctly-rejected');
    expect(r.stderr).toContain('unknown flag');
  });

  test('secret value never appears on stdout', () => {
    // The entire stdout comes from our `echo` statements, not read_secret_to_env.
    // Verify that an uncaptured secret doesn't leak via the prompt or anywhere.
    const r = runLibSnippet(
      `
      read_secret_to_env HIDDEN "Enter: "
      echo "len=\${#HIDDEN}"
      `,
      'this-must-not-leak-abc'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('this-must-not-leak-abc');
    expect(r.stdout).toBe('len=22');
    // The prompt goes to stderr; secret must not appear there either.
    expect(r.stderr).not.toContain('this-must-not-leak-abc');
  });
});
