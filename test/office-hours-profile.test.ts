/**
 * bin/gstack-developer-profile — write-through persistence for /office-hours.
 *
 * Regression guard for the profile data-loss bug: /office-hours used to APPEND
 * session state to builder-profile.jsonl while the read path migrated to
 * developer-profile.json and never re-read the legacy file — so every session
 * after the first was silently dropped, freezing tier / dedup / journey.
 *
 * These tests mirror the REAL skill lifecycle (write → read[migrate] → write →
 * read) which the existing suites never exercised (each test there starts from a
 * fresh tmpdir and reads exactly once).
 *
 * Covers:
 * - --append-session: writes through to the unified profile the read path uses
 * - --append-resources: merges shown resources WITHOUT counting as a session
 * - JSON-safe round-trip of free-form assignment text (quotes / newlines)
 * - mode:"resources" rows never inflate SESSION_COUNT / TIER
 * - design_title surfaced (not project slug / raw path)
 * - state root honors CLAUDE_PLUGIN_DATA (plugin install) like gstack-paths
 * - reconcile: orphaned legacy appends are healed on read
 * - malformed migration lines are reported, not silently dropped
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_DEV = path.join(ROOT, 'bin', 'gstack-developer-profile');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ohp-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function runDev(
  args: string[],
  opts: { input?: string; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string; status: number } {
  const env = opts.env ?? { ...process.env, GSTACK_HOME: tmpHome };
  const res = spawnSync(BIN_DEV, args, {
    env,
    input: opts.input,
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 };
}

/** Parse the legacy KEY: VALUE --read output into a map. */
function read(env?: Record<string, string | undefined>): Record<string, string> {
  const r = runDev(['--read'], env ? { env } : {});
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function session(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'builder',
    project_slug: 'app',
    signal_count: 0,
    signals: [],
    design_doc: '',
    design_title: '',
    assignment: '',
    topics: [],
    ...overrides,
  });
}

function writeLegacy(sessions: Array<Record<string, unknown>>) {
  fs.writeFileSync(
    path.join(tmpHome, 'builder-profile.jsonl'),
    sessions.map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// The core regression: writes must reach the store reads come from.
// ---------------------------------------------------------------------------

describe('office-hours profile write-through', () => {
  test('append-session after a migration is reflected on the next read (P0)', () => {
    // Session 1 the legacy way, then a read that migrates+archives the jsonl.
    writeLegacy([{ mode: 'builder', project_slug: 'app', assignment: 'watch users', signals: [] }]);
    expect(read()['SESSION_COUNT']).toBe('1');

    // Session 2 via the new write path.
    const r = runDev(['--append-session'], { input: session({ assignment: 'talk to 5 users', project_slug: 'app' }) });
    expect(r.status).toBe(0);

    const after = read();
    expect(after['SESSION_COUNT']).toBe('2');
    expect(after['LAST_ASSIGNMENT']).toBe('talk to 5 users');
    expect(after['TIER']).toBe('welcome_back');
  });

  test('append-session works for a brand-new user with no prior profile', () => {
    const r = runDev(['--append-session'], { input: session({ assignment: 'first' }) });
    expect(r.status).toBe(0);
    expect(read()['SESSION_COUNT']).toBe('1');
  });

  test('tier advances across many appended sessions', () => {
    for (let i = 0; i < 4; i++) {
      const r = runDev(['--append-session'], { input: session({ assignment: `a${i}` }) });
      expect(r.status).toBe(0);
    }
    const after = read();
    expect(after['SESSION_COUNT']).toBe('4');
    expect(after['TIER']).toBe('regular');
  });
});

// ---------------------------------------------------------------------------
// Resources are merged, never counted as a session (P1-1).
// ---------------------------------------------------------------------------

describe('append-resources', () => {
  test('merges shown resources without inflating the session count', () => {
    runDev(['--append-session'], { input: session({ assignment: 'do the thing' }) });
    const r = runDev(['--append-resources'], {
      input: JSON.stringify({ resources_shown: ['https://a.example', 'https://b.example'] }),
    });
    expect(r.status).toBe(0);

    const after = read();
    expect(after['SESSION_COUNT']).toBe('1');
    expect(after['TIER']).toBe('welcome_back');
    expect(after['LAST_ASSIGNMENT']).toBe('do the thing'); // not an empty resources row
    expect(after['RESOURCES_SHOWN_COUNT']).toBe('2');
  });

  test('resource merges are deduplicated across calls', () => {
    runDev(['--append-session'], { input: session() });
    runDev(['--append-resources'], { input: JSON.stringify({ resources_shown: ['https://x.example'] }) });
    runDev(['--append-resources'], { input: JSON.stringify({ resources_shown: ['https://x.example', 'https://y.example'] }) });
    expect(read()['RESOURCES_SHOWN_COUNT']).toBe('2');
  });

  test('legacy mode:"resources" rows do not count as sessions on migrate (P1-1)', () => {
    writeLegacy([
      { mode: 'builder', project_slug: 'app', assignment: 'real session', signals: [], resources_shown: [] },
      { mode: 'resources', project_slug: 'app', assignment: '', signals: [], resources_shown: ['https://r.example'] },
    ]);
    const after = read();
    expect(after['SESSION_COUNT']).toBe('1');
    expect(after['LAST_ASSIGNMENT']).toBe('real session');
    expect(after['RESOURCES_SHOWN_COUNT']).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// JSON safety: free-form assignment text must survive verbatim (P0-2).
// ---------------------------------------------------------------------------

describe('JSON-safe round-trip', () => {
  test('assignment with quotes, apostrophe and newline round-trips verbatim', () => {
    const assignment = 'Ask three customers "would you pay?"\nThen email Sarah — don\'t wait.';
    const r = runDev(['--append-session'], { input: session({ assignment }) });
    expect(r.status).toBe(0);

    const profile = JSON.parse(fs.readFileSync(path.join(tmpHome, 'developer-profile.json'), 'utf-8'));
    expect(profile.sessions.at(-1).assignment).toBe(assignment);
  });

  test('invalid JSON input fails loudly instead of silently dropping', () => {
    const r = runDev(['--append-session'], { input: '{not valid json' });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/json|invalid|parse/);
    // And it must not have created a corrupt/garbage profile entry.
    const file = path.join(tmpHome, 'developer-profile.json');
    if (fs.existsSync(file)) {
      const p = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect((p.sessions || []).length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Design titles, not slugs / paths (P2-6).
// ---------------------------------------------------------------------------

describe('design titles', () => {
  test('DESIGN_TITLES and LAST_DESIGN_TITLE use the human title', () => {
    runDev(['--append-session'], { input: session({ design_doc: '/p/a.md', design_title: 'Realtime Inbox' }) });
    runDev(['--append-session'], { input: session({ design_doc: '/p/b.md', design_title: 'Inbox Zero Agent' }) });
    const after = read();
    expect(JSON.parse(after['DESIGN_TITLES'])).toEqual(['Realtime Inbox', 'Inbox Zero Agent']);
    expect(after['LAST_DESIGN_TITLE']).toBe('Inbox Zero Agent');
  });

  test('falls back to the doc basename when no design_title is present', () => {
    runDev(['--append-session'], { input: session({ design_doc: '/p/user-main-design-x.md' }) });
    expect(read()['LAST_DESIGN_TITLE']).toBe('user-main-design-x.md');
  });
});

// ---------------------------------------------------------------------------
// State root honors CLAUDE_PLUGIN_DATA, matching gstack-paths (P1-5).
// ---------------------------------------------------------------------------

describe('state root resolution', () => {
  test('writes and reads under CLAUDE_PLUGIN_DATA when GSTACK_HOME is unset', () => {
    const env = { ...process.env, GSTACK_HOME: undefined, CLAUDE_PLUGIN_DATA: tmpHome } as Record<string, string | undefined>;
    const w = runDev(['--append-session'], { input: session({ assignment: 'plugin path' }), env });
    expect(w.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, 'developer-profile.json'))).toBe(true);
    expect(read(env)['SESSION_COUNT']).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Reconcile: orphaned legacy appends (from the buggy version) are healed (P0 heal).
// ---------------------------------------------------------------------------

describe('legacy reconcile', () => {
  test('orphaned builder-profile.jsonl appended after migration is folded back in', () => {
    writeLegacy([{ mode: 'builder', project_slug: 'app', assignment: 's1', signals: [] }]);
    expect(read()['SESSION_COUNT']).toBe('1'); // migrates + archives

    // Simulate the buggy version re-creating the legacy file with an orphaned session.
    writeLegacy([{ mode: 'builder', project_slug: 'app', assignment: 's2', signals: [] }]);
    const after = read(); // should reconcile
    expect(after['SESSION_COUNT']).toBe('2');
    expect(after['LAST_ASSIGNMENT']).toBe('s2');
    // Legacy file should be archived again, not left to double-fold next time.
    expect(fs.existsSync(path.join(tmpHome, 'builder-profile.jsonl'))).toBe(false);
    expect(read()['SESSION_COUNT']).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Loud failures, not silent drops (P1-2).
// ---------------------------------------------------------------------------

describe('malformed migration lines', () => {
  test('warns to stderr and does not silently undercount', () => {
    fs.writeFileSync(
      path.join(tmpHome, 'builder-profile.jsonl'),
      [
        JSON.stringify({ mode: 'builder', project_slug: 'app', assignment: 'good1', signals: [] }),
        '{ broken json',
        JSON.stringify({ mode: 'builder', project_slug: 'app', assignment: 'good2', signals: [] }),
      ].join('\n') + '\n',
    );
    const r = runDev(['--migrate']);
    expect(r.status).toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/dropped|malformed|skipped/);
    expect(read()['SESSION_COUNT']).toBe('2');
  });
});
