/**
 * gstack-codex-session-import — backfill question-log from Codex JSONL.
 *
 * Plan-tune cathedral T9. Verifies the structured-file parser (D5) handles
 * the two-tier recovery strategy from docs/spikes/codex-session-format.md:
 *   - Marker-first: <gstack-qid:foo-bar> → source=codex-import-marker.
 *   - Pattern fallback: D-numbered brief → source=codex-import-pattern,
 *     hash-only question_id.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-codex-session-import');

let stateRoot: string;
let fixtureCwd: string;
let cwdSlug: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cdximp-'));
  cwdSlug = 'codex-fixture-slug';
  fixtureCwd = path.join(stateRoot, cwdSlug);
  fs.mkdirSync(fixtureCwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

function writeSessionFile(events: Array<Record<string, unknown>>, sessionId = 'sess-fixture'): string {
  const p = path.join(stateRoot, 'rollout-fixture.jsonl');
  const meta = {
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: { id: sessionId, cwd: fixtureCwd },
  };
  const lines = [JSON.stringify(meta), ...events.map((e) => JSON.stringify(e))];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function agentMessage(text: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: text },
  };
}

function userMessage(text: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  };
}

function runImport(sessionPath: string): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GSTACK_STATE_ROOT = stateRoot;
  env.GSTACK_QUESTION_LOG_NO_DERIVE = '1';
  delete env.GSTACK_HOME;
  const res = spawnSync(BIN, [sessionPath], { env, encoding: 'utf-8', cwd: ROOT });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

function readImportedEvents(): Array<Record<string, unknown>> {
  const f = path.join(stateRoot, 'projects', cwdSlug, 'question-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ----------------------------------------------------------------------
// Marker-first path
// ----------------------------------------------------------------------

describe('marker-first import (source=codex-import-marker)', () => {
  test('extracts marker id from agent_message and pairs with next user_message', () => {
    const sessionPath = writeSessionFile([
      agentMessage(
        'D1 — Test\nELI10: blah\n<gstack-qid:ship-test-failure-triage> Tests failed.\nRecommendation: A\nA) Fix now (recommended)\nB) Investigate\nC) Ack and ship',
      ),
      userMessage('A'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED: 1');
    const events = readImportedEvents();
    expect(events.length).toBe(1);
    expect(events[0].source).toBe('codex-import-marker');
    expect(events[0].question_id).toBe('ship-test-failure-triage');
    expect(events[0].user_choice).toContain('Fix now');
    expect(events[0].recommended).toContain('Fix now');
  });
});

// ----------------------------------------------------------------------
// Pattern fallback
// ----------------------------------------------------------------------

describe('pattern fallback (source=codex-import-pattern)', () => {
  test('D-numbered brief without marker → hash id + source=codex-import-pattern', () => {
    const sessionPath = writeSessionFile([
      agentMessage('D2 — Unmarked brief\nA) Foo (recommended)\nB) Bar'),
      userMessage('A'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    const events = readImportedEvents();
    expect(events.length).toBe(1);
    expect(events[0].source).toBe('codex-import-pattern');
    expect((events[0].question_id as string).startsWith('hook-')).toBe(true);
    expect(events[0].user_choice).toContain('Foo');
  });
});

// ----------------------------------------------------------------------
// Edge cases
// ----------------------------------------------------------------------

describe('edge cases', () => {
  test('no AUQ-shaped events → 0 imported, exit 0', () => {
    const sessionPath = writeSessionFile([
      agentMessage('Just doing some work, nothing to ask.'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED: 0');
  });

  test('agent_message with marker but no following user_message → skipped', () => {
    const sessionPath = writeSessionFile([
      agentMessage('<gstack-qid:test-q> D1 — Q\nA) Foo\nB) Bar'),
      // no user_message
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    expect(readImportedEvents().length).toBe(0);
  });

  test('two D-briefs in sequence → both imported', () => {
    const sessionPath = writeSessionFile([
      agentMessage('D1 — First <gstack-qid:q1>\nA) Foo (recommended)\nB) Bar'),
      userMessage('A'),
      agentMessage('D2 — Second <gstack-qid:q2>\nA) Baz (recommended)\nB) Qux'),
      userMessage('B'),
    ]);
    const r = runImport(sessionPath);
    expect(r.status).toBe(0);
    const events = readImportedEvents();
    expect(events.length).toBe(2);
    expect(events[0].question_id).toBe('q1');
    expect(events[1].question_id).toBe('q2');
  });

  test('numeric user response also resolves to letter index', () => {
    const sessionPath = writeSessionFile([
      agentMessage('D1 — Test <gstack-qid:numeric-q>\nA) Foo\nB) Bar\nC) Baz'),
      userMessage('B - I think B is right'),
    ]);
    runImport(sessionPath);
    const events = readImportedEvents();
    expect(events.length).toBe(1);
    expect(events[0].user_choice).toContain('Bar');
  });
});

// ----------------------------------------------------------------------
// Default-mode (latest session) behavior
// ----------------------------------------------------------------------

describe('default mode (no args → latest)', () => {
  test('returns NO_SESSIONS when sessions dir is empty', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-empty-cdx-'));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      env.GSTACK_STATE_ROOT = stateRoot;
      env.CODEX_SESSIONS_ROOT = emptyDir;
      const res = spawnSync(BIN, [], { env, encoding: 'utf-8', cwd: ROOT });
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/NO_SESSIONS/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
