import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  EvalCollector,
  extractToolSummary,
  findPreviousRun,
  findLatestFinalizedRun,
  isPartialEval,
  listEvalJsonFiles,
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

/** Capture everything a block writes to stderr (finalize prints there). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as any).write = (chunk: any) => { captured += String(chunk); return true; };
  try {
    await fn();
  } finally {
    (process.stderr as any).write = original;
  }
  return captured;
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
    expect(data.schema_version).toBe(2);
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

  test('with no completed prior run, says NO BASELINE instead of comparing against its own partial', async () => {
    // addTest writes the in-progress accumulator into the same dir. If that
    // counted as a baseline, the run would compare against itself and print a
    // reassuring all-clear forever.
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry({ name: 'test-1', passed: true }));

    const output = await captureStderr(async () => { await collector.finalize(); });

    expect(fs.existsSync(path.join(tmpDir, '_partial-e2e.json'))).toBe(true); // the trap exists
    expect(output).toContain('NO BASELINE');
    expect(output).not.toContain('vs previous');
    expect(output).not.toContain('Stable run');
  });

  test('with a genuine prior run, reports the real delta', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '0.3.5-main-e2e-20260312-100000.json'),
      JSON.stringify(makeResult({
        timestamp: '2026-03-12T10:00:00Z',
        tests: [makeEntry({ name: 'test-1', passed: true, turns_used: 5 })],
      })),
    );

    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry({ name: 'test-1', passed: false, turns_used: 5 }));

    const output = await captureStderr(async () => { await collector.finalize(); });

    expect(output).toContain('vs previous');
    expect(output).toContain('REGRESSION');
    expect(output).toContain('1 regressed');
    expect(output).not.toContain('NO BASELINE');
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

// --- GSTACK_EVAL_DIR + shard slug tests ---

describe('EvalCollector eval-dir resolution', () => {
  const savedEnv = process.env.GSTACK_EVAL_DIR;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GSTACK_EVAL_DIR;
    else process.env.GSTACK_EVAL_DIR = savedEnv;
  });

  test('honors GSTACK_EVAL_DIR set after import — no --preload needed', async () => {
    // The default eval dir must resolve lazily at construction, not at module
    // load: the sharded runner sets GSTACK_EVAL_DIR in each shard child's env
    // and shard tests import this module long before any collector exists.
    const envDir = path.join(tmpDir, 'env-dir');
    process.env.GSTACK_EVAL_DIR = envDir;
    const collector = new EvalCollector('e2e');
    collector.addTest(makeEntry());
    await captureStderr(async () => { await collector.finalize(); });
    expect(fs.readdirSync(envDir).filter(f => !f.startsWith('_partial'))).toHaveLength(1);
  });

  test('explicit constructor arg beats GSTACK_EVAL_DIR', async () => {
    process.env.GSTACK_EVAL_DIR = path.join(tmpDir, 'env-dir');
    const explicit = path.join(tmpDir, 'explicit');
    const collector = new EvalCollector('e2e', explicit);
    collector.addTest(makeEntry());
    await captureStderr(async () => { await collector.finalize(); });
    expect(fs.existsSync(path.join(tmpDir, 'env-dir'))).toBe(false);
    expect(fs.readdirSync(explicit).length).toBeGreaterThan(0);
  });

  test('writes the shard slug when the eval dir is a shards/ subdir', async () => {
    const shardDir = path.join(tmpDir, 'shards', 'skill-e2e-qa');
    const collector = new EvalCollector('e2e', shardDir);
    collector.addTest(makeEntry());
    await captureStderr(async () => { await collector.finalize(); });

    const partial = JSON.parse(fs.readFileSync(path.join(shardDir, '_partial-e2e.json'), 'utf-8'));
    expect(partial.shard).toBe('skill-e2e-qa');
    const final = fs.readdirSync(shardDir).find(f => !f.startsWith('_partial'))!;
    expect(JSON.parse(fs.readFileSync(path.join(shardDir, final), 'utf-8')).shard).toBe('skill-e2e-qa');
  });

  test('writes no shard slug for a flat eval dir', async () => {
    const collector = new EvalCollector('e2e', tmpDir);
    collector.addTest(makeEntry());
    await captureStderr(async () => { await collector.finalize(); });
    const final = fs.readdirSync(tmpDir).find(f => f.endsWith('.json') && !f.startsWith('_partial'))!;
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, final), 'utf-8')).shard).toBeUndefined();
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

  test('never returns the in-progress accumulator as a baseline', () => {
    // The current run's own partial carries the current tier + branch and the
    // freshest timestamp. If it were a candidate, every run would compare
    // against itself and report "no regressions" forever.
    fs.writeFileSync(
      path.join(tmpDir, '_partial-e2e.json'),
      JSON.stringify(makeResult({ branch: 'main', timestamp: '2026-03-14T10:00:00Z', _partial: true })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', path.join(tmpDir, 'current.json'));
    expect(result).toBeNull();
  });

  test('prefers a completed run over a newer in-progress accumulator', () => {
    fs.writeFileSync(
      path.join(tmpDir, '0.3.5-main-e2e-20260312-100000.json'),
      JSON.stringify(makeResult({ branch: 'main', timestamp: '2026-03-12T10:00:00Z' })),
    );
    // Newer, same tier + branch, but in-progress — must lose to the older completed run.
    fs.writeFileSync(
      path.join(tmpDir, '_partial-e2e.json'),
      JSON.stringify(makeResult({ branch: 'main', timestamp: '2026-03-14T10:00:00Z', _partial: true })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', path.join(tmpDir, 'current.json'));
    expect(result).toContain('0.3.5-main-e2e');
  });

  test('filters by tier', () => {
    fs.writeFileSync(
      path.join(tmpDir, '0.3.6-main-llm-judge-20260314-100000.json'),
      JSON.stringify(makeResult({ tier: 'llm-judge', branch: 'main', timestamp: '2026-03-14T10:00:00Z' })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', 'current.json');
    expect(result).toBeNull(); // only llm-judge file, looking for e2e
  });

  test('a shard run prefers its own shard history over newer other-shard or flat priors', () => {
    const mine = path.join(tmpDir, 'shards', 'skill-e2e-qa');
    const other = path.join(tmpDir, 'shards', 'codex-e2e');
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    // Same-shard prior — oldest of the three, must still win.
    fs.writeFileSync(
      path.join(mine, '0.3.4-main-e2e-20260311-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-11T10:00:00Z' })),
    );
    fs.writeFileSync(
      path.join(other, '0.3.5-main-e2e-20260312-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-12T10:00:00Z' })),
    );
    fs.writeFileSync(
      path.join(tmpDir, '0.3.6-main-e2e-20260313-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-13T10:00:00Z' })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', path.join(mine, 'current.json'));
    expect(result).toContain(path.join('shards', 'skill-e2e-qa'));
  });

  test('a flat run prefers flat history over a newer shard prior', () => {
    const shardDir = path.join(tmpDir, 'shards', 'skill-e2e-qa');
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(
      path.join(shardDir, '0.3.6-main-e2e-20260314-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-14T10:00:00Z' })),
    );
    fs.writeFileSync(
      path.join(tmpDir, '0.3.5-main-e2e-20260312-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-12T10:00:00Z' })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', path.join(tmpDir, 'current.json'));
    expect(result).toContain('0.3.5-main-e2e');
  });

  test('falls back to a shard prior when the flat dir has no candidate', () => {
    const shardDir = path.join(tmpDir, 'shards', 'skill-e2e-qa');
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(
      path.join(shardDir, '0.3.6-main-e2e-20260314-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-14T10:00:00Z' })),
    );

    const result = findPreviousRun(tmpDir, 'e2e', 'main', path.join(tmpDir, 'current.json'));
    expect(result).toContain(path.join('shards', 'skill-e2e-qa'));
  });
});

// --- isPartialEval tests ---

describe('isPartialEval', () => {
  test('flag set but file renamed — still partial', () => {
    expect(isPartialEval({ _partial: true }, 'renamed-to-look-final.json')).toBe(true);
  });

  test('name matches but no flag — still partial', () => {
    expect(isPartialEval({}, '_partial-e2e.json')).toBe(true);
    expect(isPartialEval(null, path.join('/some/dir', '_partial-e2e.json'))).toBe(true);
  });

  test('finalized run is not partial', () => {
    expect(isPartialEval(makeResult(), '0.3.6-main-e2e-20260314-100000.json')).toBe(false);
  });
});

// --- listEvalJsonFiles / findLatestFinalizedRun tests ---

describe('findLatestFinalizedRun', () => {
  test('listEvalJsonFiles recurses exactly one shards/*/ level', () => {
    fs.writeFileSync(path.join(tmpDir, 'flat.json'), '{}');
    const shardDir = path.join(tmpDir, 'shards', 'skill-e2e-qa');
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(path.join(shardDir, 'sharded.json'), '{}');
    // Nested one level deeper than the contract — must NOT be picked up.
    const tooDeep = path.join(shardDir, 'shards', 'nested');
    fs.mkdirSync(tooDeep, { recursive: true });
    fs.writeFileSync(path.join(tooDeep, 'too-deep.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'not-json.txt'), '');

    const files = listEvalJsonFiles(tmpDir).map(f => path.basename(f)).sort();
    expect(files).toEqual(['flat.json', 'sharded.json']);
  });

  test('finds the newest finalized run across flat dir and shard subdirs', () => {
    fs.writeFileSync(
      path.join(tmpDir, '0.3.5-main-e2e-20260312-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-12T10:00:00Z' })),
    );
    const shardDir = path.join(tmpDir, 'shards', 'skill-e2e-qa');
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(
      path.join(shardDir, '0.3.6-main-e2e-20260314-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-14T10:00:00Z' })),
    );

    const latest = findLatestFinalizedRun(tmpDir, 'e2e');
    expect(latest?.filepath).toContain('skill-e2e-qa');
    expect(latest?.result.timestamp).toBe('2026-03-14T10:00:00Z');
  });

  test('skips partials by flag and by name, filters by tier', () => {
    // Newest by timestamp, but partial by flag under a shard dir.
    const shardDir = path.join(tmpDir, 'shards', 'skill-e2e-qa');
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(
      path.join(shardDir, 'flagged.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-16T10:00:00Z', _partial: true })),
    );
    // Partial by name only.
    fs.writeFileSync(
      path.join(tmpDir, '_partial-e2e.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-15T10:00:00Z' })),
    );
    // Wrong tier.
    fs.writeFileSync(
      path.join(tmpDir, '0.3.6-main-llm-judge-20260317-100000.json'),
      JSON.stringify(makeResult({ tier: 'llm-judge', timestamp: '2026-03-17T10:00:00Z' })),
    );
    // The genuine baseline.
    fs.writeFileSync(
      path.join(tmpDir, '0.3.5-main-e2e-20260312-100000.json'),
      JSON.stringify(makeResult({ timestamp: '2026-03-12T10:00:00Z' })),
    );

    const latest = findLatestFinalizedRun(tmpDir, 'e2e');
    expect(latest?.result.timestamp).toBe('2026-03-12T10:00:00Z');
  });

  test('returns null for missing dir or no finalized runs', () => {
    expect(findLatestFinalizedRun('/nonexistent/path', 'e2e')).toBeNull();
    expect(findLatestFinalizedRun(tmpDir, 'e2e')).toBeNull();
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

  test('says NO BASELINE instead of "stable" when nothing matched the prior run', () => {
    // A baseline file existed but shares no test names (renamed/retired suite),
    // so zero tests were actually compared. Claiming stability here is a lie.
    const c: ComparisonResult = {
      before_file: 'a.json', after_file: 'b.json',
      before_branch: 'main', after_branch: 'main',
      before_timestamp: '', after_timestamp: '',
      deltas: [
        { name: 'a', before: { passed: false, cost_usd: 0 }, after: { passed: true, cost_usd: 0.10 }, status_change: 'unchanged' },
        { name: 'b', before: { passed: false, cost_usd: 0 }, after: { passed: true, cost_usd: 0.10 }, status_change: 'unchanged' },
        { name: 'c', before: { passed: false, cost_usd: 0 }, after: { passed: true, cost_usd: 0.10 }, status_change: 'unchanged' },
      ],
      total_cost_delta: 0.30, total_duration_delta: 0,
      improved: 0, regressed: 0, unchanged: 3,
      tool_count_before: 0, tool_count_after: 0,
      matched: 0,
    };

    const notes = generateCommentary(c);
    expect(notes.some(n => n.includes('NO BASELINE'))).toBe(true);
    expect(notes.some(n => n.includes('Stable run'))).toBe(false);
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
