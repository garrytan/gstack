/**
 * The generated bun-test child that test/docsync-fault-interface*.test.ts run: it mocks the docsync
 * fixture, observer, e2e gate and session runner, imports test/skill-e2e-ship-docsync.test.ts and replays
 * its registered callbacks (moved verbatim from test/docsync-fault-interface.test.ts, GSTA-151).
 */
import * as path from 'node:path';
import { DOCS_CHECKPOINT_MARKER } from './docsync-fault-actor';

export function docsFaultCallbackScript(root: string): string {
  return `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillTestResult } from ${JSON.stringify(path.join(root, 'test/helpers/session-runner'))};
const root = ${JSON.stringify(root)};
const fixtureModule = path.join(root, 'test/helpers/docsync-fixture.ts');
const observerModule = path.join(root, 'test/helpers/docsync-observer.ts');
const fixtures = { ...await import(fixtureModule) };
const observers = { ...await import(observerModule) };
const { CAPTURE_MS, CAPTURE_LONG_MS } = await import(path.join(root, 'test/helpers/eval-budgets.ts'));
const { parseDocsCompletion } = await import(path.join(root, 'test/helpers/docsync-contract.ts'));
const { docsActorSeeded, DOCS_SEEDED_AUDIT_ID } = await import(path.join(root, 'test/helpers/docsync-fault-actor.ts'));
const callbacks = new Map();
let fixture, control = '', launches = 0, recorded, legacyReaudit = false;
let returnedResult: SkillTestResult | undefined;
let consumers: string[] = [];
function expectResult(result: SkillTestResult) {
  expect(result).toBe(returnedResult);
  expect(result).toEqual({
    toolCalls: expect.any(Array), browseErrors: [], exitReason: 'success', duration: 0,
    output: 'Bounded callback replay complete', transcript: [], model: 'free-callback-replay',
    firstResponseMs: 0, maxInterTurnMs: 0,
    costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 1 },
  });
  expect(result.toolCalls.length).toBeGreaterThan(0);
}
mock.module(fixtureModule, () => ({ ...fixtures,
  fixtureDocs(...args) { fixture = fixtures.fixtureDocs(...args); return fixture; },
}));
mock.module(observerModule, () => ({ ...observers,
  docsBoundedStageInterface(...args) { return observers.docsBoundedStageInterface(...args) + '\\nBOUNDED_CALLBACK_USED'; },
}));
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({ describeE2ETier: () => (_name, body) => body() }));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  runId: 'free-docsync-faults', describeIfSelected: (_name, _names, body) => body(),
  testConcurrentIfSelected: (name, body, budget) => callbacks.set(name, { body, budget }),
  createEvalCollector: () => ({}), finalizeEvalCollector() {},
  logCost(_name, result) {
    expectResult(result);
    consumers.push('logCost');
  },
  recordE2E(_collector, _name, _label, result, verdict) {
    expectResult(result);
    expect(verdict).toEqual({ passed: control === '' });
    consumers.push('recordE2E');
    recorded = verdict;
  },
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({ async runSkillTest(options) {
  launches++;
  const legacy = options.testName === 'ship-docsync-failure';
  const scenario = legacy ? 'legacy-completion' : options.testName.slice('ship-docsync-'.length);
  expect(options.maxTurns).toBe(legacy ? 30 : 24);
  expect(options.timeout).toBeGreaterThan((legacy ? CAPTURE_LONG_MS : CAPTURE_MS) - 20_000);
  expect(options.timeout).toBeLessThanOrEqual((legacy ? CAPTURE_LONG_MS : CAPTURE_MS) - 15_000);
  expect(options.tools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  expect(options.allowedTools).toEqual(options.tools);
  expect(options.prompt).toContain('BOUNDED_CALLBACK_USED');
  expect(options.prompt).toContain(fixture.invocation);
  expect(options.prompt).toContain('only you apply the loaded workflow');
  expect(options.prompt).toContain('do not probe invented ids');
  expect(options.prompt).toContain('Save each actual completion/rejected output once');
  expect(options.prompt).toContain('Private artifact filenames must end in .json, .md or .markdown');
  expect(options.prompt).toContain('.txt and .log filenames are not supported');
  expect(options.prompt).toContain('in a .md file without changing its bytes or reconstructing JSON');
  expect(options.prompt).toContain('the parent must not manufacture it');
  const repairable = ['recovery', 'late-result'].includes(scenario);
  const actor = path.join(root, 'test/helpers/docsync-fault-actor.ts');
  const stateFile = path.join(fixture.home, 'actor-state.json');
  expect(options.prompt.includes('bun ' + actor + ' repair ' + stateFile)).toBe(repairable);
  expect(options.prompt.includes('returns no result within the Collect deadline')).toBe(repairable);
  expect(options.prompt.includes('This launcher has no repair operation')).toBe(!repairable);
  expect(options.prompt.includes('bun ' + actor + ' inspect ' + stateFile)).toBe(true);
  expect(options.prompt).toContain('batched read-only observation');
  expect(options.prompt).toContain('Parent output handling');
  expect(options.prompt).toContain('as its own standalone Bash call with no redirect, pipe, wrapper, substitution or other composition');
  expect(options.prompt).toContain('Native Read, Glob and Grep stay available for file reads and are not Bash commands');
  expect(options.prompt).toContain('Never redirect a command into a file and never re-run a command merely to save its output');
  expect(options.prompt).toContain('Keep inspect observations in their original tool results in context and compare those returned values directly');
  expect(options.prompt).toContain('Do not transcribe or reserialize inspect JSON into duplicate snapshot files; prepare already saves the required candidate and prompt');
  expect(options.prompt).toContain('preserve each actual child completion/rejected output once in Markdown');
  expect(options.prompt).toContain('Persist each required checkpoint as one short appended journal entry');
  expect(options.prompt).toContain('use native Edit with old_string exactly ' + ${JSON.stringify(JSON.stringify(DOCS_CHECKPOINT_MARKER))});
  expect(options.prompt).toContain('new_string containing only the new entry followed by that same marker, and replace_all=false');
  expect(options.prompt).toContain('if missing or duplicated, stop rather than guessing an edit');
  expect(options.prompt).toContain('Preserve unrelated sections and every earlier entry byte-for-byte');
  expect(options.prompt).toContain("retaining each earlier attempt's id, count, evidence paths and outcome");
  expect(options.prompt).toContain('The latest stated value is current; do not recopy previous entries');
  expect(options.prompt).toContain('Reference saved candidate/prompt/completion artifacts instead of repeating their contents or prior narration');
  expect(options.prompt).toContain('Before dispatch, save the incremented attempt count, fresh audit id and candidate/prompt paths together');
  expect(options.prompt).toContain('Save the returned child handle before polling');
  expect(options.prompt).toContain('consolidation must never postpone the pre-launch count or child-settlement checks');
  expect(options.prompt).toContain('If recovery is authorized, save the intermediate result in one checkpoint before continuing it');
  expect(options.prompt).toContain('After the loaded Continue or recover / Blocked recovery steps reach a final outcome');
  expect(options.prompt).toContain('Append the finishing checkpoint and Write the complete report in the same response using separate native file calls');
  expect(options.prompt).toContain('Never omit the final report or final response, even when publication is blocked');
  expect(options.prompt).toContain('when it requires stopping, write the required invocation state and report, then stop rather than continuing later preparation to fill optional artifacts');
  expect(options.prompt).toContain('do not introduce any undeclared comparison or processing program to compare or transform observations');
  expect(options.prompt).toContain('Use only the transport commands above and the commands permitted by the Fixture observation interface below');
  expect(options.prompt).toContain('inspect takes no arguments beyond the state path shown above');
  expect(options.prompt).not.toContain('inspect call below');
  expect(options.prompt).not.toContain('inspect receipt');
  const calls = [];
  const config = JSON.parse(fs.readFileSync(path.join(fixture.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const hook = config.hooks.PreToolUse.flatMap(entry => entry.hooks).find(entry => entry.command.includes('docsync-fault-actor.ts'));
  expect(hook).toBeDefined();
  const record = (tool, input, output) => calls.push({ tool, input, output });
  const pretool = (tool, input) => {
    const result = Bun.spawnSync(['bash', '-c', hook.command], { cwd: fixture.repo,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.repo, tool_name: tool, tool_input: input })),
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  const read = file_path => {
    pretool('Read', { file_path });
    const output = fs.readFileSync(file_path, 'utf8');
    record('Read', { file_path }, output);
    return output;
  };
  const write = (file_path, content) => {
    pretool('Write', { file_path, content });
    fs.writeFileSync(file_path, content);
    record('Write', { file_path, content }, 'File written');
  };
  const invoke = (action, args = {}) => {
    const argv = [actor, action, stateFile, ...Object.entries(args).map(([key, value]) => key + '=' + value)];
    const command = 'bun ' + argv.join(' ');
    pretool('Bash', { command });
    const result = Bun.spawnSync([process.execPath, ...argv], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    const text = result.stdout.toString().trimEnd();
    const output = (result.exitCode ? 'Exit code ' + result.exitCode + '\\n' : '') + text;
    record('Bash', { command }, output);
    return { text, output, exit: result.exitCode };
  };
  read(path.join(fixture.home, 'phase.md'));
  read(path.join(fixture.skills, 'ship/sections/documentation.md'));
  const initialRecord = read(fixture.invocation);
  expect(initialRecord).toContain('Attempts used: 0');
  expect(initialRecord).toContain('synthetic prior-stage state');
  const marker = ${JSON.stringify(DOCS_CHECKPOINT_MARKER)};
  expect(initialRecord.split(marker)).toHaveLength(2);
  const recordPrefix = initialRecord.split(marker)[0];
  let checkpointCount = 0;
  const seeded = docsActorSeeded(scenario);
  let attemptsUsed = seeded ? 1 : 0;
  let seedOutput = '';
  if (seeded) {
    expect(initialRecord).toContain('Attempts used: 1');
    read(path.join(fixture.home, 'candidate-' + DOCS_SEEDED_AUDIT_ID + '.json'));
    const saved = path.join(fixture.home, 'completion-' + DOCS_SEEDED_AUDIT_ID + '.md');
    seedOutput = control === 'skip-seeded-output' ? fs.readFileSync(saved, 'utf8') : read(saved);
  }
  const checkpoint = (details, finished = false) => {
    const before = fs.readFileSync(fixture.invocation, 'utf8');
    expect(before.split(marker)).toHaveLength(2);
    const entry = '### Checkpoint ' + (++checkpointCount) + '\\nAttempts used: ' + attemptsUsed + '.\\n'
      + details + '\\nNext: ' + (finished ? 'Documentation gate finished; see ship-report.md. STOP before Step 15.' : 'Continue the actual documentation gate; STOP before Step 15.') + '\\n';
    const input = { file_path: fixture.invocation, old_string: marker, new_string: entry + marker, replace_all: false };
    pretool('Edit', input);
    const after = before.replace(input.old_string, input.new_string);
    fs.writeFileSync(fixture.invocation, after);
    record('Edit', input, 'File edited');
    expect(after.startsWith(recordPrefix)).toBe(true);
    expect(after.replace(input.new_string, marker)).toBe(before);
    expect(after.split(marker)).toHaveLength(2);
    expect(input.new_string).not.toContain(recordPrefix);
  };
  const inspectResult = invoke('inspect');
  const observed = JSON.parse(inspectResult.text);
  expect(observed.operation).toBe('inspect');
  expect(observed.files[fixtures.DOC_PATH].exists).toBe(true);
  expect(observed.pre_existing_dirty).toContain(String.fromCharCode(0));
  expect(inspectResult.text).not.toContain(String.fromCharCode(0));
  expect(calls.at(-1).output).toBe(inspectResult.text);
  if (control === 'tampered-inspect') calls[calls.length - 1].output = inspectResult.text.replace('"operation":"inspect"', '"operation":"tampered"');
  const prepare = id => {
    const result = invoke('prepare', { audit_id: id });
    expect(result.exit).toBe(0);
    const prepared = JSON.parse(result.text);
    read(prepared.candidate);
    read(prepared.prompt);
    return prepared;
  };
  const dispatch = prepared => {
    attemptsUsed++;
    checkpoint('Audit: ' + prepared.audit_id + '; candidate: ' + prepared.candidate + '; prompt: ' + prepared.prompt);
    const result = invoke('dispatch', { audit_id: prepared.audit_id, candidate: prepared.candidate, prompt: prepared.prompt, run_in_background: 'false' });
    const saved = calls.at(-2);
    expect(saved.tool).toBe('Edit');
    expect(saved.input.file_path).toBe(fixture.invocation);
    expect(saved.input.old_string).toBe(marker);
    expect(saved.input.new_string).toContain('Attempts used: ' + attemptsUsed);
    expect(saved.input.new_string).toContain(prepared.audit_id);
    expect(saved.input.new_string).toContain(prepared.candidate);
    expect(saved.input.new_string).toContain(prepared.prompt);
    return result;
  };
  let output = '', accepted = null, first;
  if (scenario !== 'missing-asset') {
    first = seeded ? { audit_id: DOCS_SEEDED_AUDIT_ID, candidate: path.join(fixture.home, 'candidate-' + DOCS_SEEDED_AUDIT_ID + '.json'),
      prompt: path.join(fixture.home, 'prompt-' + DOCS_SEEDED_AUDIT_ID + '.md') } : prepare('ship-docs-20260926-a1');
    const initial = seeded ? { text: seedOutput, output: seedOutput } : dispatch(first);
    output = initial.text;
    if (scenario === 'missing-marker') {
      expect(initial.output).toBe('SESSION_KIND: interactive\\n{"schema_version":1,"audit_id":"' + first.audit_id + '","status":"blocked","files_updated":[],"files_reviewed":[],"documentation_section":"blocked — fixture child audit ' + first.audit_id + '; Missing spawned marker.","blockers":["Missing spawned marker"],"decisions":[]}');
    }
    if (scenario === 'launch-failure') {
      expect(initial.text).toBe('Child launch failed: injected unavailable worker. No child was started.');
      expect(seeded ? initialRecord.includes('dispatch exit code 23') : initial.output.startsWith('Exit code 23\\n')).toBe(true);
      const attempts = JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].id).toBeNull();
      expect(attempts[0].candidate).toBe(fs.readFileSync(first.candidate, 'utf8'));
    }
    if (['timeout-unsettled', 'late-result'].includes(scenario)) {
      expect(initial.output).toBe('{"task_id":"fixture-child-1","status":"running","elapsed_ms":0,"virtual_clock":true}');
      const task_id = JSON.parse(output).task_id;
      if (seeded) expect(initialRecord).toContain('Returned child handle: ' + task_id + '.');
      else checkpoint('Running child handle: ' + task_id);
      expect(invoke('status', { task_id }).output).toBe('{"task_id":"fixture-child-1","status":"running","settled":false,"elapsed_ms":600001,"virtual_clock":true}');
      const stop = invoke('stop', { task_id });
      expect(JSON.parse(stop.text).settled).toBe(scenario === 'late-result');
      if (control !== 'skip-post-stop-status') {
        const status = invoke('status', { task_id });
        if (scenario === 'timeout-unsettled') expect(status.output).toBe('{"task_id":"fixture-child-1","status":"running","settled":false,"elapsed_ms":900002,"virtual_clock":true}');
      }
    }
    if (repairable) expect(invoke('repair').exit).toBe(0);
    if (repairable || scenario.startsWith('stale-') || legacy && legacyReaudit) {
      read(path.join(fixture.repo, 'app.ts'));
      const second = prepare('ship-docs-20260926-a2');
      if (control === 'stale-candidate' || control === 'legacy-stale') {
        const old = JSON.parse(fs.readFileSync(first.candidate, 'utf8'));
        old.audit_id = second.audit_id;
        write(second.candidate, JSON.stringify(old));
      }
      output = dispatch(second).text;
      if (scenario === 'late-result') expect(() => parseDocsCompletion(output, second.audit_id)).toThrow('completion identity');
      else if (legacy) expect(() => parseDocsCompletion(output, second.audit_id)).toThrow('completion fields');
      else accepted = parseDocsCompletion(output, second.audit_id);
      if (control === 'legacy-third') {
        const third = prepare('ship-docs-20260926-a3');
        output = dispatch(third).text;
      }
    }
  } else {
    expect(fs.existsSync(path.join(fixture.skills, 'document-release/sections/audit-scope.md'))).toBe(false);
  }
  if (control === 'invalid-repair') expect(invoke('repair').output).toBe('Exit code 24\\nError: repair not available');
  if (control === 'invented-handle') expect(invoke('status', { task_id: 'ship-docs-20260926-a1' }).output).toBe('Exit code 24\\nError: unknown fixture child');
  if (control === 'restore-partial') write(path.join(fixture.repo, fixtures.DOC_PATH), Buffer.from(fixture.before.contents[fixtures.DOC_PATH], 'base64').toString());
  if (control === 'user-content') write(path.join(fixture.repo, 'personal-note.txt'), 'clobbered');
  if (control === 'private-state') read(stateFile);
  if (control === 'git-mutation') record('Bash', { command: 'git add ' + fixtures.DOC_PATH }, '');
  const runShell = (command) => {
    pretool('Bash', { command });
    const r = Bun.spawnSync(['bash', '-c', command], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    record('Bash', { command }, (r.exitCode ? 'Exit code ' + r.exitCode + '\\n' : '') + r.stdout.toString().trimEnd());
    return r.exitCode;
  };
  if (control === 'redirect-transport') {
    const snapshot = path.join(fixture.home, 'snapshot.json');
    expect(runShell('bun ' + actor + ' inspect ' + stateFile + ' > ' + snapshot)).toBe(0);
    expect(calls.at(-1).output).toBe('');
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8')).head).toBe(observed.head);
  }
  if (control === 'compare-program') expect(runShell('diff ' + path.join(fixture.repo, fixtures.DOC_PATH) + ' ' + path.join(fixture.repo, fixtures.DOC_PATH))).toBe(0);
  if (control === 'mutate-index') {
    const staged = Bun.spawnSync(['git', 'add', fixtures.DOC_PATH], { cwd: fixture.repo, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(staged.exitCode).toBe(0);
  }
  if (['legacy-unchanged', 'legacy-unsettled', 'legacy-fake-repair'].includes(control)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (control === 'legacy-unchanged') {
      state.tasks[1].observed_candidate.hashes = { ...state.tasks[0].observed_candidate.hashes };
      state.tasks[1].candidate = JSON.stringify(state.tasks[1].observed_candidate);
    }
    if (control === 'legacy-unsettled') state.tasks[0].settled = false;
    if (control === 'legacy-fake-repair') { state.repaired = true; state.events.push({ action: 'repair' }); }
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  const outside = path.join(path.dirname(import.meta.path), 'outside.md');
  if (control === 'outside-artifact') record('Write', { file_path: outside, content: output }, 'attempted write');
  if (control === 'protected-artifact') record('Write', { file_path: path.join(fixture.skills, 'private.md'), content: output }, 'attempted write');
  if (control === 'script-artifact') record('Write', { file_path: actor, content: output }, 'attempted write');
  if (control === 'symlink-artifact') {
    fs.writeFileSync(outside, 'outside fixture control');
    const link = path.join(fixture.home, 'linked.md');
    fs.symlinkSync(outside, link);
    record('Write', { file_path: link, content: output }, 'attempted write');
  }
  write(path.join(fixture.home, control === 'raw-text-artifact' ? 'completion.txt' : 'completion.md'), output);
  expect(fs.readFileSync(path.join(fixture.home, control === 'raw-text-artifact' ? 'completion.txt' : 'completion.md'), 'utf8')).toBe(output);
  if (control === '') expect(fs.readdirSync(fixture.home).filter(name => /inspect|snapshot/.test(name))).toEqual([]);
  const report = path.join(fixture.home, 'ship-report.md');
  const finalReport = control === 'false-current' ? 'Documentation: current' : accepted
    ? 'Documentation: ' + accepted.status + '\\n' + accepted.documentation_section
    : 'Documentation: blocked\\n' + (legacy ? 'Invalid legacy completion; partial edit retained: ' + fixtures.DOC_PATH : 'Actual child result did not clear the gate') + '\\nEvidence: completion.md';
  checkpoint(finalReport, true);
  if (control !== 'missing-report') write(report, finalReport);
  expect(fs.readFileSync(fixture.invocation, 'utf8')).toContain(finalReport);
  expect(fs.readFileSync(fixture.invocation, 'utf8')).toContain('Attempts used: ' + attemptsUsed);
  if (attemptsUsed > 1) expect(fs.readFileSync(fixture.invocation, 'utf8')).toContain(first.audit_id);
  if (control === '') {
    expect(calls.slice(-2).map(call => [call.tool, call.input.file_path])).toEqual([
      ['Edit', fixture.invocation], ['Write', report],
    ]);
    expect(fs.readFileSync(report, 'utf8')).toBe(finalReport);
  }
  if (accepted) expect(invoke('publish', { audit_id: accepted.audit_id, report }).exit).toBe(0);
  if (control === 'invalid-publication') expect(invoke('publish', { audit_id: 'ship-docs-20260926-a1', report }).exit).toBe(24);
  returnedResult = { exitReason: 'success', output: 'Bounded callback replay complete', toolCalls: calls, transcript: [],
    browseErrors: [], duration: 0, model: 'free-callback-replay', firstResponseMs: 0, maxInterTurnMs: 0,
    costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 1 } } satisfies SkillTestResult;
  return returnedResult;
} }));
await import(path.join(root, 'test/skill-e2e-ship-docsync.test.ts'));
expect(callbacks.size).toBe(12);
const names = ['ship-docsync-failure', 'ship-docsync-missing-marker', 'ship-docsync-missing-asset',
  'ship-docsync-launch-failure', 'ship-docsync-timeout-unsettled', 'ship-docsync-late-result',
  'ship-docsync-stale-before', 'ship-docsync-stale-after', 'ship-docsync-recovery'];
for (const name of names) test(name + ' consumes actual adapter results', async () => {
  control = '';
  legacyReaudit = false;
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  const before = launches;
  expect(callbacks.get(name).budget).toBe(name === 'ship-docsync-failure' ? CAPTURE_LONG_MS : CAPTURE_MS);
  await callbacks.get(name).body();
  expect(launches).toBe(before + 1);
  expect(recorded).toEqual({ passed: true });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
test('ship-docsync-failure accepts its remaining changed-input audit and preserves raw output in Markdown', async () => {
  control = '';
  legacyReaudit = true;
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  await callbacks.get('ship-docsync-failure').body();
  expect(recorded).toEqual({ passed: true });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
for (const [name, mutation] of [
  ['ship-docsync-failure', 'false-current'], ['ship-docsync-failure', 'invalid-publication'],
  ['ship-docsync-failure', 'restore-partial'], ['ship-docsync-failure', 'user-content'],
  ['ship-docsync-failure', 'private-state'], ['ship-docsync-failure', 'git-mutation'],
  ['ship-docsync-failure', 'mutate-index'], ['ship-docsync-missing-marker', 'invalid-repair'],
  ['ship-docsync-missing-marker', 'redirect-transport'], ['ship-docsync-missing-marker', 'compare-program'],
  ['ship-docsync-launch-failure', 'invented-handle'], ['ship-docsync-timeout-unsettled', 'skip-post-stop-status'],
  ['ship-docsync-late-result', 'missing-report'],
  ['ship-docsync-stale-before', 'stale-candidate'],
  ['ship-docsync-recovery', 'skip-seeded-output'],
  ['ship-docsync-failure', 'legacy-unchanged'], ['ship-docsync-failure', 'legacy-unsettled'],
  ['ship-docsync-failure', 'legacy-stale'], ['ship-docsync-failure', 'legacy-third'],
  ['ship-docsync-failure', 'legacy-fake-repair'],
  ['ship-docsync-missing-marker', 'tampered-inspect'],
  ['ship-docsync-missing-marker', 'raw-text-artifact'], ['ship-docsync-missing-marker', 'outside-artifact'],
  ['ship-docsync-missing-marker', 'protected-artifact'], ['ship-docsync-missing-marker', 'symlink-artifact'],
  ['ship-docsync-missing-marker', 'script-artifact'],
]) test(name + ' rejects ' + mutation, async () => {
  control = mutation;
  legacyReaudit = name === 'ship-docsync-failure';
  recorded = undefined;
  returnedResult = undefined;
  consumers = [];
  await expect(callbacks.get(name).body()).rejects.toThrow();
  expect(recorded).toEqual({ passed: false });
  expect(consumers).toEqual(['logCost', 'recordE2E']);
  expect(fs.existsSync(fixture.home)).toBe(false);
});
`;
}
