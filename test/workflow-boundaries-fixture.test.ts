import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryProvider } from './helpers/agent-sdk-runner';
import { resolveClaudeBinary } from '../lib/claude-bin';
import type { EvalTestEntry } from './helpers/eval-store';
import { createBoundaryFixture, runBoundaryActor, type BoundaryCase } from './helpers/workflow-boundaries-fixture';
import { E2E_TIERS, E2E_TOUCHFILES } from './helpers/touchfiles-data';
import { PR_PROFILE_CASE_IDS, PR_PROFILE_FILES } from '../scripts/test-pr-profile';
import { applyHollowShardGuard, buildRunManifest, computePaidCaseSelection, DEFAULT_SHARD_TIMEOUT_MS, expectedPrCaseCount, prProfileTestNamePattern, resolvePaidShardBudget, retriesForFiles, verifySliceResults, type SliceResult } from '../scripts/test-paid-shards';
import { CAPTURE_MS } from './helpers/eval-budgets';

const cases: BoundaryCase[] = ['investigate-owned-completion', 'investigate-owned-abort', 'investigate-owned-ending-error'];
const files = ['test/skill-e2e-investigate-owned-completion.test.ts', 'test/skill-e2e-investigate-owned-termination.test.ts'];

for (const attack of ['read-state', 'cat-state', 'bash-edit', 'receipt-write']) test(`fixture denies undeclared interaction: ${attack}`, async () => {
  const fixture = createBoundaryFixture('investigate-owned-completion');
  try {
    const tool = attack === 'read-state' ? 'Read' : 'Bash';
    const input = attack === 'read-state' ? { file_path: fixture.boundary }
      : { command: attack === 'cat-state' ? `cat '${fixture.boundary}'`
        : attack === 'bash-edit' ? 'printf "arbitrary source" > src/value.js' : `printf FREEZE_RELEASED > '${fixture.receipts}'` };
    const decision = await fixture.canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: attack });
    expect(decision.behavior).toBe('deny');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

function protocolControl(id: BoundaryCase, faults: { skipCleanup?: boolean; duplicateQuestion?: boolean; failVerification?: boolean; rateLimit?: boolean; undeclared?: string; misleadingFinal?: boolean; splitFinal?: boolean } = {}) {
  let directory = '';
  let calls = 0;
  const provider: QueryProvider = input => {
    calls++;
    const options = input.options!;
    directory = options.cwd!;
    const env = options.env!;
    expect(options.permissionMode).toBe('default');
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.maxTurns).toBe(12);
    expect(options.allowedTools).toEqual([]);
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.pathToClaudeCodeExecutable).toBe(resolveClaudeBinary() ?? undefined);
    expect(fs.realpathSync(env.GSTACK_HOME!)).toBe(path.join(path.dirname(directory), 'state'));
    expect(env.HOME).toBe(path.join(path.dirname(directory), 'home'));
    const executeTool = async (tool: string, input: Record<string, unknown>) => {
      const decision = await options.hooks!.PreToolUse![0].hooks[0]({
        hook_event_name: 'PreToolUse', session_id: 'fixture', transcript_path: path.join(directory, 'transcript'),
        cwd: directory, tool_name: tool, tool_input: input, tool_use_id: `fixture-${calls}`,
      }, `fixture-${calls}`, { signal: new AbortController().signal });
      if ('async' in decision) throw new Error('fixture hook must be synchronous');
      expect(decision.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      const hook = decision.hookSpecificOutput as { permissionDecision?: string; updatedInput?: Record<string, unknown> };
      if (hook.permissionDecision === 'deny') throw new Error(`native fixture guard denied ${tool}`);
      expect(hook.permissionDecision).toBe(tool === 'AskUserQuestion' ? 'ask' : 'allow');
      return hook.updatedInput ?? input;
    };
    const shell = async (command: string) => {
      const approved = await executeTool('Bash', { command });
      expect(approved.timeout).toBe(10000);
      expect(approved.run_in_background).toBe(false);
      return spawnSync('bash', ['-c', approved.command as string], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
    };
    const ask = async (question: string, labels: string[]) => {
      const input = { questions: [{ header: 'Fixture', question, options: labels.map(label => ({ label, description: label })), multiSelect: false }] };
      await executeTool('AskUserQuestion', input);
      return options.canUseTool!('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: `fixture-${calls}` });
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'fixture-session' } as SDKMessage;
        if (faults.misleadingFinal) yield { type: 'assistant', session_id: 'fixture-session', parent_tool_use_id: null,
          message: { id: 'message-early', role: 'assistant', content: [{ type: 'text', text: 'I will ask whether to continue or abort, and stop if the verifier reports an error.' }] } } as SDKMessage;
        if (faults.undeclared) {
          const state = path.join(env.GSTACK_HOME!, 'freeze-dir.txt');
          const receipt = path.join(path.dirname(directory), 'receipts');
          await executeTool(faults.undeclared === 'read-state' ? 'Read' : 'Bash', faults.undeclared === 'read-state' ? { file_path: state } : {
            command: faults.undeclared === 'cat-state' ? `cat '${state}'`
              : faults.undeclared === 'bash-edit' ? 'printf "arbitrary source" > src/value.js' : `printf FREEZE_RELEASED > '${receipt}'`,
          });
        }
        expect(fs.readFileSync(path.join(directory, 'workflow.md'), 'utf8')).toContain('Terminal cleanup');
        expect(fs.existsSync(path.join(env.GSTACK_HOME!, 'freeze-dir.txt'))).toBe(false);
        const acquisition = await shell('bash "$HOME/.claude/skills/gstack/freeze/bin/freeze-state.sh" acquire "src"');
        expect(acquisition.status).toBe(0);
        const owner = acquisition.stdout.match(/FREEZE_OWNER=([a-f0-9]{32})/)![1];
        if (faults.rateLimit && calls === 1) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Attempt one acquired scope.' }] } } as SDKMessage;
          throw Object.assign(new Error('rate limit'), { status: 429 });
        }
        const decision = await ask('Continue this investigation or abort?', ['Continue', 'Abort']);
        expect(decision.behavior).toBe('allow');
        if (decision.behavior !== 'allow') throw new Error('fixture refused its declared question');
        if (faults.duplicateQuestion) await ask('Continue this investigation or abort?', ['Continue', 'Abort']);
        const answer = (decision.updatedInput!.answers as Record<string, string>)['Continue this investigation or abort?'];
        if (answer === 'Continue') {
          await executeTool('Edit', { file_path: path.join(directory, 'src/value.js'), old_string: 'return 1', new_string: 'return 2' });
          expect(fs.realpathSync(path.join(directory, 'src/value.js')).startsWith(directory + path.sep)).toBe(true);
          fs.writeFileSync(path.join(directory, 'src/value.js'), 'export function value() { return 2; }\n');
          if (faults.failVerification) {
            const file = path.join(directory, 'verify.sh');
            expect(fs.realpathSync(file).startsWith(directory + path.sep)).toBe(true);
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('value() !== 2', 'value() !== 3'));
          }
          const verified = await shell('bash ./verify.sh');
          expect(verified.status).toBe(id === 'investigate-owned-ending-error' ? 69 : faults.failVerification ? 1 : 0);
        } else expect(answer).toBe('Abort');
        if (!faults.skipCleanup) expect((await shell(`bash "$HOME/.claude/skills/gstack/freeze/bin/freeze-state.sh" release "${owner}"`)).status).toBe(0);
        const finalText = faults.misleadingFinal ? 'The fix is complete and verification succeeded.'
          : id === 'investigate-owned-abort' ? 'Aborted at your request; no edit was made and the owned boundary was released.'
          : id === 'investigate-owned-ending-error' ? 'The verifier is unavailable; the investigation ended with an error and the owned boundary was released.'
          : 'The correction passed verification and the owned boundary was released.';
        yield { type: 'assistant', session_id: 'fixture-session', parent_tool_use_id: null,
          message: { id: 'message-final', role: 'assistant', content: [{ type: 'text', text: finalText }] } } as SDKMessage;
        if (faults.splitFinal) yield { type: 'assistant', session_id: 'fixture-session', parent_tool_use_id: null,
          message: { id: 'message-final', role: 'assistant', content: [{ type: 'text', text: 'No further action was taken.' }] } } as SDKMessage;
        yield { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0 } as SDKMessage;
      },
    } as Query;
  };
  return { provider, directory: () => directory, calls: () => calls };
}

for (const id of cases) test(`fixture protocol control: ${id} persists receipts after cleanup`, async () => {
  const driver = protocolControl(id);
  const records: EvalTestEntry[] = [];
  await runBoundaryActor(id, entry => records.push(entry), driver.provider);
  expect(records).toHaveLength(1);
  expect(records[0].passed).toBe(true);
  expect(records[0].cost_usd).toBe(0);
  expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
  const retained = JSON.parse(records[0].output!);
  expect(retained.attempts).toHaveLength(1);
  expect(retained.attempts[0].events).toHaveLength(3);
  expect(retained.evidence.changedProtectedFiles).toEqual([]);
  expect(retained.evidence.receipts).toContain('FREEZE_RELEASED');
  expect(retained.evidence.interactions).toHaveLength(1);
});

for (const attack of ['read-state', 'cat-state', 'bash-edit', 'receipt-write']) test(`registered native hook rejects and retains denied ${attack}`, async () => {
  const driver = protocolControl('investigate-owned-completion', { undeclared: attack });
  const records: EvalTestEntry[] = [];
  await expect(runBoundaryActor('investigate-owned-completion', entry => records.push(entry), driver.provider)).rejects.toThrow('native fixture guard denied');
  expect(records[0].passed).toBe(false);
  const evidence = JSON.parse(records[0].output!).evidence;
  expect(evidence.executions).toHaveLength(1);
  expect(evidence.executions[0].allowed).toBe(false);
  expect(evidence.source).toBe('export function value() { return 1; }\n');
  expect(evidence.receipts).toBe('');
  expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
});

test('duplicate owner questions are rejected by the registered native hook', async () => {
  const driver = protocolControl('investigate-owned-completion', { duplicateQuestion: true });
  const records: EvalTestEntry[] = [];
  await expect(runBoundaryActor('investigate-owned-completion', entry => records.push(entry), driver.provider)).rejects.toThrow('native fixture guard denied AskUserQuestion');
  const evidence = JSON.parse(records[0].output!).evidence;
  expect(evidence.interactions.filter((event: { disposition: string }) => event.disposition === 'continue-investigation')).toHaveLength(1);
  expect(evidence.interactions.at(-1).disposition).toBe('unsupported-tool');
  expect(evidence.executions.at(-1).allowed).toBe(false);
});

test('fixture rejects a successful actor result when owned cleanup is missing', async () => {
  const driver = protocolControl('investigate-owned-abort', { skipCleanup: true });
  const records: EvalTestEntry[] = [];
  await expect(runBoundaryActor('investigate-owned-abort', entry => records.push(entry), driver.provider)).rejects.toThrow('owned boundary remains');
  expect(records[0].passed).toBe(false);
  expect(records[0].exit_reason).toBe('assertion_failed');
  expect(JSON.parse(records[0].output!).evidence.boundary).toContain('gstack-freeze-v1:');
  expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
});

test('fixture records failed verification rather than crediting successful cleanup', async () => {
  const driver = protocolControl('investigate-owned-completion', { failVerification: true });
  const records: EvalTestEntry[] = [];
  await expect(runBoundaryActor('investigate-owned-completion', entry => records.push(entry), driver.provider)).rejects.toThrow('verification did not succeed');
  expect(JSON.parse(records[0].output!).evidence.receipts).toContain('VERIFY_STATUS:1');
});

test('rate-limit retry restores the fixture and retains both native event streams', async () => {
  const driver = protocolControl('investigate-owned-completion', { rateLimit: true });
  const records: EvalTestEntry[] = [];
  await runBoundaryActor('investigate-owned-completion', entry => records.push(entry), driver.provider);
  expect(driver.calls()).toBe(2);
  const retained = JSON.parse(records[0].output!);
  expect(retained.attempts).toHaveLength(2);
  expect(retained.attempts[0].evidence.boundary).toContain('gstack-freeze-v1:');
  expect(retained.attempts[0].events.find((event: SDKMessage) => event.type === 'assistant').message.content[0].text).toContain('Attempt one');
  expect(retained.attempts[1].evidence.boundary).toBe('');
});

for (const id of ['investigate-owned-abort', 'investigate-owned-ending-error'] as const) {
  test(`${id}: an earlier acknowledgment cannot cover a misleading final response`, async () => {
    const driver = protocolControl(id, { misleadingFinal: true });
    const records: EvalTestEntry[] = [];
    await expect(runBoundaryActor(id, entry => records.push(entry), driver.provider)).rejects.toThrow(/acknowledge/);
    expect(records[0].passed).toBe(false);
    const retained = JSON.parse(records[0].output!);
    expect(retained.evidence.receipts).toContain('FREEZE_RELEASED');
    expect(retained.evidence.boundary).toBe('');
    expect(retained.assistant).toContain('whether to continue or abort');
    expect(retained.assistant).toContain('The fix is complete and verification succeeded.');
    expect(fs.existsSync(path.dirname(driver.directory()))).toBe(false);
  });
  test(`${id}: the actual final response can span multiple native fragments`, async () => {
    const driver = protocolControl(id, { splitFinal: true });
    const records: EvalTestEntry[] = [];
    await runBoundaryActor(id, entry => records.push(entry), driver.provider);
    expect(records[0].passed).toBe(true);
  });
}

test('fixture binds the configured CLI executable rather than the SDK bundled version', async () => {
  const previous = process.env.GSTACK_CLAUDE_BIN;
  process.env.GSTACK_CLAUDE_BIN = process.execPath;
  try {
    const driver = protocolControl('investigate-owned-abort');
    const records: EvalTestEntry[] = [];
    await runBoundaryActor('investigate-owned-abort', entry => records.push(entry), driver.provider);
    expect(records[0].passed).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.GSTACK_CLAUDE_BIN;
    else process.env.GSTACK_CLAUDE_BIN = previous;
  }
});

test('fixture refuses a skill registration escaping the temporary root before writing', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gbound-link-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gbound-out-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'home'));
    expect(() => createBoundaryFixture('investigate-owned-completion', root)).toThrow('fixture write escapes');
    expect(fs.readdirSync(outside)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('F9 actors are registered in the gate PR profile with exact file ownership', () => {
  for (const id of cases) {
    expect(E2E_TIERS[id], id).toBe('gate');
    expect(PR_PROFILE_CASE_IDS as readonly string[]).toContain(id);
    expect(E2E_TOUCHFILES[id]).toContain('test/helpers/workflow-boundaries-fixture.ts');
  }
  expect(PR_PROFILE_FILES[files[0]]).toEqual([cases[0]]);
  expect(PR_PROFILE_FILES[files[1]]).toEqual(cases.slice(1));
});

test('F9 changed-input selection produces three cases with exact patterns and counts', () => {
  const selected = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: ['freeze/bin/freeze-state.sh'] });
  expect(selected.coverage?.mode).toBe('pr');
  expect(selected.coverage?.unknownFiles).toEqual([]);
  expect(selected.selection.e2e).toEqual([...cases].sort());
  expect(files.map(file => expectedPrCaseCount(file, selected.selection))).toEqual([1, 2]);
  expect(prProfileTestNamePattern(files[0], selected.selection)).toBe('(?:^|\\s)(?:investigate-owned-completion)$');
  expect(prProfileTestNamePattern(files[1], selected.selection)).toBe('(?:^|\\s)(?:investigate-owned-abort|investigate-owned-ending-error)$');
});

test('both F9 files fit the existing wall with every Bun retry and reserve', () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(import.meta.dir, '..', file), 'utf8');
    const count = PR_PROFILE_FILES[file].length;
    expect([...source.matchAll(/\}, CAPTURE_MS\);/g)]).toHaveLength(count);
    expect(retriesForFiles([file])).toBe(1);
    const budget = resolvePaidShardBudget([file]);
    expect(budget).toEqual({ timeoutMs: DEFAULT_SHARD_TIMEOUT_MS, source: 'default', policyId: null });
    expect(count * CAPTURE_MS * (retriesForFiles([file]) + 1) + 120000).toBeLessThanOrEqual(budget.timeoutMs);
  }
});

test('F9 manifest rejects skipped, missing and hollow actor coverage', () => {
  const manifest = buildRunManifest({ tier: 'gate', profile: 'pr', sliceCount: 1,
    evalsAll: false, env: {}, changedFiles: ['freeze/bin/freeze-state.sh'], discovered: files });
  expect(manifest.entries.filter(entry => entry.status === 'planned').map(entry => entry.file).sort()).toEqual(files);
  const result: SliceResult = {
    version: 1, tier: 'gate', profile: 'pr', selection: manifest.selection, sliceIndex: 1, sliceCount: 1,
    outcomes: manifest.entries.map(entry => ({ files: [entry.file], status: 'passed', exitCode: 0, elapsedMs: 1,
      executedTests: expectedPrCaseCount(entry.file, manifest.selection!), skippedTests: 0,
      ...(entry.budget ? { budget: entry.budget } : {}),
    })),
  };
  expect(verifySliceResults(manifest, [result]).ok).toBe(true);
  for (const mutation of ['skip', 'empty', 'missing']) {
    const invalid = structuredClone(result);
    if (mutation === 'skip') invalid.outcomes[1].skippedTests = 1;
    if (mutation === 'empty') invalid.outcomes[1].executedTests = 0;
    if (mutation === 'missing') invalid.outcomes.pop();
    expect(verifySliceResults(manifest, [invalid]).ok).toBe(false);
  }
  const hollow = { ...result.outcomes[1], executedTests: 0, skippedTests: 2, shard: 1, groupPid: null };
  expect(applyHollowShardGuard([hollow], { evalsAll: false, requireExecuted: true })[0].status).toBe('passed-empty');
});
