import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkImplementation, createSnapshot, extractImplementationPlan, initializePlan,
  prepareMethodology } from '../bin/gstack-autoplan-snapshot';
import captured from './fixtures/autoplan-amend-input-77.json';

const ROOT = resolve(import.meta.dir, '..');
const TOOL = join(ROOT, 'bin/gstack-autoplan-snapshot.ts');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-autoplan-spec-input-')); owned.push(dir);
  const input = join(dir, 'input.md'), active = join(dir, 'active.md'), restore = join(dir, 'restore.md');
  writeFileSync(input, captured.initialImplementation);
  initializePlan(input, active, restore);
  const method = prepareMethodology('ceo', join(ROOT, 'plan-ceo-review/SKILL.md'), restore);
  const checkpoint = createSnapshot('ceo', active, restore, method.methodologyPath);
  const record = (text: string) => {
    const plan = readFileSync(active, 'utf8');
    writeFileSync(active, plan.slice(0, plan.indexOf('## Review record\n')) + '## Review record\n' + text + '\n');
  };
  record(captured.baselineEditRecord + '\n' + captured.acceptedBlock);
  return { dir, active, restore, method, checkpoint, record };
}

function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function prepare(f: ReturnType<typeof fixture>) {
  return invoke('amend-input', 'ceo', f.active, f.checkpoint.snapshotPath, f.restore, f.method.methodologyPath);
}

test('actual amended CEO requirements are exported for spec review instead of the old checkpoint', () => {
  const f = fixture();
  expect(f.checkpoint.sha256).toBe(captured.initialSha256);
  expect(captured.specDispatch.input.prompt).toContain(captured.amendResult.snapshotPath);
  expect(captured.successfulAmendAt < captured.specDispatch.timestamp).toBe(true);
  expect(captured.amendResult.sha256).not.toBe(captured.initialSha256);
  const result = prepare(f);
  expect(result.status, result.stderr).toBe(0);
  const bound = JSON.parse(result.stdout);
  expect(bound.checkpointPath).toBe(f.checkpoint.snapshotPath);
  expect(bound.reviewInputPath).not.toBe(bound.checkpointPath);
  expect(readFileSync(bound.checkpointPath, 'utf8')).toBe(captured.initialImplementation);
  const current = extractImplementationPlan(readFileSync(f.active, 'utf8'));
  expect(sha(current)).toBe(captured.amendResult.sha256);
  expect(Buffer.byteLength(current)).toBe(captured.currentImplementationBytes);
  expect(bound.sourceSha256).toBe(captured.amendResult.sha256);
  expect(bound.sourceBytes).toBe(captured.currentImplementationBytes);
  const review = readFileSync(bound.reviewInputPath, 'utf8');
  expect(sha(review)).toBe(bound.reviewInputSha256);
  expect(Buffer.byteLength(review)).toBe(bound.reviewInputBytes);
  expect(review).toContain(captured.acceptedBlock.split('\n').slice(1, -1).join('\n'));
  expect(review).toContain('post-login redirect switched behind the existing cohort feature flag');
  expect(review).not.toContain('autoplan-accepted:');
  expect(review).not.toContain('## Review record');
  expect(Object.keys(bound).sort()).toEqual(['activePlan', 'checkpointPath', 'phase', 'reviewInputBytes',
    'reviewInputPath', 'reviewInputSha256', 'reviewInputLines', 'readRanges', 'limitation', 'sourceBytes', 'sourceSha256'].sort());
  expect(checkImplementation('ceo', f.active, bound.reviewInputPath, 'unchanged').changed).toBe(false);
  expect(() => checkImplementation('ceo', f.active, bound.checkpointPath, 'unchanged')).toThrow('changed');
  if (process.platform !== 'win32') expect(statSync(bound.reviewInputPath).mode & 0o777).toBe(0o444);
});

test('each accepted spec follow-up receives a new complete input while retaining the original checkpoint', () => {
  const f = fixture(), first = prepare(f);
  expect(first.status, first.stderr).toBe(0);
  const one = JSON.parse(first.stdout), firstBytes = readFileSync(one.reviewInputPath);
  const extra = '- Synthetic accepted follow-up: retain the original response and verify the new panel timeout.\n';
  f.record(captured.baselineEditRecord + '\n' + captured.acceptedBlock.replace('<!-- /autoplan-accepted:ceo -->', extra + '<!-- /autoplan-accepted:ceo -->'));
  const second = prepare(f);
  expect(second.status, second.stderr).toBe(0);
  const two = JSON.parse(second.stdout);
  expect(two.checkpointPath).toBe(one.checkpointPath);
  expect(two.reviewInputPath).not.toBe(one.reviewInputPath);
  expect(two.sourceSha256).not.toBe(one.sourceSha256);
  expect(readFileSync(two.reviewInputPath, 'utf8')).toContain(extra.trim());
  expect(readFileSync(one.reviewInputPath)).toEqual(firstBytes);
  expect(readFileSync(two.checkpointPath, 'utf8')).toBe(captured.initialImplementation);
  expect(() => checkImplementation('ceo', f.active, one.reviewInputPath, 'unchanged')).toThrow('changed');
});

test('an explicit unchanged None record produces a current input without inventing obligations', () => {
  const f = fixture();
  f.record('<!-- autoplan-accepted:ceo -->\nNone: existing requirements already cover this review.\n<!-- /autoplan-accepted:ceo -->');
  const result = prepare(f);
  expect(result.status, result.stderr).toBe(0);
  const bound = JSON.parse(result.stdout);
  expect(bound.sourceSha256).toBe(captured.initialSha256);
  expect(bound.reviewInputPath).not.toBe(bound.checkpointPath);
  expect(readFileSync(bound.reviewInputPath, 'utf8')).toBe(captured.initialImplementation);
});

test('all four phase handoffs preserve preceding requirements and use their own amendment checkpoint', () => {
  const f = fixture(), first = prepare(f);
  expect(first.status, first.stderr).toBe(0);
  for (const phase of ['design', 'dx', 'eng']) {
    const method = prepareMethodology(phase, join(ROOT, `plan-${phase === 'dx' ? 'devex' : phase}-review/SKILL.md`), f.restore);
    const checkpoint = createSnapshot(phase, f.active, f.restore, method.methodologyPath);
    const before = readFileSync(checkpoint.snapshotPath);
    const requirement = `- Synthetic ${phase} requirement: verify the existing dashboard contract before completing this phase.`;
    writeFileSync(f.active, readFileSync(f.active, 'utf8') + `\n<!-- autoplan-accepted:${phase} -->\n${requirement}\n<!-- /autoplan-accepted:${phase} -->\n`);
    const result = invoke('amend-input', phase, f.active, checkpoint.snapshotPath, f.restore, method.methodologyPath);
    expect(result.status, result.stderr).toBe(0);
    const bound = JSON.parse(result.stdout);
    expect(bound.phase).toBe(phase);
    expect(bound.checkpointPath).toBe(checkpoint.snapshotPath);
    expect(bound.reviewInputPath).not.toBe(checkpoint.snapshotPath);
    expect(bound.sourceSha256).toBe(sha(extractImplementationPlan(readFileSync(f.active, 'utf8'))));
    const review = readFileSync(bound.reviewInputPath, 'utf8');
    expect(review).toContain(requirement);
    expect(review).toContain(captured.acceptedBlock.split('\n').slice(1, -1).join('\n'));
    expect(review).not.toContain('Review record');
    expect(readFileSync(checkpoint.snapshotPath)).toEqual(before);
  }
});

test('a new CEO invocation archives applied edit history and retains all four phases before its new amendment', () => {
  const f = fixture();
  expect(prepare(f).status).toBe(0);
  const priorBlocks: string[] = [];
  for (const phase of ['design', 'dx', 'eng']) {
    const method = prepareMethodology(phase, join(ROOT, `plan-${phase === 'dx' ? 'devex' : phase}-review/SKILL.md`), f.restore);
    const checkpoint = createSnapshot(phase, f.active, f.restore, method.methodologyPath);
    const block = `<!-- autoplan-accepted:${phase} -->\n- Synthetic accepted ${phase} requirement: preserve this phase's existing result.\n<!-- /autoplan-accepted:${phase} -->`;
    priorBlocks.push(block);
    writeFileSync(f.active, readFileSync(f.active, 'utf8') + '\n' + block + '\n');
    const result = invoke('amend-input', phase, f.active, checkpoint.snapshotPath, f.restore, method.methodologyPath);
    expect(result.status, result.stderr).toBe(0);
  }
  const completed = readFileSync(f.active, 'utf8');
  const oldCheckpoint = prepare(f);
  expect(oldCheckpoint.status).toBe(1);
  expect(oldCheckpoint.stderr).toContain('Unrecorded Implementation rewrite');
  expect(readFileSync(f.active, 'utf8')).toBe(completed);

  const premature = createSnapshot('ceo', f.active, f.restore, f.method.methodologyPath);
  const staleRecord = invoke('amend-input', 'ceo', f.active, premature.snapshotPath, f.restore, f.method.methodologyPath);
  expect(staleRecord.status).toBe(1);
  expect(staleRecord.stderr).toContain('Baseline-edit source SHA does not match immutable input');
  expect(readFileSync(f.active, 'utf8')).toBe(completed);

  const reviewAt = completed.indexOf('## Review record\n');
  const history = '```md\n' + captured.baselineEditRecord + '\n```';
  let review = completed.slice(reviewAt).replace(captured.baselineEditRecord, history);
  writeFileSync(f.active, completed.slice(0, reviewAt) + review);
  const fresh = createSnapshot('ceo', f.active, f.restore, f.method.methodologyPath);
  expect(fresh.sha256).not.toBe(fresh.sourceSha256);
  const previousEdits = JSON.parse(captured.baselineEditRecord.match(/(\{.*\}) -->$/)![1]!);
  const oldText = previousEdits.replacements[1].newText;
  const newText = oldText + ' Synthetic approved rerun condition: verify the selected cohort before redirect.';
  const newRecord = `<!-- autoplan-baseline-edits:ceo ${JSON.stringify({ sourceSha256: fresh.sourceSha256, replacements: [{ oldText, newText }] })} -->`;
  review = review.replace('<!-- /autoplan-accepted:ceo -->', '- Synthetic approved rerun condition: verify the selected cohort before redirect.\n<!-- /autoplan-accepted:ceo -->');
  writeFileSync(f.active, completed.slice(0, reviewAt) + review + '\n' + newRecord.replace(fresh.sourceSha256, fresh.sha256) + '\n');
  const wrongProjection = invoke('amend-input', 'ceo', f.active, fresh.snapshotPath, f.restore, f.method.methodologyPath);
  expect(wrongProjection.status).toBe(1);
  expect(wrongProjection.stderr).toContain('Baseline-edit source SHA does not match immutable input');
  writeFileSync(f.active, completed.slice(0, reviewAt) + review + '\n' + newRecord + '\n');
  const result = invoke('amend-input', 'ceo', f.active, fresh.snapshotPath, f.restore, f.method.methodologyPath);
  expect(result.status, result.stderr).toBe(0);
  const bound = JSON.parse(result.stdout), final = readFileSync(f.active, 'utf8');
  expect(bound.checkpointPath).toBe(fresh.snapshotPath);
  expect(extractImplementationPlan(final)).toContain(newText);
  expect(final.slice(final.indexOf('## Review record\n'))).toContain(history);
  expect(history).toContain(captured.initialSha256);
  for (const block of priorBlocks) expect(extractImplementationPlan(final)).toContain(block);
  expect(readFileSync(bound.reviewInputPath, 'utf8')).toContain(newText);
  expect(readFileSync(f.checkpoint.snapshotPath, 'utf8')).toBe(captured.initialImplementation);
});

test('a compact response provides complete read ranges through a large plan’s final partial chunk', () => {
  const f = fixture();
  const required = '- Synthetic accepted verification checklist:\n' + Array.from({ length: 1201 }, (_, n) => `  Preserve condition ${n + 1} and its matching result.\n`).join('');
  f.record('<!-- autoplan-accepted:ceo -->\n' + required + '<!-- /autoplan-accepted:ceo -->');
  const result = prepare(f);
  expect(result.status, result.stderr).toBe(0);
  const bound = JSON.parse(result.stdout), input = readFileSync(bound.reviewInputPath, 'utf8');
  expect(input).toContain(required);
  const lines = input.split('\n');
  expect(bound.reviewInputLines).toBe(lines.length);
  expect(bound.readRanges.length).toBeGreaterThan(2);
  let nextLine = 1;
  const readback: string[] = [];
  for (const range of bound.readRanges) {
    expect(range.offset).toBe(nextLine);
    expect(range.limit).toBeLessThanOrEqual(600);
    expect(range.endLine).toBe(range.offset + range.limit - 1);
    readback.push(...lines.slice(range.offset - 1, range.endLine));
    nextLine = range.endLine + 1;
  }
  expect(nextLine).toBe(lines.length + 1);
  expect(readback.join('\n')).toBe(input);
  expect(result.stdout.length).toBeLessThan(2000);
  expect(result.stdout).not.toContain(required);
  expect(bound.limitation).toContain('Successful full Reads');
});

for (const kind of ['missing-record', 'empty-record', 'unrecorded-rewrite', 'wrong-baseline', 'foreign-checkpoint', 'missing-methodology']) {
  test(`${kind} cannot publish a spec-review input`, () => {
    const f = fixture();
    if (kind === 'missing-record') f.record('CEO review pending.');
    if (kind === 'empty-record') f.record('<!-- autoplan-accepted:ceo -->\n<!-- /autoplan-accepted:ceo -->');
    if (kind === 'unrecorded-rewrite') writeFileSync(f.active, readFileSync(f.active, 'utf8').replace('Users land here after login.', 'Delete all member accounts.'));
    if (kind === 'wrong-baseline') f.record(captured.baselineEditRecord.replace(captured.initialSha256, '0'.repeat(64)) + '\n' + captured.acceptedBlock);
    if (kind === 'foreign-checkpoint') f.checkpoint.snapshotPath = fixture().checkpoint.snapshotPath;
    if (kind === 'missing-methodology') f.method.methodologyPath = join(f.dir, 'absent.md');
    const before = readdirSync(f.dir).sort();
    const result = prepare(f);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('gstack-autoplan-snapshot:');
    expect(readdirSync(f.dir).sort()).toEqual(before);
  });
}

for (const moment of ['before-export', 'after-export', 'export-failure']) {
  test(`${moment} rejects drift or failure and removes only the new export`, () => {
    const f = fixture(), worker = join(f.dir, 'controlled-export.ts');
    writeFileSync(worker, `import { mock } from 'bun:test';
const real = { ...await import('node:fs') };
const [active, checkpoint, restore, methodology, moment] = process.argv.slice(2);
let injected = false;
const drift = () => { injected = true; real.writeFileSync(active, real.readFileSync(active, 'utf8').replace('## Implementation plan\\n', '## Implementation plan\\nUnrecorded concurrent change.\\n')); };
mock.module('node:fs', () => ({ ...real,
  readFileSync(file, ...args) {
    if (!injected && moment === 'before-export' && String(file) === methodology) drift();
    return real.readFileSync(file, ...args);
  },
  writeFileSync(file, ...args) {
    if (!injected && String(file).endsWith('/snapshot.json')) {
      if (moment === 'after-export') drift();
      if (moment === 'export-failure') { injected = true; throw new Error('Injected spec export failure'); }
    }
    return real.writeFileSync(file, ...args);
  },
}));
const { prepareAmendedInput } = await import(${JSON.stringify(TOOL)});
try { prepareAmendedInput('ceo', active, checkpoint, restore, methodology); process.exitCode = 2; }
catch (error) { console.error(error.message); process.exitCode = injected ? 1 : 3; }
`);
    const before = readdirSync(f.dir).sort();
    const result = spawnSync(process.execPath, [worker, f.active, f.checkpoint.snapshotPath, f.restore, f.method.methodologyPath, moment], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(moment === 'export-failure' ? /Injected spec export failure/ : /changed|current amended/);
    expect(readdirSync(f.dir).sort()).toEqual(before);
    expect(readFileSync(f.checkpoint.snapshotPath, 'utf8')).toBe(captured.initialImplementation);
  });
}

test('amend-input CLI rejects incomplete or extra arguments without starting an export', () => {
  const f = fixture();
  const args = ['ceo', f.active, f.checkpoint.snapshotPath, f.restore, f.method.methodologyPath];
  for (const supplied of [[], args.slice(0, 3), [...args, 'extra']]) {
    const result = invoke('amend-input', ...supplied);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: amend-input');
  }
});
