import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

/**
 * Regression tests for the two Windows path bugs in the bin writers:
 *
 * 1. A checkout path containing an apostrophe used to terminate the JS
 *    single-quoted string literal that `bun -e` programs interpolated
 *    SCRIPT_DIR into (gstack-learnings-log, gstack-question-log,
 *    gstack-telemetry-log, gstack-developer-profile). The scripts exited 1
 *    but callers invoke them with 2>/dev/null, so every learning and every
 *    plan-tune question event was dropped with no visible error.
 *
 * 2. gstack-developer-profile passed an MSYS-form GSTACK_HOME (/c/Users/...)
 *    to Bun, which cannot open it — --derive always failed ENOENT on
 *    Windows git-bash.
 *
 * The apostrophe repro is OS-independent: SCRIPT_DIR derives from the
 *  script's own location, so running the bins from a copied checkout under a
 * hostile directory name reproduces bug 1 on Linux/macOS CI too.
 *
 * These tests assert rows are ACTUALLY WRITTEN, not merely that the exit
 * code is 0 — exit-code-only assertions are exactly what masked bug 1.
 */

// Per-run mkdtemp root: a fixed tmpdir name would collide across concurrent
// runs (sharded runner, sibling worktrees) — one run's beforeAll rmSync would
// tear down the other's tree mid-flight. The hostile apostrophe name lives
// one level below the unique root.
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hostile-'));
const HOSTILE = path.join(RUN_ROOT, "gstack o'brien test");
const STATE = path.join(HOSTILE, 'state');
const REPO = path.resolve(import.meta.dir, '..');

function runBin(bin: string, args: string[], env: Record<string, string> = {}) {
  // Invoke through bash explicitly: the bins are shell scripts, and Windows
  // cannot exec a shebang script directly (spawn would fail before the code
  // under test ever ran).
  const r = spawnSync('bash', [path.join(HOSTILE, 'bin', bin), ...args], {
    timeout: 30_000,
    encoding: 'utf-8',
    env: { ...process.env, GSTACK_HOME: STATE, GSTACK_STATE_ROOT: '', ...env },
    shell: false,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeAll(() => {
  fs.mkdirSync(STATE, { recursive: true });
  // The bins resolve SCRIPT_DIR from their own location and import ../lib and
  // ../scripts relative to it, so copy all three alongside each other.
  for (const dir of ['bin', 'lib', 'scripts']) {
    fs.cpSync(path.join(REPO, dir), path.join(HOSTILE, dir), { recursive: true });
  }
});

afterAll(() => {
  fs.rmSync(RUN_ROOT, { recursive: true, force: true });
});

describe('bin writers under a path containing an apostrophe', () => {
  test('gstack-learnings-log appends a row (not just exit 0)', () => {
    const r = runBin('gstack-learnings-log', [
      JSON.stringify({
        skill: 't', type: 'tool', key: 'hostile-path-probe',
        insight: 'row must land even under a hostile checkout path',
        confidence: 5, source: 'observed',
      }),
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr ?? '').not.toContain('Expected ";"');

    const projects = path.join(STATE, 'projects');
    const rows: string[] = [];
    for (const slug of fs.readdirSync(projects)) {
      const f = path.join(projects, slug, 'learnings.jsonl');
      if (fs.existsSync(f)) rows.push(...fs.readFileSync(f, 'utf-8').trim().split('\n'));
    }
    const parsed = rows.map((l) => JSON.parse(l));
    expect(parsed.some((j) => j.key === 'hostile-path-probe')).toBe(true);
  });

  test('gstack-question-log gets past module resolution to its own validation', () => {
    // An intentionally incomplete event: reaching the field-validation error
    // proves the bun -e program parsed and ran, which is the regression under
    // test. (A full happy-path event would couple this test to the question
    // registry's required fields.)
    const r = runBin('gstack-question-log', [
      JSON.stringify({ skill: 't', question_id: 'hostile-path-probe', user_choice: 'a' }),
    ]);
    expect(r.stderr ?? '').not.toContain('Expected ";"');
    expect(r.stderr ?? '').not.toContain('Cannot find module');
  });

  test('gstack-developer-profile --derive resolves GSTACK_HOME for Bun', () => {
    const r = runBin('gstack-developer-profile', ['--derive']);
    expect(r.stdout + r.stderr).not.toContain('ENOENT');
    expect(r.stdout).toContain('DERIVE: ok');
  });

  test('gstack-telemetry-log appends a row with the error message REDACTED (not just exit 0)', () => {
    // The bin's tier gate (`gstack-config get telemetry`, default off) exits 0
    // WITHOUT writing — enable the anonymous tier via the config file that
    // gstack-config resolves from GSTACK_HOME (already set by runBin).
    fs.writeFileSync(path.join(STATE, 'config.yaml'), 'telemetry: anonymous\n');

    // 36 alnum chars after ghp_ — matches the github.pat redaction pattern.
    // Built by concatenation so a token-shaped literal never sits in this file.
    const FAKE_PAT = 'ghp_' + 'a1B2'.repeat(9);
    const r = runBin(
      'gstack-telemetry-log',
      [
        '--skill', 'hostile-telemetry-probe',
        '--outcome', 'failure',
        '--error-class', 'probe',
        '--error-message', `auth failed for token ${FAKE_PAT} while pushing`,
        '--session-id', 'hostile-telemetry-session',
      ],
      {
        // gstack-telemetry-log reads GSTACK_STATE_DIR (not GSTACK_HOME) for
        // its analytics dir; point both at the same isolated state tree.
        GSTACK_STATE_DIR: STATE,
        // Keep the fire-and-forget gstack-telemetry-sync child inert: with no
        // Supabase URL (and no supabase/config.sh in the copied tree) it
        // exits 0 before any network attempt.
        GSTACK_SUPABASE_URL: '',
      },
    );
    expect(r.status).toBe(0);
    expect(r.stderr ?? '').not.toContain('Expected ";"');

    const jsonl = path.join(STATE, 'analytics', 'skill-usage.jsonl');
    expect(fs.existsSync(jsonl)).toBe(true);
    const rows = fs.readFileSync(jsonl, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const row = rows.find((j) => j.skill === 'hostile-telemetry-probe');
    expect(row).toBeDefined();
    expect(row.outcome).toBe('failure');
    expect(row.session_id).toBe('hostile-telemetry-session');
    // #1947: error_message flows through redactFindingSpans before it touches
    // disk — the credential span becomes <REDACTED-{pattern.id}> while the
    // rest of the message survives for crash triage. Asserting the marker
    // (not merely null) proves the bun -e engine call actually ran under the
    // apostrophe path instead of fail-closing the whole message away.
    expect(row.error_message).toContain('<REDACTED-github.pat>');
    expect(row.error_message).toContain('auth failed for token');
    expect(row.error_message).not.toContain(FAKE_PAT);
  });
});
