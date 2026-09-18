import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runOverlayCaseLifecycle } from './helpers/overlay-lifecycle';
import { OVERLAY_CONTRACT } from './helpers/overlay-case-policy';

// Execute the private paid-case recording callbacks with free dependencies.
// This exercises their real source without opening the paid registration gate.
test('overlay recording failure retains partial evidence but counts only completed external records', async () => {
  const source = fs.readFileSync(process.env.OVERLAY_RECORDING_REVIEW_SOURCE ?? path.join(import.meta.dir, 'helpers/overlay-case.ts'), 'utf8');
  const saveStart = source.indexOf('function saveTrial(');
  const saveEnd = source.indexOf('\n}\n', saveStart) + 3;
  const trialStart = source.indexOf('recordTrial: (arm, index, outcome) => {');
  const aggregateStart = source.indexOf('recordAggregate: result =>', trialStart);
  const aggregateEnd = source.indexOf('cleanup: () =>', aggregateStart);
  if ([saveStart, trialStart, aggregateStart, aggregateEnd].some(index => index < 0) || saveEnd < 3) throw new Error('recording callback boundary changed');
  const trial = source.slice(trialStart + 'recordTrial: '.length, aggregateStart).trim().replace(/,$/, '');
  const aggregate = source.slice(aggregateStart + 'recordAggregate: '.length, aggregateEnd).trim().replace(/,$/, '');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-recording-regression-'));
  const fixture = { id: 'owned-recording', metricName: 'metric', model: 'free', trials: 1, concurrency: 1, comparison: { direction: 'higher_is_better', minimum: 0, maximum: 1 }, pass: () => true };
  const firstCause = new Error('owned first storage cause');
  const measurements: unknown[] = []; const trials: unknown[] = [];
  let failedWriteAttempts = 0; let summary: any;
  const stem = (_id: string, _attempt: number, arm: string, index: number) => `${arm}-${index}`;
  const failedMetadata = path.join(directory, 'overlay-on-0.json');
  const deps = {
    fs: { ...fs, writeFileSync: (file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (file === failedMetadata) { failedWriteAttempts++; throw firstCause; }
      return (fs.writeFileSync as any)(file, ...args);
    } }, path, OVERLAY_CONTRACT, TRANSCRIPTS_DIR: directory, trialArtifactStem: stem,
    snapshotWorkspace: () => ({}), workspaces: new Map(), before: new Map(), trials, fixture, attempt: 1, retries: new Map(),
    evalCollector: { addTest: (entry: unknown) => measurements.push(entry) },
    recordAggregate: (value: unknown) => { summary = value; },
  };
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    const { fs, path, OVERLAY_CONTRACT, TRANSCRIPTS_DIR, trialArtifactStem, snapshotWorkspace, workspaces, before, trials, fixture, attempt, retries, evalCollector, recordAggregate } = deps;
    ${source.slice(saveStart, saveEnd)}
    return { recordTrial: ${trial}, recordAggregate: ${aggregate} };
  `);
  const callbacks = new Function('deps', code)(deps);
  try {
    const result = await runOverlayCaseLifecycle({ fixture: fixture as any, workMs: 1000, graceMs: 50,
      execute: async arm => ({ passed: true, taskCorrect: true, metric: arm === 'overlay-on' ? 1 : 0, exitReason: 'success', after: {}, result: { costUsd: arm === 'overlay-on' ? .75 : .25, events: [] } as any }),
      ...callbacks, cleanup: async () => {},
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(['trial record failed: owned first storage cause']);
    expect(failedWriteAttempts).toBe(1);
    expect(fs.existsSync(path.join(directory, 'overlay-on-0.jsonl'))).toBe(true);
    expect(fs.existsSync(failedMetadata)).toBe(false);
    expect(fs.existsSync(path.join(directory, 'overlay-off-0.json'))).toBe(true);
    expect(measurements).toHaveLength(1);
    expect(summary.startedTrials).toBe(2);
    expect(summary.recordedTrials).toBe(1);
    expect(summary.recordedCostUsd).toBe(.25);
    expect(summary.partialEvidence).toBe(true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('versioned aggregate keeps false efficacy and cannot overwrite earlier attempt evidence', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'helpers/overlay-case.ts'), 'utf8');
  const start = source.indexOf('const recordAggregate = (value:');
  const end = source.indexOf('\n    try {', start);
  if (start < 0 || end < 0) throw new Error('aggregate callback boundary changed');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-aggregate-contract-'));
  const entries: any[] = [];
  const fixture = { id: 'owned-contract', metricName: 'bash_tool_calls', model: 'free' };
  const deps = {
    fs, path, OVERLAY_CONTRACT, TRANSCRIPTS_DIR: directory, fixture, started: Date.now(),
    evalCollector: { addTest: (entry: unknown) => entries.push(entry) }, console: { log: () => {} },
  };
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    const { fs, path, OVERLAY_CONTRACT, TRANSCRIPTS_DIR, fixture, started, evalCollector, console } = deps;
    let summary; let aggregateRecorded = false;
    ${source.slice(start, end)}
    return recordAggregate;
  `);
  const recorder = new Function('deps', 'attempt', code);
  const verdict = { passed: true, assessment: { comparison: { status: 'baseline_saturated', criterionMet: false } } };
  try {
    const first = recorder(deps, 1);
    first(verdict);
    first({ passed: false }); // the same callback records only once
    const file = path.join(directory, 'owned-contract-attempt-1-aggregate.json');
    const original = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(original)).toMatchObject({ ...verdict, contract: OVERLAY_CONTRACT });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'owned-contract-contract-v2-aggregate', passed: true, cost_usd: 0, duration_ms: 0 });
    expect(() => recorder(deps, 1)({ passed: false })).toThrow('EEXIST');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    recorder(deps, 2)({ passed: false, errors: ['task incomplete'] });
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'owned-contract-attempt-2-aggregate.json'), 'utf8'))).toMatchObject({
      contract: OVERLAY_CONTRACT, passed: false, errors: ['task incomplete'],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(entries).toHaveLength(2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
