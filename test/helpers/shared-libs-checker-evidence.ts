/**
 * Captures and replay adapters shared by test/shared-libs-checker-interface-evidence*.test.ts
 * (moved from test/shared-libs-checker-interface-evidence.test.ts, GSTA-151). Each test file
 * runs its own beforeAll over the captures it replays and its own afterAll cleanup.
 */
import { expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasTrustedSharedLibsCheck } from './shared-libs-review-start-evidence';
import {
  createSharedInteractiveToolHandler, createSharedLibsFixture, fixtureGit, fixtureWorkingTree, fixtureWrite,
  installNormalizingFilter, reviewLifecycleInstructions, reviewRevalidationPrompt, reviewRecords,
  seedReviewSources, seedSkippedAdvisory, SHARED_LIBS_ROOT, shellQuote, toolCommandTrace,
  type SharedLibsFixture,
} from './shared-libs-eval-fixture';
import {
  seedPathReviewPrerequisites, checkPathReviewPrerequisites,
  hasPathReviewPrerequisiteReceipt, type PathEligibilityFixture,
} from './shared-libs-path-fixture';
import { CAPTURE_LONG_MS } from './eval-budgets';
import capturedChecker from '../fixtures/shared-libs-index-flags-r59-checker-public.json';

export const helper = path.join(SHARED_LIBS_ROOT, 'bin/gstack-review-log');
export const fixtures: SharedLibsFixture[] = [];
export const captures = new Map<string, any>();
export const pathSource = fs.readFileSync(path.join(import.meta.dir, '..', 'skill-e2e-shared-libs-paths.test.ts'), 'utf8');
export const pathKinds = ['symlinks', 'submodule', 'ignored', 'legacy', 'assume-unchanged', 'skip-worktree', 'removed-filter'] as const;

export async function capture(change: string, prepared?: PathEligibilityFixture, declared = false) {
  const f = prepared?.fixture ?? createSharedLibsFixture(`checker-${change}`);
  fixtures.push(f);
  let current = prepared?.current;
  if (!current) {
    seedReviewSources(f);
    fixtureWrite(f, 'src/retry-worker.ts', fs.readFileSync(path.join(f.repo, 'src/retry-worker.ts'), 'utf8')
      .replace('const unusedRetryDiagnostic = "unused";\n', ''));
    if (change === 'filtered') installNormalizingFilter(f);
    const { action: _action, ...finding } = await seedSkippedAdvisory(f);
    current = finding;
    if (change === 'branch') fixtureGit(f, 'checkout', '-b', 'feature-a');
    if (change === 'secondary') fixtureWrite(f, 'src/retry-route.ts',
      fs.readFileSync(path.join(f.repo, 'src/retry-route.ts'), 'utf8') + '// Changed caller\n');
    if (change === 'filtered') fixtureWrite(f, 'src/retry-route.ts',
      fs.readFileSync(path.join(f.repo, 'src/retry-route.ts'), 'utf8') + '// RAW-ONLY changed caller\n');
  }
  const events: any[] = [];
  const invoke = (command: string) => {
    const id = `call-${events.length}`;
    events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const output = execFileSync('bash', ['-c', command], { cwd: f.repo, env: { ...process.env, ...f.env },
      encoding: 'utf8', timeout: 30_000 });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
    return output.trim();
  };
  const instructionFile = reviewLifecycleInstructions(f);
  const instructions = fs.readFileSync(instructionFile, 'utf8');
  const resumed = prepared?.resumed ?? seedPathReviewPrerequisites(f);
  const prerequisites = checkPathReviewPrerequisites(f, resumed.input);
  const protocol = declared ? [...reviewRevalidationPrompt(f, instructionFile, path.join(f.root, 'current-advisory.jsonl'), resumed)
    .matchAll(/```bash\n([\s\S]*?)\n```/g)].map(match => match[1]) : [];
  if (declared) expect(protocol).toHaveLength(3);
  const startCommand = instructions.match(/```bash\n(DIFF_BASE=\$[\s\S]*?)\n```/)?.[1];
  expect(startCommand).toBeDefined();
  const token = invoke(declared ? protocol[0] : startCommand!).split('\n')[0];
  if (declared) invoke('git diff origin/main');
  for (const file of current.evidence_paths) invoke(`cat ${shellQuote(file)}`);
  const checkAt = events.length;
  const receipt = JSON.parse(invoke(declared ? protocol[1].replace('REVIEW_START', token).replace('CURRENT_FINDING_JSON', JSON.stringify(current))
    : `${shellQuote(helper)} --check-shared-libs ${token} <<'FINDING'\n${JSON.stringify(current)}\nFINDING`));
  const questions: any[] = [];
  if (declared && !receipt.reusable) {
    const input = { questions: [{ question: 'Revalidate this supplied authored-source advisory?',
      options: [{ label: 'Fix', description: 'Apply the extraction.' },
        { label: 'Skip', description: 'Keep the source and index unchanged; record this advisory decision.' }] }] };
    const callback = createSharedInteractiveToolHandler('skip', {
      nonQuestion: () => { throw new Error('No non-question tool is allowed by this free actor'); },
      onQuestion: value => { questions.push(value); }, onAnswer: () => {},
    });
    const id = `decision-${events.length}`;
    events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } });
    const answer = await callback('AskUserQuestion', input);
    expect(answer.updatedInput.answers).toEqual({ [input.questions[0].question]: 'Skip' });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
      content: JSON.stringify(answer.updatedInput.answers) }] } });
  }
  {
    const settled = JSON.parse(invoke(resumed.checkCommand));
    expect(settled).toEqual(checkPathReviewPrerequisites(f, resumed.input));
    expect(settled).toMatchObject({ synthetic: true, native_coverage: false, settled: true, current: true });
  }
  const finishAt = events.length;
  const record = JSON.stringify({ skill: 'review', status: 'clean', issues_found: 0,
    completed: true, converged: true, findings: change === 'unchanged' ? [] : [{ ...current, action: 'skipped' }] });
  invoke(declared ? protocol[2].replace("'FINAL_REVIEW_JSON'", shellQuote(record)).replace('REVIEW_START', token)
    : `${shellQuote(helper)} ${shellQuote(record)} --finish ${token} && ${shellQuote(path.join(SHARED_LIBS_ROOT, 'bin/gstack-review-read'))}`);
  const expected = { helper, repo: f.repo, state: f.state, slug: 'fixture-shared-libs',
    directory: path.join(f.state, 'projects/fixture-shared-libs/.review-starts'),
    branch: fixtureGit(f, 'symbolic-ref', '--quiet', '--short', 'HEAD'), wtree: fixtureWorkingTree(f),
    startedAt: receipt.review_start.started_at, finding: current, reusable: change === 'unchanged',
    coveredPaths: receipt.snapshot.covered_paths,
    ...(prepared ? { sources: Object.fromEntries(current!.evidence_paths.map((file: string) => [file, fs.readFileSync(path.join(f.repo, file), 'utf8')])) } : {}) };
  return { f, current, token, receipt, events, checkAt, finishAt, expected, prepared, resumed, prerequisites, ...(declared ? { questions } : {}) };
}

export function replay(change = 'unchanged') { return structuredClone(captures.get(change)); }
export function call(run: any, at = run.checkAt) { return run.events[at].message.content[0]; }
export function result(run: any, at = run.checkAt) { return run.events[at + 1].message.content[0]; }
export function alterReceipt(run: any, change: (receipt: any) => void) {
  const receipt = JSON.parse(result(run).content);
  change(receipt);
  result(run).content = JSON.stringify(receipt);
}

export function pathCallback(run: any, overrides: Record<string, any> = {}) {
  const start = pathSource.indexOf('async function exerciseEligibility(');
  const end = pathSource.indexOf('\ndescribeE2E(', start);
  const readStart = pathSource.indexOf('function sourceReadTrace(');
  expect(start).toBeGreaterThan(readStart);
  expect(end).toBeGreaterThan(start);
  const rows: any[] = [];
  const native = { events: run.events, exitReason: 'success', output: '', toolCalls: run.events
    .filter((event: any) => event.type === 'assistant')
    .flatMap((event: any) => event.message.content.filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({ tool: block.name, input: block.input }))) };
  const exercise = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`const {
    captures, preparePathEligibilityFixture, fs, path, reviewLifecycleInstructions, reviewRevalidationPrompt,
    runSharedInteractive, readRequests, toolCommandTrace, fixtureGit, fixtureWorkingTree, reviewRecords, expect,
    CAPTURE_LONG_MS, hasTrustedSharedLibsCheck, SHARED_LIBS_ROOT,
    checkPathReviewPrerequisites, hasPathReviewPrerequisiteReceipt } = deps;
    ${pathSource.slice(readStart, end)} return exerciseEligibility;`))({
    captures: { runAttempt: async (_name: string, _kinds: string[], _timeout: number, work: any) =>
      work({ add: (scenario: string, row: any) => rows.push({ scenario, row }) }) },
    preparePathEligibilityFixture: () => run.prepared,
    fs: { ...fs, rmSync: (directory: string) => { expect(directory).toBe(run.f.root); } }, path,
    reviewLifecycleInstructions, reviewRevalidationPrompt,
    runSharedInteractive: async (fixture: any, _name: string, prompt: string, choice: string) => {
      expect(choice).toBe('skip');
      expect(fixture).toBe(run.prepared.fixture);
      expect(prompt).toContain(reviewRevalidationPrompt(fixture, path.join(fixture.root, 'review-lifecycle.md'),
        path.join(fixture.root, 'current-advisory.jsonl'), run.prepared.resumed));
      return { result: native, questions: run.questions ?? [{}] };
    },
    readRequests: () => [], toolCommandTrace, fixtureGit, fixtureWorkingTree, reviewRecords, expect,
    CAPTURE_LONG_MS, hasTrustedSharedLibsCheck, SHARED_LIBS_ROOT,
    checkPathReviewPrerequisites, hasPathReviewPrerequisiteReceipt, ...overrides,
  });
  return { rows, invoke: () => exercise('shared-libs-review-path-eligibility', [run.kind]) };
}

export function capturedPathRun(index: number) {
  const captured = structuredClone(capturedChecker.attempts[index]);
  const events: any[] = captured.events;
  const blocks = events.flatMap(event => event.message.content);
  const calls = blocks.filter(block => block.type === 'tool_use');
  const returned = (id: string) => {
    const result = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === id);
    expect(result).toBeDefined();
    expect(result.is_error).not.toBe(true);
    expect(typeof result.content).toBe('string');
    return result.content as string;
  };
  const files = new Map<string, string>(calls.filter(call => call.name === 'Read')
    .map(call => [call.input.file_path, returned(call.id).replace(/^\d+\t/gm, '')]));
  const repo = captured.repo, root = path.posix.dirname(repo), state = path.posix.join(root, 'state');
  const input = path.posix.join(root, 'resumed-review-prerequisites.json');
  const supplied = path.posix.join(root, 'current-advisory.jsonl');
  const current = JSON.parse(files.get(supplied)!);
  const prerequisiteCall = calls.find(call => call.input.command?.includes('--check-review-prerequisites'));
  const prerequisites = JSON.parse(returned(prerequisiteCall.id));
  expect(prerequisites).toMatchObject({ settled: true, current: true, context: { binding: { root, repo, state } } });
  expect(prerequisites.context).toEqual(JSON.parse(files.get(input)!));
  const finish = calls.find(call => call.input.command?.includes('--finish'));
  const records = returned(finish.id).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const f = { root, repo, state } as SharedLibsFixture;
  const run = { f, kind: 'assume-unchanged', events, questions: calls.filter(call => call.name === 'AskUserQuestion').map(call => call.input),
    prepared: { fixture: f, current, sourcePaths: ['src/retry-route.ts'], beforeTree: prerequisites.context.binding.wtree,
      resumed: { input, checkCommand: prerequisiteCall.input.command } } };
  expect(captured.exit_reason).toBe('success');
  expect(run.questions).toHaveLength(1);
  for (const call of calls.filter(call => call.name === 'AskUserQuestion')) {
    for (const question of call.input.questions) {
      expect(returned(call.id)).toContain(`"${question.question}"="Skip"`);
      expect(question.options.some((option: any) => option.label === 'Skip')).toBe(true);
    }
  }
  const overrides = {
    path: path.posix, SHARED_LIBS_ROOT: '/workspace/gstack',
    fs: {
      readFileSync: (file: string) => { expect(files.has(file)).toBe(true); return files.get(file); },
      realpathSync: (file: string) => file,
      writeFileSync: (file: string, contents: string) => {
        expect(file).toBe(supplied);
        expect(JSON.parse(contents)).toEqual(current);
      },
      rmSync: (directory: string) => { expect(directory).toBe(root); },
    },
    reviewLifecycleInstructions: () => path.posix.join(root, 'review-lifecycle.md'),
    checkPathReviewPrerequisites: (fixture: SharedLibsFixture, file: string) => {
      expect(fixture).toBe(f); expect(file).toBe(input); return prerequisites;
    },
    fixtureGit: (fixture: SharedLibsFixture, ...args: string[]) => {
      expect(fixture).toBe(f); expect(args).toEqual(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return prerequisites.context.binding.branch;
    },
    fixtureWorkingTree: (fixture: SharedLibsFixture) => {
      expect(fixture).toBe(f); return prerequisites.context.binding.wtree;
    },
    reviewRecords: (fixture: SharedLibsFixture) => { expect(fixture).toBe(f); return structuredClone(records); },
  };
  return { run, overrides };
}
