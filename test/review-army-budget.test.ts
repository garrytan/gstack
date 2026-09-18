import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test('consensus drains its timed-out capture before Bun retries or removes the fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-army-finalization-'));
  try {
    const script = path.join(dir, 'consensus.test.ts');
    fs.writeFileSync(script, `
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSkillSections, REVIEW_ARMY_E2E_SECTIONS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/skill-fixture.ts'))};
const root = ${JSON.stringify(ROOT)};
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  fs.readFileSync(path.join(root, 'test/skill-e2e-review-army.test.ts'), 'utf8'),
).replace(/^import\\b[^;]*;\\s*$/gm, '');
let attempts = 0;
const records = [], registrations = [], captureOptions = [];
// These scaled values exercise native Bun retry/afterAll ordering without a
// provider. Capture returns only after its work timeout and a separate drain.
const captureMs = 100, drainMs = 40;
const run = async opts => {
  const attempt = ++attempts;
  captureOptions.push({ timeout: opts.timeout, maxTurns: opts.maxTurns });
  if (attempt === 1) await Bun.sleep(captureMs + drainMs);
  else await Bun.sleep(50);
  expect(fs.existsSync(opts.workingDirectory)).toBe(true);
  if (attempt === 2) fs.writeFileSync(path.join(opts.workingDirectory, 'review-output.md'), 'SQL injection');
  return { exitReason: attempt === 1 ? 'timeout' : 'success', browseErrors: [] };
};
new Function('describe', 'test', 'expect', 'beforeAll', 'afterAll',
  'JUDGE_MS', 'CAPTURE_MS', 'SESSION_DRAIN_GRACE_MS', 'runSkillTest',
  'ROOT', 'runId', 'describeIfSelected', 'testConcurrentIfSelected',
  'logCost', 'recordE2E', 'createEvalCollector', 'finalizeEvalCollector',
  'extractSkillSections', 'REVIEW_ARMY_E2E_SECTIONS', 'spawnSync', 'fs', 'path', 'os', source)(
  describe, test, expect, beforeAll, afterAll, 120_000, captureMs, drainMs, run,
  root, 'free-consensus', (name, ids, body) => { if (ids.includes('review-army-consensus')) describe(name, body); },
  (id, body, outer) => { registrations.push({ id, outer }); test.concurrent(id, body, outer); },
  () => {}, (_collector, _name, _suite, result) => records.push(result.exitReason),
  () => null, () => {}, extractSkillSections, REVIEW_ARMY_E2E_SECTIONS, spawnSync, fs, path, os,
);
afterAll(() => console.log('CONSENSUS_LIFECYCLE=' + JSON.stringify({ attempts, records, registrations, captureOptions })));
`);
    const child = Bun.spawnSync([process.execPath, 'test', '--retry', '1', script], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 8_000,
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, output).toBe(0);
    expect(output).not.toContain('Unhandled error between tests');
    const match = output.match(/CONSENSUS_LIFECYCLE=(\{[^\n]+\})/);
    expect(match, output).not.toBeNull();
    const actual = JSON.parse(match![1]);
    expect(actual.attempts).toBe(2);
    expect(actual.records).toEqual(['timeout', 'success']);
    expect(actual.captureOptions).toEqual([{ timeout: 100, maxTurns: 20 }, { timeout: 100, maxTurns: 20 }]);
    expect(actual.registrations).toEqual([{ id: 'review-army-consensus', outer: 100 + 40 + 5_000 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const validReport of [true, false]) {
  test(`red-team retries only after cancellation and recording, and preserves report validation (${validReport})`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-army-redteam-finalization-'));
    try {
      const script = path.join(dir, 'redteam.test.ts');
      fs.writeFileSync(script, `
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSkillSections, REVIEW_ARMY_E2E_SECTIONS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/skill-fixture.ts'))};
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/office-hours-attempt.ts'))};
const root = ${JSON.stringify(ROOT)};
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  fs.readFileSync(path.join(root, 'test/skill-e2e-review-army.test.ts'), 'utf8'),
).replace(/^import\\b[^;]*;\\s*$/gm, '');
const captureMs = 200, drainMs = 40;
let attempts = 0;
const records = [], registrations = [], captureOptions = [], events = [], fixturePaths = [];
const collector = { addTest: entry => {
  records.push({ passed: entry.passed, exitReason: entry.exit_reason, model: entry.model });
  events.push('record-' + records.length);
} };
const run = async opts => {
  const attempt = ++attempts;
  events.push('start-' + attempt);
  fixturePaths.push(opts.workingDirectory);
  captureOptions.push({ timeout: opts.timeout, maxTurns: opts.maxTurns, model: opts.model ?? null, signal: !!opts.signal });
  opts.signal?.addEventListener('abort', () => events.push('abort-' + attempt), { once: true });
  await Bun.sleep(attempt === 1 ? captureMs + drainMs : 80);
  expect(fs.existsSync(opts.workingDirectory)).toBe(true);
  events.push('capture-done-' + attempt);
  if (attempt === 2) fs.writeFileSync(path.join(opts.workingDirectory, 'review-output.md'), ${JSON.stringify(validReport ? 'RED TEAM REVIEW' : 'ordinary unrelated prose')});
  return { fixtureAttempt: attempt, exitReason: attempt === 1 ? 'timeout' : 'success', duration: 1,
    toolCalls: [], browseErrors: [], transcript: [], output: '', model: 'fixture-model', firstResponseMs: 1, maxInterTurnMs: 0,
    costEstimate: { inputChars: 1, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 0 } };
};
new Function('describe', 'test', 'expect', 'beforeAll', 'afterAll',
  'JUDGE_MS', 'CAPTURE_MS', 'SESSION_DRAIN_GRACE_MS', 'runSkillTest',
  'runRecordedOfficeHoursAttempt', 'OFFICE_HOURS_BUN_GRACE_MS', 'resolveEvalModel',
  'ROOT', 'runId', 'describeIfSelected', 'testConcurrentIfSelected',
  'logCost', 'recordE2E', 'createEvalCollector', 'finalizeEvalCollector',
  'extractSkillSections', 'REVIEW_ARMY_E2E_SECTIONS', 'spawnSync', 'fs', 'path', 'os', source)(
  describe, test, expect, beforeAll, afterAll, 120_000, captureMs, drainMs, run,
  runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS, () => { throw new Error('EVALS_MODEL override must be preserved'); },
  root, 'free-redteam', (name, ids, body) => { if (ids.includes('review-army-red-team')) describe(name, body); },
  (id, body, outer) => { registrations.push({ id, outer }); test.concurrent(id, body, outer); },
  (_name, result) => events.push('validate-' + result.fixtureAttempt),
  (_collector, _name, _suite, result) => collector.addTest({ passed: result.exitReason === 'success', exit_reason: result.exitReason, model: result.model }),
  () => collector, () => {}, extractSkillSections, REVIEW_ARMY_E2E_SECTIONS, spawnSync, fs, path, os,
);
// Observe late bodies after the real fixture hook; this does not extend a test's registration.
afterAll(async () => {
  await Bun.sleep(captureMs);
  console.log('REDTEAM_LIFECYCLE=' + JSON.stringify({ attempts, records, registrations, captureOptions, events,
    fixturesRemoved: fixturePaths.every(p => !fs.existsSync(p)) }));
});
`);
      const child = Bun.spawnSync([process.execPath, 'test', '--retry', '1', script], {
        cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 8_000,
        env: { ...process.env, EVALS: '', EVALS_MODEL: 'fixture-model' },
      });
      const output = child.stdout.toString() + child.stderr.toString();
      expect(child.exitCode, output).toBe(validReport ? 0 : 1);
      expect(output).not.toContain('Unhandled error between tests');
      const match = output.match(/REDTEAM_LIFECYCLE=(\{[^\n]+\})/);
      expect(match, output).not.toBeNull();
      const actual = JSON.parse(match![1]);
      expect(actual.attempts).toBe(2);
      expect(actual.records).toEqual([
        { passed: false, exitReason: 'timeout', model: 'fixture-model' },
        { passed: validReport, exitReason: 'success', model: 'fixture-model' },
      ]);
      expect(actual.captureOptions).toEqual([1, 2].map(() => ({ timeout: 200, maxTurns: 20, model: null, signal: true })));
      expect(actual.registrations).toEqual([{ id: 'review-army-red-team', outer: 200 + 10_000 }]);
      expect(actual.events).toEqual(['start-1', 'abort-1', 'capture-done-1', 'record-1',
        'start-2', 'capture-done-2', 'validate-2', 'abort-2', 'record-2']);
      expect(actual.fixturesRemoved).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
}
