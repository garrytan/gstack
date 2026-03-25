import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

// Each test gets a fresh temp directory for GSTACK_STATE_DIR
let tmpDir: string;

function run(cmd: string, env: Record<string, string> = {}): string {
  return execSync(cmd, {
    cwd: ROOT,
    env: { ...process.env, GSTACK_STATE_DIR: tmpDir, GSTACK_DIR: ROOT, ...env },
    encoding: 'utf-8',
    timeout: 10000,
  }).trim();
}

function setConfig(key: string, value: string) {
  run(`${BIN}/gstack-config set ${key} ${value}`);
}

function readJsonl(): string[] {
  const file = path.join(tmpDir, 'analytics', 'skill-usage.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
}

function parseJsonl(): any[] {
  return readJsonl().map(line => JSON.parse(line));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-tel-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-telemetry-log', () => {
  test('appends valid JSONL when tier=anonymous', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 142 --outcome success --session-id test-123`);

    const events = parseJsonl();
    expect(events).toHaveLength(1);
    expect(events[0].v).toBe(1);
    expect(events[0].skill).toBe('qa');
    expect(events[0].duration_s).toBe(142);
    expect(events[0].outcome).toBe('success');
    expect(events[0].session_id).toBe('test-123');
    expect(events[0].event_type).toBe('skill_run');
    expect(events[0].os).toBeTruthy();
    expect(events[0].gstack_version).toBeTruthy();
  });

  test('produces no output when tier=off', () => {
    setConfig('telemetry', 'off');
    run(`${BIN}/gstack-telemetry-log --skill ship --duration 30 --outcome success --session-id test-456`);

    expect(readJsonl()).toHaveLength(0);
  });

  test('defaults to off for invalid tier value', () => {
    setConfig('telemetry', 'invalid_value');
    run(`${BIN}/gstack-telemetry-log --skill ship --duration 30 --outcome success --session-id test-789`);

    expect(readJsonl()).toHaveLength(0);
  });

  test('includes installation_id for community tier', () => {
    setConfig('telemetry', 'community');
    run(`${BIN}/gstack-telemetry-log --skill review --duration 100 --outcome success --session-id comm-123`);

    const events = parseJsonl();
    expect(events).toHaveLength(1);
    // installation_id should be a UUID v4 (or hex fallback)
    expect(events[0].installation_id).toMatch(/^[a-f0-9-]{32,36}$/);
  });

  test('installation_id is null for anonymous tier', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 50 --outcome success --session-id anon-123`);

    const events = parseJsonl();
    expect(events[0].installation_id).toBeNull();
  });

  test('includes error_class when provided', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill browse --duration 10 --outcome error --error-class timeout --session-id err-123`);

    const events = parseJsonl();
    expect(events[0].error_class).toBe('timeout');
    expect(events[0].outcome).toBe('error');
  });

  test('handles missing duration gracefully', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --outcome success --session-id nodur-123`);

    const events = parseJsonl();
    expect(events[0].duration_s).toBeNull();
  });

  test('supports event_type flag', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --event-type upgrade_prompted --skill "" --outcome success --session-id up-123`);

    const events = parseJsonl();
    expect(events[0].event_type).toBe('upgrade_prompted');
  });

  test('includes local-only fields (_repo_slug, _branch)', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 50 --outcome success --session-id local-123`);

    const events = parseJsonl();
    // These should be present in local JSONL
    expect(events[0]).toHaveProperty('_repo_slug');
    expect(events[0]).toHaveProperty('_branch');
  });

  test('creates analytics directory if missing', () => {
    // Remove analytics dir
    const analyticsDir = path.join(tmpDir, 'analytics');
    if (fs.existsSync(analyticsDir)) fs.rmSync(analyticsDir, { recursive: true });

    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 50 --outcome success --session-id mkdir-123`);

    expect(fs.existsSync(analyticsDir)).toBe(true);
    expect(readJsonl()).toHaveLength(1);
  });
});

describe('.pending marker', () => {
  test('finalizes stale .pending from another session as outcome:unknown', () => {
    setConfig('telemetry', 'anonymous');

    // Write a fake .pending marker from a different session
    const analyticsDir = path.join(tmpDir, 'analytics');
    fs.mkdirSync(analyticsDir, { recursive: true });
    fs.writeFileSync(
      path.join(analyticsDir, '.pending-old-123'),
      '{"skill":"old-skill","ts":"2026-03-18T00:00:00Z","session_id":"old-123","gstack_version":"0.6.4"}'
    );

    // Run telemetry-log with a DIFFERENT session — should finalize the old pending marker
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 50 --outcome success --session-id new-456`);

    const events = parseJsonl();
    expect(events).toHaveLength(2);

    // First event: finalized pending
    expect(events[0].skill).toBe('old-skill');
    expect(events[0].outcome).toBe('unknown');
    expect(events[0].session_id).toBe('old-123');

    // Second event: new event
    expect(events[1].skill).toBe('qa');
    expect(events[1].outcome).toBe('success');
  });

  test('.pending-SESSION file is removed after finalization', () => {
    setConfig('telemetry', 'anonymous');

    const analyticsDir = path.join(tmpDir, 'analytics');
    fs.mkdirSync(analyticsDir, { recursive: true });
    const pendingPath = path.join(analyticsDir, '.pending-stale-session');
    fs.writeFileSync(pendingPath, '{"skill":"stale","ts":"2026-03-18T00:00:00Z","session_id":"stale-session","gstack_version":"v"}');

    run(`${BIN}/gstack-telemetry-log --skill qa --duration 50 --outcome success --session-id new-456`);

    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  test('does not finalize own session pending marker', () => {
    setConfig('telemetry', 'anonymous');

    const analyticsDir = path.join(tmpDir, 'analytics');
    fs.mkdirSync(analyticsDir, { recursive: true });
    // Create pending for same session ID we'll use
    const pendingPath = path.join(analyticsDir, '.pending-same-session');
    fs.writeFileSync(pendingPath, '{"skill":"in-flight","ts":"2026-03-18T00:00:00Z","session_id":"same-session","gstack_version":"v"}');

    run(`${BIN}/gstack-telemetry-log --skill qa --duration 50 --outcome success --session-id same-session`);

    // Should only have 1 event (the new one), not finalize own pending
    const events = parseJsonl();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('qa');
  });

  test('tier=off still clears own session pending', () => {
    setConfig('telemetry', 'off');

    const analyticsDir = path.join(tmpDir, 'analytics');
    fs.mkdirSync(analyticsDir, { recursive: true });
    const pendingPath = path.join(analyticsDir, '.pending-off-123');
    fs.writeFileSync(pendingPath, '{"skill":"stale","ts":"2026-03-18T00:00:00Z","session_id":"off-123","gstack_version":"v"}');

    run(`${BIN}/gstack-telemetry-log --skill qa --duration 50 --outcome success --session-id off-123`);

    expect(fs.existsSync(pendingPath)).toBe(false);
    // But no JSONL entries since tier=off
    expect(readJsonl()).toHaveLength(0);
  });
});

describe('gstack-analytics', () => {
  test('shows "no data" for empty JSONL', () => {
    const output = run(`${BIN}/gstack-analytics`);
    expect(output).toContain('no data');
  });

  test('renders usage dashboard with events', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 120 --outcome success --session-id a-1`);
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 60 --outcome success --session-id a-2`);
    run(`${BIN}/gstack-telemetry-log --skill ship --duration 30 --outcome error --error-class timeout --session-id a-3`);

    const output = run(`${BIN}/gstack-analytics all`);
    expect(output).toContain('/qa');
    expect(output).toContain('/ship');
    expect(output).toContain('2 runs');
    expect(output).toContain('1 runs');
    expect(output).toContain('Success rate: 66%');
    expect(output).toContain('Errors: 1');
  });

  test('filters by time window', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 60 --outcome success --session-id t-1`);

    const output7d = run(`${BIN}/gstack-analytics 7d`);
    expect(output7d).toContain('/qa');
    expect(output7d).toContain('last 7 days');
  });
});

describe('gstack-telemetry-sync', () => {
  test('exits silently with no Supabase URL configured', () => {
    // Default: GSTACK_SUPABASE_URL is not set → exit 0
    const result = run(`${BIN}/gstack-telemetry-sync`);
    expect(result).toBe('');
  });

  test('exits silently with no JSONL file', () => {
    const result = run(`${BIN}/gstack-telemetry-sync`, { GSTACK_SUPABASE_URL: 'http://localhost:9999' });
    expect(result).toBe('');
  });

  test('does not rename JSONL field names (edge function expects raw names)', () => {
    setConfig('telemetry', 'anonymous');
    run(`${BIN}/gstack-telemetry-log --skill qa --duration 60 --outcome success --session-id raw-fields-1`);

    const events = parseJsonl();
    expect(events).toHaveLength(1);
    // Edge function expects these raw field names, NOT Postgres column names
    expect(events[0]).toHaveProperty('v');
    expect(events[0]).toHaveProperty('ts');
    expect(events[0]).toHaveProperty('sessions');
    // Should NOT have Postgres column names
    expect(events[0]).not.toHaveProperty('schema_version');
    expect(events[0]).not.toHaveProperty('event_timestamp');
    expect(events[0]).not.toHaveProperty('concurrent_sessions');
  });
});

describe('gstack-community-dashboard', () => {
  test('shows unconfigured message when no Supabase config available', () => {
    // Use a fake GSTACK_DIR with no supabase/config.sh
    const output = run(`${BIN}/gstack-community-dashboard`, {
      GSTACK_DIR: tmpDir,
      GSTACK_SUPABASE_URL: '',
      GSTACK_SUPABASE_ANON_KEY: '',
    });
    expect(output).toContain('Supabase not configured');
    expect(output).toContain('gstack-analytics');
  });

  test('connects to Supabase when config exists', () => {
    // Use the real GSTACK_DIR which has supabase/config.sh
    const output = run(`${BIN}/gstack-community-dashboard`);
    expect(output).toContain('gstack community dashboard');
    // Should not show "not configured" since config.sh exists
    expect(output).not.toContain('Supabase not configured');
  });
});
