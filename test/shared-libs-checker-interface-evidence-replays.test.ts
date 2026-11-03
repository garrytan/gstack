// Split from test/shared-libs-checker-interface-evidence.test.ts (GSTA-151): the cases that need no beforeAll capture (R59 public attempts, synthetic prerequisites, captured gate reads).
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasTrustedSharedLibsCheck } from './helpers/shared-libs-review-start-evidence';
import { fixtureGit, fixtureWorkingTree } from './helpers/shared-libs-eval-fixture';
import { preparePathEligibilityFixture, checkPathReviewPrerequisites } from './helpers/shared-libs-path-fixture';
import { pathCallback, capturedPathRun } from './helpers/shared-libs-checker-evidence';
import loopRead from './fixtures/shared-libs-index-flags-loop-read-39173752116.json';
import erroredRead from './fixtures/shared-libs-path-ignored-errored-read-40617200857.json';

describe('native executable shared-code checker evidence', () => {
  test.each([0, 1])('the complete R59 public attempt %i satisfies the actual callback without a manual fingerprint call', async index => {
    const { run, overrides } = capturedPathRun(index);
    const commands = run.events.flatMap(event => event.message.content)
      .filter(block => block.type === 'tool_use' && block.name === 'Bash').map(block => block.input.command).join('\n');
    expect(commands).not.toContain('sharedLibsFingerprint');
    let checks = 0;
    const adapter = pathCallback(run, { ...overrides, hasTrustedSharedLibsCheck: (events: unknown[], expected: any) => {
      checks++;
      expect(events).toBe(run.events);
      expect(expected.finding).toEqual(run.prepared.current);
      expect(expected.reusable).toBe(false);
      expect(expected.coveredPaths).toEqual(['src/retry-worker.ts', 'lib/retry-after.ts']);
      return hasTrustedSharedLibsCheck(events, expected);
    } });
    await adapter.invoke();
    expect(checks).toBe(1);
    expect(adapter.rows).toMatchObject([{ scenario: 'assume-unchanged', row: { passed: true } }]);
    const refused = pathCallback(run, { ...overrides, hasTrustedSharedLibsCheck: () => false });
    await expect(refused.invoke()).rejects.toThrow();
    expect(refused.rows[0].row.passed).toBe(false);
  });

  test.each([0, 1].flatMap(index => ['missing', 'failed', 'unpaired', 'fingerprint', 'binding', 'extra coverage'].map(invalid => [index, invalid] as const)))(
    'the R59 public attempt %i callback rejects a %s checker receipt', async (index, invalid) => {
      const { run, overrides } = capturedPathRun(index);
      const blocks = run.events.flatMap(event => event.message.content);
      const check = blocks.find(block => block.type === 'tool_use' && block.input.command?.includes('--check-shared-libs'));
      const receipt = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === check.id);
      if (invalid === 'missing') receipt.content = '';
      else if (invalid === 'failed') receipt.is_error = true;
      else if (invalid === 'unpaired') receipt.tool_use_id = 'unpaired-checker';
      else {
        const value = JSON.parse(receipt.content);
        if (invalid === 'fingerprint') value.fingerprint = `shared-libs:${'a'.repeat(64)}`;
        if (invalid === 'binding') value.review_start.started_at = 'foreign';
        if (invalid === 'extra coverage') value.snapshot.covered_paths.push('src/retry-route.ts');
        receipt.content = JSON.stringify(value);
      }
      let checks = 0;
      const adapter = pathCallback(run, { ...overrides, hasTrustedSharedLibsCheck: (events: unknown[], expected: any) => {
        checks++;
        return hasTrustedSharedLibsCheck(events, expected);
      } });
      await expect(adapter.invoke()).rejects.toThrow();
      expect(checks).toBe(1);
      expect(adapter.rows[0].row.passed).toBe(false);
    });

  test.each(['missing file', 'missing QA', 'empty probes', 'failed probe', 'missing native', 'failed native',
    'blocked native', 'foreign state', 'branch', 'base', 'index flag', 'raw hidden source', 'configuration', 'structured required'])(
    'synthetic prerequisites cannot settle with %s', async invalid => {
      const prepared = preparePathEligibilityFixture('assume-unchanged'), f = prepared.fixture;
      try {
        const original = checkPathReviewPrerequisites(f, prepared.resumed.input);
        expect(original.settled).toBe(true);
        const context = structuredClone(original.context);
        if (invalid === 'missing QA') delete context.qa;
        if (invalid === 'empty probes') context.qa.required_probes = [];
        if (invalid === 'failed probe') context.qa.required_probes[0].status = 'failed';
        if (invalid === 'missing native') delete context.native_adversarial;
        if (invalid === 'failed native' || invalid === 'blocked native') context.native_adversarial.status = invalid.split(' ')[0];
        if (invalid === 'foreign state') context.binding.state = '/another-fixture/state';
        if (invalid === 'structured required') context.structured_review.required = true;
        fs.writeFileSync(prepared.resumed.input, JSON.stringify(context));
        if (invalid === 'missing file') fs.unlinkSync(prepared.resumed.input);
        if (invalid === 'branch') fixtureGit(f, 'checkout', '-b', 'another-branch');
        if (invalid === 'base') fixtureGit(f, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
        if (invalid === 'index flag') fixtureGit(f, 'update-index', '--no-assume-unchanged', 'src/retry-route.ts');
        if (invalid === 'raw hidden source') {
          fs.appendFileSync(path.join(f.repo, 'src/retry-route.ts'), '\n// Changed after the synthetic QA result\n');
          expect(fixtureWorkingTree(f)).toBe(original.context.binding.wtree);
        }
        if (invalid === 'configuration') fixtureGit(f, 'config', 'core.ignorecase', 'true');
        const checked = checkPathReviewPrerequisites(f, prepared.resumed.input);
        expect(checked.settled).toBe(false);
        expect(JSON.parse(execFileSync('bash', ['-c', prepared.resumed.checkCommand], {
          cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 30_000,
        }))).toEqual(checked);
        const run = { f, prepared, kind: 'assume-unchanged', events: [] };
        const adapter = pathCallback(run);
        await expect(adapter.invoke()).rejects.toThrow('fixture prerequisites must be settled before capture');
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
});

// Gate 39173752116 slice 12: the skip-worktree review read every evidence file in one
// literal for-loop that printed each path before its contents.
describe('literal loop reads from the captured skip-worktree review', () => {
  const loop = (events: any[]) => events.flatMap(event => event.message.content)
    .find((block: any) => block.type === 'tool_use' && block.input?.command?.startsWith('for f in '));
  const output = (events: any[], id: string) => events.flatMap(event => event.message.content)
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id);

  test('a literal loop whose output names each evidence file counts as reading it', () => {
    expect(hasTrustedSharedLibsCheck(structuredClone(loopRead.events), loopRead.expected)).toBe(true);
  });

  test.each(['variable list', 'file missing from output', 'path outside the repo'])('%s is still rejected', shape => {
    const events = structuredClone(loopRead.events), call = loop(events), files = 'src/retry-worker.ts src/retry-route.ts lib/retry-after.ts';
    expect(call.input.command).toContain(`for f in ${files} `);
    if (shape === 'variable list') call.input.command = `FILES="${files}"; ${call.input.command.replace(files, '$FILES')}`;
    if (shape === 'file missing from output') {
      const result = output(events, call.id);
      result.content = JSON.parse(JSON.stringify(result.content).replaceAll('src/retry-route.ts', 'src/omitted.ts'));
    }
    if (shape === 'path outside the repo') call.input.command = call.input.command.replace(' src/retry-route.ts ', ' ../outside/src/retry-route.ts ');
    expect(hasTrustedSharedLibsCheck(events, loopRead.expected)).toBe(false);
  });
});

// Gate 40617200857 slice 8: the ignored-path review returned all of src/retry-worker.ts through
// cat -n, then a later `echo ===` in the same call failed, so the result carried is_error.
describe('errored Bash reads from the captured ignored-path review', () => {
  const blocks = (events: any[]) => events.flatMap(event => event.message.content);
  const read = (events: any[]) => blocks(events).find((block: any) => block.type === 'tool_use'
    && block.input?.command?.startsWith('cat -n src/retry-worker.ts; echo ===;'));
  const output = (events: any[], id: string) => blocks(events).find((block: any) => block.type === 'tool_result' && block.tool_use_id === id);

  test('a whole evidence source returned before a later failure counts as reading it', () => {
    const events = structuredClone(erroredRead.events);
    expect(output(events, read(events).id).is_error).toBe(true);
    expect(hasTrustedSharedLibsCheck(events, erroredRead.expected)).toBe(true);
  });

  test.each(['no expected sources', 'empty expected source', 'last source line missing', 'missing file', 'errored single read', 'errored native Read', 'errored checker'])('%s is still rejected', shape => {
    const events = structuredClone(erroredRead.events), call = read(events), result = output(events, call.id);
    const expected: any = structuredClone(erroredRead.expected);
    if (shape === 'no expected sources') delete expected.sources;
    if (shape === 'empty expected source') expected.sources['src/retry-worker.ts'] = '';
    if (shape === 'last source line missing') result.content = result.content.replace(/\n +15\t\}\n/, '\n');
    if (shape === 'missing file') result.content = 'Exit code 1\ncat: src/retry-worker.ts: No such file or directory';
    if (shape === 'errored single read') call.input.command = 'cat -n src/retry-worker.ts';
    if (shape === 'errored native Read') {
      call.name = 'Read';
      call.input = { file_path: 'src/retry-worker.ts' };
    }
    if (shape === 'errored checker') {
      const checker = blocks(events).find((block: any) => block.type === 'tool_use' && block.input?.command?.includes('--check-shared-libs'));
      output(events, checker.id).is_error = true;
    }
    expect(hasTrustedSharedLibsCheck(events, expected)).toBe(false);
  });
});
