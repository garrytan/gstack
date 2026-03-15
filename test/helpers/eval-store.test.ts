import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  EvalCollector,
  extractToolSummary,
  findPreviousRun,
  compareEvalResults,
  formatComparison,
} from './eval-store';
import type { EvalResult, EvalTestEntry } from './eval-store';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-store-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// --- Helper to make a minimal test entry ---

function makeEntry(overrides?: Partial<EvalTestEntry>): EvalTestEntry {
  return {
    name: 'test-1',
    suite: 'suite-1',
    tier: 'e2e',
    passed: true,
    duration_ms: 1000,
    cost_usd: 0.05,
    ...overrides,
  };
}

// --- Helper to make a minimal EvalResult ---

function makeResult(overrides?: Partial<EvalResult>): EvalResult {
  return {
    schema_version: 1,
    version: '0.3.6',
    branch: 'main',
    git_sha: 'abc1234',
    timestamp: '2026-03-14T12:00:00.000Z',
    hostname: 'test-host',
    tier: 'e2e',
    total_tests: 1,
    passed: 1,
    failed: 0,
    total_cost_usd: 0.05,
    total_duration_ms: 1000,
    tests: [makeEntry()],
    ...overrides,
  };
}

// --- EvalCollector tests ---

describe('EvalCollector', () => {
  test('addTest accumulates entries', () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry({ name: 'a' }));
    collector.addTest(makeEntry({ name: 'b' }));
    collector.addTest(makeEntry({ name: 'c' }));
    // We can't inspect tests directly, but finalize will write them
  });

  test('finalize writes JSON file to eval dir', async () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry());
    const filepath = await collector.finalize();

    expect(filepath).toBeTruthy();
    expect(fs.existsSync(filepath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(data.tests).toHaveLength(1);
    expect(data.tests[0].name).toBe('test-1');
  });

  test('written JSON has correct schema fields', async () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry({ passed: true, cost_usd: 0.10, duration_ms: 2000 }));
    collector.addTest(makeEntry({ name: 'test-2', passed: false, cost_usd: 0.05, duration_ms: 1000 }));
    const filepath = await collector.finalize();

    const data: EvalResult = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(data.schema_version).toBe(1);
    expect(data.tier).toBe('e2e');
    expect(data.total_tests).toBe(2);
    expect(data.passed).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.total_cost_usd).toBe(0.15);
    expect(data.total_duration_ms).toBe(3000);
    expect(data.timestamp).toBeTruthy();
    expect(data.hostname).toBeTruthy();
  });

  test('finalize creates directory if missing', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'deep', 'evals');
    const collector = new EvalCollector('e2e', nestedDir);
    collector.addTest(makeEntry());
    const filepath = await collector.finalize();
    expect(fs.existsSync(filepath)).toBe(true);
  });

  test('double finalize does not write twice', async () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry());
    const filepath1 = await collector.finalize();
    const filepath2 = await collector.finalize();

    expect(filepath1).toBeTruthy();
    expect(filepath2).toBe(''); // second call returns empty
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  test('empty collector writes valid file', async () => {
    const collector = new EvalCollector('llm-judge', tmpDir);
    const filepath = await collector.finalize();

    const data: EvalResult = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(data.total_tests).toBe(0);
    expect(data.passed).toBe(0);
    expect(data.tests).toHaveLength(0);
    expect(data.tier).toBe('llm-judge');
  });
});

// --- extractToolSummary tests ---

describe('extractToolSummary', () => {
  test('counts tool types from transcript events', () => {
    const transcript = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: {} },
      ] } },
      { type: 'user', tool_use_result: { stdout: '' } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', name: 'Read', input: {} },
      ] } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'tool_use', name: 'Write', input: {} },
      ] } },
    ];

    const summary = extractToolSummary(transcript);
    expect(summary).toEqual({ Bash: 2, Read: 1, Write: 1 });
  });

  test('returns empty object for empty transcript', () => {
    expect(extractToolSummary([])).toEqual({});
  });

  test('handles events with no content array', () => {
    const transcript = [
      { type: 'assistant', message: {} },
      { type: 'assistant' },
    ];
    expect(extractToolSummary(transcript)).toEqual({});
  });
});

// --- findPreviousRun tests ---

describe('findPreviousRun', () => {
  test('finds correct file — same branch preferred, most recent', () => {
    // Write three eval files
    const files = [
      { name: '0.3.5-main-e2e-20260312-100000.json', data: makeResult({ branch: 'main', timestamp: '2026-03-12T10:00:00Z' }) },
      { name: '0.3.5-feature-e2e-20260313-100000.json', data: makeResult({ branch: 'feature', timestamp: '2026-03-13T10:00:00Z' }) },
      { name: '0.3.6-feature-e2e-20260314-100000.json', data: makeResult({ branch: 'feature', timestamp: '2026-03-14T10:00:00Z' }) },
    ];
    for (const f of files) {
      fs.writeFileSync(path.join(tmpDir, f.name), JSON.stringify(f.data));
    }

    // Should prefer feature branch (most recent on same branch)
    const result = findPreviousRun(tmpDir, 'e2e', 'feature', path.join(tmpDir, 'current.json'));
    expect(result).toContain('0.3.6-feature-e2e-20260314');
  });

  test('falls back to different branch when no same-branch match', () => {
    const files = [
      { name: '0.3.5-main-e2e-20260312-100000.json', data: makeResult({ branch: 'main', timestamp: '2026-03-12T10:00:00Z' }) },
    ];
    for (const f of files) {
      fs.writeFileSync(path.join(tmpDir, f.name), JSON.stringify(f.data));
    }

    const result = findPreviousRun(tmpDir, 'e2e', 'new-branch', path.join(tmpDir, 'current.json'));
    expect(result).toContain('0.3.5-main-e2e');
  });

  test('returns null when no prior runs exist', () => {
    const result = findPreviousRun(tmpDir, 'e2e', 'main', path.join(tmpDir, 'current.json'));
    expect(result).toBeNull();
  });

  test('returns null when directory does not exist', () => {
    const result = findPreviousRun('/nonexistent/path', 'e2e', 'main', 'current.json');
    expect(result).toBeNull();
  });

  test('excludes the current file from results', () => {
    const filename = '0.3.6-main-e2e-20260314-100000.json';
    fs.writeFileSync(
      path.join(tmpDir, filename),
      JSON.stringify(makeResult({ branch: 'main', timestamp: '2026-03-14T10:00:00Z' })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', path.join(tmpDir, filename));
    expect(result).toBeNull(); // only file is excluded
  });

  test('filters by tier', () => {
    fs.writeFileSync(
      path.join(tmpDir, '0.3.6-main-llm-judge-20260314-100000.json'),
      JSON.stringify(makeResult({ tier: 'llm-judge', branch: 'main', timestamp: '2026-03-14T10:00:00Z' })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', 'current.json');
    expect(result).toBeNull(); // only llm-judge file, looking for e2e
  });
});

// --- compareEvalResults tests ---

describe('compareEvalResults', () => {
  test('detects improved/regressed/unchanged per test', () => {
    const before = makeResult({
      tests: [
        makeEntry({ name: 'test-a', passed: false }),
        makeEntry({ name: 'test-b', passed: true }),
        makeEntry({ name: 'test-c', passed: true }),
      ],
      total_tests: 3, passed: 2, failed: 1,
    });
    const after = makeResult({
      tests: [
        makeEntry({ name: 'test-a', passed: true }),   // improved
        makeEntry({ name: 'test-b', passed: false }),  // regressed
        makeEntry({ name: 'test-c', passed: true }),   // unchanged
      ],
      total_tests: 3, passed: 2, failed: 1,
    });

    const result = compareEvalResults(before, after, 'before.json', 'after.json');
    expect(result.improved).toBe(1);
    expect(result.regressed).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.deltas.find(d => d.name === 'test-a')?.status_change).toBe('improved');
    expect(result.deltas.find(d => d.name === 'test-b')?.status_change).toBe('regressed');
    expect(result.deltas.find(d => d.name === 'test-c')?.status_change).toBe('unchanged');
  });

  test('handles tests present in one run but not the other', () => {
    const before = makeResult({
      tests: [
        makeEntry({ name: 'old-test', passed: true }),
        makeEntry({ name: 'shared', passed: true }),
      ],
    });
    const after = makeResult({
      tests: [
        makeEntry({ name: 'shared', passed: true }),
        makeEntry({ name: 'new-test', passed: true }),
      ],
    });

    const result = compareEvalResults(before, after, 'before.json', 'after.json');
    expect(result.deltas).toHaveLength(3); // shared + new-test + old-test (removed)
    expect(result.deltas.find(d => d.name.includes('old-test'))?.name).toContain('removed');
  });

  test('computes cost and duration deltas', () => {
    const before = makeResult({ total_cost_usd: 2.00, total_duration_ms: 60000 });
    const after = makeResult({ total_cost_usd: 1.50, total_duration_ms: 45000 });

    const result = compareEvalResults(before, after, 'a.json', 'b.json');
    expect(result.total_cost_delta).toBe(-0.50);
    expect(result.total_duration_delta).toBe(-15000);
  });
});

// --- formatComparison tests ---

describe('formatComparison', () => {
  test('produces readable output with status arrows', () => {
    const comparison: ComparisonResult = {
      before_file: 'before.json',
      after_file: 'after.json',
      before_branch: 'main',
      after_branch: 'feature',
      before_timestamp: '2026-03-13T14:30:00Z',
      after_timestamp: '2026-03-14T14:30:00Z',
      deltas: [
        {
          name: 'browse basic',
          before: { passed: true, cost_usd: 0.07, tool_summary: { Bash: 3 } },
          after: { passed: true, cost_usd: 0.06, tool_summary: { Bash: 4 } },
          status_change: 'unchanged',
        },
        {
          name: 'planted bugs static',
          before: { passed: false, cost_usd: 1.00, detection_rate: 3, tool_summary: {} },
          after: { passed: true, cost_usd: 0.95, detection_rate: 4, tool_summary: {} },
          status_change: 'improved',
        },
      ],
      total_cost_delta: -0.06,
      total_duration_delta: -5000,
      improved: 1,
      regressed: 0,
      unchanged: 1,
      tool_count_before: 3,
      tool_count_after: 4,
    };

    const output = formatComparison(comparison);
    expect(output).toContain('vs previous');
    expect(output).toContain('main');
    expect(output).toContain('1 improved');
    expect(output).toContain('1 unchanged');
    expect(output).toContain('↑'); // improved arrow
    expect(output).toContain('='); // unchanged arrow
  });
});
