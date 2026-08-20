import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;

function runProfile(): Record<string, string> {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  const stdout = execSync(`${BIN}/gstack-builder-profile`, execOpts).trim();
  const result: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

function writeProfile(entries: object[]): void {
  const profileFile = path.join(tmpDir, 'builder-profile.jsonl');
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(profileFile, content);
}

function makeEntry(overrides: Partial<{
  date: string;
  mode: string;
  project_slug: string;
  signal_count: number;
  signals: string[];
  design_doc: string;
  assignment: string;
  resources_shown: string[];
  topics: string[];
}> = {}): object {
  return {
    date: '2026-04-01T00:00:00Z',
    mode: 'startup',
    project_slug: 'test-app',
    signal_count: 0,
    signals: [],
    design_doc: '',
    assignment: '',
    resources_shown: [],
    topics: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-profile-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-builder-profile', () => {
  describe('empty/missing state', () => {
    test('no profile file → introduction tier with defaults', () => {
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('0');
      expect(r['TIER']).toBe('introduction');
      expect(r['TOTAL_SIGNAL_COUNT']).toBe('0');
      expect(r['CROSS_PROJECT']).toBe('false');
      expect(r['NUDGE_ELIGIBLE']).toBe('false');
      expect(r['RESOURCES_SHOWN_COUNT']).toBe('0');
    });

    test('empty profile file → introduction tier', () => {
      fs.writeFileSync(path.join(tmpDir, 'builder-profile.jsonl'), '');
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('0');
      expect(r['TIER']).toBe('introduction');
    });
  });

  describe('tier computation', () => {
    test('1 session → welcome_back', () => {
      writeProfile([makeEntry()]);
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('1');
      expect(r['TIER']).toBe('welcome_back');
    });

    test('2 sessions → welcome_back', () => {
      writeProfile([makeEntry(), makeEntry({ date: '2026-04-02T00:00:00Z' })]);
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('2');
      expect(r['TIER']).toBe('welcome_back');
    });

    test('3 sessions → welcome_back', () => {
      writeProfile([
        makeEntry(),
        makeEntry({ date: '2026-04-02T00:00:00Z' }),
        makeEntry({ date: '2026-04-03T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('3');
      expect(r['TIER']).toBe('welcome_back');
    });

    test('4 sessions → regular', () => {
      writeProfile(Array.from({ length: 4 }, (_, i) =>
        makeEntry({ date: `2026-04-0${i + 1}T00:00:00Z` })
      ));
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('4');
      expect(r['TIER']).toBe('regular');
    });

    test('7 sessions → regular', () => {
      writeProfile(Array.from({ length: 7 }, (_, i) =>
        makeEntry({ date: `2026-04-0${i + 1}T00:00:00Z` })
      ));
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('7');
      expect(r['TIER']).toBe('regular');
    });

    test('8 sessions → inner_circle', () => {
      writeProfile(Array.from({ length: 8 }, (_, i) =>
        makeEntry({ date: `2026-04-0${i + 1}T00:00:00Z` })
      ));
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('8');
      expect(r['TIER']).toBe('inner_circle');
    });

    test('15 sessions → inner_circle', () => {
      writeProfile(Array.from({ length: 15 }, (_, i) =>
        makeEntry({ date: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z` })
      ));
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('15');
      expect(r['TIER']).toBe('inner_circle');
    });
  });

  describe('signal accumulation', () => {
    test('accumulates signals across sessions', () => {
      writeProfile([
        makeEntry({ signal_count: 2, signals: ['named_users', 'pushback'] }),
        makeEntry({ signal_count: 1, signals: ['taste'], date: '2026-04-02T00:00:00Z' }),
        makeEntry({ signal_count: 2, signals: ['named_users', 'agency'], date: '2026-04-03T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['TOTAL_SIGNAL_COUNT']).toBe('5');
      expect(r['ACCUMULATED_SIGNALS']).toContain('named_users:2');
      expect(r['ACCUMULATED_SIGNALS']).toContain('pushback:1');
      expect(r['ACCUMULATED_SIGNALS']).toContain('taste:1');
      expect(r['ACCUMULATED_SIGNALS']).toContain('agency:1');
    });

    test('zero signals → empty accumulation', () => {
      writeProfile([makeEntry()]);
      const r = runProfile();
      expect(r['TOTAL_SIGNAL_COUNT']).toBe('0');
      expect(r['ACCUMULATED_SIGNALS']).toBe('');
    });
  });

  describe('cross-project detection', () => {
    test('same project consecutive → false', () => {
      writeProfile([
        makeEntry({ project_slug: 'app-a' }),
        makeEntry({ project_slug: 'app-a', date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['CROSS_PROJECT']).toBe('false');
    });

    test('different project consecutive → true', () => {
      writeProfile([
        makeEntry({ project_slug: 'app-a' }),
        makeEntry({ project_slug: 'app-b', date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['CROSS_PROJECT']).toBe('true');
    });

    test('single session → false', () => {
      writeProfile([makeEntry()]);
      const r = runProfile();
      expect(r['CROSS_PROJECT']).toBe('false');
    });
  });

  describe('nudge eligibility', () => {
    test('3+ builder sessions with 5+ signals → eligible', () => {
      writeProfile([
        makeEntry({ mode: 'builder', signal_count: 2, signals: ['taste', 'agency'] }),
        makeEntry({ mode: 'builder', signal_count: 2, signals: ['named_users', 'pushback'], date: '2026-04-02T00:00:00Z' }),
        makeEntry({ mode: 'builder', signal_count: 1, signals: ['domain_expertise'], date: '2026-04-03T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['NUDGE_ELIGIBLE']).toBe('true');
    });

    test('startup mode only → not eligible', () => {
      writeProfile([
        makeEntry({ mode: 'startup', signal_count: 3, signals: ['a', 'b', 'c'] }),
        makeEntry({ mode: 'startup', signal_count: 3, signals: ['d', 'e', 'f'], date: '2026-04-02T00:00:00Z' }),
        makeEntry({ mode: 'startup', signal_count: 3, signals: ['g', 'h', 'i'], date: '2026-04-03T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['NUDGE_ELIGIBLE']).toBe('false');
    });

    test('builder mode but <5 signals → not eligible', () => {
      writeProfile([
        makeEntry({ mode: 'builder', signal_count: 1, signals: ['taste'] }),
        makeEntry({ mode: 'builder', signal_count: 1, signals: ['agency'], date: '2026-04-02T00:00:00Z' }),
        makeEntry({ mode: 'builder', signal_count: 1, signals: ['pushback'], date: '2026-04-03T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['NUDGE_ELIGIBLE']).toBe('false');
    });

    test('<3 builder sessions → not eligible even with enough signals', () => {
      writeProfile([
        makeEntry({ mode: 'builder', signal_count: 3, signals: ['a', 'b', 'c'] }),
        makeEntry({ mode: 'builder', signal_count: 3, signals: ['d', 'e', 'f'], date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['NUDGE_ELIGIBLE']).toBe('false');
    });
  });

  describe('resource dedup', () => {
    test('aggregates resources across sessions', () => {
      writeProfile([
        makeEntry({ resources_shown: ['https://url1.com', 'https://url2.com'] }),
        makeEntry({ resources_shown: ['https://url2.com', 'https://url3.com'], date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['RESOURCES_SHOWN_COUNT']).toBe('3');
      expect(r['RESOURCES_SHOWN']).toContain('https://url1.com');
      expect(r['RESOURCES_SHOWN']).toContain('https://url2.com');
      expect(r['RESOURCES_SHOWN']).toContain('https://url3.com');
    });

    test('deduplicates identical URLs', () => {
      writeProfile([
        makeEntry({ resources_shown: ['https://same.com'] }),
        makeEntry({ resources_shown: ['https://same.com'], date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['RESOURCES_SHOWN_COUNT']).toBe('1');
    });

    test('empty resources → count 0', () => {
      writeProfile([makeEntry()]);
      const r = runProfile();
      expect(r['RESOURCES_SHOWN_COUNT']).toBe('0');
    });
  });

  describe('topics', () => {
    test('aggregates topics across sessions', () => {
      writeProfile([
        makeEntry({ topics: ['fintech', 'payments'] }),
        makeEntry({ topics: ['ai-product', 'fintech'], date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['TOPICS']).toContain('fintech');
      expect(r['TOPICS']).toContain('payments');
      expect(r['TOPICS']).toContain('ai-product');
    });
  });

  describe('last session data', () => {
    test('returns last session assignment and project', () => {
      writeProfile([
        makeEntry({ assignment: 'First task', project_slug: 'old-app' }),
        makeEntry({ assignment: 'Talk to users', project_slug: 'new-app', date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['LAST_ASSIGNMENT']).toBe('Talk to users');
      expect(r['LAST_PROJECT']).toBe('new-app');
    });

    test('returns last design doc', () => {
      writeProfile([
        makeEntry({ design_doc: 'path/to/design-1.md' }),
        makeEntry({ design_doc: 'path/to/design-2.md', date: '2026-04-02T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['LAST_DESIGN_TITLE']).toBe('path/to/design-2.md');
    });
  });

  describe('malformed JSONL handling', () => {
    test('skips malformed lines, counts valid ones', () => {
      const profileFile = path.join(tmpDir, 'builder-profile.jsonl');
      const lines = [
        JSON.stringify(makeEntry({ project_slug: 'good-1' })),
        'this is not json',
        '{broken json',
        JSON.stringify(makeEntry({ project_slug: 'good-2', date: '2026-04-02T00:00:00Z' })),
      ];
      fs.writeFileSync(profileFile, lines.join('\n') + '\n');
      const r = runProfile();
      expect(r['SESSION_COUNT']).toBe('2');
      expect(r['TIER']).toBe('welcome_back');
    });
  });

  describe('design count', () => {
    test('counts entries with non-empty design_doc', () => {
      writeProfile([
        makeEntry({ design_doc: 'path/design-1.md' }),
        makeEntry({ design_doc: '', date: '2026-04-02T00:00:00Z' }),
        makeEntry({ design_doc: 'path/design-2.md', date: '2026-04-03T00:00:00Z' }),
      ]);
      const r = runProfile();
      expect(r['DESIGN_COUNT']).toBe('2');
    });
  });
});
