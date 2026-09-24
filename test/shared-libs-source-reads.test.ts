import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import native from './fixtures/shared-libs-resolved-reads-public.json';
import { E2E_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';

const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs-paths.test.ts'), 'utf8');
const detectorStart = source.indexOf('function sourceReadTrace(');
const callbackStart = source.indexOf('async function exerciseEligibility(');
const callbackEnd = source.indexOf('\ndescribeE2E(', callbackStart);
if (detectorStart < 0 || callbackStart <= detectorStart || callbackEnd <= callbackStart) throw new Error('Missing production detector or callback');
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const detect = new Function('fs', 'path', `${transpiler.transformSync(source.slice(detectorStart, callbackStart))}; return sourceReadTrace;`)(fs, path);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const readId = 'toolu_0165HzBNP4ydttNR7XzQBxnK';
const nativeRead = native.matching_results.find(row => row.tool_use_id === readId)!;
const aliases = ['src/retry-route.ts', 'src/retry-alias/retry.ts'];
const targets = ['.fixture/first-party/direct-route.ts', '.fixture/first-party/routes/retry.ts'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-resolved-read-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  for (const file of ['src/retry-worker.ts', 'lib/retry-after.ts', ...targets]) {
    const body = nativeRead.content.split(`=== ${file} ===\n`)[1]?.split('\n=== ')[0];
    if (!body) throw new Error(`Missing native file contents: ${file}`);
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  }
  fs.symlinkSync('../.fixture/first-party/direct-route.ts', path.join(repo, aliases[0]));
  fs.symlinkSync('../.fixture/first-party/routes', path.join(repo, 'src/retry-alias'));
  return { root, repo, state: path.join(root, 'state'), bin: path.join(root, 'bin') };
}

function capture() {
  const tools = structuredClone(native.tools);
  const events = tools.flatMap(tool => {
    const output = native.matching_results.find(row => row.tool_use_id === tool.id);
    return [{ type: 'assistant', message: { content: [{ type: 'tool_use', ...tool }] } },
      ...(output ? [{ type: 'user', message: { content: [structuredClone(output)] } }] : [])];
  });
  return { exitReason: 'success', output: '', events,
    toolCalls: tools.map(tool => ({ tool: tool.name, input: tool.input, output: '' })) };
}

test('the retained native resolved-path read proves both current authored callers', () => {
  const f = fixture();
  const result = capture();
  const reads = detect(result, f, aliases);
  for (const alias of aliases) expect(reads).toContain(alias);
  for (const target of targets) expect(fs.readFileSync(path.join(f.repo, target), 'utf8')).toContain('changed after the prior decision');
});

test.each(['missing-result', 'failed-result', 'wrong-result-id', 'metadata-only', 'stale-content', 'assistant-only'])('%s cannot prove resolved source reads', kind => {
  const f = fixture();
  const result: any = capture();
  const event = result.events.find((event: any) => event.message.content[0].tool_use_id === readId);
  const block = event.message.content[0];
  if (kind === 'missing-result') result.events = result.events.filter((candidate: any) => candidate !== event);
  if (kind === 'failed-result') block.is_error = true;
  if (kind === 'wrong-result-id') block.tool_use_id = 'unrelated';
  if (kind === 'metadata-only') block.content = 'Both target files exist and are 738 bytes.';
  if (kind === 'stale-content') block.content = block.content.replaceAll('// Authored caller changed after the prior decision (symlinks).', '');
  if (kind === 'assistant-only') event.type = 'assistant';
  const reads = detect(result, f, aliases);
  for (const alias of aliases) expect(reads).not.toContain(alias);
});

test('a canonical Read result accepts native line prefixes but still requires current contents', () => {
  const f = fixture();
  const content = fs.readFileSync(path.join(f.repo, targets[0]), 'utf8');
  const input = { file_path: path.join(f.repo, targets[0]) };
  const block = { type: 'tool_result', tool_use_id: 'read-target', content: content.split('\n').map((line, index) => `${index + 1}→${line}`).join('\n') };
  const result = { toolCalls: [{ tool: 'Read', input }], events: [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-target', name: 'Read', input }] } },
    { type: 'user', message: { content: [block] } },
  ] };
  expect(detect(result, f, aliases)).toContain(aliases[0]);
  expect(detect(result, f, aliases)).not.toContain(aliases[1]);
  block.content = '';
  expect(detect(result, f, aliases)).not.toContain(aliases[0]);
});

test('resolved aliases cannot grant credit for targets outside the fixture repository', () => {
  const f = fixture();
  const outside = path.join(f.root, 'outside.ts');
  fs.writeFileSync(outside, fs.readFileSync(path.join(f.repo, targets[0])));
  fs.unlinkSync(path.join(f.repo, aliases[0]));
  fs.symlinkSync(outside, path.join(f.repo, aliases[0]));
  const result: any = capture();
  for (const tool of result.toolCalls) if (tool.tool === 'Bash') tool.input.command = tool.input.command.replaceAll(targets[0], outside);
  for (const event of result.events) for (const block of event.message.content) {
    if (block.type === 'tool_use' && block.name === 'Bash') block.input.command = block.input.command.replaceAll(targets[0], outside);
  }
  expect(detect(result, f, aliases)).not.toContain(aliases[0]);
  expect(detect(result, f, aliases)).toContain(aliases[1]);
});

test.each(['.backup', '/foreign-root/'])('similarly named read targets cannot acquire alias credit: %s', spelling => {
  const f = fixture();
  const result: any = capture();
  const tool = result.events.flatMap((event: any) => event.message.content).find((block: any) => block.id === readId);
  for (const target of targets) tool.input.command = tool.input.command.replaceAll(target, spelling === '.backup' ? target + spelling : spelling + target);
  const reads = detect(result, f, aliases);
  for (const alias of aliases) expect(reads).not.toContain(alias);
});

test('a Read result from another repository cannot prove an identically named target', () => {
  const f = fixture();
  const input = { file_path: path.join(f.root, 'another-repo', targets[0]) };
  const result = { toolCalls: [{ tool: 'Read', input }], events: [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'foreign-read', name: 'Read', input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'foreign-read', content: fs.readFileSync(path.join(f.repo, targets[0]), 'utf8') }] } },
  ] };
  expect(detect(result, f, aliases)).not.toContain(aliases[0]);
});

test.each(['Read', 'Bash'])('direct alias reads retain the existing %s contract', tool => {
  const f = fixture();
  const result = { toolCalls: [{ tool, input: tool === 'Read' ? { file_path: aliases[0] } : { command: `cat ${aliases[0]}` } }] };
  expect(detect(result, f, aliases)).toContain(aliases[0]);
});

test.each(['test/shared-libs-source-reads.test.ts', 'test/fixtures/shared-libs-resolved-reads-public.json'])('%s selects every owning path callback without a global fallback', file => {
  expect(selectTests([file], E2E_TOUCHFILES, GLOBAL_TOUCHFILES).selected.sort()).toEqual([
    'shared-libs-review-index-flags', 'shared-libs-review-path-eligibility', 'shared-libs-review-prior-coverage',
  ]);
});

test.each([false, true])('the actual eligibility callback consumes the read detector result (missing output=%s)', async missingOutput => {
  const f = fixture();
  const result: any = capture();
  if (missingOutput) result.events = result.events.filter((event: any) => event.message.content[0].tool_use_id !== readId);
  const rows: any[] = [];
  let detectorCalls = 0;
  const exercise = new Function('deps', `const { captures, preparePathEligibilityFixture, fs, path,
    reviewLifecycleInstructions, reviewRevalidationPrompt, runSharedInteractive, readRequests,
    toolCommandTrace, sourceReadTrace, fixtureWorkingTree, reviewRecords, expect, CAPTURE_LONG_MS } = deps;
    ${transpiler.transformSync(source.slice(callbackStart, callbackEnd))}; return exerciseEligibility;`)({
    captures: { runAttempt: (_name: string, _kinds: string[], _timeout: number, work: any) => work({ add: (_kind: string, row: any) => rows.push(row) }) },
    preparePathEligibilityFixture: () => ({ fixture: f, sourcePaths: aliases, beforeTree: 'tree', current: { evidence_paths: ['src/retry-worker.ts', 'lib/retry-after.ts', ...aliases] } }),
    fs, path, expect, CAPTURE_LONG_MS: 600_000,
    reviewLifecycleInstructions: () => 'read the authored sources', reviewRevalidationPrompt: () => 'revalidate',
    runSharedInteractive: async () => ({ result, questions: [{}] }), readRequests: () => [],
    toolCommandTrace: (value: any) => value.toolCalls.filter((call: any) => call.tool === 'Bash').map((call: any) => call.input.command),
    sourceReadTrace: (...args: any[]) => { detectorCalls++; return detect(...args); },
    fixtureWorkingTree: () => 'tree',
    reviewRecords: () => [{ skill: 'review' }, { skill: 'review', status: 'clean', issues_found: 0, completed: true, converged: true,
      review_binding: { state: 'verified' }, findings: [{ advisory: true, action: 'skipped', helper_target: { path: 'lib/retry-after.ts', symbol: 'retrySeconds' },
        fingerprint: `shared-libs:${'a'.repeat(64)}`, evidence_paths: ['src/retry-worker.ts', ...aliases], snapshot_covered_paths: ['src/retry-worker.ts', 'lib/retry-after.ts'] }] }],
  });
  if (missingOutput) await expect(exercise('shared-libs-review-path-eligibility', ['symlinks'])).rejects.toThrow();
  else await exercise('shared-libs-review-path-eligibility', ['symlinks']);
  expect(detectorCalls).toBe(1);
  expect(rows).toHaveLength(1);
  expect(rows[0].passed).toBe(!missingOutput);
  expect(fs.existsSync(f.root)).toBe(false);
});
