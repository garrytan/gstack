import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildEvalInputIdentity, lookupEvalInputCache, storeEvalInputCache,
  EVAL_CACHE_MAX_AGE_MS, EVAL_CACHE_RESULT_MAX_BYTES,
  type EvalInputManifest, type EvalPassingProof,
} from '../scripts/eval-input-cache';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const NOW = 1_800_000_000_000;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cache-')); roots.push(root);
  for (const [file, content] of Object.entries({ 'runner.ts': 'run()', 'rubric.ts': 'clarity >= 4',
    'fixture.json': '{"project":"sample"}', 'generated.md': 'Review this plan', 'bun.lock': 'dependencies' })) {
    fs.writeFileSync(path.join(root, file), content, { mode: 0o644 });
  }
  const input: EvalInputManifest = {
    root, scope: { repository: 'owner/repo', pullRequest: 42 },
    coverage: { dependencies: 'complete', prompts: 'complete', environment: 'complete' }, unknownDependencies: [],
    files: ['runner.ts', 'rubric.ts', 'fixture.json', 'generated.md', 'bun.lock'],
    prompts: { 'CEO quality': 'Full expanded source bundle and exact rubric' },
    parameters: { thresholds: { clarity: 4 }, retries: 1, max_tokens: 8192, temperature: null },
    runtime: { models: { judge: 'model-v1' }, endpoint: 'https://api.example.test', bun: '1.4.0', node: '22', platform: 'linux', arch: 'x64' },
  };
  const result = buildEvalInputIdentity(input);
  if (result.status !== 'eligible') throw new Error(result.reason);
  const identity = result.identity;
  const proof: EvalPassingProof = { execution: 'new', finalized: true, completeAttemptHistory: true,
    exitCode: 0, timedOut: false, cancelled: false, skipped: 0, failed: 0, passed: 1,
    cases: [{ id: 'CEO quality', outcome: 'passed', attempt: 1 }],
    source: { runId: '1234', revision: 'a'.repeat(40), completedAt: NOW - 1000 },
    result: { clarity: 4, completeness: 5, actionability: 4, reasoning: 'Clear instructions' } };
  const cacheDir = path.join(root, 'cache');
  const common = { cacheDir, purpose: 'gate' as const, now: NOW };
  const save = (change: Partial<Parameters<typeof storeEvalInputCache>[0]> = {}) =>
    storeEvalInputCache({ ...common, before: identity, after: identity, proof, ...change });
  const read = (change: Partial<Parameters<typeof lookupEvalInputCache>[0]> = {}) =>
    lookupEvalInputCache({ ...common, identity, validateResult: result =>
      !!result && typeof result === 'object' && !Array.isArray(result)
      && result.clarity === 4 && result.completeness === 5 && result.actionability === 4,
    ...change });
  return { root, input, identity, proof, cacheDir, save, read, filename: path.join(cacheDir, identity.key + '.json') };
}
const key = (input: EvalInputManifest) => {
  const result = buildEvalInputIdentity(input);
  if (result.status !== 'eligible') throw new Error(result.reason);
  return result.identity.key;
};

test('identical consumed bytes reuse original successful public evidence without refreshing it', () => {
  const f = fixture();
  expect(f.read().status).toBe('miss');
  expect(f.save()).toEqual({ status: 'stored', key: f.identity.key });
  const before = fs.readFileSync(f.filename, 'utf8');
  expect(f.read()).toEqual({ status: 'reused', key: f.identity.key, caseIds: ['CEO quality'], source: f.proof.source, result: f.proof.result });
  expect(f.read({ now: NOW + 60_000 }).status).toBe('reused');
  expect(fs.readFileSync(f.filename, 'utf8')).toBe(before);
  if (process.platform !== 'win32') expect(fs.statSync(f.filename).mode & 0o777).toBe(0o600);
});

test('file/map enumeration order and checkout location do not change consumed identity', () => {
  const a = fixture(), b = fixture();
  b.input.files.reverse();
  b.input.parameters = { temperature: null, max_tokens: 8192, retries: 1, thresholds: { clarity: 4 } };
  expect(key(a.input)).toBe(key(b.input));
});

for (const file of ['runner.ts', 'rubric.ts', 'fixture.json', 'generated.md', 'bun.lock'])
  test(`changed ${file} invalidates a previous pass without relying on commit changes`, () => {
    const f = fixture(); f.save(); fs.appendFileSync(path.join(f.root, file), '\nchanged');
    const identity = buildEvalInputIdentity(f.input);
    expect(identity.status).toBe('eligible');
    if (identity.status === 'eligible') {
      expect(identity.identity.key).not.toBe(f.identity.key);
      expect(f.read({ identity: identity.identity }).status).toBe('miss');
      expect(f.save({ after: identity.identity }).status).toBe('not-stored');
    }
  });

for (const [name, change] of Object.entries({
  prompt: (m: EvalInputManifest) => { m.prompts['CEO quality'] += '\nextra input'; },
  rubric: (m: EvalInputManifest) => { m.parameters.thresholds = { clarity: 5 }; },
  retries: (m: EvalInputManifest) => { m.parameters.retries = 2; },
  model: (m: EvalInputManifest) => { m.runtime.models = { judge: 'model-v2' }; },
  runtime: (m: EvalInputManifest) => { m.runtime.bun = '1.4.1'; },
  environment: (m: EvalInputManifest) => { m.runtime.endpoint = 'https://other.example.test'; },
  selection: (m: EvalInputManifest) => { m.prompts.Other = 'A different complete prompt'; },
  dependency: (m: EvalInputManifest) => { m.files = m.files.filter(file => file !== 'fixture.json'); },
})) test(`${name} identity changes invalidate prior evidence`, () => {
  const f = fixture(); change(f.input); expect(key(f.input)).not.toBe(f.identity.key);
});

for (const [name, change] of Object.entries({
  unknown: (m: any) => { m.unknownDependencies = ['dynamic import']; },
  incomplete: (m: any) => { m.coverage.dependencies = 'unknown'; },
  environment: (m: any) => { delete m.coverage.environment; },
  noPrompt: (m: any) => { m.prompts = {}; },
  emptyPrompt: (m: any) => { m.prompts['CEO quality'] = ''; },
  noParameters: (m: any) => { m.parameters = {}; },
  noRuntime: (m: any) => { m.runtime = {}; },
  undefined: (m: any) => { m.parameters.unknown = undefined; },
  sparseArray: (m: any) => { m.parameters.unknown = new Array(1); },
  nonFinite: (m: any) => { m.parameters.timeout = NaN; },
  dateObject: (m: any) => { m.parameters.date = new Date(); },
  missingFile: (m: any) => { m.files.push('missing.ts'); },
  duplicateFile: (m: any) => { m.files.push('runner.ts'); },
  absoluteFile: (m: any) => { m.files = [path.join(m.root, 'runner.ts')]; },
  traversal: (m: any) => { m.files = ['../runner.ts']; },
  directory: (m: any) => { m.files = ['.']; },
})) test(`unknown or invalid input (${name}) cannot create a reusable identity`, () => {
  const f = fixture(); change(f.input); expect(buildEvalInputIdentity(f.input).status).toBe('ineligible');
  expect(fs.existsSync(f.cacheDir)).toBe(false);
});

for (const [name, mutation] of Object.entries({
  failed: { failed: 1 }, skipped: { skipped: 1 }, timeout: { timedOut: true }, cancelled: { cancelled: true },
  killed: { exitCode: 137 }, nonzero: { exitCode: 1 }, partial: { finalized: false },
  incompleteHistory: { completeAttemptHistory: false }, hollow: { passed: 0, cases: [] },
  missing: { cases: [] }, wrongCount: { passed: 2 }, wrongCase: { cases: [{ id: 'Other', outcome: 'passed', attempt: 1 }] },
  retry: { cases: [{ id: 'CEO quality', outcome: 'passed', attempt: 2 }] },
  duplicate: { cases: [{ id: 'CEO quality', outcome: 'passed', attempt: 1 }, { id: 'CEO quality', outcome: 'passed', attempt: 1 }] },
  assertionFailure: { cases: [{ id: 'CEO quality', outcome: 'failed', attempt: 1 }] },
  reuse: { execution: 'reused' },
})) test(`${name} evidence is neither stored nor accepted if found in a receipt`, () => {
  const f = fixture(), proof = { ...f.proof, ...mutation } as EvalPassingProof;
  expect(f.save({ proof }).status).toBe('not-stored');
  expect(fs.existsSync(f.cacheDir)).toBe(false);
  f.save(); const receipt = JSON.parse(fs.readFileSync(f.filename, 'utf8')); receipt.proof = proof;
  fs.writeFileSync(f.filename, JSON.stringify(receipt)); expect(f.read().status).toBe('miss');
});

for (const purpose of ['periodic', 'release'] as const) test(`${purpose} always executes fresh`, () => {
  const f = fixture(); expect(f.save({ purpose }).status).toBe('not-stored');
  f.save(); expect(f.read({ purpose }).status).toBe('miss');
});
test('fresh bypass applies to both lookup and publication', () => {
  const f = fixture(); expect(f.save({ fresh: true }).status).toBe('not-stored');
  f.save(); expect(f.read({ fresh: true }).status).toBe('miss');
});
test('24-hour expiry, future timestamps and malformed age policy fail closed', () => {
  const f = fixture(); f.save();
  expect(f.read({ now: f.proof.source.completedAt + EVAL_CACHE_MAX_AGE_MS - 1 }).status).toBe('reused');
  expect(f.read({ now: f.proof.source.completedAt + EVAL_CACHE_MAX_AGE_MS }).status).toBe('miss');
  expect(f.read({ now: f.proof.source.completedAt - 1 }).status).toBe('miss');
  expect(f.read({ maxAgeMs: 0 }).status).toBe('miss');
  expect(f.save({ now: f.proof.source.completedAt - 1 }).status).toBe('not-stored');
});
test('different PR/repository cannot borrow a receipt, even copied to its expected key', () => {
  for (const scope of [{ repository: 'owner/repo', pullRequest: 43 }, { repository: 'other/repo', pullRequest: 42 }]) {
    const f = fixture(); f.save();
    const result = buildEvalInputIdentity({ ...f.input, scope });
    if (result.status !== 'eligible') throw new Error(result.reason);
    fs.copyFileSync(f.filename, path.join(f.cacheDir, `${result.identity.key}.json`));
    expect(f.read({ identity: result.identity }).status).toBe('miss');
  }
});
test('caller revalidates cached values; rejected or throwing assertions cannot grant credit', () => {
  const f = fixture(); f.save();
  expect(f.read({ validateResult: () => false }).status).toBe('miss');
  expect(f.read({ validateResult: () => { throw new Error('assertion failed'); } }).status).toBe('miss');
  const receipt = JSON.parse(fs.readFileSync(f.filename, 'utf8')); receipt.proof.result.clarity = 1;
  fs.writeFileSync(f.filename, JSON.stringify(receipt));
  expect(f.read({ validateResult: () => true }).status).toBe('miss');
});
test('payloads are bounded strict JSON and operational collector fields never persist', () => {
  const f = fixture();
  expect(f.save({ proof: { ...f.proof, result: 'x'.repeat(EVAL_CACHE_RESULT_MAX_BYTES) } }).status).toBe('not-stored');
  expect(f.save({ proof: { ...f.proof, result: undefined } as any }).status).toBe('not-stored');
  expect(f.save({ proof: { ...f.proof, prompt: 'PRIVATE PROMPT', transcript: 'PRIVATE TRANSCRIPT' } as any }).status).toBe('stored');
  const text = fs.readFileSync(f.filename, 'utf8');
  expect(text).not.toContain('PRIVATE'); expect(text).not.toContain(f.input.prompts['CEO quality']!);
});
test('malformed receipts, unknown schema and filesystem failures produce misses, not success', () => {
  const f = fixture(); f.save();
  const valid = fs.readFileSync(f.filename, 'utf8');
  for (const content of ['{broken', '{}', valid.replace('"schema":1', '"schema":99')]) {
    fs.writeFileSync(f.filename, content); expect(f.read().status).toBe('miss');
  }
  expect(f.save({ cacheDir: path.join(f.root, 'runner.ts') }).status).toBe('not-stored');
});
test.skipIf(process.platform === 'win32')('external input links and symlinked receipts cannot supply cache credit', () => {
  const f = fixture(), outside = fixture();
  fs.symlinkSync(path.join(outside.root, 'runner.ts'), path.join(f.root, 'outside.ts'));
  expect(buildEvalInputIdentity({ ...f.input, files: ['outside.ts'] }).status).toBe('ineligible');
  f.save(); const real = path.join(f.root, 'receipt.json'); fs.renameSync(f.filename, real); fs.symlinkSync(real, f.filename);
  expect(f.read().status).toBe('miss');
});
