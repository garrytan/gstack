import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { initializePlan, prepareMethodology, createSnapshot, amendImplementation,
  extractImplementationPlan, checkPhaseImplementation } from '../bin/gstack-autoplan-snapshot';
import { autoplanPhaseCompletions } from './helpers/autoplan-phase-observer';
import { auditAutoplanMethodReads, loadAutoplanMethodologyBinding } from './helpers/autoplan-method-read-audit';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import { readPlanSkillCompletion } from './helpers/plan-skill-completion';
import captured from './fixtures/autoplan-phase-handoff-6714.json';

const ROOT = resolve(import.meta.dir, '..');
const source = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gstack-autoplan-handoff-')); owned.push(root);
  const input = join(root, 'input.md'), active = join(root, 'active.md'), restore = join(root, 'restore.md');
  writeFileSync(input, captured.originalImplementation);
  initializePlan(input, active, restore);
  const methodology = prepareMethodology('ceo', join(ROOT, 'plan-ceo-review/SKILL.md'), restore);
  const create = () => createSnapshot('ceo', active, restore, methodology.methodologyPath);
  const record = (block: string) => {
    const plan = readFileSync(active, 'utf8');
    writeFileSync(active, plan.slice(0, plan.indexOf('## Review record\n')) + '## Review record\n' + block + '\n');
  };
  return { root, active, create, record };
}

test('captured accepted CEO decisions remained outside the operative input', () => {
  const f = fixture(); f.record(captured.acceptedCeoBlock);
  const premature = f.create();
  expect(premature.sha256).toBe(captured.originalImplementationSha256);
  expect(premature.sourceBytes).toBe(4607);
  expect(readFileSync(premature.snapshotPath, 'utf8')).not.toContain('per-source deadline');
  expect(captured.acceptedCeoBlock).toContain('per-source deadline');
});

test('a Step 0 checkpoint applies full accepted bytes before a fresh voice snapshot', () => {
  const f = fixture(), step0 = f.create();
  f.record(captured.acceptedCeoBlock);
  amendImplementation('ceo', f.active, step0.snapshotPath);
  expect(checkPhaseImplementation('ceo', f.active, step0.snapshotPath, 'changed').recordedObligations.none).toBe(false);
  expect(extractImplementationPlan(readFileSync(f.active, 'utf8'))).toContain(captured.acceptedCeoBlock);
  const revised = captured.acceptedCeoBlock.replace('<!-- /autoplan-accepted:ceo -->',
    '- Synthetic accepted spec follow-up: verify the completed response.\n<!-- /autoplan-accepted:ceo -->');
  f.record(revised);
  amendImplementation('ceo', f.active, step0.snapshotPath);
  const voices = f.create();
  expect(voices.snapshotPath).not.toBe(step0.snapshotPath);
  expect(voices.sha256).not.toBe(captured.originalImplementationSha256);
  expect(readFileSync(voices.snapshotPath, 'utf8')).toContain(revised.split('\n').slice(1, -1).join('\n'));
  expect(readFileSync(step0.snapshotPath, 'utf8')).toBe(captured.originalImplementation);
  const final = revised.replace('<!-- /autoplan-accepted:ceo -->',
    '- Synthetic accepted full-review follow-up: retain the earlier spec fix.\n<!-- /autoplan-accepted:ceo -->');
  f.record(final);
  amendImplementation('ceo', f.active, voices.snapshotPath);
  expect(checkPhaseImplementation('ceo', f.active, voices.snapshotPath, 'changed').recordedObligations.none).toBe(false);
  expect(extractImplementationPlan(readFileSync(f.active, 'utf8'))).toContain(final);
});

test('no-change or a draft record does not invent an accepted amendment', () => {
  const f = fixture(), step0 = f.create();
  f.record('<!-- autoplan-accepted:ceo -->\nNone: existing requirements cover this phase.\n<!-- /autoplan-accepted:ceo -->');
  amendImplementation('ceo', f.active, step0.snapshotPath);
  expect(checkPhaseImplementation('ceo', f.active, step0.snapshotPath, 'unchanged').recordedObligations.none).toBe(true);
  expect(f.create().sha256).toBe(captured.originalImplementationSha256);
  f.record(captured.acceptedCeoBlock);
  expect(() => checkPhaseImplementation('ceo', f.active, step0.snapshotPath, 'changed')).toThrow();
  expect(f.create().sha256).toBe(captured.originalImplementationSha256);
});

test('captured file summaries and real tool progress cannot replace missing parent messages', () => {
  expect(captured.observedOutcome).toBe('timeout');
  const transcript = { status: 'ready' as const, calls: [], assistantMessages: captured.assistantMessages };
  expect(autoplanPhaseCompletions(transcript, Date.parse('2026-09-15T12:29:00Z'))).toEqual([]);
  // Explicitly synthetic message; it proves only CEO, never the other three phases.
  const message = { sessionId: captured.assistantMessages[0]!.sessionId,
    timestamp: '2026-09-15T13:24:30Z', text: 'Phase 1 complete.' };
  expect(autoplanPhaseCompletions({ ...transcript, assistantMessages: [...transcript.assistantMessages, message] }, 0))
    .toEqual([{ phase: 1, ts: Date.parse(message.timestamp) }]);
  for (const text of ['# Phase 1 complete.', '> Phase 1 complete.', '```\nPhase 1 complete.\n```', 'I will send Phase 1 complete. later.']) {
    expect(autoplanPhaseCompletions({ ...transcript, assistantMessages: [{ ...message, text }] }, 0)).toEqual([]);
  }
});

test('compaction restores the exact dispatch field from the existing immutable manifest', () => {
  const f = fixture(), snapshot = f.create();
  const restored = JSON.parse(readFileSync(join(dirname(snapshot.snapshotPath), 'snapshot.json'), 'utf8'));
  expect(restored.nativeDispatchPrompt).toBe(snapshot.nativeDispatchPrompt);
  expect(loadAutoplanMethodologyBinding(restored.nativeDispatchPrompt, [f.root]).phase).toBe('ceo');
  expect(restored.nativeDispatchPrompt).not.toContain(captured.originalImplementation);
  expect(createHash('sha256').update(readFileSync(snapshot.nativePromptPath)).digest('hex')).toBe(snapshot.nativePromptSha256);
  // The exact captured DX prefix is insufficient by design; the inline body is not a dispatch.
  expect(auditAutoplanMethodReads([{ sessionId: 'captured-parent', timestamp: captured.dxDispatch.timestamp,
    toolUseId: captured.dxDispatch.toolUseId, kind: 'use', name: 'Agent', input: { prompt: captured.dxDispatch.promptPrefix } }],
  () => { throw new Error('An inline body must not select a methodology binding'); })).toEqual([]);
  expect(() => loadAutoplanMethodologyBinding(snapshot.nativePrompt, [f.root])).toThrow();
  expect(() => loadAutoplanMethodologyBinding(restored.nativeDispatchPrompt.replace('CEO', 'DESIGN'), [f.root])).toThrow();
});

test('the working-plan destination rule leaves conversation messages in the conversation', () => {
  const intake = source('autoplan/SKILL.md.tmpl').split('### Step 1: Capture restore point')[1]!.split('### Step 2:')[0]!;
  expect(intake).not.toContain('Write all amendments/outputs to ACTIVE_PLAN');
  expect(intake).toContain('Save plan amendments and review artifacts to ACTIVE_PLAN');
  expect(intake).toContain('Send phase announcements and the final approval request in the conversation');
});

test('CEO applies Step 0 decisions before each spec dispatch and refreshes the native input afterward', () => {
  const section = source('autoplan/sections/ceo-phase.md.tmpl');
  const preliminary = section.slice(section.indexOf('**At 0H'), section.indexOf('Step 0.5 (Dual Voices)'));
  expect(preliminary).toContain('`snapshotPath` as `<CEO_STEP0_CHECKPOINT>`');
  expect(preliminary).toContain('Before every spec dispatch, including after each accepted spec fix');
  expect(preliminary).toContain('amend-input ceo "<ACTIVE_PLAN>" "<CEO_STEP0_CHECKPOINT>" "<RESTORE_PATH>" "<methodologyPath>"');
  expect(preliminary).toContain('use returned `reviewInputPath` as `<CEO_SPEC_INPUT>`');
  expect(preliminary).toContain('returned `readRanges` offset/limit through EOF');
  expect(preliminary).toContain('Supply the complete CEO scope summary and `<CEO_SPEC_INPUT>`');
  expect(preliminary).toContain('three-launch cap');
  expect(preliminary).toContain('User Challenges retain the original requirements');
  expect(section).toContain('create a fresh snapshot below for both voices');
});

test('compaction recovery separates saved artifacts, sent messages and pending reviewer state', () => {
  const contract = source('autoplan/SKILL.md.tmpl').split('## Sequential Execution')[1]!.split('---')[0]!;
  expect(contract).toContain('reconcile saved artifacts and sent conversation messages separately');
  expect(contract).toContain("verified phase lacks its announcement, resume the close procedure at step 6 (Publish) before advancing");
  expect(contract).toContain('regenerate and reread the full packet if the implementation or accepted decisions changed');
  expect(contract).toContain('If its reviewer is pending, wait for that same reviewer');
  expect(contract).toContain('Read `snapshot.json` beside that final `<PHASE_INPUT>`');
  expect(contract).toContain('use its `nativeDispatchPrompt` unchanged');
});

test('a same-phase draft checkpoint cannot substitute for the post-Step-0 voice input', () => {
  const f = fixture(), draft = f.create();
  f.record(captured.acceptedCeoBlock);
  amendImplementation('ceo', f.active, draft.snapshotPath);
  const final = f.create();
  // Both are valid immutable CEO manifests. Phase identity alone cannot choose the final input.
  expect(loadAutoplanMethodologyBinding(draft.nativeDispatchPrompt, [f.root]).phase).toBe('ceo');
  expect(loadAutoplanMethodologyBinding(final.nativeDispatchPrompt, [f.root]).phase).toBe('ceo');
  expect(draft.sha256).toBe(captured.originalImplementationSha256);
  expect(final.sha256).not.toBe(draft.sha256);
  const contract = source('autoplan/SKILL.md.tmpl').split('## Sequential Execution')[1]!.split('---')[0]!;
  expect(contract).toContain('finish any incomplete preliminary work before recovering a voice input');
  expect(contract).toContain('Never dispatch `<CEO_STEP0_CHECKPOINT>`');
  expect(contract).toContain('If the final voice input does not exist, create it after the preliminary gates');
});

test('taste overrides follow the existing affected-phase and final Eng rerun rule', () => {
  const skill = source('autoplan/SKILL.md.tmpl');
  const override = skill.split('- B:')[1]!.split('- B2:')[0]!;
  expect(override).toContain("follow D's affected-phase rerun rule (including Eng last)");
  expect(override).toContain('before re-presenting the gate');
  expect(override).toContain('same 3-cycle cap as D');
  expect(skill).toContain('a re-run of any earlier phase re-runs Eng after it');
  expect(skill).toContain('scope→1, design→2, dx→2.5, test plan→3, arch→3');
  expect(skill).not.toContain('scope→1B');
});


test('captured parent text and a following tool can share a response without ending the turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'gstack-autoplan-continuation-')); owned.push(root);
  const project = join(root, 'projects', 'fixture'); mkdirSync(project, { recursive: true });
  const [textEnvelope, toolEnvelope] = captured.nativeContinuation.records;
  expect(textEnvelope!.message.id).toBe(toolEnvelope!.message.id);
  expect(textEnvelope!.message.stop_reason).toBe('tool_use');
  expect(toolEnvelope!.message.stop_reason).toBe('tool_use');
  const file = join(project, `${textEnvelope!.sessionId}.jsonl`);
  const read = (rows: unknown[]) => {
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const tools: NativePublicToolEvent[] = [];
    const transcript = readPlanCountTranscript(root, root, event => tools.push(event));
    return { transcript, tools, hits: autoplanPhaseCompletions(transcript, 0) };
  };
  const start = Date.parse(textEnvelope!.timestamp);
  // Explicit synthetic phase text/input inside the captured public response envelope.
  // The actual original text made no completion claim and retains zero credit.
  const originals = captured.nativeContinuation.records.map(row => ({ ...row, cwd: root,
    message: { ...row.message, content: row.message.content.map(block => block.type === 'tool_use'
      ? { ...block, input: { command: 'true' } } : block) } }));
  expect(read(originals).hits).toEqual([]);
  const phases = [1, 2, 2.5, 3];
  const rows = phases.flatMap((phase, index) => {
    const id = `msg_synthetic_phase_${String(phase).replace('.', '_')}`;
    return [
      { ...textEnvelope, cwd: root, timestamp: new Date(start + index * 10).toISOString(),
        message: { ...textEnvelope!.message, id, content: [{ type: 'text', text: `Phase ${phase} complete.` }] } },
      { ...toolEnvelope, cwd: root, timestamp: new Date(start + index * 10 + 1).toISOString(),
        message: { ...toolEnvelope!.message, id, content: [{ type: 'tool_use', id: `next_${phase}`,
          name: 'Read', input: { file_path: join(root, 'next-phase.md') } }] } },
    ];
  });
  const result = read(rows);
  expect(result.hits.map(hit => hit.phase)).toEqual(phases);
  expect(result.tools).toHaveLength(4);
  expect(result.hits.every((hit, index) => hit.ts < Date.parse(result.tools[index]!.timestamp))).toBe(true);
  expect(readPlanSkillCompletion(root, textEnvelope!.sessionId, 'Phase 3 complete.')).toBeNull();
  // Tool arguments, tool results and sidechain text are not parent announcements.
  expect(read([{ ...rows[1], message: { ...rows[1]!.message, content: [{ type: 'tool_use', id: 'source',
    name: 'Bash', input: { command: 'echo "Phase 1 complete."' } }] } }]).hits).toEqual([]);
  expect(read([{ ...rows[0], type: 'user', message: { role: 'user', content: [{ type: 'tool_result',
    tool_use_id: 'source', content: 'Phase 1 complete.' }] } }]).hits).toEqual([]);
  expect(read([{ ...rows[0], isSidechain: true }]).hits).toEqual([]);
  expect(read([{ ...rows[0], message: { ...rows[0]!.message,
    content: [{ type: 'text', text: 'Phase 2 skipped — no UI scope.' }] } }]).hits).toEqual([]);
});

test('phase progress text permits immediate tool continuation in the same turn', () => {
  const contract = source('autoplan/SKILL.md.tmpl').split('## Sequential Execution')[1]!.split('---')[0]!;
  expect(contract.replace(/\s+/g, ' ')).toContain("load its `phase-close` section afresh");
  expect(contract).toContain('in the same turn');
  expect(contract).not.toContain('This parent response contains no tool calls');
  const shared = source('autoplan/sections/phase-close.md.tmpl').replace(/\s+/g, ' ');
  const operations = ["3. **Prepare this phase's close packet.**", '4. **Read the complete current packet.**',
    '5. **Verify the current implementation.**', '6. **Publish the parent report.**', '7. **Return to the driver.**'];
  const positions = operations.map(operation => shared.indexOf(operation));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(shared).toContain('SEND the filled report below now as visible parent assistant text');
  expect(shared).toContain('This message is the next operation before any next-phase tool call');
  expect(shared).toContain('After sending the actual parent report, continue to the driver in the same turn');
  expect(shared).toContain("The sent conversation message is step 6's output");
  expect(shared).not.toContain('The packet owns the close continuation');
  expect(shared).not.toContain('This message contains no tool calls');
  for (const phase of ['ceo', 'design', 'dx', 'eng']) {
    const close = source(`autoplan/sections/${phase}-phase.md.tmpl`).split('**Close this phase:**')[1]!;
    expect(close).toContain('{{SECTION:phase-close}}');
    expect(close.trim().endsWith('{{SECTION:phase-close}}')).toBe(true);
    expect(close).not.toContain('**Phase ');
  }
});

test('the captured cf74 full readback did not publish a CEO report before the Design Read', () => {
  // Public projection from chain-ceo-close/receipt.json (0b1ede1e…0e9de0),
  // source cf74db538a2f4c4361f2573316abb91e01663564. The complete retained
  // parent window contains no assistant text between this Read ACK and Design.
  const lastParentMessage = {
    sessionId: '647c542b-5f7a-45d7-b1d9-8e2d984eab17',
    timestamp: '2026-09-16T01:27:36.112Z',
    text: 'Tasks JSONL written (13 rows). Now the phase-close procedure for CEO.',
  };
  const readbackAck = { toolUseId: 'toolu_01SpARevKkyf9P9MqwN8w9Ms',
    timestamp: '2026-09-16T01:27:53.896Z', startLine: 1, numLines: 109, totalLines: 109 };
  const nextPhaseUse = { toolUseId: 'toolu_01XvX1QbuKqv1xWjpdHsFLnj',
    timestamp: '2026-09-16T01:28:04.501Z', name: 'Read',
    input: { file_path: '/home/vercel-sandbox/gstack/autoplan/sections/design-phase.md' } };
  const boundary = Date.parse(nextPhaseUse.timestamp);
  expect(Date.parse(readbackAck.timestamp)).toBeLessThan(boundary);
  expect(readbackAck.numLines).toBe(readbackAck.totalLines);
  const observe = (messages: typeof lastParentMessage[], through = boundary) =>
    autoplanPhaseCompletions({ status: 'ready', calls: [],
      assistantMessages: messages.filter(message => Date.parse(message.timestamp) <= through) },
    Date.parse(lastParentMessage.timestamp));
  expect(observe([lastParentMessage])).toEqual([]);

  // Synthetic controls exercise the unchanged public observer's timestamps.
  // A later announcement remains later; it cannot populate the earlier boundary.
  const report = { ...lastParentMessage, timestamp: new Date(boundary - 1).toISOString(),
    text: '**Phase 1 complete.**\nCodex: disabled. Claude subagent: completed: 9 issues.\n'
      + 'Consensus: N/A (voice coverage missing).\nPassing to Phase 2 (Design Review).' };
  expect(observe([lastParentMessage, report])).toEqual([{ phase: 1, ts: boundary - 1 }]);
  const late = { ...report, timestamp: new Date(boundary + 1).toISOString() };
  expect(observe([lastParentMessage, late])).toEqual([]);
  expect(observe([lastParentMessage, late], boundary + 1)).toEqual([{ phase: 1, ts: boundary + 1 }]);
  for (const text of [`\`\`\`text\n${report.text}\n\`\`\``, 'I will send the CEO completion report after Design.']) {
    expect(observe([lastParentMessage, { ...report, text }])).toEqual([]);
  }
});

// Minimal exact public projection of the two f359 CEO close failures. Packet
// hashes/complete ranges were authenticated against each original Read result;
// only this parent-message boundary is replayed here, not semantic compliance.
test.each([
  { attempt: 'uREF54', sessionId: '94599121-1626-4188-a553-e68579eeb329',
    lastAt: '2026-09-16T07:37:49.858Z',
    lastText: 'One stale phrase in R1: "production p95 ≤ 300ms over each 48h cohort hold" contradicts row 40 (hold = max(48h, power-based minimum)). Fixing both copies, then regenerating the packet.',
    readId: 'toolu_01AEEg5eZxFJdurZgdDQsUs3', readAt: '2026-09-16T07:38:07.954Z', lines: 137,
    packetSha256: '6e1349a485c2d21bb62588df2730439f5dfffbcc5faaf6f9dc500178dbb3fe1d',
    designId: 'toolu_01VCEDJEdVHpqX3d6VuLBMrx', designAt: '2026-09-16T07:38:18.984Z' },
  { attempt: 'RhTXQ5', sessionId: '45abf2fa-0d62-471f-9efa-9a0d5b2ec1b5',
    lastAt: '2026-09-16T08:26:23.970Z',
    lastText: 'Task JSONL written (11 lines). Now reading `phase-close.md` afresh to close Phase 1.',
    readId: 'toolu_01AnPNRCY2c9Lg6nvSMpdYsp', readAt: '2026-09-16T08:26:42.105Z', lines: 138,
    packetSha256: '0de1420a316b222df62b5454bcea6d812b4e5040d873a225bfe89840c5a1652f',
    designId: 'toolu_0116k1GsR8JxowqSYBJtJbpi', designAt: '2026-09-16T08:26:52.230Z' },
])('captured f359 $attempt complete packet leaves publication pending', evidence => {
  const message = { sessionId: evidence.sessionId, timestamp: evidence.lastAt, text: evidence.lastText };
  const boundary = Date.parse(evidence.designAt);
  const observe = (messages: typeof message[]) => autoplanPhaseCompletions({ status: 'ready', calls: [],
    assistantMessages: messages.filter(row => Date.parse(row.timestamp) <= boundary) }, Date.parse(evidence.lastAt));
  expect(Date.parse(evidence.readAt)).toBeLessThan(boundary);
  expect(observe([message])).toEqual([]);
  // Synthetic publication tests only the missing native operation and its order.
  const report = { ...message, timestamp: new Date(boundary - 1).toISOString(),
    text: '**Phase 1 complete.**\nOutside review: disabled. Native subagent: completed: 9 issues.\n'
      + 'Consensus: N/A (voice coverage missing).\nPassing to Phase 2 (Design Review).' };
  expect(observe([message, report])).toEqual([{phase: 1, ts: boundary - 1}]);
  expect(observe([message, {...report, timestamp: new Date(boundary + 1).toISOString()}])).toEqual([]);
  for (const text of ['```text\n' + report.text + '\n```', '> Phase 1 complete.',
    'Expected output:\n' + report.text, 'I will publish Phase 1 complete after Design.']) {
    expect(observe([message, {...report, text}])).toEqual([]);
  }
});
