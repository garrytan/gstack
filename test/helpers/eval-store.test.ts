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
  generateCommentary,
  judgePassed,
} from './eval-store';
import type { EvalResult, EvalTestEntry, ComparisonResult } from './eval-store';

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
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.json') && !f.startsWith('_partial'))).toHaveLength(1);
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

  test('finalize aggregates per-test costs into result-level costs[]', async () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry({
      name: 'test-a',
      costs: [{ model: 'claude-sonnet-4-6', calls: 1, input_tokens: 100, output_tokens: 50, cost_usd: 0.01 }],
    }));
    collector.addTest(makeEntry({
      name: 'test-b',
      costs: [{ model: 'claude-sonnet-4-6', calls: 1, input_tokens: 200, output_tokens: 100, cost_usd: 0.02 }],
    }));
    collector.addTest(makeEntry({
      name: 'test-c',
      costs: [{ model: 'claude-haiku-4-5', calls: 1, input_tokens: 50, output_tokens: 25, cost_usd: 0.005 }],
    }));

    const filepath = await collector.finalize();
    const data: EvalResult = JSON.parse(fs.readFileSync(filepath, 'utf-8'));

    expect(data.costs).toBeDefined();
    expect(data.costs).toHaveLength(2); // two models
    const sonnet = data.costs!.find(c => c.model === 'claude-sonnet-4-6');
    const haiku = data.costs!.find(c => c.model === 'claude-haiku-4-5');
    expect(sonnet).toBeDefined();
    expect(sonnet!.calls).toBe(2);
    expect(sonnet!.input_tokens).toBe(300);
    expect(sonnet!.output_tokens).toBe(150);
    expect(sonnet!.cost_usd).toBeCloseTo(0.03);
    expect(haiku).toBeDefined();
    expect(haiku!.calls).toBe(1);
    expect(haiku!.cost_usd).toBeCloseTo(0.005);
  });

  test('finalize omits costs when no tests have cost data', async () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry({ name: 'no-costs' }));
    const filepath = await collector.finalize();
    const data: EvalResult = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(data.costs).toBeUndefined();
  });

  test('finalize aggregates cache token fields', async () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry({
      name: 'test-a',
      costs: [{
        model: 'claude-sonnet-4-6', calls: 1,
        input_tokens: 10, output_tokens: 50,
        cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000,
        cost_usd: 0.01,
      }],
    }));
    collector.addTest(makeEntry({
      name: 'test-b',
      costs: [{
        model: 'claude-sonnet-4-6', calls: 1,
        input_tokens: 20, output_tokens: 100,
        cache_read_input_tokens: 8000, cache_creation_input_tokens: 500,
        cost_usd: 0.02,
      }],
    }));

    const filepath = await collector.finalize();
    const data: EvalResult = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const sonnet = data.costs!.find(c => c.model === 'claude-sonnet-4-6')!;
    expect(sonnet.cache_read_input_tokens).toBe(13000);
    expect(sonnet.cache_creation_input_tokens).toBe(1500);
  });
});

// --- judgePassed tests ---

describe('judgePassed', () => {
  test('passes when all thresholds met', () => {
    expect(judgePassed(
      { detection_rate: 3, false_positives: 1, evidence_quality: 3 },
      { minimum_detection: 2, max_false_positives: 2 },
    )).toBe(true);
  });

  test('fails when detection rate below minimum', () => {
    expect(judgePassed(
      { detection_rate: 1, false_positives: 0, evidence_quality: 3 },
      { minimum_detection: 2, max_false_positives: 2 },
    )).toBe(false);
  });

  test('fails when too many false positives', () => {
    expect(judgePassed(
      { detection_rate: 3, false_positives: 3, evidence_quality: 3 },
      { minimum_detection: 2, max_false_positives: 2 },
    )).toBe(false);
  });

  test('fails when evidence quality below 2', () => {
    expect(judgePassed(
      { detection_rate: 3, false_positives: 0, evidence_quality: 1 },
      { minimum_detection: 2, max_false_positives: 2 },
    )).toBe(false);
  });

  test('passes at exact thresholds', () => {
    expect(judgePassed(
      { detection_rate: 2, false_positives: 2, evidence_quality: 2 },
      { minimum_detection: 2, max_false_positives: 2 },
    )).toBe(true);
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
          before: { passed: true, cost_usd: 0.07, turns_used: 6, duration_ms: 24000, tool_summary: { Bash: 3 } },
          after: { passed: true, cost_usd: 0.06, turns_used: 5, duration_ms: 19000, tool_summary: { Bash: 4 } },
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
    // Turns and duration deltas
    expect(output).toContain('6→5t');
    expect(output).toContain('24→19s');
  });

  test('includes commentary section', () => {
    const comparison: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '2026-03-13T14:30:00Z',
      after_timestamp: '2026-03-14T14:30:00Z',
      deltas: [
        {
          name: 'test-a',
          before: { passed: true, cost_usd: 0.50, turns_used: 20, duration_ms: 120000 },
          after: { passed: true, cost_usd: 0.30, turns_used: 10, duration_ms: 60000 },
          status_change: 'unchanged',
        },
        {
          name: 'test-b',
          before: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 },
          after: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 },
          status_change: 'unchanged',
        },
        {
          name: 'test-c',
          before: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 },
          after: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 },
          status_change: 'unchanged',
        },
      ],
      total_cost_delta: -0.20,
      total_duration_delta: -60000,
      improved: 0, regressed: 0, unchanged: 3,
      tool_count_before: 30, tool_count_after: 20,
    };

    const output = formatComparison(comparison);
    expect(output).toContain('Takeaway');
    expect(output).toContain('fewer turns');
    expect(output).toContain('faster');
  });
});

// --- generateCommentary tests ---

describe('generateCommentary', () => {
  test('flags regressions prominently', () => {
    const c: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '', after_timestamp: '',
      deltas: [{
        name: 'critical-test',
        before: { passed: true, cost_usd: 0.10 },
        after: { passed: false, cost_usd: 0.10 },
        status_change: 'regressed',
      }],
      total_cost_delta: 0, total_duration_delta: 0,
      improved: 0, regressed: 1, unchanged: 0,
      tool_count_before: 0, tool_count_after: 0,
    };

    const notes = generateCommentary(c);
    expect(notes.some(n => n.includes('REGRESSION'))).toBe(true);
    expect(notes.some(n => n.includes('critical-test'))).toBe(true);
  });

  test('notes improvements', () => {
    const c: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '', after_timestamp: '',
      deltas: [{
        name: 'fixed-test',
        before: { passed: false, cost_usd: 0.10 },
        after: { passed: true, cost_usd: 0.10 },
        status_change: 'improved',
      }],
      total_cost_delta: 0, total_duration_delta: 0,
      improved: 1, regressed: 0, unchanged: 0,
      tool_count_before: 0, tool_count_after: 0,
    };

    const notes = generateCommentary(c);
    expect(notes.some(n => n.includes('Fixed'))).toBe(true);
    expect(notes.some(n => n.includes('fixed-test'))).toBe(true);
  });

  test('reports efficiency gains for stable tests', () => {
    const c: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '', after_timestamp: '',
      deltas: [{
        name: 'fast-test',
        before: { passed: true, cost_usd: 0.50, turns_used: 20, duration_ms: 120000 },
        after: { passed: true, cost_usd: 0.25, turns_used: 10, duration_ms: 60000 },
        status_change: 'unchanged',
      }],
      total_cost_delta: -0.25, total_duration_delta: -60000,
      improved: 0, regressed: 0, unchanged: 1,
      tool_count_before: 0, tool_count_after: 0,
    };

    const notes = generateCommentary(c);
    expect(notes.some(n => n.includes('fewer turns'))).toBe(true);
    expect(notes.some(n => n.includes('faster'))).toBe(true);
    expect(notes.some(n => n.includes('cheaper'))).toBe(true);
  });

  test('reports detection rate changes', () => {
    const c: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '', after_timestamp: '',
      deltas: [{
        name: 'detection-test',
        before: { passed: true, cost_usd: 0.50, detection_rate: 3 },
        after: { passed: true, cost_usd: 0.50, detection_rate: 5 },
        status_change: 'unchanged',
      }],
      total_cost_delta: 0, total_duration_delta: 0,
      improved: 0, regressed: 0, unchanged: 1,
      tool_count_before: 0, tool_count_after: 0,
    };

    const notes = generateCommentary(c);
    expect(notes.some(n => n.includes('detecting 2 more bugs'))).toBe(true);
  });

  test('produces overall summary for 3+ tests with no regressions', () => {
    const c: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '', after_timestamp: '',
      deltas: [
        { name: 'a', before: { passed: true, cost_usd: 0.50, turns_used: 10, duration_ms: 60000 },
          after: { passed: true, cost_usd: 0.30, turns_used: 6, duration_ms: 40000 }, status_change: 'unchanged' },
        { name: 'b', before: { passed: true, cost_usd: 0.20, turns_used: 5, duration_ms: 30000 },
          after: { passed: true, cost_usd: 0.15, turns_used: 4, duration_ms: 25000 }, status_change: 'unchanged' },
        { name: 'c', before: { passed: true, cost_usd: 0.10, turns_used: 3, duration_ms: 20000 },
          after: { passed: true, cost_usd: 0.08, turns_used: 3, duration_ms: 18000 }, status_change: 'unchanged' },
      ],
      total_cost_delta: -0.27, total_duration_delta: -27000,
      improved: 0, regressed: 0, unchanged: 3,
      tool_count_before: 0, tool_count_after: 0,
    };

    const notes = generateCommentary(c);
    expect(notes.some(n => n.includes('Overall'))).toBe(true);
    expect(notes.some(n => n.includes('No regressions'))).toBe(true);
  });

  test('returns empty for stable run with no significant changes', () => {
    const c: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '', after_timestamp: '',
      deltas: [
        { name: 'a', before: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 },
          after: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 21000 }, status_change: 'unchanged' },
        { name: 'b', before: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 },
          after: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 }, status_change: 'unchanged' },
        { name: 'c', before: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 },
          after: { passed: true, cost_usd: 0.10, turns_used: 5, duration_ms: 20000 }, status_change: 'unchanged' },
      ],
      total_cost_delta: 0, total_duration_delta: 1000,
      improved: 0, regressed: 0, unchanged: 3,
      tool_count_before: 15, tool_count_after: 15,
    };

    const notes = generateCommentary(c);
    expect(notes.some(n => n.includes('Stable run'))).toBe(true);
  });
});
