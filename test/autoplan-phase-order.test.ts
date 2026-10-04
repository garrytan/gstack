/**
 * /autoplan phase-order pin (free, static).
 *
 * The pipeline order is a deliberate design decision (2026-08-25, user-directed):
 * CEO → Design (if UI scope) → DX (if developer-facing scope) → Eng, ALWAYS LAST.
 * Eng is the required shipping gate — it must review the FINAL amended plan, so
 * every other phase's amendments land before it. The original order buried Eng
 * mid-pipeline (CEO → Design → Eng → DX), which let DX findings land AFTER the
 * gate had signed off — the gate validated a stale plan.
 *
 * These assertions pin the template so a refactor can't silently restore the
 * old order. No paid eval runs the whole chain; the production phase-publication
 * hook enforces the order at runtime (autoplan-publication-guard.test.ts).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'node:os';
import { prepareMethodology, createSnapshot, preparePhaseClose } from '../bin/gstack-autoplan-snapshot';
import { SECTION } from '../scripts/resolvers/sections';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { expectMentions } from './helpers/prompt-structure';

const ROOT = path.join(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const phases = [
  { child: 'ceo', id: '1', next: ['2'] },
  { child: 'design', id: '2', next: ['2.5', '3'] },
  { child: 'dx', id: '2.5', next: ['3'] },
  { child: 'eng', id: '3', next: ['4'] },
];

// Exercise the actual packet's bound report data; the shared close procedure
// owns the separate native-message operation that consumes those fields.
const closePackets = new Map<string, ReturnType<typeof preparePhaseClose> & { text: string }>();
function closePacket(phase: string) {
  if (closePackets.has(phase)) return closePackets.get(phase)!;
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'autoplan-order-'));
  try {
    const active = path.join(dir, 'active.md'), restore = path.join(dir, 'restore.md');
    const original = '## Implementation plan\nKeep the documented behavior.\n## Review record\n';
    fs.writeFileSync(active, original); fs.writeFileSync(restore, original);
    const skill = `plan-${phase === 'dx' ? 'devex' : phase}-review/SKILL.md`;
    const method = prepareMethodology(phase, path.join(ROOT, skill), restore).methodologyPath;
    const checkpoint = createSnapshot(phase, active, restore, method).snapshotPath;
    fs.appendFileSync(active, `<!-- autoplan-accepted:${phase} -->\nNone: current behavior is retained.\n<!-- /autoplan-accepted:${phase} -->\n`);
    const packet = preparePhaseClose(phase, active, checkpoint, restore, method);
    const text = fs.readFileSync(packet.closePacketPath, 'utf8');
    const result = { ...packet, text }; closePackets.set(phase, result); return result;
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

function closeContent(phase: string) { return closePacket(phase).text; }

const flat = (text: string) => text.replace(/\s+/g, ' ');
function ordered(text: string, anchors: string[]) {
  const positions = anchors.map(anchor => text.indexOf(anchor));
  expect(positions.every(position => position >= 0), `missing one of ${JSON.stringify(anchors)}`).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe('autoplan phase order (Eng always last)', () => {
  const tmpl = read('autoplan/SKILL.md.tmpl');

  test('Sequential Execution block names Eng as the terminal phase', () => {
    const block = tmpl.split('## Sequential Execution')[1]?.split('---')[0] ?? '';
    expect(block).toMatch(/CEO → Design.*→ DX.*→ Eng/s);
    // The old order must not resurface anywhere in the template.
    expect(tmpl).not.toContain('CEO → Design → Eng → DX');
  });

  test('phase headings appear in the new order: 1, 2, 2.5, 3', () => {
    ordered(tmpl, ['## Phase 1: CEO Review', '## Phase 2: Design Review', '## Phase 2.5: DX Review', '## Phase 3: Eng Review']);
    // No stale Phase 3.5 heading or transition marker survives.
    expect(tmpl).not.toContain('Phase 3.5');
  });

  test.each(phases)('carved child completion and handoff IDs match the pipeline: %j', ({ child, id, next }) => {
    const section = read(`autoplan/sections/${child}-phase.md.tmpl`);
    const report = closePacket(child).report;
    const announced = [report.number];
    const handoff = report.next;
    expect(section.trim().endsWith('{{SECTION:phase-close}}')).toBe(true);
    const pointer = section.indexOf('{{SECTION:phase-close}}');
    expect(pointer).toBeGreaterThan(section.indexOf('**Close this phase:**'));
    expect(section.slice(pointer).trim()).toBe('{{SECTION:phase-close}}');
    const generated = read(`autoplan/sections/${child}-phase.md`);
    expect(generated).toContain('Read `~/.claude/skills/gstack/autoplan/sections/phase-close.md` and execute it');
    expect(announced).toEqual([id]);
    expect([...handoff.matchAll(/Phase (\d+(?:\.\d+)?)/g)].map(m => m[1])).toEqual(next);
    // Catch obsolete Phase 3.5 references anywhere in any carved child,
    // including prose or prompts that could contradict otherwise-correct headings.
    const known = new Set(['0', '0.5', '1', '2', '2.5', '3', '4']);
    const mentioned = [...section.matchAll(/\bPhase (\d+(?:\.\d+)?)\b/gi)].map(m => m[1]);
    expect(mentioned.filter(id => !known.has(id))).toEqual([]);
  });

  test('each later Codex voice receives only already-completed phase context', () => {
    const dx = read('autoplan/sections/dx-phase.md.tmpl');
    const priorContext = [...dx.matchAll(/^\s*(CEO|Design|Eng|DX): <insert /gm)].map(m => m[1]);
    expect(priorContext).toEqual(['CEO', 'Design']);
    // Eng's Codex voice sees every prior phase's consensus, DX included.
    expect(read('autoplan/sections/eng-phase.md.tmpl')).toContain(
      'DX: <insert DX consensus table summary',
    );
  });

  test('single final gate: premises queue for the gate, never a mid-run stop', () => {
    expect(flat(tmpl)).toMatch(/never auto-decide user challenges/i);
    expectMentions(flat(tmpl), [['never', 'approval', 'mid-run']], 'flat(tmpl)');
    expect(tmpl).not.toContain('Premise gate passed (user confirmed)');
    const ceo = read('autoplan/sections/ceo-phase.md.tmpl');
    expect(ceo).not.toContain('GATE: Present premises to user for confirmation');
    expect(flat(ceo)).toContain('as User Challenges for Phase 4');
    expect(flat(ceo)).toMatch(/never stop mid-pipeline/i);
  });

  test('generated workflow loads each complete skill at its own phase boundary', () => {
    const skill = read('autoplan/SKILL.md');
    const phase0 = skill.slice(skill.indexOf('### Step 3:'), skill.indexOf('## Phase 1:'));
    const setup = flat(phase0.split('**Section skip list')[0]!);
    expect(setup).toMatch(/never prefetch future phases/i);
    // Locating paths at intake does not load or execute their future phases.
    expect(phase0.split('**Section skip list')[0]!).not.toMatch(/^Read `[^`]+\/SKILL\.md` in full now/gm);

    const owners = [
      { id: '1', name: 'ceo', next: '## Phase 2:' },
      { id: '2', name: 'design', next: '## Phase 2.5:' },
      { id: '2.5', name: 'devex', next: '## Phase 3:' },
      { id: '3', name: 'eng', next: '## Decision Audit Trail' },
    ];
    for (const { id, name, next } of owners) {
      const start = skill.indexOf(`## Phase ${id}:`);
      const end = skill.indexOf(next, start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const block = skill.slice(start, end);
      const child = name === 'devex' ? 'dx' : name;
      expect(block).toContain(`/autoplan/sections/${child}-phase.md`);
      // The phase checkpoint binds the installed host's complete methodology.
      // A second runtime-root Read would select another harness's skill.
      expect(block).not.toMatch(/^Read `[^`]+\/SKILL\.md` in full now/gm);
      const phase = read(`autoplan/sections/${child}-phase.md`);
      const load = phase.indexOf('Before dispatch, Read `methodologyPath`');
      expect(load).toBeGreaterThanOrEqual(0);
      expect(phase).toContain(`methodology ${child} "<REVIEW_SKILL>" "<RESTORE_PATH>"`);
      expect(phase).toContain('per `readRanges`');
      expect(load).toBeLessThan(phase.indexOf(`create ${child} `));
      if (id === '2' || id === '2.5') {
        expect(block.indexOf('**Skip condition:**')).toBeLessThan(block.indexOf('> **STOP.**'));
      }
    }
    const gate = skill.indexOf('## Phase 4: Final Approval Gate');
    expect(gate).toBeGreaterThan(-1);
    expect(skill.indexOf('Read `~/.claude/skills/gstack/autoplan/sections/tasks-aggregator.md`'))
      .toBeGreaterThan(gate);
  });
});

describe('autoplan phase execution checkpoints', () => {
  const tmpl = read('autoplan/SKILL.md.tmpl');
  const phases = ['ceo', 'design', 'dx', 'eng'];

  test('loads full review skills at phase entry instead of prefetching future phases', () => {
    const intake = flat(tmpl.split('### Step 3:')[1]?.split('## Phase 0.5:')[0] ?? '');
    expect(intake).toContain('`<REVIEW_SKILL>`');
    expect(intake).toMatch(/never prefetch future phases/i);
    for (const phase of phases) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      expect(section).toMatch(/^Before dispatch, Read \{\{AUTOPLAN_REVIEW_FILE:plan-[a-z-]+:with-sections\}\}/);
      const load = section.split('**Override rules:**')[0]!;
      expect(load).toContain('per `readRanges`');
      expect(load).toMatch(/to EOF/);
      expect(load).toMatch(/skip-listed: load only/i);
      expect(section.indexOf(':with-sections}}')).toBeLessThan(section.indexOf('create ' + phase));
      expect(section).toContain(`create ${phase} "<ACTIVE_PLAN>" "<RESTORE_PATH>" "<methodologyPath>"`);
    }
  });

  for (const phase of phases) {
    test(`${phase} places a blocking native dispatch and its completion wait before outside review`, () => {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const native = section.indexOf(`**{{NATIVE_LABEL}} ${phase === 'design' ? 'design' : phase === 'dx' ? 'DX' : phase === 'ceo' ? 'CEO' : 'eng'} subagent**`);
      const outside = section.indexOf('{{OUTSIDE_INVOCATION:autoplan}}');
      expect(native).toBeGreaterThan(-1);
      expect(native).toBeLessThan(outside);
      const dispatch = section.slice(native, outside);
      const words = flat(dispatch);
      expect(dispatch).toContain('run_in_background: false');
      expect(dispatch).toContain('isAsync: true');
      expect(words).toMatch(/final tool call/i);
      expect(words).toMatch(/end response immediately/i);
      expectMentions(words, [['no', 'calls/review', 'further']], 'words');
      expect(dispatch).toContain('`nativePromptPath` to EOF');
      expect(words).toMatch(/INPUT must match snapshot phase\/hash/i);
      expect(words).toMatch(/retry invalid input once/i);
      expect(words).toMatch(/no inline substitute/i);
      // Provider preflight, timeout and native fallback remain at every call.
      // The invocation states its own outer gate; a second, larger number would contradict it.
      expect(section).not.toContain('Outer tool timeout');
      expect(section).toContain(`{{OUTSIDE_PROVENANCE:${phase}}}`);
      expect(section).toContain(phase === 'ceo' ? 'Outside disabled/unavailable' : 'Missing/disabled');
      expect(section).toContain('N/A');
      expect(section).toMatch(/primary cannot replace/i);
      expect(section).toMatch(/(never|not) CONFIRMED/);
    });
  }

  test('the parent completes only the current phase and cannot waive native work for context pressure', () => {
    const contract = flat(tmpl.split('## Sequential Execution')[1]?.split('---')[0] ?? '');
    expect(contract).toMatch(/keep one phase active/i);
    expectMentions(contract, [['never', 'future-phase', 'reviews']], 'contract');
    ordered(contract, ['Load its phase instructions', 'create the fresh snapshot', 'nativeDispatchPrompt',
      'Consume the native terminal result', 'remaining primary review sections']);
    ordered(contract, ['`phase-close`', 'parent completion message', 'Only after the message has been sent may the driver',
      'after Eng, proceed to final synthesis/approval']);
    expectMentions(contract, [['do not', 'review', 'close']], 'contract');
    expect(contract).toContain('step 6 (Publish)');
    expect(contract).toMatch(/do not prove uptake/i);
    expect(contract).toMatch(/pending is not unavailable/i);
    expectMentions(contract, [['never', 'passes/required', 'sections']], 'contract');
    expectMentions(contract, [['never', 'transcripts', 'agent']], 'contract');
    const rerun = flat(tmpl.split('**Starting an affected-phase rerun:**')[1]!.split('---')[0]!);
    expect(rerun).toMatch(/verbatim/i);
    expect(rerun).toContain('`baselineEdits.record` and `sourceSha256`');
    expect(flat(tmpl)).toContain('`amend-input`');
  });

  test('each phase binds its fixed amendment checkpoint before loading the shared close', () => {
    for (const [phase, number] of [['ceo', '1'], ['design', '2'], ['dx', '2.5'], ['eng', '3']]) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const barrier = section.indexOf('**Close this phase:**');
      const pointer = section.indexOf('{{SECTION:phase-close}}');
      expect(barrier).toBeGreaterThan(-1);
      expect(pointer).toBeGreaterThan(barrier);
      expect(closePacket(phase).report.number).toBe(number);
      expect(section.match(/\{\{SECTION:phase-close\}\}/g)).toHaveLength(1);
      const binding = flat(section.slice(barrier, pointer));
      const checkpoint = phase === 'ceo' ? 'CEO_STEP0_CHECKPOINT' : `${phase.toUpperCase()}_INPUT`;
      expect(binding).toContain(`Use phase \`${phase}\`, checkpoint \`<${checkpoint}>\``);
      expect(binding).toContain('`methodologyPath`');
      expect(binding).toMatch(/afresh/i);
      expectMentions(binding, [['do not', 'exports', 'replace']], 'binding');
      expect(section.slice(pointer).trim()).toBe('{{SECTION:phase-close}}');
    }
  });

  test('the shared close separates complete readback, verification, publication and driver return', () => {
    const template = read('autoplan/sections/phase-close.md.tmpl');
    const close = flat(template);
    const stages = ['1. **Finish and save the review.**', '2. **Reconcile accepted requirements.**',
      "3. **Prepare this phase's close packet.**", '4. **Read the complete current packet.**',
      '5. **Verify the current implementation.**', '6. **Publish the parent report.**', '7. **Return to the driver.**'];
    const positions = stages.map(stage => template.indexOf(stage));
    ordered(template, stages);
    expect(close).toMatch(/terminal reviewer results/i);
    expect(close).toMatch(/INPUT to its voice snapshot/i);
    expectMentions(close, [['no', 'unavailable/disabled', 'completion']], 'close');
    expect(close).toMatch(/a `None` record must explain/i);
    expect(template).toContain('prepare-close "<PHASE>" "<ACTIVE_PLAN>" "<AMENDMENT_CHECKPOINT>" "<RESTORE_PATH>" "<methodologyPath>"');
    expect(close).toContain('`readRanges`');
    expect(close).toContain("exact `offset` and `limit`");
    expect(close).toMatch(/through EOF/i);
    expectMentions(close, [['do not', 'advance', 'request']], 'close');
    expect(close).toMatch(/returns to step 3/i);
    const verification = flat(template.slice(positions[4], positions[5]));
    expect(verification).toContain('Recheck step 1');
    expect(verification).toMatch(/keep this phase open/i);
    expect(close).not.toContain('The packet owns the close continuation');
    expect(read('autoplan/sections/phase-close.md')).toContain(template.trim());
  });

  test('native publication precedes driver continuation without a repair bypass or user wait', () => {
    const close = flat(read('autoplan/sections/phase-close.md.tmpl'));
    const publish = close.indexOf('6. **Publish the parent report.**');
    const report = close.indexOf('**Phase <report.number> complete.**');
    const continueAt = close.indexOf('7. **Return to the driver.**');
    expect(publish).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(publish);
    expect(continueAt).toBeGreaterThan(report);
    expectMentions(close.slice(publish, report), [['before', 'next-phase', 'tool']], 'close.slice(publish, report)');
    expect(close.slice(continueAt)).toMatch(/in the same turn/i);
    expectMentions(close.slice(continueAt), [['do not', 'continue', 'reply']], 'close.slice(continueAt)');
    expect(close.slice(continueAt)).toMatch(/a skip is never a completion/i);
    expectMentions(close, [['does not', 'printing', 'through']], 'close');
  });

  test('all four phase formats consume the current packet data in the shared publication step', () => {
    const totals: Record<string, string> = {ceo: '6', design: 'rows in the completed design litmus scorecard', dx: '6', eng: '6'};
    const numbers: Record<string, string> = {ceo: '1', design: '2', dx: '2.5', eng: '3'};
    const publication = read('autoplan/sections/phase-close.md.tmpl').split('6. **Publish the parent report.**')[1]!.split('7. **Return')[0]!;
    expect(publication).toContain('**Phase <report.number> complete.**');
    expect(publication).toContain('Outside review: <completed: N concerns / unavailable / disabled>');
    expect(publication).toContain('Native subagent: <completed: N issues / unavailable>');
    expect(publication).toContain('N/A (voice coverage missing)');
    expect(publication).toContain('X/<report.total> native+outside confirmed');
    expect(publication).toContain('`report.includeDxMetrics`');
    expect(publication).toContain('DX overall: <score>/10. TTHW: <observed> min → <target> min.');
    expect(publication).toContain('`report.next`');
    for (const child of phases) {
      const packet = closePacket(child);
      expect(packet.report.number).toBe(numbers[child]);
      expect(packet.report.total).toBe(totals[child]);
      expect(packet.report.includeDxMetrics).toBe(child === 'dx');
      expect(packet.phaseComplete).toBe(false);
      const continuation = packet.text.split('## Return to the close procedure')[1]!;
      expectMentions(continuation, [['not', 'following', 'completed']], 'continuation');
      expect(continuation).toContain(`**Phase ${numbers[child]} complete.**`);
      expect(continuation).toContain(`Passing to <applicable ${packet.report.next}>.`);
      const caller = read(`autoplan/sections/${child}-phase.md.tmpl`).split('**Close this phase:**')[1]!;
      expect(caller.trim().endsWith('{{SECTION:phase-close}}')).toBe(true);
      expect(caller).not.toContain('**Phase ');
      expect(caller).not.toContain('Passing to ');
    }
  });

  test('Design hands off to conditional DX and DX never requests a future Eng result', () => {
    const design = read('autoplan/sections/design-phase.md.tmpl');
    const dx = read('autoplan/sections/dx-phase.md.tmpl');
    expect(design).not.toContain('> Passing to Phase 3.');
    expect(dx).toContain("Design: <insert Design consensus summary, or 'skipped, no UI scope'>");
    expect(dx).not.toContain('Eng: <insert Eng consensus summary>');
  });
});


describe('autoplan current implementation-plan identity', () => {
  test('pins the assigned active plan and keeps accepted amendments separate from review analyses', () => {
    const intake = flat(read('autoplan/SKILL.md.tmpl').split('## Phase 0: Intake')[1]?.split('### Step 2:')[0] ?? '');
    expect(intake).toContain('ACTIVE_PLAN (harness-assigned plan, else SOURCE_PLAN)');
    expect(intake).toMatch(/save plan amendments and review artifacts to ACTIVE_PLAN/i);
    expectMentions(intake, [['approval', 'conversation', 'request']], 'intake');
    expect(intake).toMatch(/init backs up SOURCE_PLAN exactly/i);
    expect(intake).toContain('init "<SOURCE_PLAN>" "<ACTIVE_PLAN>" "<RESTORE_PATH>"');
    expect(intake).toMatch(/on helper errors, stop/i);
    expect(intake).toContain('`## Review record`');
    // Binding belongs to the lazy execution site, not a stale intake variable.
    expect(intake).not.toContain('Bind `<review_plan_path>`');
  });

  test('DX scope consumes the deterministic full-input result and permits only enabling overrides', () => {
    const intake = flat(read('autoplan/SKILL.md.tmpl').split('### Step 2: Read context')[1]?.split('### Step 3:')[0] ?? '');
    expect(intake).toContain('scope "<ACTIVE_PLAN>"');
    expect(intake).toContain('`dxRequired`');
    expect(intake).toMatch(/threshold is 2\+ term matches/);
    expect(intake).toContain('`--developer-tool` or `--agent-primary`');
    expectMentions(intake, [['no', 'positive', 'context']], 'intake');
  });

  test('every native and outside call site binds the fresh snapshot, retaining requested outside consensus', () => {
    for (const phase of ['ceo', 'design', 'dx', 'eng']) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const bind = section.indexOf("**Bind phase input:**");
      const native = section.indexOf('subagent**');
      const outside = section.indexOf('{{OUTSIDE_INVOCATION:autoplan}}');
      expect(bind).toBeGreaterThan(-1);
      expect(bind).toBeLessThan(native);
      expect(native).toBeLessThan(outside);
      const preparation = section.slice(bind, native);
      expect(preparation).toContain(`create ${phase} "<ACTIVE_PLAN>" "<RESTORE_PATH>"`);
      expect(preparation).toContain('`snapshotPath` as `<' + phase.toUpperCase() + '_INPUT>`');
      expect(preparation).toContain('`Review record`');
      expect(flat(section)).toMatch(/send its `nativeDispatchPrompt` verbatim/i);
      expect(section).toContain('Read `snapshot.json` beside `<' + phase.toUpperCase() + '_INPUT>`');
      expect(section).toContain('Reads `nativePromptPath` to EOF');
      expect(section).toContain(`Outside prompt: inline the full contents of <${phase.toUpperCase()}_INPUT>`);
      const checkpoint = phase === 'ceo' ? 'CEO_STEP0_CHECKPOINT' : `${phase.toUpperCase()}_INPUT`;
      expect(section).toContain(`Use phase \`${phase}\`, checkpoint \`<${checkpoint}>\``);
      expect(section).toContain('{{SECTION:phase-close}}');
      expect(section).not.toContain('<review_plan_path>');
      expect(section).not.toContain('<plan_path>');
      expectMentions(section, [['no', 'summaries', 'reviews']], 'section');
    }
    expect(read('autoplan/sections/phase-close.md.tmpl')).toContain('prepare-close "<PHASE>" "<ACTIVE_PLAN>" "<AMENDMENT_CHECKPOINT>"');
    expect(read('autoplan/sections/eng-phase.md.tmpl')).toContain('DX: <insert DX consensus table summary');
  });
});


describe('phase-close control ownership across installed hosts', () => {
  test.each(ALL_HOST_CONFIGS)('$name loads or inlines the same numbered close procedure', host => {
    const ctx = {host: host.name, paths: HOST_PATHS[host.name], skillName: 'autoplan', tmplPath: ''} as TemplateContext;
    const rendered = SECTION(ctx, ['phase-close']);
    const template = read('autoplan/sections/phase-close.md.tmpl').trimEnd();
    if (host.name === 'claude') {
      expect(rendered).toContain(`${ctx.paths.skillRoot}/autoplan/sections/phase-close.md`);
      expect(rendered).toContain('and execute it');
    } else {
      expect(rendered).toBe(template);
      ordered(rendered, ['4. **Read the complete current packet.**', '5. **Verify the current implementation.**',
        '6. **Publish the parent report.**', '7. **Return to the driver.**']);
      expect(rendered).toMatch(/in the same turn/i);
      expectMentions(rendered, [['do not', 'continue', 'reply']], 'rendered');
      expect(rendered).not.toContain('The packet owns the close continuation');
    }
  });
});
