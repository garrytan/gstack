// Split from test/shared-libs-checker-interface-evidence.test.ts (GSTA-151): the cases that replay the declared-protocol captures.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { sharedLibsFingerprint } from '../lib/review-evidence';
import { hasTrustedSharedLibsCheck, hasTrustedReviewStartRead } from './helpers/shared-libs-review-start-evidence';
import {
  fixtureGit, fixtureWorkingTree, reviewRecords, SHARED_LIBS_ROOT, toolCommandTrace, type SharedLibsFixture,
} from './helpers/shared-libs-eval-fixture';
import {
  preparePathEligibilityFixture, checkPathReviewPrerequisites, hasPathReviewPrerequisiteReceipt,
} from './helpers/shared-libs-path-fixture';
import { fixtures, captures, pathKinds, capture, replay, call, result, pathCallback } from './helpers/shared-libs-checker-evidence';

const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs.test.ts'), 'utf8');

beforeAll(async () => {
  for (const change of ['unchanged', 'secondary', 'branch', 'filtered']) captures.set(`declared-${change}`, await capture(change, undefined, true));
  for (const kind of pathKinds) captures.set(`declared-path-${kind}`, await capture(`path-${kind}`, preparePathEligibilityFixture(kind), true));
}, 120_000);
afterAll(() => { for (const fixture of fixtures) fs.rmSync(fixture.root, { recursive: true, force: true }); });

describe('native executable shared-code checker evidence', () => {
  test('the actual path callback consumes the current synthetic prerequisite result without claiming native coverage', async () => {
    const run = replay('declared-path-assume-unchanged');
    run.kind = 'assume-unchanged';
    let verified = 0;
    const adapter = pathCallback(run, { hasPathReviewPrerequisiteReceipt: (events: any[], command: string, expected: any) => {
      verified++;
      expect(command).toBe(run.prepared.resumed.checkCommand);
      expect(expected).toMatchObject({ synthetic: true, native_coverage: false, settled: true, current: true });
      expect(expected.context.binding.repo).toBe(run.f.repo);
      expect(expected.context.binding.state).toBe(run.f.state);
      expect(expected.context.binding.index).toMatch(/^h /m);
      return hasPathReviewPrerequisiteReceipt(events, command, expected);
    } });
    await adapter.invoke();
    expect(verified).toBe(1);
    expect(adapter.rows[0].row.passed).toBe(true);
    expect(adapter.rows[0].row.transcript[0]).toMatchObject({
      prerequisite_source: 'synthetic-fixture-input', prerequisite_native_coverage: false,
    });
    const refused = pathCallback(run, { hasPathReviewPrerequisiteReceipt: () => false });
    await expect(refused.invoke()).rejects.toThrow('consume current synthetic prerequisites');
    expect(refused.rows[0].row.passed).toBe(false);
  });

  test.each(['missing', 'failed', 'unpaired', 'assistant-only', 'caption', 'false', 'foreign state', 'after finish'])(
    'the registered path callback rejects %s prerequisite receipts even with a completed record', async invalid => {
      const run = replay('declared-path-ignored');
      run.kind = 'ignored';
      const at = run.events.findIndex((event: any) => event.type === 'assistant'
        && event.message.content[0].input?.command === run.prepared.resumed.checkCommand);
      expect(at).toBeGreaterThan(run.checkAt);
      if (invalid === 'missing') run.events.splice(at, 2);
      if (invalid === 'failed') result(run, at).is_error = true;
      if (invalid === 'unpaired') result(run, at).tool_use_id = 'another-call';
      if (invalid === 'assistant-only') run.events[at + 1].type = 'assistant';
      if (invalid === 'caption') call(run, at).input = { command: 'true', description: run.prepared.resumed.checkCommand };
      if (invalid === 'false' || invalid === 'foreign state') {
        const receipt = JSON.parse(result(run, at).content);
        if (invalid === 'false') receipt.settled = false;
        else receipt.context.binding.state = '/another-fixture/state';
        result(run, at).content = JSON.stringify(receipt);
      }
      if (invalid === 'after finish') run.events.push(...run.events.splice(at, 2));
      const adapter = pathCallback(run);
      await expect(adapter.invoke()).rejects.toThrow('consume current synthetic prerequisites');
      expect(adapter.rows[0].row.passed).toBe(false);
    });

  test.each(['raw source', 'supplied context'])('the registered callback rejects late changes to %s', async changed => {
    const run = replay('declared-path-assume-unchanged');
    run.kind = 'assume-unchanged';
    const file = changed === 'raw source' ? path.join(run.f.repo, 'src/retry-route.ts') : run.prepared.resumed.input;
    const before = fs.readFileSync(file, 'utf8');
    const adapter = pathCallback(run, { runSharedInteractive: async () => {
      fs.writeFileSync(file, before + '\n');
      return { questions: run.questions, result: { exitReason: 'success', output: '', events: run.events,
        toolCalls: run.events.filter((event: any) => event.type === 'assistant')
          .map((event: any) => ({ tool: event.message.content[0].name, input: event.message.content[0].input })) } };
    } });
    try {
      await expect(adapter.invoke()).rejects.toThrow('prerequisite state must remain unchanged');
      expect(adapter.rows[0].row.passed).toBe(false);
    } finally { fs.writeFileSync(file, before); }
  });

  test.each(['unchanged', 'secondary', 'branch', 'filtered'])('declared receipt commands satisfy the real %s revalidation callback', change => {
    const run = replay(`declared-${change}`);
    expect(result(run, 0).content.trim()).toBe(run.token);
    expect(JSON.parse(result(run).content)).toEqual(run.receipt);
    expect(call(run, run.finishAt).input.command).toContain(`--finish ${run.token} && '${SHARED_LIBS_ROOT}/bin/gstack-review-read'`);
    expect(run.questions).toHaveLength(change === 'unchanged' ? 0 : 1);
    const scenario = source.slice(source.indexOf("test('shared-libs-review-revalidation'"));
    const marker = '}, result => {';
    const start = scenario.indexOf(marker) + marker.length;
    const body = scenario.slice(start, scenario.indexOf('\n        });', start));
    const verify = new Function('deps', 'result', new Bun.Transpiler({ loader: 'ts' }).transformSync(`const {
      change, questions, expect, toolCommandTrace, reviewRecords, createHash, path, f, current,
      fixtureGit, fixtureWorkingTree, hasTrustedReviewStartRead, hasTrustedSharedLibsCheck, SHARED_LIBS_ROOT,
      resumed, prerequisites, checkPathReviewPrerequisites, hasPathReviewPrerequisiteReceipt
    } = deps; ${body}`));
    const native = { events: run.events, toolCalls: run.events.filter((event: any) => event.type === 'assistant')
      .map((event: any) => ({ tool: event.message.content[0].name, input: event.message.content[0].input })) };
    let checks = 0;
    verify({ change, questions: run.questions, expect, toolCommandTrace, reviewRecords, createHash, path,
      f: run.f, current: run.current, fixtureGit, fixtureWorkingTree, hasTrustedReviewStartRead, SHARED_LIBS_ROOT,
      resumed: run.resumed, prerequisites: run.prerequisites, checkPathReviewPrerequisites, hasPathReviewPrerequisiteReceipt,
      hasTrustedSharedLibsCheck: (events: unknown[], expected: any) => {
        checks++;
        expect(events).toBe(run.events);
        expect(expected).toEqual(run.expected);
        return hasTrustedSharedLibsCheck(events, expected);
      } }, native);
    expect(checks).toBe(1);
  });

  test.each(pathKinds)('declared receipt commands satisfy the real %s path callback after an actual actor decision', async kind => {
    const run = replay(`declared-path-${kind}`);
    run.kind = kind;
    expect(result(run, 0).content.trim()).toBe(run.token);
    expect(JSON.parse(result(run).content)).toEqual(run.receipt);
    expect(run.receipt.reusable).toBe(false);
    expect(run.questions).toHaveLength(1);
    let checks = 0;
    const adapter = pathCallback(run, { hasTrustedSharedLibsCheck: (events: unknown[], expected: any) => {
      checks++;
      expect(expected).toEqual(run.expected);
      return hasTrustedSharedLibsCheck(events, expected);
    } });
    await adapter.invoke();
    expect(checks).toBe(1);
    expect(adapter.rows).toMatchObject([{ scenario: kind, row: { passed: true } }]);
  });

  test.each(['revised-only identity', 'unsupported finding', 'unfinished review', 'missing explicit decision'])(
    'canonical transport cannot waive %s in the real ignored-path callback', async failure => {
      const run = replay('declared-path-ignored');
      run.kind = 'ignored';
      if (failure === 'missing explicit decision') run.questions = [];
      const adapter = pathCallback(run, { reviewRecords: (fixture: SharedLibsFixture) => {
        const records = reviewRecords(fixture);
        const final = records.at(-1);
        if (failure === 'revised-only identity') {
          const revised = { ...final.findings[0], evidence_paths: [
            'src/retry-worker.ts', 'src/scheduler.ts', 'src/retry-route.ts', 'lib/retry-after.ts',
          ] };
          revised.fingerprint = sharedLibsFingerprint(revised);
          revised.snapshot_covered_paths = [...revised.evidence_paths];
          expect(revised.fingerprint).not.toBe(run.current.fingerprint);
          final.findings = [revised];
        }
        if (failure === 'unsupported finding') final.findings = [];
        if (failure === 'unfinished review') final.completed = false;
        return records;
      } });
      await expect(adapter.invoke()).rejects.toThrow();
      expect(adapter.rows).toMatchObject([{ scenario: 'ignored', row: { passed: false } }]);
    });

  test.each(['start batching', 'mixed checker stdout', 'finish metadata prelude', 'loop-only caller reads'])(
    'the unchanged detector still rejects %s after protocol declaration', shape => {
      const run = replay('declared-unchanged');
      if (shape === 'start batching') call(run, 0).input.command = `echo start; ${call(run, 0).input.command}; git diff origin/main`;
      if (shape === 'mixed checker stdout') result(run).content = `checker receipt:\n${result(run).content}\nexit=0`;
      if (shape === 'finish metadata prelude') call(run, run.finishAt).input.command = `TS=$(date -u); ${call(run, run.finishAt).input.command}`;
      if (shape === 'loop-only caller reads') {
        for (const event of run.events) for (const block of event.message.content) {
          if (block.type === 'tool_use' && block.name === 'Bash' && block.input.command.startsWith('cat ')) {
            block.input.command = `for f in ${block.input.command.slice(4)}; do cat "$f"; done`;
          }
        }
      }
      expect(hasTrustedSharedLibsCheck(run.events, run.expected)).toBe(false);
    });
});
