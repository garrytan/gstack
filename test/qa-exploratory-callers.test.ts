import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  callerExcerpt, callerProbeReadErrors, callerReviewRecordTemplate, callerSnapshot, callerTools, createQaCallerFixture, qaCallerInstructions,
  QA_CALLER_CASES, QA_CALLER_TEST_MS,
  qaCallerSessionOptions, qaCallerCommandAllowed, readCallerReceipt, retainQaCallerEvidence, runQaCaller, unloadedHelperCommand, validateCallerEvidence,
  type CallerProbe, type CallerReceipt, type QaCallerFixture,
} from './helpers/qa-callers-fixture';
import type { runSkillTest, SkillTestResult } from './helpers/session-runner';
import { SESSION_DRAIN_GRACE_MS } from './helpers/session-runner';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { readQACheckpointFiles } from './helpers/qa-checkpoint-evidence';
import { generateQAExploratory, generateQAResource, generateQAReview, generateQAReviewPreflight } from '../scripts/resolvers/qa';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { qaProbeNames } from './helpers/qa-probe-names';

function nativeCall(id: string, name: string, input: object, output: string, parent: string | null = null, failed = false) {
  return [
    { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: failed }] } },
  ];
}

const snapshot = callerSnapshot({ 'scale.ts': 'return n+n', 'README.md': 'double an integer' });
const happy: CallerProbe = { id: 'probe-happy', charter: 'happy', input: '3', snapshot, status: 'pass', stdout: '6\n', stderr: '', exit: 0 };
const adverse: CallerProbe = { id: 'probe-invalid', charter: 'adverse', input: 'no', snapshot, status: 'pass', stdout: '', stderr: 'integer required: 0..9\n', exit: 2 };
const diffPreface = 'DIFF_BASE=$(git merge-base origin/main HEAD) && ';
const capturedNativeDiffs = [
  `${diffPreface}git diff --name-status "$DIFF_BASE"`,
  `${diffPreface}git diff "$DIFF_BASE" -- . ':(exclude)*test*' ':(exclude)*fixture*' ':(exclude)*.spec.*'`,
  `${diffPreface}git diff --stat "$DIFF_BASE" -- '*test*' '*fixture*' '*.spec.*'`,
];
const generatedReviewRecord = (bin: string, token: string) => `${bin} '{"skill":"adversarial-review","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"clean","source":"in-host","host":"claude","outside_provider":"codex","outside_status":"unavailable","phase":"adversarial","tier":"always","gate":"informational","commit":"'"$(git rev-parse --short HEAD)"'","completed":true,"converged":true}' --finish ${token}`;
const checkpointRoots: string[] = [];
afterEach(() => { for (const root of checkpointRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function checkpointSequence(probes: CallerProbe[], reportRoot: string) {
  const transcript: unknown[] = [];
  const files: Record<string, string> = {};
  for (const [index, probe] of probes.entries()) {
    if (index) {
      const previous = probes[index - 1];
      const name = `exploration-${String(index).padStart(3, '0')}.json`;
      const content = JSON.stringify({ observationCommand: `bun scripts/probe.ts ${previous.input}`, observed: previous, hypothesis: 'The next distinct input should follow the documented CLI contract.', nextCommand: `bun scripts/probe.ts ${probe.input}` });
      files[name] = content;
      fs.writeFileSync(path.join(reportRoot, name), content, { mode: 0o600 });
      transcript.push(...nativeCall(`checkpoint-${index}`, 'Write', { file_path: path.join(reportRoot, name), content }, 'File created successfully'));
    }
    transcript.push(...nativeCall(probe.id, 'Bash', { command: `bun scripts/probe.ts ${probe.input}` }, JSON.stringify(probe), null, probe.exit !== 0));
  }
  return { transcript, checkpointFiles: files, reportMarkdown: Object.keys(files).map(name => `[Checkpoint](${name})`).join('\n') };
}

function evidence() {
  const probes = [happy, adverse].map(probe => ({ ...probe }));
  const reportRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-notes-'));
  checkpointRoots.push(reportRoot);
  const checkpoints = checkpointSequence(probes, reportRoot);
  return {
    caller: 'review' as const,
    result: { exitReason: 'success', transcript: [
      ...nativeCall('parent', 'Read', { file_path: '/fixture/caller-review.md' }, 'parent workflow'),
      ...nativeCall('shared', 'Read', { file_path: '/runtime/qa/sections/exploratory.md' }, 'shared method'),
      ...nativeCall('functional', 'Read', { file_path: '/runtime/qa/sections/system-functional.md' }, 'functional method'),
      ...checkpoints.transcript,
    ] as unknown[] },
    probes,
    receipt: { status: 'pass', probes: probes.map(probe => probe.id), remaining: [] } as CallerReceipt,
    currentSnapshot: snapshot,
    requiredCharters: ['happy', 'adverse'],
    mutations: [] as string[],
    observerComplete: true,
    reportRoot,
    checkpointFiles: checkpoints.checkpointFiles,
    reportMarkdown: checkpoints.reportMarkdown,
  };
}

function rebuildCheckpoints(observed: ReturnType<typeof evidence>) {
  const checkpoints = checkpointSequence(observed.probes, observed.reportRoot);
  observed.result.transcript = observed.result.transcript.slice(0, 6).concat(checkpoints.transcript);
  observed.checkpointFiles = checkpoints.checkpointFiles;
  observed.reportMarkdown = checkpoints.reportMarkdown;
}

describe('caller native-event observer controls', () => {
  test('captured instruction Read and probe in one provider response is not consumed instruction evidence', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/qa-caller-read-probe-mtb1007a.json'), 'utf8'));
    const tools = callerTools(captured.events);
    const probe = tools.find(tool => tool.name === 'Bash')!;
    const resources = ['exploratory', 'system-functional'].map(id => [id, tools.find(tool => String(tool.input.file_path).endsWith(`/qa/sections/${id}.md`))] as const);
    expect(resources[0][1]!.resultIndex).toBeLessThan(probe.index);
    expect(resources[0][1]!.messageId).toBe(probe.messageId);
    expect(callerProbeReadErrors(probe, resources)).toEqual([
      'probe preceded resource read: exploratory', 'probe preceded resource read: system-functional',
    ]);
    expect(callerProbeReadErrors({ ...probe, messageId: 'separate-response-control' }, resources))
      .toEqual(['probe preceded resource read: system-functional']);
    const ordered = structuredClone(captured.events);
    const command = ordered.splice(2, 2);
    command[0].message.id = 'separate-response-control';
    ordered.push(...command);
    const ready = callerTools(ordered);
    expect(callerProbeReadErrors(ready.find(tool => tool.name === 'Bash')!,
      ['exploratory', 'system-functional'].map(id => [id, ready.find(tool => String(tool.input.file_path).endsWith(`/qa/sections/${id}.md`))] as const))).toEqual([]);
  });

  test.each(['pending-result', 'same-event', 'same-message-id'])('method Read %s cannot authorize a dependent probe', ordering => {
    const observed = evidence();
    const events = observed.result.transcript as any[];
    if (ordering === 'pending-result') {
      const result = events.splice(5, 1)[0];
      events.splice(6, 0, result);
    } else if (ordering === 'same-event') {
      events[4].message.content.push(...events[6].message.content);
      events.splice(6, 1);
    } else {
      events[4].message.id = 'same-provider-message';
      events[6].message.id = 'same-provider-message';
    }
    expect(validateCallerEvidence(observed)).toContain('probe preceded resource read: system-functional');
  });

  test.each(['before-result', 'same-message-id'])('completed review logging rejects handoff %s', ordering => {
    const observed = evidence();
    const handoff = nativeCall('handoff', 'Read', { file_path: '/fixture/reports/HANDOFF.md' }, 'Fixture inputs changed.');
    const complete = nativeCall('complete-review', 'Bash', { command: generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token') }, 'Saved');
    observed.result.transcript.push(...handoff, ...complete);
    expect(validateCallerEvidence(observed)).toEqual([]);
    const events = observed.result.transcript as any[];
    if (ordering === 'before-result') {
      events.splice(-4, 4, handoff[0], complete[0], handoff[1], complete[1]);
    } else {
      (handoff[0].message as any).id = 'shared-finalization-turn';
      (complete[0].message as any).id = 'shared-finalization-turn';
    }
    expect(validateCallerEvidence(observed)).toContain('review completion preceded handoff freshness decision');
  });

  test('captured gate-census-5 review record: bun-wrapped helper and receipt status are outside the interface', () => {
    // ci-36629958451-1-gate-census-5 review-exploratory-small-cli, native events 68 and 70 (fixture paths shortened).
    const record = (status: string) => `/runtime/bin/gstack-review-log '{"skill":"review","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","commit":"'"$(git rev-parse --short HEAD)"'","branch":"caller-change","status":"${status}","completed":false,"converged":false,"critical":1,"informational":0,"findings":[{"path":"scale.ts","line":3,"category":"functional-contract","severity":"CRITICAL","fingerprint":"scale.ts:3:functional-contract","action":"ask-pending"}]}' --finish d45404cf-ba19-4bc6-a505-9801e9322f54`;
    const errorsFor = (command: string, caller: 'review' | 'ship' = 'review') => {
      const observed = { ...evidence(), caller };
      observed.result.transcript.push(...nativeCall('record', 'Bash', { command }, 'Saved'));
      return validateCallerEvidence(observed);
    };
    expect(errorsFor(`bun ${record('blocked')}`)).toContain('command outside declared caller observation interface');
    expect(errorsFor(record('blocked'))).toEqual(['review record status outside the review vocabulary: blocked']);
    expect(errorsFor(record('issues_found'))).toEqual([]);
    expect(errorsFor(record('unavailable'))).toEqual(['review record status outside the review vocabulary: unavailable']);
    // ci-36907899270-1-eval-slices-6: an accepted record whose finding cites checkpoints as evidence.
    const cited = record('issues_found').replace('"action":"ask-pending"}', '"action":"ask-pending","evidence":["reports/exploration-002.json","reports/exploration-003.json"]}');
    expect(cited).not.toBe(record('issues_found'));
    expect(errorsFor(cited)).toEqual([]);
    expect(errorsFor(`bun ${cited}`)).toEqual(['command outside declared caller observation interface', 'QA checkpoint: Unsupported checkpoint Bash interaction']);
    expect(errorsFor(record('unavailable'), 'ship').filter(error => error.includes('vocabulary'))).toEqual([]);
    expect(errorsFor(generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token').replace('"status":"clean"', '"status":"blocked"'))).toEqual([]);
    const prompt = (id: 'review-exploratory-small-cli' | 'ship-exploratory-small-cli') => {
      const fixture = createQaCallerFixture(id, { installRuntime: false });
      try { return qaCallerSessionOptions(fixture, 'free-control').prompt; } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
    };
    expect(prompt('review-exploratory-small-cli')).toContain('never through bun or another interpreter. A review record fills this installed template, keeping its keys and adding none: `');
    expect(prompt('review-exploratory-small-cli')).toContain('otherwise issues_found; a review stopped at a gate records completed:false');
    expect(prompt('ship-exploratory-small-cli')).toContain('otherwise issues_found (unavailable for missing dispatched reviewer output)');
  });

  test('captured gate-census-5 typo: a helper path bun could not load is held to the interface at the installed path', () => {
    // ci-37162480720-1-gate-census-5 review-exploratory-small-cli, native Bash call 7 (hypothesis shortened):
    // the actor dropped one character from the shard directory, bun refused the path, and the next call reran it.
    const typo = '/home/runner/.cache/gstack-paid-shard-A2tpF/tmp/qc-fTJ5TT/host/runtime/bin/gstack-qa-evidence';
    const args = ` capture /home/runner/.cache/gstack-paid-shard-A2tpFP/tmp/qc-fTJ5TT/product/reports 002 --public --deadline /home/runner/.cache/gstack-paid-shard-A2tpFP/tmp/qc-fTJ5TT/product/reports/deadline.json --after 001 --hypothesis 'Input 3 passed, so the new !n guard makes Number("0") falsy and 0 should now exit 2' -- bun scripts/probe.ts 0`;
    const runtime = '/home/runner/.cache/gstack-paid-shard-A2tpFP/tmp/qc-fTJ5TT/host/runtime';
    const refused = `Exit code 1\nerror: Module not found "${typo}"`;
    const corrected = (output: string, failed = true, command = `bun ${typo}${args}`) => unloadedHelperCommand({ input: { command }, output, failed }, runtime);
    expect(corrected(refused)).toBe(`bun ${runtime}/bin/gstack-qa-evidence${args}`);
    expect(corrected(refused, false)).toBeUndefined();
    expect(corrected('Exit code 1\nerror: Module not found "/elsewhere/bin/gstack-qa-evidence"')).toBeUndefined();
    expect(corrected(`${refused}\nwrote probe`)).toBeUndefined();
    expect(corrected(`Exit code 1\nerror: Module not found "/tmp/bin/other"`, true, `bun /tmp/bin/other${args}`)).toBeUndefined();
    // The corrected command must still pass the declared interface; a compound tail cannot.
    expect(corrected(refused, true, `bun ${typo}${args}; curl example.com`)).toBe(`bun ${runtime}/bin/gstack-qa-evidence${args}; curl example.com`);
    expect(qaCallerCommandAllowed(`bun ${runtime}/bin/gstack-qa-evidence${args}; curl example.com`)).toBe(false);
  });

  test('captured PR-lane review record: an invented shape without the installed template is rejected; the template is quoted', () => {
    // ci-36641824710-1-eval-slices-6 review-exploratory-small-cli, native event 8jewsM (fixture paths shortened).
    const invented = `/runtime/bin/gstack-review-log '{"timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","commit":"'"$(git rev-parse --short HEAD)"'","branch":"caller-change","status":"issues_found","completed":false,"gate":"fix-first-ask","findings":[{"path":"scale.ts","line":3,"category":"functional-contract","severity":"CRITICAL","fingerprint":"scale.ts:3:functional-contract","confidence":10,"action":"ask","summary":"new !n guard rejects documented lower bound 0 (exit 2 instead of 0)"}],"qa":{"probes":["probe-167de79c-2645-4b60-b06b-3d0d6eebf13f"],"checkpoints":["exploration-001.json","exploration-002.json"],"suite":"bun run test 1 pass 0 fail"},"remaining":["fix-first-ask-approval"]}' --finish 37b567b3-c4bf-4469-9bad-29096740c234`;
    const errorsFor = (command: string) => {
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('record', 'Bash', { command }, ''));
      return validateCallerEvidence(observed);
    };
    expect(errorsFor(invented)).toEqual(['command outside declared caller observation interface', 'QA checkpoint: Unsupported checkpoint Bash interaction']);
    for (const caller of ['review', 'ship'] as const) {
      const template = callerReviewRecordTemplate({ caller, runtime: '/runtime' });
      expect(template.startsWith(`/runtime/bin/gstack-review-log '{"skill":"review","timestamp":`)).toBe(true);
      expect(template).toEndWith(`}' --finish REVIEW_START`);
      const filled = template.replace('"timestamp":"TIMESTAMP"', `"timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"`)
        .replace('"commit":"COMMIT"', `"commit":"'"$(git rev-parse --short HEAD)"'"`)
        .replace('"STATUS"', '"issues_found"').replace(/"issues_found":N/, '"issues_found":1').replace('"critical":N', '"critical":1').replace('"informational":N', '"informational":0')
        .replace('SCORE', '10.0').replace('SPECIALISTS_JSON', '{}').replace('FINDINGS_JSON', '[{"fingerprint":"scale.ts:3:functional-contract","severity":"CRITICAL","action":"ask-pending"}]')
        .replace('COMPLETED', 'false').replace('CONVERGED', 'false').replace('CYCLES', '0').replace('REVIEW_START', 'native-token');
      expect(errorsFor(filled)).toEqual([]);
      const fixture = createQaCallerFixture(caller === 'review' ? 'review-exploratory-small-cli' : 'ship-exploratory-small-cli', { installRuntime: false });
      try { expect(qaCallerSessionOptions(fixture, 'free-control').prompt).toContain(callerReviewRecordTemplate(fixture)); } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
    }
  });

  test('captured PR-lane plan-completion git log is in the caller interface; other log forms stay outside', () => {
    // ci-36641824710-1-eval-slices-7 ship-exploratory-plan-checks, native event 3Pvdmu: ship/sections/plan-completion.md requires this read.
    expect(fs.readFileSync(path.join(import.meta.dir, '../ship/sections/plan-completion.md'), 'utf8')).toContain('`git log origin/<base>..HEAD --oneline`');
    expect(qaCallerCommandAllowed('git log origin/main..HEAD --oneline')).toBe(true);
    for (const command of ['git log', 'git log --oneline', 'git log origin/main..HEAD', 'git log origin/main..HEAD --oneline -p',
      'git log origin/main..HEAD --oneline --output=/tmp/x', 'git log --all --oneline', 'git log origin/main..HEAD --oneline; git push',
      'git log origin/main..HEAD --oneline && git commit -am x', 'git -c core.pager=x log origin/main..HEAD --oneline', 'git log origin/main...HEAD --oneline']) {
      expect(qaCallerCommandAllowed(command)).toBe(false);
    }
    const fixture = createQaCallerFixture('ship-exploratory-plan-checks', { installRuntime: false });
    try { expect(qaCallerSessionOptions(fixture, 'free-control').prompt).toContain("git log origin/main..HEAD --oneline, git diff"); } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('a later unchanged handoff reread does not invalidate an already completed freshness decision', () => {
    const observed = evidence();
    observed.result.transcript.push(
      ...nativeCall('initial-handoff', 'Read', { file_path: '/fixture/HANDOFF.md' }, 'No concurrent input update.'),
      ...nativeCall('complete-review', 'Bash', { command: generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token') }, 'Saved'),
      ...nativeCall('repeat-handoff', 'Read', { file_path: '/fixture/HANDOFF.md' }, 'No concurrent input update.'),
    );
    expect(validateCallerEvidence(observed)).toEqual([]);
    (observed.result.transcript.at(-1) as any).message.content[0].content = 'Fixture inputs changed.';
    expect(validateCallerEvidence(observed)).toContain('review completion preceded handoff freshness decision');
  });

  test.each(['valid', 'no-metadata', 'no-prior-metadata', 'wrong-path', 'wrong-parent', 'wrong-session',
    'partial-read', 'failed-read', 'wrong-output', 'pending-read', 'same-turn-read', 'changed-handoff', 'fake-cache-pair', 'intervening-partial'])
    ('native unchanged handoff acknowledgment requires an earlier full delivery: %s', variation => {
      const observed = evidence();
      const file = '/fixture/HANDOFF.md';
      const content = 'No concurrent input update.\n';
      const unchanged = 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.';
      const full = nativeCall('full-handoff', 'Read', { file_path: file }, '1\tNo concurrent input update.\n2\t') as any[];
      const completion = nativeCall('completion', 'Bash', { command: generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token') }, 'Saved') as any[];
      const cached = nativeCall('cached-handoff', 'Read', { file_path: file }, unchanged) as any[];
      for (const event of [...full, ...completion, ...cached]) event.session_id = 'native-session';
      full[0].message.id = 'earlier-read';
      completion[0].message.id = cached[0].message.id = 'completion-turn';
      full[1].tool_use_result = { type: 'text', file: { filePath: file, content, startLine: 1, numLines: 2, totalLines: 2 } };
      cached[1].tool_use_result = { type: 'file_unchanged', file: { filePath: file } };
      if (variation === 'no-metadata') delete cached[1].tool_use_result;
      if (variation === 'no-prior-metadata') delete full[1].tool_use_result;
      if (variation === 'wrong-path') cached[1].tool_use_result.file.filePath = '/other/HANDOFF.md';
      if (variation === 'wrong-parent') for (const event of full) event.parent_tool_use_id = 'other-agent';
      if (variation === 'wrong-session') for (const event of full) event.session_id = 'other-session';
      if (variation === 'partial-read') full[1].tool_use_result.file.totalLines = 3;
      if (variation === 'failed-read') full[1].message.content[0].is_error = true;
      if (variation === 'wrong-output') cached[1].message.content[0].content = 'The file is unchanged.';
      if (variation === 'same-turn-read') full[0].message.id = 'completion-turn';
      if (variation === 'changed-handoff') {
        cached[1].tool_use_result = { type: 'text', file: { filePath: file, content: 'Changed.\n', startLine: 1, numLines: 2, totalLines: 2 } };
        cached[1].message.content[0].content = '1\tChanged.\n2\t';
      }
      if (variation === 'fake-cache-pair') {
        full[1].message.content[0].content = unchanged;
        delete full[1].tool_use_result;
        delete cached[1].tool_use_result;
      }
      if (variation === 'intervening-partial') {
        const partial = nativeCall('partial-handoff', 'Read', { file_path: file, limit: 1 }, '1\tChanged.') as any[];
        for (const event of partial) event.session_id = 'native-session';
        partial[0].message.id = 'partial-read';
        full.push(...partial);
      }
      observed.result.transcript.push(...(variation === 'pending-read'
        ? [full[0], ...completion, full[1], ...cached] : [...full, ...completion, ...cached]));
      const failures = validateCallerEvidence(observed);
      if (variation === 'valid') expect(failures).toEqual([]);
      else expect(failures).toContain('review completion preceded handoff freshness decision');
    });

  test('independent resource Reads can share a turn without weakening checkpoint causality', () => {
    const observed = evidence();
    const events = observed.result.transcript as any[];
    observed.result.transcript = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [events[0], events[2], events[4]].flatMap(event => event.message.content) } },
      events[1], events[3], events[5], ...events.slice(6),
    ];
    expect(validateCallerEvidence(observed)).toEqual([]);
    const grouped = observed.result.transcript as any[];
    const checkpoint = grouped.findIndex(event => event.message.content.some((block: any) => block.type === 'tool_use' && block.name === 'Write'));
    grouped[checkpoint].message.content.push(...grouped[checkpoint + 2].message.content);
    grouped.splice(checkpoint + 2, 1);
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
  });

  test('a full parent section Read cannot substitute for actual method Reads', () => {
    const observed = evidence();
    observed.result.transcript.splice(0, 6, ...nativeCall('parent', 'Read', { file_path: '/fixture/caller-review.md' }, qaCallerInstructions('review')));
    const errors = validateCallerEvidence(observed);
    expect(errors).toEqual(['missing executed resource read: /qa/sections/exploratory.md', 'missing executed resource read: /qa/sections/system-functional.md']);
  });

  test('late-input synthetic replay keeps stale adverse coverage and overall remaining separate from passing happy proof', () => {
    const observed = evidence();
    const current = { ...happy, id: 'current-happy', snapshot: 'changed-fixture-inputs' };
    observed.probes.push(current);
    observed.currentSnapshot = current.snapshot;
    observed.receipt.probes = [current.id, adverse.id];
    observed.receipt.remaining = ['rerun rejection against changed fixture inputs'];
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual(['false green for charter: adverse', 'blocked, failing or incomplete coverage reported green']);
    observed.receipt.remaining = [];
    expect(validateCallerEvidence(observed)).toEqual(['missing current charter: adverse', 'false green for charter: adverse']);
    const freshAdverse = { ...adverse, id: 'current-adverse', snapshot: current.snapshot };
    observed.probes.push(freshAdverse);
    observed.receipt.probes = [current.id, freshAdverse.id];
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.result.transcript.splice(-4, 2);
    expect(validateCallerEvidence(observed).some(error => error.includes('checkpoint'))).toBe(true);
  });

  test('a defect replay note must copy the immediately prior result, not the older failing receipt', () => {
    const observed = evidence();
    observed.probes[0].status = 'fail';
    observed.probes.push({ ...observed.probes[0], id: 'defect-replay' });
    observed.receipt.status = 'fail';
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    const file = path.join(observed.reportRoot, 'exploration-002.json');
    const note = JSON.parse(observed.checkpointFiles['exploration-002.json']);
    note.observationCommand = 'bun scripts/probe.ts 3';
    note.observed = observed.probes[0];
    const content = JSON.stringify(note);
    fs.writeFileSync(file, content, { mode: 0o600 });
    observed.checkpointFiles['exploration-002.json'] = content;
    for (const event of observed.result.transcript as any[]) for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name === 'Write' && block.input.file_path === file) block.input.content = content;
    }
    expect(validateCallerEvidence(observed)).toContain('QA checkpoint: Missing unique completed checkpoint before probe: bun scripts/probe.ts 3');
  });
  test('caller acceptance requires causal persisted checkpoints for every subsequent probe', () => {
    const observed = evidence();
    expect(validateCallerEvidence(observed)).toEqual([]);
    const original = observed.result.transcript.slice();
    observed.result.transcript.splice(8, 2);
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
    observed.result.transcript = original;
    const result = observed.result.transcript[9] as any;
    result.message.content[0].is_error = true;
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
    result.message.content[0].is_error = false;
    observed.reportMarkdown = 'No links';
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
  });

  test('changed-input rechecks need a fresh checkpoint and wrong fixture UUID stays forbidden', () => {
    const observed = evidence();
    const fresh = { ...happy, id: 'fresh-probe', snapshot: 'changed-input' };
    observed.probes.push(fresh);
    observed.result.transcript.push(...nativeCall(fresh.id, 'Bash', { command: 'bun scripts/probe.ts 3' }, JSON.stringify(fresh)));
    expect(validateCallerEvidence(observed).some(error => /checkpoint/i.test(error))).toBe(true);
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    const attempted = path.join(observed.reportRoot + '-mistyped-uuid', 'exploration-003.json');
    observed.result.transcript.push(...nativeCall('wrong-path', 'Write', { file_path: attempted, content: '{}' }, 'not authorized', null, true));
    expect(validateCallerEvidence({ ...observed, fixtureRoot: observed.reportRoot }).some(error => /write outside/.test(error))).toBe(true);
  });
  test('literal directory operands and installed bookkeeping substitutions are closed classes', () => {
    for (const command of ['ls reports', 'ls -la -- "reports"', "ls -- 'space name' reports", "ls -- 'git push; $(touch forged)'", generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token')]) {
      expect(qaCallerCommandAllowed(command), command).toBe(true);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('inventory', 'Bash', { command }, 'native output'));
      expect(validateCallerEvidence(observed)).toEqual([]);
    }
    for (const command of ['ls $HOME', 'ls *', 'ls "$(touch forged)"', 'ls reports > forged', 'ls reports; touch forged', 'ls --format=long reports',
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token').replace('date -u +%Y-%m-%dT%H:%M:%SZ', 'date -u +%Y; touch forged'),
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token').replace('"timestamp":', '"other":'),
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token').replace('git rev-parse --short HEAD', 'git -c core.hooksPath=forged rev-parse --short HEAD'),
      generatedReviewRecord('/runtime/bin/gstack-review-log', 'native-token') + '; touch forged']) {
      expect(qaCallerCommandAllowed(command), command).toBe(false);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('rejected', 'Bash', { command }, 'not authorized', null, true));
      expect(validateCallerEvidence(observed)).toContain('command outside declared caller observation interface');
    }
  });
  test('credits paired commands and real rejection-as-designed, not final prose', () => {
    const observed = evidence();
    observed.result.transcript.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Nothing was run. Everything is green.' }] } });
    expect(validateCallerEvidence(observed)).toEqual([]);
  });

  test('unexecuted promises, echoed receipt ids and empty captures earn no credit', () => {
    const absent = evidence();
    absent.result.transcript = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Read exploratory.md and tested happy plus invalid paths. All pass.' }] } }];
    expect(validateCallerEvidence(absent).length).toBeGreaterThan(0);
    const echo = evidence();
    echo.result.transcript = echo.result.transcript.slice(0, 6).concat(nativeCall('echo', 'Bash', { command: "echo 'bun scripts/probe.ts 3; probe-happy probe-invalid'" }, JSON.stringify(happy) + '\n' + JSON.stringify(adverse)));
    expect(validateCallerEvidence(echo).filter(error => error.includes('missing native command'))).toHaveLength(2);
  });

  test('missing, orphaned and duplicated native events fail closed', () => {
    expect(() => callerTools(nativeCall('one', 'Read', {}, 'text').slice(0, 1))).toThrow();
    expect(() => callerTools(nativeCall('one', 'Read', {}, 'text').slice(1))).toThrow();
    const event = nativeCall('one', 'Read', {}, 'text')[0];
    expect(() => callerTools([event, event])).toThrow();
    expect(() => callerTools([...nativeCall('one', 'Read', {}, 'text'), ...nativeCall('one', 'Read', {}, 'text')])).toThrow();
    const incomplete = evidence();
    incomplete.observerComplete = false;
    expect(validateCallerEvidence(incomplete)).toContain('observer incomplete');
  });

  test('parent-scoped reused native tool ids retain distinct child attribution', () => {
    const tools = callerTools([
      ...nativeCall('same', 'Read', { file_path: 'parent' }, 'parent-output'),
      ...nativeCall('same', 'Read', { file_path: 'child' }, 'child-output', 'agent-id'),
    ]);
    expect(tools.map(tool => [tool.parent, tool.output])).toEqual([[null, 'parent-output'], ['agent-id', 'child-output']]);
  });

  test.each([{}, 42, true, [null], ['not a native block']].map(content => ({ content })))('malformed native content fails closed (%j)', ({ content }) => {
    const malformed = { type: 'assistant', message: { content } };
    expect(() => callerTools([...nativeCall('one', 'Read', {}, 'text'), malformed])).toThrow();
  });

  test('plain-text user messages do not invent native tool evidence', () => {
    expect(callerTools([{ type: 'user', message: { content: 'A plain-text prompt' } }])).toEqual([]);
  });

  test('the bounded caller command interface rejects custom interpreters and composed probe scripts', () => {
    for (const command of ['python3 -c "import mmap"', 'bun -e "1"', 'node writer.js', 'bun scripts/probe.ts 3; echo forged', 'git diff && python3 exploit.py']) {
      expect(qaCallerCommandAllowed(command)).toBe(false);
    }
    for (const command of ['bun scripts/probe.ts 3', "bun scripts/probe.ts '3oops'", 'git diff origin/main', 'git ls-files --others --exclude-standard']) {
      expect(qaCallerCommandAllowed(command)).toBe(true);
    }
    const generated = 'DIFF_BASE=$(git merge-base origin/main HEAD)\ngit diff "$DIFF_BASE"';
    expect(qaCallerCommandAllowed(generated, [generated])).toBe(true);
    expect(qaCallerCommandAllowed(generated + '\nnode hidden.js', [generated])).toBe(false);
  });

  test('the relocated native reviewer can record its own attempt without gaining shell authority', () => {
    const bin = '/fixture/runtime/bin/gstack-review-log';
    expect(qaCallerCommandAllowed(`${bin} --start adversarial-review`)).toBe(true);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"adversarial-review","completed":true}' --finish native-token`)).toBe(true);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"adversarial-review","completed":false,"converged":false}'`)).toBe(true);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"adversarial-review","completed":true}'`)).toBe(false);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"review","completed":true}'`)).toBe(false);
    expect(qaCallerCommandAllowed(`${bin} '{"skill":"ship"}' --finish native-token`)).toBe(false);
    expect(qaCallerCommandAllowed(`${bin} --start adversarial-review; node hidden.js`)).toBe(false);
  });

  test('captured native diffs belong to a literal read-only class, not a spelling allowlist', () => {
    for (const command of [...capturedNativeDiffs, 'git merge-base origin/main HEAD', "git diff origin/main -- 'git push; $(touch forged)'"]) {
      expect(qaCallerCommandAllowed(command), command).toBe(true);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('diff', 'Bash', { command }, 'native diff output', 'native-reviewer'));
      expect(validateCallerEvidence(observed)).toEqual([]);
    }
    for (const mode of ['', ' --stat', ' --numstat', ' --name-only', ' --name-status']) {
      for (const [prefix, base] of [['', ''], ['', ' origin/main'], [diffPreface, ' "$DIFF_BASE"']]) {
        for (const selection of ['', ' -- scale.ts', " -- '*.ts' ':(exclude)*test*'", ' -- "space name.ts"']) {
          for (const arguments_ of [mode + base, base + mode]) {
            const command = `${prefix}git diff${arguments_}${selection}`;
            expect(qaCallerCommandAllowed(command), command).toBe(true);
          }
        }
      }
    }
  });

  test('diff grammar rejects write options, hidden evaluation, arbitrary bases and composition', () => {
    for (const command of [
      'git diff --output=forged origin/main', 'git diff origin/main --output forged',
      'git diff --no-index scale.ts forged', 'git diff --ext-diff origin/main',
      'git diff --textconv origin/main', 'git -c diff.external=writer diff origin/main',
      'GIT_EXTERNAL_DIFF=writer git diff origin/main', 'git --no-pager diff origin/main',
      'git diff HEAD', 'git diff origin/other', 'git diff "$DIFF_BASE"',
      'git diff --stat --numstat origin/main', 'git diff origin/main --stat --name-only',
      'git diff origin/main -- *.ts', 'git diff origin/main -- $HOME',
      'git diff origin/main -- "$(touch forged)"', 'git diff origin/main -- `touch forged`',
      'git diff origin/main -- <(touch forged)', 'git diff origin/main -- scale.ts > forged',
      'git diff origin/main -- scale.ts; touch forged', 'git diff origin/main && git add .',
      'git diff origin/main\nnode hidden.js', 'git diff origin/main -- "a\\$(touch forged)"',
      'git diff origin/main -- "unterminated', "git diff origin/main -- 'line\nbreak'",
      `${diffPreface}git diff "$DIFF_BASE"; git reset --hard`,
      `${diffPreface}git diff "$DIFF_BASE" && touch forged`,
      `${diffPreface}git diff "$DIFF_BASE" --output=forged`,
      `${diffPreface}git diff "$DIFF_BASE" -- "$(touch forged)"`,
      `${diffPreface}git diff $DIFF_BASE`, `${diffPreface}git diff origin/main`,
      'DIFF_BASE=$(git merge-base origin/main HEAD; touch forged) && git diff "$DIFF_BASE"',
      'DIFF_BASE=$(git merge-base origin/main HEAD) ; git diff "$DIFF_BASE"',
      'DIFF_BASE=$(git -c alias.merge-base=writer merge-base origin/main HEAD) && git diff "$DIFF_BASE"',
      'DIFF_BASE=$(git merge-base origin/other HEAD) && git diff "$DIFF_BASE"',
    ]) {
      expect(qaCallerCommandAllowed(command), command).toBe(false);
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('diff', 'Bash', { command }, 'rejected', 'native-reviewer', true));
      expect(validateCallerEvidence(observed)).toContain('command outside declared caller observation interface');
    }
    for (const command of ['git merge main', 'git push; touch forged', 'git -c core.hooksPath=hooks commit', `${diffPreface}git diff "$DIFF_BASE"; git reset --hard`]) {
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('mutation', 'Bash', { command }, 'denied', 'native-reviewer', true));
      expect(validateCallerEvidence(observed)).toContain('unauthorized git/publication action');
    }
  });

  test('native CLI arguments include absence and literal text without granting shell evaluation', () => {
    for (const executable of ['scripts/probe.ts', 'cli.ts']) {
      for (const argument of ['', ' 0', ' λ', " ''", " 'bad input; $(touch forged)'", ' "bad input; invalid"']) {
        expect(qaCallerCommandAllowed(`bun ${executable}${argument}`), argument).toBe(true);
      }
      for (const argument of [' *', ' $HOME', ' $(touch forged)', ' `touch forged`', ' "$(touch forged)"', ' 3 > forged', ' 3\nnode hidden.js', " 'one' 'two'", " 'unterminated", ' a\\ b']) {
        expect(qaCallerCommandAllowed(`bun ${executable}${argument}`), argument).toBe(false);
      }
    }
    const observed = evidence();
    observed.result.transcript.push(...nativeCall('literal', 'Bash', { command: "bun scripts/probe.ts 'git push; $(touch forged)'" }, 'literal input rejected'));
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.result.transcript.push(...nativeCall('composed', 'Bash', { command: 'bun scripts/probe.ts 3; git push' }, 'not authorized'));
    expect(validateCallerEvidence(observed)).toContain('unauthorized git/publication action');
  });

  test('failed or out-of-order resource reads do not satisfy automatic invocation', () => {
    const failed = evidence();
    failed.result.transcript.splice(2, 2, ...nativeCall('shared', 'Read', { file_path: '/runtime/qa/sections/exploratory.md' }, 'missing file', null, true));
    expect(validateCallerEvidence(failed).some(error => error.includes('missing executed resource'))).toBe(true);
    const late = evidence();
    late.result.transcript = late.result.transcript.slice(6).concat(late.result.transcript.slice(0, 6));
    expect(validateCallerEvidence(late).some(error => error.includes('preceded'))).toBe(true);
  });

  test('browser setup, full-skill recursion and child mutation attempts are rejected', () => {
    for (const [name, input, parent] of [
      ['Read', { file_path: '/runtime/qa/sections/browser-setup.md' }, null],
      ['Read', { file_path: '/runtime/devex-review/SKILL.md' }, null],
      ['Read', { file_path: '/runtime/qa/SKILL.md' }, 'agent'],
      ['Skill', { skill: 'review' }, 'agent'],
      ['Skill', { skill: 'gstack-ship' }, 'agent'],
      ['Edit', { file_path: '/fixture/cli.test.ts', old_string: 'old', new_string: 'new' }, 'agent'],
      ['Bash', { command: 'git commit -am "unauthorized"' }, 'agent'],
      ['Bash', { command: 'git push origin feature' }, null],
    ] as const) {
      const observed = evidence();
      observed.result.transcript.push(...nativeCall('forbidden', name, input, 'denied', parent, true));
      expect(validateCallerEvidence(observed).length, JSON.stringify(input)).toBeGreaterThan(0);
    }
  });

  test('shell write-and-restore, rename, deletion and commit observations are violations even with a clean final tree', () => {
    for (const file of ['scale.ts', 'cli.test.ts', 'renamed.ts', '.git/refs/heads/caller-change']) {
      const observed = evidence();
      observed.mutations.push(file);
      expect(validateCallerEvidence(observed)).toContain(`unauthorized mutation: ${file}`);
    }
  });

  test('same-input passing reruns are detected while reproducing a failure is allowed', () => {
    const observed = evidence();
    const repeated = { ...happy, id: 'probe-duplicate' };
    observed.probes.push(repeated);
    observed.result.transcript.push(...nativeCall('duplicate', 'Bash', { command: 'bun scripts/probe.ts 3' }, JSON.stringify(repeated)));
    expect(validateCallerEvidence(observed)).toContain('duplicate unchanged passing probe: probe-duplicate');
    observed.probes[0].status = 'fail';
    repeated.status = 'fail';
    observed.receipt.status = 'fail';
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
  });

  test('late source, test, contract or fixture inputs cannot reuse stale passing proof', () => {
    for (const file of ['scale.ts', 'cli.test.ts', 'README.md', 'fixture.json']) {
      const observed = evidence();
      observed.currentSnapshot = callerSnapshot({ [file]: 'changed' });
      expect(validateCallerEvidence(observed).filter(error => error.includes('false green'))).toHaveLength(2);
      const fresh = observed.probes.map(probe => ({ ...probe, id: `${probe.id}-fresh`, snapshot: observed.currentSnapshot }));
      observed.probes.push(...fresh);
      observed.result.transcript.push(...fresh.flatMap(probe => nativeCall(probe.id, 'Bash', { command: `bun scripts/probe.ts ${probe.input}` }, JSON.stringify(probe))));
      observed.receipt.probes = fresh.map(probe => probe.id);
      rebuildCheckpoints(observed);
      expect(validateCallerEvidence(observed)).toEqual([]);
    }
  });

  test('unavailable, incomplete, timed-out and unobserved probes never become green', () => {
    for (const status of ['blocked', 'inconclusive', 'fail'] as const) {
      const observed = evidence();
      observed.probes[1].status = status;
      expect(validateCallerEvidence(observed).some(error => error.includes('reported green'))).toBe(true);
    }
    const timeout = evidence();
    timeout.result.exitReason = 'timeout';
    expect(validateCallerEvidence(timeout)).toContain('session did not complete: timeout');
    const unseen = evidence();
    unseen.receipt.probes.push('fictional');
    expect(validateCallerEvidence(unseen)).toContain('receipt references an unobserved probe');
  });

  test('additional required plan contracts cannot disappear behind an ordinary smoke pass', () => {
    const observed = evidence();
    observed.requiredCharters.push('plan:nine');
    expect(validateCallerEvidence(observed)).toContain('false green for charter: plan:nine');
  });

  test('one successful adverse zero cannot replace both distinct smoke scenarios', () => {
    const observed = evidence();
    const zero = { ...adverse, id: 'probe-zero', input: '0', exit: 0, stdout: '0\n', stderr: '' };
    observed.probes = [zero];
    observed.receipt.probes = [zero.id];
    fs.rmSync(path.join(observed.reportRoot, 'exploration-001.json'));
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual(['missing current charter: happy', 'false green for charter: happy']);
  });

  test('successful plan nine covers happy and plan while preserving a distinct adverse check', () => {
    const observed = evidence();
    const boundary = { ...happy, id: 'probe-nine', input: '9', charter: 'plan:nine', stdout: '18\n' };
    observed.probes[0] = boundary;
    observed.receipt.probes[0] = boundary.id;
    observed.requiredCharters.push('plan:nine');
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.receipt.probes = [boundary.id];
    expect(validateCallerEvidence(observed)).toContain('false green for charter: adverse');
    observed.receipt.probes = [adverse.id];
    expect(validateCallerEvidence(observed)).toContain('false green for charter: happy');
    expect(validateCallerEvidence(observed)).toContain('false green for charter: plan:nine');
  });

  test('a distinct successful upper boundary supplies the authored edge and overlapping plan coverage', () => {
    const observed = evidence();
    const boundary = { ...happy, id: 'probe-nine', input: '9', charter: 'plan:nine', stdout: '18\n' };
    observed.probes[1] = boundary;
    observed.receipt.probes[1] = boundary.id;
    observed.requiredCharters.push('plan:nine');
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.receipt.probes.reverse();
    expect(validateCallerEvidence(observed)).toEqual([]);
    boundary.snapshot = 'superseded';
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toContain('false green for charter: adverse');
    expect(validateCallerEvidence(observed)).toContain('false green for charter: plan:nine');
  });

  test('R88 captured plan receipt bytes satisfy the smoke contract under synthetic event transport', () => {
    const observed = evidence();
    observed.probes = [
      { id: 'probe-d490188d-898b-405e-bfac-b4d8e0c54025', charter: 'happy', input: '4', snapshot: '936ff5b3b13172fb2357a120804c1cf5cac68d911c82cae5bce630f04dd62b57', status: 'pass', stdout: '8\n', stderr: '', exit: 0 },
      { id: 'probe-9e1bb5f2-0ad1-4975-9232-1354f4d42df3', charter: 'plan:nine', input: '9', snapshot: '936ff5b3b13172fb2357a120804c1cf5cac68d911c82cae5bce630f04dd62b57', status: 'pass', stdout: '18\n', stderr: '', exit: 0 },
    ];
    observed.currentSnapshot = observed.probes[0].snapshot;
    observed.receipt = { status: 'pass', probes: ['probe-d490188d-898b-405e-bfac-b4d8e0c54025', 'probe-9e1bb5f2-0ad1-4975-9232-1354f4d42df3'], remaining: [] };
    observed.requiredCharters.push('plan:nine');
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toEqual([]);
    observed.receipt.probes.shift();
    expect(validateCallerEvidence(observed)).toContain('false green for charter: adverse');
    observed.receipt.probes = [observed.probes[0].id];
    expect(validateCallerEvidence(observed)).toContain('false green for charter: plan:nine');
  });

  test.each(['input', 'stdout', 'stderr', 'exit', 'status'])('upper-boundary %s must prove the declared edge rather than just its charter label', field => {
    const observed = evidence();
    const boundary = { ...happy, id: 'probe-nine', input: '9', charter: 'plan:nine', stdout: '18\n' };
    Object.assign(boundary, { [field]: { input: '4', stdout: '8\n', stderr: 'unexpected', exit: 2, status: 'fail' }[field] });
    observed.probes[1] = boundary;
    observed.receipt.probes[1] = boundary.id;
    rebuildCheckpoints(observed);
    expect(validateCallerEvidence(observed)).toContain('false green for charter: adverse');
  });
});

describe('generated actual parent paths', () => {
  test('authored parent QA owns ordered loading, execution and current-input finalization', () => {
    for (const skillName of ['review', 'ship']) {
      const ctx = { skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host: 'claude' as const, paths: HOST_PATHS.claude };
      const parent = generateQAReview(ctx);
      const phases = [
        skillName === 'review' ? '1. Set the charter and isolation' : '1. Load methods before any QA or explicit-verification probe',
        skillName === 'review' ? '2. Check readiness and list required checks' : '2. List required checks',
        '3. Run smoke and plan checks', '4. Check freshness before reporting',
      ];
      const positions = phases.map(phase => parent.indexOf(phase));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      const load = skillName === 'review' ? generateQAReviewPreflight(ctx) : parent.slice(positions[0], positions[1]);
      if (skillName === 'review') {
        const readiness = parent.slice(positions[1], positions[2]).replace(/\s+/g, ' ');
        expect(readiness).toMatch(/Read QA's `sections\/browser-setup\.md` and follow its report-only rules/i);
        expect(readiness).toMatch(/never install, import cookies or bootstrap tests/i);
        expect(load).not.toContain('sections/browser-setup.md');
      }
      expect(load).toContain('{{QA_RESOURCE:exploratory}}');
      expect(load).not.toContain('{{QA_RESOURCE:scope}}');
      expect(load).not.toContain('sections/system-functional.md');
      const resource = generateQAResource(ctx, ['exploratory']);
      expect(resource).toContain(`installed /${skillName} SKILL.md's directory`);
      expect(resource).toContain('`../qa/sections/exploratory.md`');
      const flat = parent.replace(/\s+/g, ' ');
      expect(flat).toMatch(/repeat step 3 for affected checks/i);
    }
  });

  test('authored shared loop preserves complete safe observations and re-enters checkpoints after input changes', () => {
    const text = generateQAExploratory({ skillName: 'qa', tmplPath: 'qa/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude }).replace(/\s+/g, ' ');
    expect(text).toMatch(/observationCommand: last completed probe's full outer command/i);
    expect(text).toMatch(/observed: its exact decoded child JSON/i);
    expect(text).toMatch(/identity hash unchanged/i);
    expect(text).not.toContain('nest unchanged child JSON');
  });
  test('the shared smoke has explicit limits without waiving required plan checks', () => {
    const raw = fs.readFileSync(path.join(import.meta.dir, '../qa/sections/exploratory.md'), 'utf8');
    const body = raw.replace(/\s+/g, ' ');
    expect(body).toMatch(/stop after 5 minutes or 12 probes/i);
    const n = qaProbeNames(raw);
    expect(body).toContain(`${n.guard} enforces the deadline`);
    expect(body).toMatch(new RegExp(`never reset ${n.deadline}\\W+bypass ${n.guard}`, 'i'));
    expect(body).toMatch(/plan checks and revalidation remain required beyond this smoke budget/i);
    expect(body).toContain('leaves /review incomplete');
    expect(body).toMatch(/\/ship blocked unless the user explicitly accepts that named risk/i);
  });

  test('excerpt extraction fails loudly instead of producing an empty passing fixture', () => {
    expect(callerExcerpt('before\nSTART\nbody\nEND\nafter', 'START', 'END')).toBe('START\nbody\n');
    expect(() => callerExcerpt('START without end', 'START', 'END')).toThrow('boundary');
    expect(() => callerExcerpt('START START END', 'START', 'END')).toThrow('boundary');
  });

  test('the review fixture admits only the actual native read-only diff fragments', () => {
    const fixture = createQaCallerFixture('review-exploratory-small-cli', { installRuntime: false });
    try {
      const command = 'DIFF_BASE=$(git merge-base origin/main HEAD) && git diff --name-status "$DIFF_BASE"';
      expect(fixture.workflowCommands).toContain(command);
      expect(qaCallerCommandAllowed(command, fixture.workflowCommands)).toBe(true);
      expect(qaCallerCommandAllowed(command + '; node hidden.js', fixture.workflowCommands)).toBe(false);
      expect(qaCallerCommandAllowed(command.replace('git diff', 'git reset'), fixture.workflowCommands)).toBe(false);
      expect(qaCallerSessionOptions(fixture, 'free-control').prompt).toContain('the native reviewer is still required');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const caller of ['review', 'ship'] as const) {
    test(`${caller} uses its generated parent entrypoint, not an isolated explorer prompt`, () => {
      const excerpt = qaCallerInstructions(caller);
      if (caller === 'review') {
        expect(excerpt).toContain('### Step 4.7: Exploratory QA (before Fix-First)');
        expect(excerpt).toContain('**Test stub override:**');
        expect(excerpt.indexOf('### Step 4.7: Exploratory QA')).toBeLessThan(excerpt.indexOf('## Step 5: Fix-First Review'));
        expect(excerpt.indexOf('/review/sections/adversarial.md')).toBeGreaterThan(excerpt.indexOf('### Step 4.7: Exploratory QA'));
        expect(excerpt.indexOf('/review/sections/adversarial.md')).toBeLessThan(excerpt.indexOf('## Step 5: Fix-First Review'));
      } else {
        expect(excerpt).toContain('/ship/sections/plan-completion.md');
        expect(excerpt).toContain('/ship/sections/review-army.md');
        expect(excerpt).not.toContain('/ship/sections/greptile.md');
      }
    });
  }
});

describe('real caller-specific native fixture and capture boundary', () => {
  const fixtureFor = async (id: Parameters<typeof createQaCallerFixture>[0], installRuntime = false) => {
    const fixture = createQaCallerFixture(id, { instructions: 'Free fixture control: no agent instructions or workflow credit.', installRuntime });
    await fixture.observe();
    return fixture;
  };
  const probe = (fixture: QaCallerFixture, value: string) => spawnSync(process.execPath, ['scripts/probe.ts', value], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
  const dispose = async (fixture: QaCallerFixture) => { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); };

  test('deadline authority is closed over the installed helper, owned state and literal probe child', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli', true);
    try {
      const context = { runtime: fixture.runtime, fixtureRoot: fixture.cwd };
      const helper = path.join(fixture.runtime, 'bin/gstack-qa-deadline');
      const state = path.join(fixture.cwd, 'reports/deadline.json');
      const run = `bun ${helper} run ${state} -- `;
      for (const command of [
        `bun ${helper} start ${state} 300`, `bun ${helper} start ${state} 0.001`,
        `bun '${helper}' start '${state}' 1.001 '2026-09-27T00:00:00Z'`,
        `bun ${helper} status ${state}`, `${run}bun scripts/probe.ts`, `${run}bun scripts/probe.ts 3`,
        `${run}bun scripts/probe.ts 'git push; $(touch forged)'`, `${run}bun scripts/probe.ts "invalid; text"`,
      ]) expect(qaCallerCommandAllowed(command, [], context), command).toBe(true);
      const forbidden = [
        `${run}bun cli.ts 3`, `${run}bun run test`, `${run}bun scripts/probe.ts 3 no`,
        `${run}bun /tmp/probe.ts 3`, `${run}bun -e 'console.log(1)'`, `${run}bash -c 'bun scripts/probe.ts 3'`,
        `${run}git push`, `${run}gh pr create`, `${run}bun ${helper} run ${state} -- bun scripts/probe.ts 3`,
        `${run}env bun scripts/probe.ts 3`, `${run}timeout 1 bun scripts/probe.ts 3`,
        `${run}bun scripts/probe.ts $(date)`, `${run}bun scripts/probe.ts "$VALUE"`, `${run}bun scripts/probe.ts 3 > reports/out`,
        `${run}bun scripts/probe.ts 3 && git push`, `${run}bun scripts/probe.ts 3; git push`, `${run}bun scripts/probe.ts 3 | cat`,
        `bun ${helper} status ${state} extra`, `bun ${helper} start ${state} 0`, `bun ${helper} start ${state} 300.001`,
        `bun ${helper} start ${state} -1`, `bun ${helper} start ${state} 1e2`, `bun ${helper} start ${state} 1.0001`,
        `bun ${helper} start ${state} 1 not-a-time`, `bun ${helper} start ${state} 1 2026-02-30T00:00:00Z`,
        `bun ${helper} start ${state} 1 2026-09-27T00:00:00+00:00`, `bun ${helper} start ${state} 1 2026-09-27T00:00:00Z extra`,
        `bun ${helper} start ${state} 1 $(date -u +%Y-%m-%dT%H:%M:%SZ)`,
        `bun ${helper} run reports/deadline.json -- bun scripts/probe.ts 3`,
        `bun ${helper} run ${fixture.cwd}/reports/other.json -- bun scripts/probe.ts 3`,
        `bun ${helper} run ${fixture.cwd}/reports/../reports/deadline.json -- bun scripts/probe.ts 3`,
        `bun ${helper} run ${fixture.root}/outside.json -- bun scripts/probe.ts 3`,
        `bun ${helper}-lookalike run ${state} -- bun scripts/probe.ts 3`,
        `${run}bun scripts/probe.ts 'line\nbreak'`, `${run}bun scripts/probe.ts 3\nbun scripts/probe.ts no`,
      ];
      for (const command of forbidden) {
        expect(qaCallerCommandAllowed(command, [], context), command).toBe(false);
        expect(qaCallerCommandAllowed(command, [command], context), command).toBe(false);
      }
      expect(qaCallerCommandAllowed(`${run}bun scripts/probe.ts 3`)).toBe(false);
      expect(qaCallerCommandAllowed(`${run}bun scripts/probe.ts 3`, [], { ...context, fixtureRoot: fixture.root })).toBe(false);
      const fakeRuntime = path.join(fixture.root, 'forged-runtime');
      fs.mkdirSync(path.join(fakeRuntime, 'bin'), { recursive: true });
      fs.copyFileSync(helper, path.join(fakeRuntime, 'bin/gstack-qa-deadline'));
      const forged = `bun ${fakeRuntime}/bin/gstack-qa-deadline run ${state} -- bun scripts/probe.ts 3`;
      expect(qaCallerCommandAllowed(forged, [forged], { ...context, runtime: fakeRuntime })).toBe(false);
      fs.symlinkSync(path.join(fixture.root, 'outside.json'), state);
      expect(qaCallerCommandAllowed(`${run}bun scripts/probe.ts 3`, [], context)).toBe(false);
      fs.unlinkSync(state);
      fs.renameSync(path.dirname(state), path.join(fixture.cwd, 'original-reports'));
      fs.symlinkSync(path.join(fixture.cwd, 'original-reports'), path.dirname(state), 'dir');
      expect(qaCallerCommandAllowed(`${run}bun scripts/probe.ts 3`, [], context)).toBe(false);
    } finally { await dispose(fixture); }
  });

  test('actual runner binds guarded child JSON and journal to full outer checkpoint commands', async () => {
    const fixture = await fixtureFor('ship-exploratory-plan-checks', true);
    try {
      const reportRoot = path.join(fixture.cwd, 'reports');
      const helper = path.join(fixture.runtime, 'bin/gstack-qa-deadline');
      const state = path.join(reportRoot, 'deadline.json');
      const command = (value: string) => `bun ${helper} run ${state} -- bun scripts/probe.ts ${value}`;
      const result = await runQaCaller(fixture, 'free-guarded-callback', async options => {
        const transcript: unknown[] = [
          ...nativeCall('parent', 'Read', { file_path: `${fixture.cwd}/caller-ship.md` }, 'parent workflow'),
          ...nativeCall('shared', 'Read', { file_path: `${fixture.runtime}/qa/sections/exploratory.md` }, 'shared method'),
          ...nativeCall('functional', 'Read', { file_path: `${fixture.runtime}/qa/sections/system-functional.md` }, 'functional method'),
        ];
        transcript.push(...nativeCall('ship-army', 'Read', { file_path: `${fixture.runtime}/ship/sections/review-army.md` }, 'ship Step 9'));
        const execute = (id: string, cmd: string, exit: number) => {
          expect(qaCallerCommandAllowed(cmd, fixture.workflowCommands, { runtime: fixture.runtime, fixtureRoot: fixture.cwd })).toBe(true);
          const actual = spawnSync('bash', ['-c', cmd], { cwd: options.workingDirectory, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 5000 });
          expect(actual.error).toBeUndefined();
          expect(actual.status, actual.stderr).toBe(exit);
          transcript.push(...nativeCall(id, 'Bash', { command: cmd }, actual.stdout + actual.stderr, null, actual.status !== 0));
          return actual;
        };
        execute('start', `bun ${helper} start ${state} 300`, 0);
        const prior = JSON.parse(execute('happy', command('3'), 0).stdout);
        const content = JSON.stringify({ observationCommand: command('3'), observed: prior, hypothesis: 'The invalid input should reject with the documented exit and stderr.', nextCommand: command("'git push; $(touch forged)'") });
        const file = path.join(reportRoot, 'exploration-001.json');
        fs.writeFileSync(file, content, { mode: 0o600 });
        transcript.push(...nativeCall('checkpoint', 'Write', { file_path: file, content }, 'File created successfully'));
        const adverse = execute('adverse', command("'git push; $(touch forged)'"), 2);
        expect(adverse.stderr).toContain('QA_DEADLINE ');
        const planContent = JSON.stringify({ observationCommand: command("'git push; $(touch forged)'"), observed: JSON.parse(adverse.stdout), hypothesis: 'The separate required plan check must also double its boundary input correctly.', nextCommand: 'bun scripts/probe.ts 9' });
        const planFile = path.join(reportRoot, 'exploration-002.json');
        fs.writeFileSync(planFile, planContent, { mode: 0o600 });
        transcript.push(...nativeCall('plan-checkpoint', 'Write', { file_path: planFile, content: planContent }, 'File created successfully'));
        execute('required-plan', 'bun scripts/probe.ts 9', 0);
        return { exitReason: 'success', transcript } as SkillTestResult;
      });
      await fixture.close();
      const input = {
        caller: fixture.caller, result, probes: fixture.probes(),
        receipt: { status: 'pass' as const, probes: fixture.probes().map(probe => probe.id), remaining: [] },
        currentSnapshot: fixture.snapshot(), requiredCharters: ['happy', 'adverse', 'plan:nine'], mutations: fixture.mutationEvents,
        observerComplete: fixture.observation?.complete === true && !fixture.observerErrors.length,
        fixtureRoot: fixture.cwd, runtime: fixture.runtime, reportRoot, requireGuardedSmoke: true,
        checkpointFiles: readQACheckpointFiles(reportRoot), reportMarkdown: '[Reasoning](exploration-001.json)\n[Required plan](exploration-002.json)',
      };
      expect(input.probes).toHaveLength(3);
      expect(validateCallerEvidence(input)).toEqual([]);
      expect(validateCallerEvidence({ ...input, requireGuardedSmoke: false })).toEqual([]);
      expect(validateCallerEvidence({ ...input, requiredCharters: ['happy', 'adverse'] })).toContain(`smoke probe missing trusted deadline run: ${input.probes[2].id}`);
      for (const [name, writeId, probeId] of [
        ['exploration-001.json', 'checkpoint', 'happy'],
        ['exploration-002.json', 'plan-checkpoint', 'adverse'],
      ]) {
        const original = input.checkpointFiles[name];
        const completion = (result.transcript as any[]).find(event => event.message.content[0].tool_use_id === probeId).message.content[0];
        const receipts = completion.content.split('\n').filter((line: string) => line.startsWith('QA_DEADLINE '))
          .map((line: string) => JSON.parse(line.slice('QA_DEADLINE '.length)));
        for (const shape of ['child', 'guard-envelope', 'interpretation']) {
          const note = JSON.parse(original);
          if (shape === 'child') note.observed = { child: note.observed };
          if (shape === 'guard-envelope') note.observed = { guardStarted: receipts[0], child: note.observed, guardFinished: receipts[1], outerExit: receipts[1].exitCode };
          if (shape === 'interpretation') note.observed = { ...note.observed, classification: 'expected rejection' };
          const content = JSON.stringify(note);
          fs.writeFileSync(path.join(reportRoot, name), content);
          const transcript = structuredClone(result.transcript) as any[];
          transcript.find(event => event.message.content[0].id === writeId).message.content[0].input.content = content;
          const errors = validateCallerEvidence({ ...input, checkpointFiles: { ...input.checkpointFiles, [name]: content }, result: { ...result, transcript } });
          expect(errors, `${name}: ${shape}`).toContain(`QA checkpoint: Missing unique completed checkpoint before probe: ${note.nextCommand}`);
          expect(errors, `${name}: ${shape}`).toContain(`QA checkpoint: Unrelated, reused or retrospective checkpoint: ${name}`);
        }
        fs.writeFileSync(path.join(reportRoot, name), original);
      }
      expect(validateCallerEvidence(input)).toEqual([]);
      for (const change of ['missing-start', 'missing-finish', 'missing-both', 'extra-receipt', 'reversed', 'malformed', 'forged-guard', 'wrong-state', 'wrong-budget', 'wrong-deadline', 'stale-start', 'late-start', 'wrong-remaining', 'finish-before-start', 'late-finish', 'timeout', 'child-124', 'wrong-exit', 'wrong-failed-status', 'extra-field']) {
        const transcript = structuredClone(result.transcript) as any[];
        const completion = transcript.find(event => event.message.content[0].tool_use_id === 'adverse').message.content[0];
        const lines = completion.content.split('\n') as string[];
        const receipts = lines.filter(line => line.startsWith('QA_DEADLINE ')).map(line => JSON.parse(line.slice('QA_DEADLINE '.length)));
        const [started, finished] = receipts;
        if (change === 'missing-start') receipts.shift();
        if (change === 'missing-finish') receipts.pop();
        if (change === 'missing-both') receipts.length = 0;
        if (change === 'extra-receipt') receipts.push({ ...finished });
        if (change === 'reversed') receipts.reverse();
        if (change === 'forged-guard') started.guard = 'not-the-deadline-helper';
        if (change === 'wrong-state') started.startedAt = new Date(Date.parse(started.startedAt) - 1).toISOString();
        if (change === 'wrong-budget') started.budgetMs += 1;
        if (change === 'wrong-deadline') finished.deadlineAt = new Date(Date.parse(finished.deadlineAt) + 1).toISOString();
        if (change === 'stale-start' || change === 'late-start') {
          started.observedAt = change === 'stale-start' ? new Date(Date.parse(started.startedAt) - 1).toISOString() : started.deadlineAt;
          started.remainingMs = Date.parse(started.deadlineAt) - Date.parse(started.observedAt);
        }
        if (change === 'wrong-remaining') started.remainingMs += 1;
        if (change === 'finish-before-start') finished.observedAt = new Date(Date.parse(started.observedAt) - 1).toISOString();
        if (change === 'late-finish' || change === 'timeout') finished.observedAt = finished.deadlineAt;
        if (change === 'timeout') finished.timedOut = true;
        if (change === 'timeout' || change === 'child-124') finished.exitCode = 124;
        if (change === 'wrong-exit') finished.exitCode = 0;
        if (change === 'wrong-failed-status') completion.is_error = false;
        if (change === 'extra-field') started.untrusted = true;
        completion.content = [...lines.filter(line => !line.startsWith('QA_DEADLINE ')), ...receipts.map(receipt => `QA_DEADLINE ${JSON.stringify(receipt)}`)].join('\n');
        if (change === 'malformed') completion.content = completion.content.replace(/QA_DEADLINE [^\n]+/, 'QA_DEADLINE {');
        const altered = { ...input, result: { ...result, transcript } };
        expect(validateCallerEvidence({ ...altered, requireGuardedSmoke: false }), change).toEqual([]);
        expect(validateCallerEvidence(altered), change).toContain(`smoke probe missing consistent deadline receipts: ${input.probes[1].id}`);
      }
      const allBare = structuredClone(result.transcript) as any[];
      const bareFiles: Record<string, string> = {};
      const unwrap = (value: string) => value.replace(`bun ${helper} run ${state} -- `, '');
      for (const event of allBare) {
        const block = event.message.content[0];
        if (block.type === 'tool_use' && block.name === 'Bash') block.input.command = unwrap(block.input.command);
        if (block.type === 'tool_use' && block.name === 'Write') {
          const note = JSON.parse(block.input.content);
          note.observationCommand = unwrap(note.observationCommand);
          note.nextCommand = unwrap(note.nextCommand);
          block.input.content = JSON.stringify(note);
          bareFiles[path.basename(block.input.file_path)] = block.input.content;
          fs.writeFileSync(block.input.file_path, block.input.content);
        }
        if (['happy', 'adverse'].includes(block.tool_use_id)) block.content = block.content.split('\n').filter((line: string) => !line.startsWith('QA_DEADLINE ')).join('\n');
      }
      const bareInput = { ...input, checkpointFiles: bareFiles, result: { ...result, transcript: allBare } };
      expect(validateCallerEvidence({ ...bareInput, requireGuardedSmoke: false })).toEqual([]);
      expect(validateCallerEvidence(bareInput)).toContain('no authenticated guarded diagnostic executed');
      for (const probe of input.probes.slice(0, 2)) expect(validateCallerEvidence(bareInput)).toContain(`smoke probe missing trusted deadline run: ${probe.id}`);
      for (const [name, content] of Object.entries(input.checkpointFiles)) fs.writeFileSync(path.join(reportRoot, name), content);
      expect(fs.existsSync(path.join(fixture.cwd, 'forged'))).toBe(false);
      expect(validateCallerEvidence({ ...input, runtime: undefined })).toContain('command outside declared caller observation interface');
      for (const name of ['Write', 'Edit', 'MultiEdit']) {
        for (const file of [state, 'reports/deadline.json', 'reports/../reports/deadline.json', path.join(reportRoot, '.qa-deadline-forged')]) {
          const transcript = [...result.transcript, ...nativeCall(`reserved-${name}`, name, { file_path: file, content: '{}' }, 'done')];
          expect(validateCallerEvidence({ ...input, result: { ...result, transcript } })).toContain('actor attempted to replace reserved deadline state');
        }
      }
      const linked = path.join(reportRoot, 'clock-alias');
      fs.symlinkSync(state, linked);
      const aliasTranscript = [...result.transcript, ...nativeCall('alias', 'Write', { file_path: linked, content: '{}' }, 'done')];
      expect(validateCallerEvidence({ ...input, result: { ...result, transcript: aliasTranscript } })).toContain('write outside the declared report/fixture interface');
      fs.unlinkSync(linked);
      fs.linkSync(state, linked);
      expect(qaCallerCommandAllowed(command('3'), [], { runtime: fixture.runtime, fixtureRoot: fixture.cwd })).toBe(false);
      expect(validateCallerEvidence({ ...input, result: { ...result, transcript: aliasTranscript } })).toContain('write outside the declared report/fixture interface');
      fs.unlinkSync(linked);
      const original = input.checkpointFiles['exploration-001.json'];
      for (const field of ['observationCommand', 'nextCommand', 'observed']) {
        const changed = JSON.parse(original);
        if (field === 'observed') delete changed.observed.snapshot;
        else changed[field] = field === 'observationCommand' ? 'bun scripts/probe.ts 3' : "bun scripts/probe.ts 'git push; $(touch forged)'";
        const content = JSON.stringify(changed);
        fs.writeFileSync(path.join(reportRoot, 'exploration-001.json'), content);
        const transcript = structuredClone(result.transcript) as any[];
        transcript.find(event => event.message.content[0].id === 'checkpoint').message.content[0].input.content = content;
        expect(validateCallerEvidence({ ...input, checkpointFiles: { ...input.checkpointFiles, 'exploration-001.json': content }, result: { ...result, transcript } }).some(error => error.includes('checkpoint'))).toBe(true);
      }
      fs.writeFileSync(path.join(reportRoot, 'exploration-001.json'), original);
      const duplicateJSON = structuredClone(result.transcript) as any[];
      duplicateJSON.find(event => event.message.content[0].tool_use_id === 'adverse').message.content[0].content += '\n{}';
      expect(validateCallerEvidence({ ...input, result: { ...result, transcript: duplicateJSON } }).some(error => /ambiguous native probe/.test(error))).toBe(true);
    } finally { await dispose(fixture); }
  });

  test('a completed child exit 124 is guarded negative evidence, not expiry or a passing contract', async () => {
    const fixture = createQaCallerFixture('ship-exploratory-small-cli', { instructions: 'Free completed-child exit control.', installRuntime: true });
    try {
      const cli = path.join(fixture.cwd, 'cli.ts');
      expect(fs.realpathSync(cli)).toBe(cli);
      fs.appendFileSync(cli, '\nprocess.exit(124);\n');
      await fixture.observe();
      const reportRoot = path.join(fixture.cwd, 'reports');
      const helper = path.join(fixture.runtime, 'bin/gstack-qa-deadline');
      const state = path.join(reportRoot, 'deadline.json');
      const result = await runQaCaller(fixture, 'free-completed-child-124', async options => {
        const transcript: unknown[] = [
          ...nativeCall('parent', 'Read', { file_path: `${fixture.cwd}/caller-ship.md` }, 'parent workflow'),
          ...nativeCall('shared', 'Read', { file_path: `${fixture.runtime}/qa/sections/exploratory.md` }, 'shared method'),
          ...nativeCall('functional', 'Read', { file_path: `${fixture.runtime}/qa/sections/system-functional.md` }, 'functional method'),
          ...nativeCall('ship-army', 'Read', { file_path: `${fixture.runtime}/ship/sections/review-army.md` }, 'ship Step 9'),
        ];
        for (const [id, command, exit] of [
          ['start', `bun ${helper} start ${state} 300`, 0],
          ['child-124', `bun ${helper} run ${state} -- bun scripts/probe.ts 3`, 124],
        ] as const) {
          expect(qaCallerCommandAllowed(command, [], { runtime: fixture.runtime, fixtureRoot: fixture.cwd })).toBe(true);
          const actual = spawnSync('bash', ['-c', command], { cwd: options.workingDirectory, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 5000 });
          expect(actual.error).toBeUndefined();
          expect(actual.status, actual.stderr).toBe(exit);
          transcript.push(...nativeCall(id, 'Bash', { command }, actual.stdout + actual.stderr, null, actual.status !== 0));
          if (id === 'child-124') {
            const frames = actual.stderr.split('\n').filter(line => line.startsWith('QA_DEADLINE ')).map(line => JSON.parse(line.slice('QA_DEADLINE '.length)));
            expect(frames.map(frame => frame.event)).toEqual(['started', 'finished']);
            expect(frames[1]).toMatchObject({ timedOut: false, exitCode: 124 });
            expect(JSON.parse(actual.stdout)).toMatchObject({ exit: 124, status: 'fail', stdout: '6\n' });
          }
        }
        return { exitReason: 'success', transcript } as SkillTestResult;
      });
      await fixture.close();
      const input = {
        caller: fixture.caller, result, probes: fixture.probes(),
        receipt: { status: 'fail' as const, probes: fixture.probes().map(probe => probe.id), remaining: ['adverse not run'] },
        currentSnapshot: fixture.snapshot(), requiredCharters: ['happy', 'adverse'], mutations: fixture.mutationEvents,
        observerComplete: fixture.observation?.complete === true && !fixture.observerErrors.length,
        fixtureRoot: fixture.cwd, runtime: fixture.runtime, reportRoot, requireGuardedSmoke: true,
        checkpointFiles: readQACheckpointFiles(reportRoot), reportMarkdown: 'The diagnostic ran and failed its required exit-status contract.',
      };
      expect(input.probes).toHaveLength(1);
      expect(validateCallerEvidence(input)).toEqual([]);
      const green = validateCallerEvidence({ ...input, receipt: { ...input.receipt, status: 'pass', remaining: [] } });
      expect(green).toContain('false green for charter: happy');
      expect(green).toContain('blocked, failing or incomplete coverage reported green');
    } finally { await dispose(fixture); }
  });

  test('only a completed authenticated expired guard-run consumes an unused checkpoint without probe credit', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli', true);
    const retained = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-deadline-evidence-'));
    checkpointRoots.push(retained);
    let deadlineBytes = '';
    try {
      const reportRoot = path.join(fixture.cwd, 'reports');
      const helper = path.join(fixture.runtime, 'bin/gstack-qa-deadline');
      const state = path.join(reportRoot, 'deadline.json');
      const guarded = `bun ${helper} run ${state} -- bun scripts/probe.ts no`;
      const result = await runQaCaller(fixture, 'free-expired-callback', async options => {
        const transcript: unknown[] = [
          ...nativeCall('parent', 'Read', { file_path: `${fixture.cwd}/caller-ship.md` }, 'parent workflow'),
          ...nativeCall('shared', 'Read', { file_path: `${fixture.runtime}/qa/sections/exploratory.md` }, 'shared method'),
          ...nativeCall('functional', 'Read', { file_path: `${fixture.runtime}/qa/sections/system-functional.md` }, 'functional method'),
        ];
        transcript.push(...nativeCall('ship-army', 'Read', { file_path: `${fixture.runtime}/ship/sections/review-army.md` }, 'ship Step 9'));
        const execute = (id: string, command: string, exit: number) => {
          expect(qaCallerCommandAllowed(command, [], { runtime: fixture.runtime, fixtureRoot: fixture.cwd })).toBe(true);
          const actual = spawnSync('bash', ['-c', command], { cwd: options.workingDirectory, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 5000 });
          expect(actual.error).toBeUndefined();
          expect(actual.status, actual.stderr).toBe(exit);
          transcript.push(...nativeCall(id, 'Bash', { command }, actual.stdout + actual.stderr, null, actual.status !== 0));
          return actual;
        };
        const prior = JSON.parse(execute('baseline', 'bun scripts/probe.ts 3', 0).stdout);
        execute('start', `bun ${helper} start ${state} 1 2000-01-01T00:00:00Z`, 124);
        const content = JSON.stringify({ observationCommand: 'bun scripts/probe.ts 3', observed: prior, hypothesis: 'The next distinct invalid input should reject according to the CLI contract.', nextCommand: guarded });
        fs.writeFileSync(path.join(reportRoot, 'exploration-001.json'), content, { mode: 0o600 });
        transcript.push(...nativeCall('checkpoint', 'Write', { file_path: path.join(reportRoot, 'exploration-001.json'), content }, 'File created successfully'));
        expect(execute('expired', guarded, 124).stdout).toBe('');
        return { exitReason: 'success', transcript } as SkillTestResult;
      });
      await fixture.close();
      const input = {
        caller: fixture.caller, result, probes: fixture.probes(),
        receipt: { status: 'blocked' as const, probes: fixture.probes().map(probe => probe.id), remaining: ['adverse not run: deadline expired'] },
        currentSnapshot: fixture.snapshot(), requiredCharters: ['happy', 'adverse'], mutations: fixture.mutationEvents,
        observerComplete: fixture.observation?.complete === true && !fixture.observerErrors.length,
        fixtureRoot: fixture.cwd, runtime: fixture.runtime, reportRoot,
        checkpointFiles: readQACheckpointFiles(reportRoot), reportMarkdown: '[Unexecuted follow-up](exploration-001.json)',
      };
      expect(input.probes).toHaveLength(1);
      expect(validateCallerEvidence(input)).toEqual([]);
      expect(validateCallerEvidence({ ...input, requireGuardedSmoke: true })).toContain('no authenticated guarded diagnostic executed');
      expect(validateCallerEvidence({ ...input, receipt: { ...input.receipt, status: 'pass', remaining: [] } })).toContain('false green for charter: adverse');
      const childLocal = structuredClone(result.transcript) as any[];
      for (const event of childLocal) {
        const block = event.message.content[0];
        if (['baseline', 'start', 'checkpoint', 'expired'].includes(block.id ?? block.tool_use_id)) event.parent_tool_use_id = 'discovery-child';
      }
      expect(validateCallerEvidence({ ...input, result: { ...result, transcript: childLocal } })).toEqual([]);
      const original = input.checkpointFiles['exploration-001.json'];
      for (const change of ['status-only', 'unprefixed', 'success', 'missing-result', 'wrong-state', 'not-expired', 'started', 'finished-timeout', 'child-124', 'mixed-started', 'mixed-finished', 'duplicate-expired', 'extra-json', 'wrong-parent', 'late-write', 'pending-write', 'forged-helper']) {
        const transcript = structuredClone(result.transcript) as any[];
        const use = transcript.find(event => event.message.content[0].id === 'expired');
        const completion = transcript.find(event => event.message.content[0].tool_use_id === 'expired');
        const write = transcript.find(event => event.message.content[0].id === 'checkpoint');
        const writeResult = transcript.find(event => event.message.content[0].tool_use_id === 'checkpoint');
        if (change === 'status-only' || change === 'forged-helper') {
          use.message.content[0].input.command = change === 'status-only' ? `bun ${helper} status ${state}` : guarded.replace(helper, `${helper}-lookalike`);
          const note = { ...JSON.parse(original), nextCommand: use.message.content[0].input.command };
          write.message.content[0].input.content = JSON.stringify(note);
        } else if (change === 'unprefixed') completion.message.content[0].content = completion.message.content[0].content.replace('QA_DEADLINE ', '');
        else if (change === 'success') completion.message.content[0].is_error = false;
        else if (change === 'missing-result') transcript.splice(transcript.indexOf(completion), 1);
        else if (change === 'extra-json') completion.message.content[0].content += '\n{}';
        else if (change === 'wrong-parent') { use.parent_tool_use_id = 'other-parent'; completion.parent_tool_use_id = 'other-parent'; }
        else if (change === 'late-write' || change === 'pending-write') {
          transcript.splice(transcript.indexOf(writeResult), 1);
          if (change === 'late-write') transcript.splice(transcript.indexOf(write), 1);
          transcript.push(...(change === 'late-write' ? [write, writeResult] : [writeResult]));
        } else {
          const diagnostic = completion.message.content[0].content.split('\n').find((line: string) => line.startsWith('QA_DEADLINE '));
          const receipt = JSON.parse(diagnostic.slice('QA_DEADLINE '.length));
          if (change === 'wrong-state') receipt.budgetMs += 1;
          if (change === 'not-expired') receipt.expired = false;
          if (change === 'started') receipt.event = 'started';
          completion.message.content[0].content = `QA_DEADLINE ${JSON.stringify(receipt)}\n`;
          if (change === 'finished-timeout' || change === 'child-124') {
            const finished = { guard: 'qa-deadline', event: 'finished', observedAt: receipt.observedAt, deadlineAt: receipt.deadlineAt, timedOut: change === 'finished-timeout', exitCode: 124 };
            completion.message.content[0].content = `QA_DEADLINE ${JSON.stringify(finished)}\n`;
          }
          if (change === 'mixed-started' || change === 'mixed-finished' || change === 'duplicate-expired') {
            const event = change === 'mixed-started' ? 'started' : change === 'mixed-finished' ? 'finished' : 'expired';
            completion.message.content[0].content += `QA_DEADLINE ${JSON.stringify({ ...receipt, event })}\n`;
          }
        }
        const content = write.message.content[0].input.content;
        fs.writeFileSync(path.join(reportRoot, 'exploration-001.json'), content);
        const errors = validateCallerEvidence({ ...input, checkpointFiles: { 'exploration-001.json': content }, result: { ...result, transcript } });
        expect(errors.length, change).toBeGreaterThan(0);
        if (change !== 'missing-result') expect(errors.some(error => /checkpoint/i.test(error)), change).toBe(true);
      }
      fs.writeFileSync(path.join(reportRoot, 'exploration-001.json'), original);
      expect(fixture.probes()).toEqual(input.probes);
      expect(validateCallerEvidence(input)).toEqual([]);
      deadlineBytes = fs.readFileSync(state, 'utf8');
      retainQaCallerEvidence(fixture, retained, result);
    } finally { await dispose(fixture); }
    expect(fs.existsSync(fixture.root)).toBe(false);
    expect(fs.readFileSync(path.join(retained, 'deadline.json'), 'utf8')).toBe(deadlineBytes);
    expect(fs.statSync(path.join(retained, 'deadline.json')).mode & 0o777).toBe(0o600);
  });

  test('deadline capture preserves diagnostics without following linked state or losing other evidence', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli', true);
    const retained = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-unsafe-deadline-'));
    checkpointRoots.push(retained);
    try {
      const witness = path.join(fixture.root, 'outside-state.json');
      fs.writeFileSync(witness, 'outside witness must never be captured');
      fs.symlinkSync(witness, path.join(fixture.cwd, 'reports/deadline.json'));
      await fixture.close();
      retainQaCallerEvidence(fixture, retained, undefined);
      expect(fs.existsSync(path.join(retained, 'deadline.json'))).toBe(false);
      expect(fs.readFileSync(path.join(retained, 'deadline-capture-error.txt'), 'utf8')).toContain('Symlinked deadline paths are forbidden');
      expect(fs.readFileSync(path.join(retained, 'native-events.json'), 'utf8')).toBe('[]');
      expect(fs.readFileSync(witness, 'utf8')).toBe('outside witness must never be captured');
      expect(fs.readdirSync(retained).some(file => fs.readFileSync(path.join(retained, file), 'utf8').includes('outside witness must never be captured'))).toBe(false);
    } finally { await dispose(fixture); }
  });

  test('actual runner receives a safe receipt interface without scenario answers or a duplicate QA workflow', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-config');
      await runQaCaller(fixture, 'free-receipt-interface', async options => {
        expect(options.prompt).toMatch(/overall supplied phase gate/i);
        expect(options.prompt).toMatch(/no remaining required contracts or gates/i);
        expect(options.prompt).toMatch(/not required remainder/i);
        expect(options.prompt).toContain('(probe-...)');
        expect(options.prompt).toMatch(/never the helper's three-digit capture IDs/i);
        expect(options.prompt).not.toMatch(/bun scripts\/probe\.ts \d|exploration-[0-9]{3}|snapshot.*must|plan:nine|adverse/i);
        const readme = fs.readFileSync(path.join(fixture.cwd, 'README.md'), 'utf8');
        expect(readme).toMatch(/synthetic, nonsecret/i);
        expect(readme).toMatch(/snapshot identifies the owned source/i);
        expect(readme).not.toMatch(/checkpoint|exploration-NNN|hypothesis|nextCommand/);
        return { exitReason: 'success', transcript: [] } as unknown as SkillTestResult;
      });
    } finally { await dispose(fixture); }
  });

  test('native caller retention uses the explicitly selected shard artifact directory', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-qa-callers.test.ts'), 'utf8');
    expect(source).toContain("path.join(process.env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'qa-callers', id)");
  });

  test('caller fixtures canonicalize an aliased temporary parent before checkpoint validation', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-temp-alias-'));
    const target = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias);
    const previous = process.env.TMPDIR;
    let fixture: QaCallerFixture | undefined;
    try {
      process.env.TMPDIR = alias;
      expect(os.tmpdir()).toBe(alias);
      fixture = createQaCallerFixture('ship-exploratory-small-cli', { installRuntime: false });
      expect(fixture.root).toBe(fs.realpathSync(fixture.root));
      expect(path.dirname(fixture.root)).toBe(target);
      expect(readQACheckpointFiles(path.join(fixture.cwd, 'reports'))).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      if (fixture) await dispose(fixture);
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(process.env.TMPDIR).toBe(previous);
  });

  test('actual runner callback binds a successful pre-probe Write to native JSON and retained files', async () => {
    const fixture = await fixtureFor('review-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-config');
      const reportRoot = path.join(fixture.cwd, 'reports');
      const result = await runQaCaller(fixture, 'free-checkpoint-callback', async options => {
        const transcript: unknown[] = evidence().result.transcript.slice(0, 6);
        const execute = (value: string) => {
          const command = `bun scripts/probe.ts ${value}`;
          const actual = spawnSync('bash', ['-c', command], { cwd: options.workingDirectory, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 5000 });
          expect(actual.status).toBe(value === '3' ? 0 : 2);
          const observed = JSON.parse(actual.stdout);
          transcript.push(...nativeCall(observed.id, 'Bash', { command }, actual.stdout, null, actual.status !== 0));
          return observed;
        };
        const prior = execute('3');
        const content = JSON.stringify({ observationCommand: 'bun scripts/probe.ts 3', observed: prior, hypothesis: 'The invalid input should reject with exit two and the documented stderr.', nextCommand: 'bun scripts/probe.ts no' });
        const file = path.join(reportRoot, 'exploration-001.json');
        fs.writeFileSync(file, content, { mode: 0o600 });
        transcript.push(...nativeCall('checkpoint', 'Write', { file_path: file, content }, `File created successfully at: ${file}`));
        execute('no');
        fs.writeFileSync(path.join(reportRoot, 'review.md'), '[Reasoning](exploration-001.json)');
        return { exitReason: 'success', transcript } as SkillTestResult;
      });
      await fixture.close();
      const input = {
        caller: fixture.caller, result, probes: fixture.probes(),
        receipt: { status: 'pass' as const, probes: fixture.probes().map(probe => probe.id), remaining: [] },
        requiredCharters: ['happy', 'adverse'], currentSnapshot: fixture.snapshot(), mutations: fixture.mutationEvents,
        observerComplete: fixture.observation?.complete === true && !fixture.observerErrors.length,
        fixtureRoot: fixture.cwd, reportRoot, checkpointFiles: readQACheckpointFiles(reportRoot),
        reportMarkdown: fs.readFileSync(path.join(reportRoot, 'review.md'), 'utf8'),
      };
      expect(validateCallerEvidence(input)).toEqual([]);
      result.transcript.splice(8, 2);
      expect(validateCallerEvidence(input).some(error => /checkpoint/i.test(error))).toBe(true);
    } finally { await dispose(fixture); }
  });

  test('actual runner callback executes literal listing and installed bookkeeping without mutation authority', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-config');
      const result = await runQaCaller(fixture, 'free-native-interface', async options => {
        const observed = evidence();
        const execute = (id: string, command: string) => {
          expect(qaCallerCommandAllowed(command, fixture.workflowCommands), command).toBe(true);
          const actual = spawnSync('bash', ['-c', command], { cwd: options.workingDirectory, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 5000 });
          expect(actual.status, actual.stderr).toBe(0);
          observed.result.transcript.push(...nativeCall(id, 'Bash', { command }, actual.stdout));
          return actual.stdout.trim();
        };
        const bin = path.join(import.meta.dir, '../bin/gstack-review-log');
        execute('listing', 'ls -la -- reports');
        const token = execute('start', `${bin} --start adversarial-review`);
        execute('finish', generatedReviewRecord(bin, token));
        expect(validateCallerEvidence(observed)).toEqual([]);
        const records = (fs.readdirSync(fixture.state, { recursive: true }) as string[]).filter(file => file.endsWith('.jsonl')).flatMap(file => fs.readFileSync(path.join(fixture.state, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
        const record = records.find(record => record.skill === 'adversarial-review');
        expect(record?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(record?.commit).toMatch(/^[0-9a-f]{7,40}$/);
        return observed.result as SkillTestResult;
      });
      expect(result.exitReason).toBe('success');
      const literal = "ls -- 'git push; $(touch forged)'";
      expect(qaCallerCommandAllowed(literal)).toBe(true);
      const absent = spawnSync('bash', ['-c', literal], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
      expect(absent.status).toBe(2);
      expect(absent.stderr).toContain('git push; $(touch forged)');
      expect(fs.existsSync(path.join(fixture.cwd, 'forged'))).toBe(false);
      await fixture.close();
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('permitted missing and quoted CLI inputs execute literally under the real observer', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      for (const [argument, input] of [['', ''], [" 'git push; $(touch forged)'", 'git push; $(touch forged)'], [' "invalid; text"', 'invalid; text']]) {
        const command = `bun scripts/probe.ts${argument}`;
        expect(qaCallerCommandAllowed(command)).toBe(true);
        const result = spawnSync('bash', ['-c', command], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stdout)).toMatchObject({ input, status: 'pass', exit: 2 });
      }
      await fixture.close();
      expect(fs.existsSync(path.join(fixture.cwd, 'forged'))).toBe(false);
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('allowed diff modes and literal pathspecs execute as read-only Git arguments', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      const env = qaCallerSessionOptions(fixture, 'free-diff-control').env;
      const execute = (command: string) => {
        expect(qaCallerCommandAllowed(command), command).toBe(true);
        const result = spawnSync('bash', ['-c', command], { cwd: fixture.cwd, env: { ...process.env, ...env, DIFF_BASE: 'untrusted-inherited-value' }, encoding: 'utf8', timeout: 5000 });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        return result.stdout;
      };
      for (const mode of ['', '--stat', '--numstat', '--name-only', '--name-status']) {
        const expected = spawnSync('git', ['diff', ...(mode ? [mode] : []), 'origin/main', '--', '*.ts', ':(exclude)*test*'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
        expect(expected.status).toBe(0);
        expect(expected.stdout).toContain('scale.ts');
        for (const [prefix, base] of [['', ''], ['', ' origin/main'], [diffPreface, ' "$DIFF_BASE"']]) {
          const option = mode ? ` ${mode}` : '';
          for (const arguments_ of [option + base, base + option]) {
            expect(execute(`${prefix}git diff${arguments_} -- '*.ts' ':(exclude)*test*'`)).toBe(expected.stdout);
          }
        }
      }
      for (const command of capturedNativeDiffs) execute(command);
      for (const selection of ["'$(touch forged)'", "'git push; touch forged'", '"space name.ts"', '--output=forged', '--ext-diff']) {
        expect(execute(`git diff origin/main -- ${selection}`)).toBe('');
      }
      await fixture.close();
      expect(fs.existsSync(path.join(fixture.cwd, 'forged'))).toBe(false);
      expect(fixture.observation?.complete).toBe(true);
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('every caller reserves completion within the unchanged capture and turn budgets', async () => {
    expect(CAPTURE_MS).toBe(300_000);
    expect(QA_CALLER_TEST_MS).toBe(CAPTURE_MS + SESSION_DRAIN_GRACE_MS + 10_000);
    for (const caseId of QA_CALLER_CASES) {
      const fixture = createQaCallerFixture(caseId, { installRuntime: false });
      try {
        const options = qaCallerSessionOptions(fixture, 'free-reserve-contract');
        expect(options.timeout).toBe(300_000);
        expect(options.maxTurns).toBe(25);
        expect(options.completionReserveMs).toBe(75_000);
        expect(options.completionReserveMs).toBe(options.timeout! / 4);
        expect(options).not.toHaveProperty('model');
        expect(options).not.toHaveProperty('tools');
        expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Agent', 'Skill', 'AskUserQuestion']);
        expect(options.prompt).toContain('Keep normal parent decision gates.');
        expect(options.prompt).toContain('the native reviewer is still required');
        expect(options.prompt).toContain('first unresolved approval gate');
        expect(options.prompt).toContain('at most one output mode: --stat, --numstat, --name-only, or --name-status');
        expect(options.prompt).toContain(diffPreface);
        expect(options.prompt).toContain('optional literal pathspec arguments after --');
        expect(qaCallerCommandAllowed('date -u +%Y-%m-%dT%H:%M:%SZ')).toBe(true);
        expect(() => readCallerReceipt(fixture)).toThrow();
      } finally { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
    }
  });

  test.each(QA_CALLER_CASES)('%s supplies scheduling boundaries through the actual runner callback', async caseId => {
    const fixture = createQaCallerFixture(caseId);
    try {
      const sentinel = { exitReason: 'error_max_turns', transcript: [] } as unknown as SkillTestResult;
      let calls = 0;
      const result = await runQaCaller(fixture, 'free-scheduling-contract', async options => {
        calls++;
        expect(options.maxTurns).toBe(25);
        expect(options.timeout).toBe(300_000);
        expect(options.completionReserveMs).toBe(75_000);
        expect(options.appendSystemPrompt).toContain(`at most ${options.maxTurns} assistant turns`);
        for (const rule of [/separate native tool calls/i, /approval prerequisites settle/i,
          /completion reserve is for required verification/i, /superseded evidence/i,
          /never group diagnostic probes/i, /turn limit does not authorize skipping work/i]) {
          expect(options.appendSystemPrompt).toMatch(rule);
        }
        expect(options.appendSystemPrompt).not.toMatch(/bun scripts\/probe\.ts \d|invalid input|highest.risk/i);
        expect(options.prompt).toMatch(/keep normal parent decision gates/i);
        expect(options.prompt).toMatch(/Hard deadline UTC, never its Runner entry UTC/i);
        expect(options.prompt).toMatch(/completed:true review record, read HANDOFF\.md/i);
        expect(options.prompt).toMatch(/do not publish a checkpoint for it/i);
        expect(options.prompt).toMatch(/authenticated expired-capture result/i);
        expect(options.prompt).toContain('reports/review.md');
        return sentinel;
      });
      expect(calls).toBe(1);
      expect(result).toBe(sentinel);
      expect(qaCallerCommandAllowed('git diff origin/main')).toBe(true);
      expect(qaCallerCommandAllowed('git status --short')).toBe(true);
      expect(qaCallerCommandAllowed('git diff origin/main && git status --short')).toBe(false);
      expect(() => readCallerReceipt(fixture)).toThrow();
    } finally { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('supplied earlier-phase context names readable installed assets without recursive discovery', () => {
    const fixture = createQaCallerFixture('review-exploratory-small-cli');
    try {
      const prompt = qaCallerSessionOptions(fixture, 'free-control').prompt;
      for (const relative of ['review/checklist.md', 'qa/templates/functional-report-template.md']) {
        const asset = path.join(fixture.runtime, relative);
        expect(prompt).toContain(asset);
        expect(fs.readFileSync(asset, 'utf8').length).toBeGreaterThan(200);
      }
      expect(prompt).toContain('Pass these same command and write boundaries to any child');
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('the caller phase starts with cross-project onboarding already resolved in its owned state', () => {
    const fixture = createQaCallerFixture('ship-exploratory-small-cli', { installRuntime: false });
    try {
      const preference = spawnSync('bash', [path.join(import.meta.dir, '../bin/gstack-config'), 'get', 'cross_project_learnings'], {
        cwd: fixture.cwd, env: { ...process.env, GSTACK_HOME: fixture.state }, encoding: 'utf8', timeout: 5000,
      });
      expect(preference.status).toBe(0);
      expect(preference.stdout.trim()).toBe('false');
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('the resumed review phase receives a real start token bound to its current fixture snapshot', () => {
    const fixture = createQaCallerFixture('review-exploratory-small-cli', { installRuntime: false });
    try {
      expect(fixture.reviewStart).toMatch(/^[0-9a-f-]{36}$/);
      const files = fs.readdirSync(fixture.state, { recursive: true }) as string[];
      const captures = files.filter(file => file.endsWith(`${fixture.reviewStart}.json`));
      expect(captures).toHaveLength(1);
      const start = JSON.parse(fs.readFileSync(path.join(fixture.state, captures[0]), 'utf8'));
      expect(start).toMatchObject({ skill: 'review', repo: fs.realpathSync(fixture.cwd), branch: 'caller-change' });
      expect(start.wtree).toMatch(/^[0-9a-f]{40,64}$/);
      expect(qaCallerSessionOptions(fixture, 'free-phase-context').prompt).toContain(`REVIEW_START=${fixture.reviewStart}`);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('the declared phase interface rejects re-entering setup and composing shell inventory', () => {
    const fixture = createQaCallerFixture('ship-exploratory-small-cli', { installRuntime: false });
    try {
      const prompt = qaCallerSessionOptions(fixture, 'free-phase-interface').prompt;
      expect(prompt).toContain('do not read or invoke the full parent SKILL.md');
      expect(prompt).toContain('without fetch');
      expect(prompt).toContain('even read-only commands must not be chained');
      expect(prompt).not.toMatch(/bun scripts\/probe\.ts \d|invalid input|highest.risk/i);
      expect(qaCallerCommandAllowed('pwd && ls -la')).toBe(false);
      expect(qaCallerCommandAllowed('git fetch origin main')).toBe(false);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test('all five caller options declare diagnostic checkpoints apart from suite verification', async () => {
    for (const caseId of QA_CALLER_CASES) {
      const fixture = createQaCallerFixture(caseId, { installRuntime: false });
      try {
        const prompt = qaCallerSessionOptions(fixture, 'free-diagnostic-checkpoint-contract').prompt;
        expect(prompt).toContain('Use diagnostic-client commands such as `bun scripts/probe.ts <literal>` for exploratory discoveries and their checkpoint evidence.');
        expect(prompt).toContain('A required `bun run test` is separate suite verification: report it as verification, never as a diagnostic observation or checkpoint anchor/target.');
        expect(prompt).toContain('Use the production evidence helper to publish each diagnostic checkpoint as `reports/exploration-NNN.json`, not inside a nested directory');
      } finally { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
    }
    expect(qaCallerCommandAllowed('bun scripts/probe.ts 3')).toBe(true);
    expect(qaCallerCommandAllowed('bun run test')).toBe(true);
    expect(qaCallerCommandAllowed('bun scripts/probe.ts 3; bun run test')).toBe(false);
  });

  test('authorized review bookkeeping leaves the observed product and real Git metadata untouched', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      const start = spawnSync('bash', [path.join(import.meta.dir, '../bin/gstack-review-log'), '--start', 'review'], {
        cwd: fixture.cwd,
        env: { ...process.env, GSTACK_HOME: fixture.state, ...fixture.gitEnvironment },
        encoding: 'utf8', timeout: 5000,
      });
      expect(start.status).toBe(0);
      expect(start.stdout.trim()).toMatch(/^[0-9a-f-]{36}$/);
      await fixture.close();
      expect(fixture.observerErrors).toEqual([]);
      expect(fixture.mutationEvents).toEqual([]);
      expect(fs.realpathSync(fixture.gitEnvironment.GIT_OBJECT_DIRECTORY).startsWith(fixture.state + path.sep)).toBe(true);
      const env = qaCallerSessionOptions(fixture, 'free-bookkeeping-state').env;
      expect(env).toMatchObject(fixture.gitEnvironment);
    } finally { await dispose(fixture); }
  });

  test('real generated runtime and shared resource pointers stay inside the private skill view', async () => {
    const fixture = createQaCallerFixture('ship-exploratory-small-cli');
    try {
      const identity = spawnSync('git', ['config', '--local', 'user.name'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
      expect(identity.status).toBe(0);
      expect(identity.stdout.trim()).toBe('QA Caller Fixture');
      await fixture.observe();
      const registered = path.join(fixture.config, 'skills/qa/sections/exploratory.md');
      expect(fs.realpathSync(registered).startsWith(fixture.root + path.sep)).toBe(true);
      expect(fs.readFileSync(registered, 'utf8')).toContain('# Shared exploratory QA');
      expect(fs.readFileSync(path.join(fixture.cwd, 'caller-ship.md'), 'utf8')).toContain(fixture.runtime + '/ship/sections/review-army.md');
      expect(probe(fixture, '3').status).toBe(0);
      await fixture.close();
      expect(fixture.observation?.complete).toBe(true);
      expect(fixture.observerErrors).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('native probes expose exact streams, seeded defect and unchanged-input fingerprints', async () => {
    const fixture = await fixtureFor('review-exploratory-small-cli');
    try {
      expect(probe(fixture, '3').status).toBe(0);
      expect(probe(fixture, 'no').status).toBe(2);
      expect(probe(fixture, '0').status).toBe(2);
      expect(fixture.probes().map(({ input, stdout, stderr, exit, status }) => ({ input, stdout, stderr, exit, status }))).toEqual([
        { input: '3', stdout: '6\n', stderr: '', exit: 0, status: 'pass' },
        { input: 'no', stdout: '', stderr: 'integer required: 0..9\n', exit: 2, status: 'pass' },
        { input: '0', stdout: '', stderr: 'integer required: 0..9\n', exit: 2, status: 'fail' },
      ]);
      expect(fixture.probes().every(result => result.snapshot === fixture.snapshot())).toBe(true);
      expect(fs.existsSync(path.join(fixture.cwd, 'PLAN.md'))).toBe(false);
    } finally { await dispose(fixture); }
  });

  test('missing native prerequisite blocks the real CLI as well as its diagnostic client', async () => {
    const fixture = await fixtureFor('ship-exploratory-unavailable');
    try {
      expect(probe(fixture, '3').status).not.toBe(0);
      expect(fixture.probes()).toEqual([expect.objectContaining({ status: 'blocked', stdout: '' })]);
      expect(fixture.probes()[0].stderr).not.toBe('');
      const direct = spawnSync(process.execPath, ['cli.ts', '3'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 });
      expect(direct.status).not.toBe(0);
      expect(direct.stderr).toContain('vendor/native-engine.ts');
    } finally { await dispose(fixture); }
  });

  test('actual write watcher observes transient edits, rename and deletion', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      const file = path.join(fixture.cwd, 'scale.ts'), original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, 'temporary violation');
      fs.writeFileSync(file, original);
      const renamed = path.join(fixture.cwd, 'renamed.ts');
      fs.renameSync(file, renamed);
      fs.renameSync(renamed, file);
      fs.writeFileSync(path.join(fixture.cwd, 'created.test.ts'), 'test');
      fs.unlinkSync(path.join(fixture.cwd, 'created.test.ts'));
      await Bun.sleep(50);
      await fixture.close();
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(fixture.mutationEvents).toContain('scale.ts');
      expect(fixture.mutationEvents).toContain('renamed.ts');
      expect(fixture.mutationEvents).toContain('created.test.ts');
      expect(fixture.observation?.complete).toBe(true);
      expect(fixture.observerErrors).toEqual([]);
      expect(validateCallerEvidence({ ...evidence(), mutations: fixture.mutationEvents }))
        .toContain('unauthorized mutation: scale.ts');
    } finally { await dispose(fixture); }
  });

  test('late candidate coordinator changes consumed bytes and does not label its own write an agent violation', async () => {
    const fixture = await fixtureFor('ship-exploratory-late-input');
    try {
      const original = fixture.snapshot();
      probe(fixture, '3'); probe(fixture, 'no');
      await Bun.sleep(50);
      expect(fixture.lateApplied).toBe(true);
      expect(fixture.snapshot()).not.toBe(original);
      expect(fixture.probes().every(result => result.snapshot === original)).toBe(true);
      expect(fixture.mutationEvents).toEqual([]);
      probe(fixture, '3');
      expect(fixture.probes().at(-1)?.snapshot).toBe(fixture.snapshot());
      await fixture.close();
      expect(fixture.mutationEvents).toEqual([]);
    } finally { await dispose(fixture); }
  });

  test('actual runner callback receives the parent request and hermetic state without teaching the probes', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    try {
      fixture.config = path.join(fixture.root, 'callback-control-config');
      const options = qaCallerSessionOptions(fixture, 'free-callback-control');
      let received: Parameters<typeof runSkillTest>[0] | undefined;
      const sentinel = { exitReason: 'timeout', transcript: [] } as unknown as SkillTestResult;
      const result = await runQaCaller(fixture, 'free-callback-control', async supplied => { received = supplied; return sentinel; });
      expect(result).toBe(sentinel);
      expect(received).toEqual(options);
      expect(options.env?.GSTACK_HOME).toBe(fixture.state);
      expect(options.env?.GSTACK_STATE_ROOT).toBe(fixture.state);
      expect(options.allowedTools).toContain('Edit');
      expect(options.allowedTools).toContain('Bash');
      expect(options.prompt).toContain(`This excerpt comes from ${fixture.runtime}/${fixture.caller}/SKILL.md`);
      expect(options.prompt).toContain('not from the excerpt file or product directory');
      expect(options.prompt).not.toMatch(/bun scripts\/probe\.ts \d|invalid input|highest.risk/i);
      expect(() => readCallerReceipt(fixture)).toThrow();
      fs.writeFileSync(path.join(fixture.cwd, 'reports/receipt.json'), '{"status":"pass","probes":"none"}');
      expect(() => readCallerReceipt(fixture)).toThrow('Malformed');
    } finally { await dispose(fixture); }
  });

  test('native diagnostic evidence remains private and survives fixture cleanup', async () => {
    const fixture = await fixtureFor('ship-exploratory-small-cli');
    const artifacts = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-proof-'));
    try {
      probe(fixture, '3');
      probe(fixture, 'no');
      const notes = checkpointSequence(fixture.probes(), path.join(fixture.cwd, 'reports'));
      await fixture.close();
      retainQaCallerEvidence(fixture, artifacts, { transcript: notes.transcript } as SkillTestResult);
      await dispose(fixture);
      expect(fs.existsSync(fixture.root)).toBe(false);
      const rows = fs.readFileSync(path.join(artifacts, 'native-probes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toEqual([expect.objectContaining({ input: '3', status: 'pass', stdout: '6\n' }), expect.objectContaining({ input: 'no', status: 'pass', exit: 2 })]);
      expect(fs.readFileSync(path.join(artifacts, 'exploration-001.json'), 'utf8')).toBe(notes.checkpointFiles['exploration-001.json']);
      expect(fs.statSync(path.join(artifacts, 'exploration-001.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(artifacts).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(artifacts, 'native-probes.jsonl')).mode & 0o777).toBe(0o600);
    } finally {
      if (fs.existsSync(fixture.root)) await dispose(fixture);
      fs.rmSync(artifacts, { recursive: true, force: true });
    }
  });

  test('retained handoff metadata preserves cached-read proof after fixture cleanup', async () => {
    const fixture = await fixtureFor('review-exploratory-small-cli');
    const artifacts = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-read-proof-'));
    try {
      const file = path.join(fixture.cwd, 'HANDOFF.md');
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const full = nativeCall('handoff', 'Read', { file_path: file }, lines.map((line, i) => `${i + 1}\t${line}`).join('\n')) as any[];
      const cached = nativeCall('cached', 'Read', { file_path: file }, 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.') as any[];
      for (const event of [...full, ...cached]) event.session_id = 'retained-session';
      full[0].message.id = 'first';
      cached[0].message.id = 'later';
      full[1].tool_use_result = { type: 'text', file: { filePath: file, content, startLine: 1, numLines: lines.length, totalLines: lines.length } };
      cached[1].tool_use_result = { type: 'file_unchanged', file: { filePath: file } };
      await fixture.close();
      retainQaCallerEvidence(fixture, artifacts, { transcript: [...full, ...cached], exitReason: 'success' } as SkillTestResult);
      await dispose(fixture);
      expect(fs.existsSync(fixture.root)).toBe(false);
      const retained = JSON.parse(fs.readFileSync(path.join(artifacts, 'native-events.json'), 'utf8'));
      expect(retained).toEqual([...full, ...cached]);
      expect(callerTools(retained).map(tool => tool.handoffContent)).toEqual([content, content]);
      expect(fs.statSync(path.join(artifacts, 'native-events.json')).mode & 0o777).toBe(0o600);
    } finally {
      if (fs.existsSync(fixture.root)) await dispose(fixture);
      fs.rmSync(artifacts, { recursive: true, force: true });
    }
  });

  test('retained Bash interruption metadata still rejects an interrupted native result', async () => {
    const fixture = await fixtureFor('review-exploratory-small-cli');
    const artifacts = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-interrupted-'));
    try {
      const events = nativeCall('interrupted', 'Bash', { command: 'bun scripts/probe.ts 3' }, '{}') as any[];
      events[1].tool_use_result = { interrupted: true };
      expect(callerTools(events)[0].failed).toBe(true);
      await fixture.close();
      retainQaCallerEvidence(fixture, artifacts, { transcript: events, exitReason: 'success' } as SkillTestResult);
      await dispose(fixture);
      const retained = JSON.parse(fs.readFileSync(path.join(artifacts, 'native-events.json'), 'utf8'));
      expect(retained[1].tool_use_result).toEqual({ interrupted: true });
      expect(callerTools(retained)[0].failed).toBe(true);
    } finally {
      if (fs.existsSync(fixture.root)) await dispose(fixture);
      fs.rmSync(artifacts, { recursive: true, force: true });
    }
  });

  test('unsafe checkpoint links retain private failure evidence without reading or modifying their targets', async () => {
    for (const kind of ['symlink', 'hardlink'] as const) {
      const fixture = await fixtureFor('ship-exploratory-small-cli');
      const artifacts = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-link-proof-'));
      const source = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-link-source-'));
      try {
        const target = path.join(source, 'untouched.txt');
        const sentinel = 'Unsafe target bytes must never enter retained checkpoint evidence.';
        fs.writeFileSync(target, sentinel, { mode: 0o640 });
        fs.utimesSync(target, new Date(1000), new Date(2000));
        const note = path.join(fixture.cwd, 'reports/exploration-001.json');
        if (kind === 'symlink') fs.symlinkSync(target, note);
        else fs.linkSync(target, note);
        const targetBefore = fs.statSync(target);
        const linkBefore = fs.lstatSync(note);
        probe(fixture, '3');
        const nativeProbe = fixture.probes()[0];
        const result = { exitReason: 'success', transcript: nativeCall('native-probe', 'Bash', { command: 'bun scripts/probe.ts 3' }, JSON.stringify(nativeProbe)) } as SkillTestResult;
        fs.writeFileSync(path.join(fixture.cwd, 'reports/review.md'), 'Original report: checkpoint capture must fail.');
        fs.writeFileSync(path.join(fixture.cwd, 'reports/receipt.json'), JSON.stringify({ status: 'blocked', probes: [nativeProbe.id], remaining: ['unsafe checkpoint'] }));
        await fixture.close();
        const observed = evidence();
        expect(validateCallerEvidence({ ...observed, reportRoot: path.join(fixture.cwd, 'reports'), checkpointFiles: {} }).some(error => /unsafe.*checkpoint/i.test(error))).toBe(true);
        retainQaCallerEvidence(fixture, artifacts, result);
        expect(fs.statSync(target)).toMatchObject({ ino: targetBefore.ino, mode: targetBefore.mode, size: targetBefore.size, atimeMs: targetBefore.atimeMs, mtimeMs: targetBefore.mtimeMs });
        expect(fs.lstatSync(note)).toMatchObject({ ino: linkBefore.ino, mode: linkBefore.mode, size: linkBefore.size, mtimeMs: linkBefore.mtimeMs });
        expect(fs.readFileSync(target, 'utf8')).toBe(sentinel);
        expect(fs.readFileSync(path.join(artifacts, 'checkpoint-capture-error.txt'), 'utf8')).toContain('Unsafe checkpoint file: exploration-001.json');
        expect(fs.existsSync(path.join(artifacts, 'exploration-001.json'))).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(artifacts, 'native-events.json'), 'utf8'))).toEqual(result.transcript);
        expect(fs.readFileSync(path.join(artifacts, 'native-probes.jsonl'), 'utf8')).toContain(nativeProbe.id);
        expect(JSON.parse(fs.readFileSync(path.join(artifacts, 'observer.json'), 'utf8'))).toMatchObject({ exitReason: 'success', snapshot: fixture.snapshot() });
        expect(fs.readFileSync(path.join(artifacts, 'report.md'), 'utf8')).toBe('Original report: checkpoint capture must fail.');
        expect(JSON.parse(fs.readFileSync(path.join(artifacts, 'receipt.json'), 'utf8'))).toMatchObject({ status: 'blocked', remaining: ['unsafe checkpoint'] });
        await dispose(fixture);
        expect(fs.existsSync(fixture.root)).toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe(sentinel);
        expect(fs.statSync(artifacts).mode & 0o777).toBe(0o700);
        for (const file of fs.readdirSync(artifacts)) {
          expect(fs.statSync(path.join(artifacts, file)).mode & 0o777).toBe(0o600);
          expect(fs.readFileSync(path.join(artifacts, file), 'utf8')).not.toContain(sentinel);
        }
      } finally {
        if (fs.existsSync(fixture.root)) await dispose(fixture);
        fs.rmSync(artifacts, { recursive: true, force: true });
        fs.rmSync(source, { recursive: true, force: true });
      }
    }
  });
});
