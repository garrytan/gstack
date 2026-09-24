/**
 * plan-ceo-review carve — static ordering guard (GATE tier, free, deterministic).
 *
 * This is the per-PR mechanical backstop for the v2-plan Phase B carve of
 * plan-ceo-review (Codex outside-voice P2). The periodic real-PTY E2E
 * (skill-e2e-plan-ceo-review-section-loading.test.ts) is the behavioral proof,
 * but it runs weekly and costs money. This file runs on every `bun test` and
 * fails CI the moment the carve's structural invariants break:
 *
 *  1. The skeleton points at the section with a STOP-Read directive, and that
 *     directive sits AFTER Step 0 (scope + mode) — so the conversational Step 0
 *     stays in the always-loaded skeleton, never stranded in the on-demand file.
 *  2. The heavy review body (Sections 1-11) is NOT in the skeleton — it moved to
 *     the section. A regression that inlines it back would re-bloat the skeleton.
 *  3. The review report writer ("GSTACK REVIEW REPORT") lives in the section, and
 *     the blocking EXIT PLAN MODE GATE that verifies it lives in the skeleton
 *     AFTER the STOP — so the gate fires once the section work returns.
 *  4. Nothing review-governing sits in the skeleton below the STOP (Codex P1):
 *     no "Section N", no "## Mode Quick Reference", no "## Formatting Rules".
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { validateCeoReviewCompletion } from './helpers/auq-sdk-capture';
import { generateAntiShortcutClause, generateSpecReviewLoop, generatePlanFileReviewReport, generatePlanReviewApprovalCheck, generateExitPlanModeGate, generateCodexPlanReview } from '../scripts/resolvers/review';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateTasksSectionEmit } from '../scripts/resolvers/tasks-section';
import { generateBrainCacheRefresh } from '../scripts/resolvers/gbrain';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const SKELETON = path.join(ROOT, 'plan-ceo-review', 'SKILL.md');
const SECTION = path.join(ROOT, 'plan-ceo-review', 'sections', 'review-sections.md');

// Prose wrapping is not the contract; keep raw documents for line/heading guards.
const compactProse = (value: string) => value.replace(/\s+/g, ' ').trim();

// The actual cb3 quality attempts both found the same execution ambiguities.
// These are source-order guards; the selected judge remains the clarity proof.
test('CEO decision cycle returns to its caller with two complete persistence checkpoints', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const cycle = compactProse(source.split('### 0D.')[1]!.split('### 0E.')[0]!);
  const stages = ['**2. Record the pending choice.**', 'Commitment | Source/approval or pending | Current | A | B | C',
    '**Pre-question checkpoint:**', '**STOP for the actual answer, even for a lone option.**',
    'Save the answer reference and scope in Exact approval and scope', '**Post-answer checkpoint:**'];
  const positions = stages.map(stage => cycle.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(cycle.match(/\*\*(?:Pre-question|Post-answer) checkpoint:\*\*/g)).toHaveLength(2);
  expect(cycle).toContain('Start at step 1. Reuse exact prior approvals');
  expect(cycle).toContain('run steps 2–4 only when a new answer is needed, even for one option');
  expect(cycle).toContain('0D never restarts mode selection');
  expect(cycle).toContain('Return to the calling step with the saved answer; do not ask it again');
  expect(cycle).not.toContain('Save pending rows before comparing options');
  expect(cycle).toContain('complete current plan, pending rows and comparisons');
});

test('CEO mode provenance separates an explicit instruction from asked and automatic question logs', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const mode = source.split('### 0E.')[1]!.split('### 0F.')[0]!;
  const rows = mode.split('\n').filter(line => /^- \*\*(Explicit user choice|Successful preference check|Actual question answer):\*\*/.test(line));
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain('no question log because none was asked');
  expect(rows[1]).toContain('`auto_decided: true`');
  expect(rows[2]).toContain('`auto_decided: false`');
  expect(mode.indexOf('**Explicit user choice:**')).toBeGreaterThan(mode.indexOf('4. **Mode handoff:**'));
});

test('CEO scope destinations preserve deferrals without asking their already answered TODO again', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const scope = compactProse(source.split('### 0G.')[1]!.split('### 0H.')[0]!);
  expect(scope).toContain('**Defer:**');
  expect(scope).toContain('**Skip / Cut:**');
  expect(scope).toContain('TODOS.md with context and NOT in scope with the deferral reason');
  expect(scope).toContain('NOT in scope with the rejection reason; no TODO');
  expect(section).toContain('Only unanswered TODO proposals reach this menu');
  expect(compactProse(section)).toContain('Do not ask again about an item already deferred, skipped or kept');
  const readiness = compactProse(generatePlanReviewApprovalCheck({ skillName: 'plan-ceo-review' } as TemplateContext));
  expect(readiness).toContain('An approved delivery-scope deferral is settled');
  expect(readiness).toContain('Deferring a needed policy or remedy decision leaves that choice unresolved');
  expect(readiness).toContain('Keep declined, deferred and unanswered changes out of accepted work');
});

test('CEO completion facts precede summary and report while publication follows readback', () => {
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const stages = ['{{PLAN_REVIEW_APPROVAL_CHECK}}', '### Review facts', '### Completion Summary',
    '{{PLAN_FILE_REVIEW_REPORT}}', '**Publish the Completion Summary:**', '## Review Log'];
  const positions = stages.map(stage => section.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(compactProse(section)).toContain('Derive facts from the approved ledger and completed sections');
  expect(compactProse(section)).toContain('Stage 3 publishes it after report verification');
});

// These three source scenarios guard instruction branches, not native execution.
test('CEO handoff allows no pending choice without inventing an approval', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const initial = compactProse(source.split('### 0C.')[1]!.split('### 0D.')[0]!);
  const approach = compactProse(source.split('### 0D.')[1]!.split('### 0E.')[0]!);
  const handoff = source.split('**Mode handoff:**')[1]!.split('### 0F.')[0]!;
  const noChoice = approach.indexOf('With no new answer needed');
  expect(noChoice).toBeGreaterThan(0);
  expect(noChoice).toBeLessThan(approach.indexOf('**2. Record the pending choice.**'));
  expect(initial).toContain('Before 0E, call 0D for unresolved approaches');
  expect(initial).toContain('With no required choice, or after those choices settle, go to 0E');
  expect(initial).toContain('A) current/requested plan, B) smallest scoped alternative, C) larger approach/rewrite only with evidence');
  expect(approach).toContain('invent no alternatives or approval');
  expect(handoff).toContain('No new approach decision was needed');
  expect(compactProse(handoff)).toContain('Preserve 0D approvals');
  expect(handoff).toContain('<rows or none>');
});

test('CEO handoff carries all answered rows instead of one synthetic approach', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const handoff = source.split('**Mode handoff:**')[1]!.split('### 0F.')[0]!;
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  expect(handoff).toContain('every governing approved row\'s ID, answer reference and accepted scope');
  expect(handoff).toContain('Keep rows separate');
  expect(handoff).toContain('Auto-decided review mode → <selected mode> (your preference)');
  expect(handoff).toContain('Mode: <selected mode>; approved decisions: <rows or none>');
  expect(handoff).not.toContain('<approved 0D approach>');
  expect(section).toContain('Step 0E mode-handoff format and the current ledger dispositions');
  expect(section).toContain('including actual later scope-answer references');
  expect(section).toContain('do not ask or log the mode again');
});

// Guards the missing public handoff instruction, not model compliance or posture detection.
test('CEO mode handoff applies the selected mode before the next question', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const selection = source.split('### 0E. Mode Selection')[1]!.split('### 0F.')[0]!;
  const handoffStart = selection.indexOf('**Mode handoff:**');
  const routeStart = selection.indexOf("Follow the selected mode's route:");
  expect(handoffStart).toBeGreaterThan(0);
  expect(routeStart).toBeGreaterThan(handoffStart);
  const handoff = selection.slice(handoffStart, routeStart);
  const instruction = handoff.split('\n')[0]!;
  expect(instruction).toMatch(/before tools or further questions/i);
  expect(instruction).toMatch(/chat.*mode.s application and rationale/i);
  expect(selection).toContain('4. **Mode handoff:**');
  expect(selection).toContain('An explicit choice skips steps 2–3');
  expect(instruction).toContain('After selection');
  expect(instruction).toContain('send brief chat before tools');
  const selectionSteps = compactProse(selection.slice(0, handoffStart));
  expect(selectionSteps).toContain('A check that exits 0 with `AUTO_DECIDE` selects the recommendation');
  expect(selectionSteps).toContain('**STOP for the answer**');
  expect(selectionSteps).not.toMatch(/\blog (?:with|that ID)\b/);
  const loggingStart = handoff.indexOf('Record mode provenance after the handoff');
  expect(loggingStart).toBeGreaterThan(handoff.indexOf('- Other selections:'));
  expect(loggingStart).toBeLessThan(handoff.indexOf('Selecting a mode does not approve changes'));
  const logging = compactProse(handoff.slice(loggingStart));
  expect(logging).toContain('**Explicit user choice:**');
  expect(logging).toContain('no question log because none was asked');
  expect(logging).toContain('`plan-ceo-review-mode`, `auto_decided: true`');
  expect(logging).toContain('`auto_decided: false`, including the question ID only when `QUESTION_TUNING: true`');
  const formats = handoff.split('\n').filter(line => /^- (`plan-ceo-review-mode:|Other selections:)/.test(line));
  expect(formats).toHaveLength(2);
  for (const format of formats) {
    expect(format).toContain('<Application and rationale>');
    expect(format).toContain('<rows or none>');
  }
});

test('SELECTIVE baseline cuts preserve prior answers until their own scope decision', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const modeWork = source.split('### 0G.')[1]!.split('### 0H.')[0]!;
  expect(modeWork).toContain('Run all three HOLD SCOPE checks below, including their defer/keep decisions');
  const holdChecks = modeWork.split('**For HOLD SCOPE**')[1]!.split('**For SCOPE REDUCTION**')[0]!;
  expect([...holdChecks.matchAll(/^\d+\. /gm)]).toHaveLength(3);
  const cuts = compactProse(modeWork.split('**Deferring current scope**')[1]!);
  expect(cuts).toContain('REDUCTION, HOLD and SELECTIVE\'s HOLD checks');
  expect(cuts).toContain('**A)** Defer this item to TODOS.md **B)** Keep it in scope');
  expect(cuts).toContain("Run all four 0D steps for each unanswered addition or deferral");
  expect(compactProse(source)).toContain('Selecting a mode does not approve changes');
  const answer = cuts.indexOf('wait for the answer');
  const apply = cuts.indexOf('A deferral changes only delivery scope');
  expect(answer).toBeGreaterThan(0);
  expect(apply).toBeGreaterThan(answer);
  expect(cuts).toContain('record its answer/reason beside the prior approval');
  expect(holdChecks).toContain('more than 8 files or more than 2 new classes/services');
  expect(cuts).toContain('Keep other approvals and limits unchanged');
});

// These check the storage branches and their order, not model compliance.
test('CEO defines pending choices and storage before its first decision procedure', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const step0 = compactProse(source.split('## Step 0:')[1]!);
  const policy = step0.indexOf('**Storage policy: choose before writing.**');
  const choice = step0.indexOf('Resolve a choice only');
  const firstDecision = step0.indexOf('### 0D.');
  expect(policy).toBeGreaterThan(0);
  expect(choice).toBeGreaterThan(0);
  expect(policy).toBeLessThan(firstDecision);
  expect(choice).toBeLessThan(firstDecision);
  const compare = compactProse(step0.split('**3. Compare and save')[1]!.split('**4. Ask, record')[0]!);
  expect(compare).toContain('Under the storage policy, save/present the complete current plan, pending rows and comparisons');
  // Native c6fc D3 saved and asked Effort 0: matching copies did not validate the domain.
  expect(compare).toContain('For an option with no implementation, use effort S');
  expect(compare).toContain('state zero implementation work');
  expect(compare).toContain('never effort 0');
  // cdd D3 cited a missing ledger row; a completed comparison did not create it.
  const rowCheck = compare.indexOf('Find exactly one row by its assigned ID');
  expect(rowCheck).toBeGreaterThan(compare.indexOf('**Pre-question checkpoint:**'));
  expect(compare).toContain('Repair missing/duplicate rows in step 2');
  expect(compare).toContain('Effort/risk must each be one listed value, never a range');
  expect(compare).toContain('After the latest successful Write/Edit, Read the ledger row and full payload through the last');
  expect(compare).toContain('Copy the grid and all exact fields');
  expect(compare).toContain('S/M/L/XL effort, low/medium/high risk');
  expect(compare).toContain('Validate every field above');
  const validate = compare.indexOf('Effort/risk must each be one listed value');
  const repair = compare.indexOf('Correct missing or invalid fields and host-limit violations before saving');
  const readback = compare.indexOf('**Read-back.**');
  expect(validate).toBeGreaterThan(compare.indexOf('**Pre-question checkpoint:**'));
  expect(validate).toBeGreaterThan(rowCheck);
  expect(repair).toBeGreaterThan(validate);
  expect(readback).toBeGreaterThan(repair);
  expect(step0).toContain('Use native Write for a missing file and scoped Edit for checkpoints');
  expect(step0).toContain('retain all current content, ledger rows and comparisons');
  const persistence = step0.split('### 0H.')[1]!.split('### 0I.')[0]!;
  const persistenceStages = ['**Save or present both inputs under the storage policy.**',
    'mkdir -p', '**Otherwise:**', '**CEO summary format — use for both saved and chat output:**',
    '# CEO Plan: {Feature Name}', '{{SPEC_REVIEW_LOOP}}'].map(stage => persistence.indexOf(stage));
  expect(persistenceStages.every(position => position >= 0)).toBe(true);
  expect(persistenceStages).toEqual([...persistenceStages].sort((a, b) => a - b));
  expect(persistence).not.toContain('Save a chat-only plan');
});

test('CEO chat storage still supplies both spec inputs and the full report without claiming file completion', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext;
    const spec = generateSpecReviewLoop(ctx);
    const report = generatePlanFileReviewReport(ctx);
    const gate = generateExitPlanModeGate(ctx);
    expect(spec).toContain('both complete labeled texts');
    expect(spec).toContain('all five dimensions');
    expect(spec).toContain('Make at most three reviewer launches');
    expect(spec).toContain('If launch or review fails, times out, or cannot review both complete inputs');
    expect(spec).toContain('a successful reviewer result is not required');
    expect(compactProse(spec)).toContain('Reviewer failure therefore continues here; required storage failure stops here');
    expect(spec).not.toContain('quality bonus, not a gate');
    expect(report.indexOf('### Generate the report')).toBeLessThan(report.indexOf('### Write to the plan file'));
    expect(report).not.toContain('If no file is in scope, skip this section');
    expect(report).toContain('not persisted');
    expect(report).toContain("Follow Stage 3's blocked chat return; no completed-review log or handoff");
    expect(report).toContain('**Read-back gate:**');
    expect(compactProse(report)).toContain('If the destination file exists, Read it now, whether or not step 2 deleted a report');
    expect(report).toContain('Use Edit with the suffix from this Read, or Write the complete file');
    expect(report).toContain('If the destination file does not exist, use Write to create the complete file');
    expect(report).toContain('In both cases, keep the report last and continue to the Read-back gate');
    expect(report).not.toContain('retry once');
    const tasks = generateTasksSectionEmit(ctx, ['ceo-review']);
    expect(tasks).toContain('write when permitted, including zero tasks');
    expect(tasks).not.toContain('always write');
    expect(compactProse(tasks)).toContain('Strategy-only tasks name the next research, design or verification action and its owner');
    expect(tasks).toContain('they do not choose implementation contracts');
    expect(compactProse(tasks)).toContain('For unknown files, write "to be determined" and use an empty JSONL files array');
    const outside = generateCodexPlanReview(ctx);
    if (outside) expect(outside).toContain('Include the CEO scope summary when available for this mode');
    expect(gate).toContain('Do not call ExitPlanMode until all checks pass');
    expect(gate.indexOf('Missing plan/report saves')).toBeGreaterThan(0);
    expect(gate.indexOf('Missing plan/report saves')).toBeLessThan(gate.indexOf('1. Read the plan file'));
    expect(compactProse(gate)).toContain('For forbidden history, confirm no write was attempted');
    expect(compactProse(gate)).toContain('Best-effort history does not; show unsaved fields and errors');
    expect(gate).toContain('**Gate outcome: Blocked**');
  }
});

// The original 660 judge found competing routes. These guards verify the
// instruction branches and ordering; only the selected judge proves clarity.
test('CEO routes administrative menus separately while scope and TODO retain the full decision protocol', () => {
  const main = compactProse(fs.readFileSync(`${SKELETON}.tmpl`, 'utf8'));
  const decisions = main.slice(main.indexOf('### 0D.'), main.indexOf('### 0E.'));
  const mechanics = decisions.split('- **Admin question:**')[1]!.split('- **Plan decision:**')[0]!;
  const substantive = decisions.split('- **Plan decision:**')[1]!.split('If an admin answer requests')[0]!;
  expect(mechanics).toContain("Use its listed menu and the preamble question transport");
  expect(mechanics).toContain('wait and record the answer');
  expect(mechanics).toContain('document approval or promotion');
  expect(mechanics).toContain('Skip steps 1–4; this approves no plan changes');
  expect(substantive).toContain('Start at step 1');
  expect(substantive).toContain('review-depth expansion');
  const procedure = decisions.slice(decisions.indexOf('**1. Check sources'));
  for (const gate of ['ledger row', 'comparison', 'For chat, verify the complete text labeled **not persisted**', 'Read-back', 'one native arguments object', 'actual answer']) expect(procedure).toContain(gate);
  expect(decisions).toContain("Use its listed menu and the preamble question transport");
  expect(decisions).toContain('If an admin answer requests a plan change, use the Plan decision route for that change');
  expect(decisions).toContain('Include one column per option (add D for a four-option menu)');
  expect(decisions).toContain('For different kinds of work');
  expect(decisions).not.toContain('For every question');
  expect(main).toContain('Run all four 0D steps for each unanswered addition or deferral, using its menu');
  const section = compactProse(fs.readFileSync(`${SECTION}.tmpl`, 'utf8'));
  expect(section).toContain('Resolve each remaining proposal through all four steps of 0D, using the menu below');
  expect(section).toContain('**A)** Add to TODOS.md **B)** Skip — not valuable enough **C)** Keep in the current plan as required work');
  expect(main).toContain('**A)** Add to this plan\'s scope **B)** Defer to TODOS.md **C)** Skip');
  expect(main).toContain('Reuse answered scope decisions without another question or comparison');
});

test('CEO output stages prepare body before report and publish only after verification with a blocked chat return', () => {
  const section = compactProse(fs.readFileSync(`${SECTION}.tmpl`, 'utf8'));
  const stages = ['### Stage 1 — Prepare', '### Review facts', '### Completion Summary',
    '### Stage 2 — Save and verify', '{{PLAN_FILE_REVIEW_REPORT}}', '### Stage 3 — Publish', '## Review Log'];
  const positions = stages.map(stage => section.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(section).toContain('Keep them before the terminal report');
  expect(section).toContain('no stage depends on a completion log written later');
  expect(section).toContain('After the report Read-back gate passes');
  expect(section).toContain('Do not append it after the report in the file');
  const chat = section.slice(section.indexOf('If no plan/report write is permitted'), section.indexOf('## Handoff Note Cleanup'));
  expect(chat).toContain('complete plan, report and summary as not persisted, then use **Gate outcome: Blocked**');
  expect(chat).toContain('without claiming saved completion');
  expect(chat).toContain('skip Review Log, success telemetry and the next-skill handoff');
  const main = compactProse(fs.readFileSync(`${SKELETON}.tmpl`, 'utf8'));
  const blocked = main.slice(main.indexOf('- **Blocked:**'), main.indexOf('- **Passed with'));
  expect(blocked).toContain('complete plan, report and summary');
  expect(blocked).toContain('Label only unwritten artifacts **not persisted**');
  expect(blocked).toContain('missing logs do not unsave a verified report');
  expect(main).toContain('verified report plus forbidden metadata or failed best-effort history can pass');
  expect(main).toContain('Failed required writes still block');
  expect(blocked).toContain('**completion blocked**');
  expect(blocked).toContain('without success telemetry, ExitPlanMode or the queued handoff');
  const gate = compactProse(generateExitPlanModeGate({ skillName: 'plan-ceo-review' } as TemplateContext));
  const precheck = gate.slice(0, gate.indexOf('Verify `Approval readiness: PASS`'));
  expect(precheck).toContain('Missing plan/report saves and failed permitted 0H metrics block completion');
  expect(precheck).toContain('Best-effort history does not');
  expect(precheck).toContain('show unsaved fields and errors');
  // Optional task/archive/TODO restrictions cannot block verified required artifacts.
  expect(precheck).not.toMatch(/Forbidden storage|(?:task|archive|TODO).*forbidden/);
});

test('CEO prior unresolved count remains a final report bullet for prior-only and mixed unresolved cases', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext;
    const report = compactProse(generatePlanFileReviewReport(ctx));
    const status = report.slice(report.indexOf('**Unresolved-decisions status'), report.indexOf('### Write to the plan file'));
    expect(status).toContain('excluding the current skill so it is not counted twice');
    expect(status).toContain('If both counts are zero');
    expect(status).toContain('exact unbolded line `NO UNRESOLVED DECISIONS`');
    expect(status).toContain('one bullet per current open item');
    expect(status).toContain('a final bullet `- + N unresolved from prior reviews`, even if there are no current items');
    expect(status).toContain('last bullet is the final non-whitespace line');
    expect(status).toContain('append no separate count line or trailing prose');
  }
});

test('CEO saves compared proposals before recording an actual answer in its separate field', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const procedure = compactProse(source.split('### 0D.')[1]!.split('### 0E. Mode Selection')[0]!);
  const compare = procedure.indexOf('**3. Compare and save');
  const save = procedure.indexOf("In Proposed, compare every commitment");
  const ask = procedure.indexOf('**4. Ask, record');
  const actualAnswer = procedure.indexOf('Save the answer reference and scope in Exact approval and scope');
  const amend = procedure.indexOf('update Status and amend only authorized work');
  expect(0 <= compare && compare < save && save < ask && ask < actualAnswer && actualAnswer < amend).toBe(true);
  expect(procedure.slice(compare, ask)).toContain('Under the storage policy, save/present the complete current plan, pending rows and comparisons');
  expect(compactProse(procedure.slice(compare, ask))).toContain('Show unchanged, shared and pending values');
  expect(procedure).toContain('A failed save stops the review');
  expect(procedure.slice(0, compare)).toContain('Record pending rows before comparisons; never prewrite approval or tasks');
  expect(procedure.slice(ask)).toContain('storage policy before taking another row');
});

// A topic row alone did not expose the independently selectable test additions.
// This guards the executable representation/order, not the model's compliance.
test('CEO value comparisons and decline-all outcomes stay explicit before approval', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const procedure = compactProse(source.split('### 0D.')[1]!.split('### 0E.')[0]!);
  const pendingSave = procedure.indexOf('Record pending rows before comparisons;');
  const values = procedure.indexOf('Commitment | Source/approval or pending | Current | A | B | C');
  expect(values).toBeGreaterThan(-1);
  const comparedSave = procedure.indexOf('Under the storage policy, save/present the complete current plan, pending rows and comparisons');
  const ask = procedure.indexOf('**4. Ask, record');
  expect(pendingSave >= 0 && pendingSave < values && values < comparedSave && comparedSave < ask).toBe(true);
  const comparison = procedure.slice(values, ask);
  expect(compactProse(comparison)).toContain('Show unchanged, shared and pending values');
  expect(compactProse(comparison)).toContain('Changes remain separate decisions even if they use the same framework');
  expect(comparison).toContain('Keep other rows fixed or pending');
  expect(compactProse(comparison)).toContain('preserve requirements, tests and fixes');
  expect(procedure).toContain('If all options are declined, continue only with a viable current approach retained by the answer');
  expect(procedure).toContain('otherwise leave the row unresolved and stop for direction');
});

// The paid paired-control skipped its provisional ledger and treated two
// contracts as one test strategy. Guard drafting before menu synthesis on each
// host; this is an instruction-order check, not proof of native compliance.
test('CEO Step 0 drafts provisional contracts before menus and saves their complete comparison on every host', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-pending-rows-'));
  try {
    const generated = await runGeneration({ host: 'all', outputRoot, contentLinkRoot: null, log: () => {} });
    expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
    const carriers = generated.artifacts.filter(artifact => artifact.kind === 'skill'
      && (artifact.relativePath === 'plan-ceo-review/SKILL.md'
        || artifact.relativePath.endsWith('/gstack-plan-ceo-review/SKILL.md')));
    expect(carriers).toHaveLength(ALL_HOST_CONFIGS.length);
    for (const file of [`${SKELETON}.tmpl`, ...carriers.map(carrier => path.join(outputRoot, carrier.relativePath))]) {
      const source = fs.readFileSync(file, 'utf8');
      const approach = compactProse(source.split('### 0D.')[1]?.split('### 0E. Mode Selection')[0] ?? '');
      const positions = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
        'Record owner, behavior, limits, test method and coverage in Current/Proposed', 'Record pending rows before comparisons;',
        "**3. Compare and save that row's options.**", '**Pre-question checkpoint:**',
        '**4. Ask, record the answer, and amend.**',
        'Ask one row per call with that object unchanged, without recomposing'].map(stage => approach.indexOf(stage));
      expect(positions.every(position => position >= 0), file).toBe(true);
      expect(positions, file).toEqual([...positions].sort((a, b) => a - b));
      expect(source).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
      expect(source.indexOf('| ID and owner |')).toBeLessThan(source.indexOf('**2. Record the pending choice.**'));
      expect(approach).toContain('behavior, limits, test method and coverage');
      expect(approach).toContain('other rows fixed or pending');
      expect(approach).toContain('independent changes separate ledger rows');
      expect(approach.indexOf('Record owner, behavior, limits, test method and coverage in Current/Proposed')).toBeLessThan(approach.indexOf('Build one `currentDecision`'));
      expect(compactProse(approach)).toContain('Changes remain separate decisions even if they use the same framework');
      expect(approach).toContain('A failed save stops the review');
      expect(approach).toContain('Record pending rows before comparisons; never prewrite approval or tasks');
      expect(approach).toContain('never prewrite approval or tasks');
      expect(approach).toContain('Save the answer reference and scope in Exact approval and scope');
      expect(source.indexOf('### 0D.')).toBeLessThan(source.indexOf('### 0E. Mode Selection'));
    }
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }); }
}, 30_000);

// A saved topic row did not prevent the captured paired menu from combining
// separately proposed coverage. Main review also asked about a draft-created
// recovery promise before reconciling it with the original contract.
// These guards enforce instruction order, not model compliance or judge results.
test('CEO decision units and factual reconciliation precede menu synthesis', () => {
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const alternatives = compactProse(skeleton.split('### 0D.')[1]?.split('### 0E.')[0] ?? '');
  const stages = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
    'Record pending rows before comparisons;',
    "**3. Compare and save that row's options.**", '**Pre-question checkpoint:**',
    '**4. Ask, record the answer, and amend.**'];
  const positions = stages.map(stage => alternatives.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  const analyze = compactProse(section.split('**Analyze.**')[1]?.split('**Resolve.**')[0] ?? '');
  expect(analyze).toContain('Correct false claims');
  expect(section.indexOf('### Outside Voice Integration Rule')).toBeLessThan(section.indexOf('{{CODEX_PLAN_REVIEW}}'));
});

test('CEO outside findings reuse authority-first decisions without turning unknown facts into policies', () => {
  const section = fs.readFileSync(SECTION, 'utf8');
  const findingsStart = section.indexOf('**Integrate reviewer findings:**');
  const comparisonStart = section.indexOf('**Cross-model tension:**', findingsStart);
  expect(findingsStart).toBeGreaterThan(0);
  expect(comparisonStart).toBeGreaterThan(findingsStart);
  const tension = section.slice(findingsStart, comparisonStart);
  // The outside branch delegates to the original procedure, instead of defining
  // another four-stage approval loop with potentially different prerequisites.
  expect(tension).toContain('same six-column ledger. Use 0D for new or reopened choices');
  expect(tension).toContain('including both saves and the actual answer');
  expect(tension).toContain('do not start a second procedure');
  expect(tension).not.toContain('reference | commitment | current value');
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const procedure = compactProse(skeleton.split('### 0D.')[1]!.split('### 0E.')[0]!);
  const stages = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
    'Record pending rows before comparisons;', "**3. Compare and save that row's options.**",
    '**Pre-question checkpoint:**', '**4. Ask, record the answer, and amend.**']
    .map(stage => procedure.indexOf(stage));
  expect(stages.every(position => position >= 0)).toBe(true);
  expect(stages).toEqual([...stages].sort((a, b) => a - b));
  expect(tension).toContain('Correct false premises without changing accepted behavior');
  expect(tension).toContain('Keep uncertainty with its owner and required verification');
  expect(tension).toContain('identify the causal mechanism and surface the decision or blocking verification now');
  expect(tension).toContain('A credible material risk can require action before confirmation');
  expect(tension).toContain('merely imagining another behavior is not evidence of a defect');
  expect(tension).toContain('factual corrections and confirmations need no behavior-change menu');
  expect(tension).toContain('Preserve the requested mode and its authorized scope exploration');
  expect(tension).toContain('A) Apply this change; B) Keep');
  expect(tension).toContain('A) Include; B) Defer; C) Cut; D) Hold');
  expect(tension).toContain('Revising two candidates takes two rows');
  expect(tension).toContain("check the assembled set's capacity and dependencies");
  expect(tension).toContain('Never silently trim or replace another candidate');
  expect(procedure).toContain('Record pending rows before comparisons; never prewrite approval or tasks');
  expect(skeleton).toContain('Stop with the cause; chat cannot replace a failed save');
  expect(compactProse(skeleton)).toContain('Honor user/host artifact and cleanup limits');
  expect(procedure).toContain('Under the storage policy, save/present the complete current plan, pending rows and comparisons');
  expect(compactProse(procedure)).toContain('Ask one row per call with that object unchanged, without recomposing');
  expect(procedure).toContain('Save the answer reference and scope in Exact approval and scope');
  expect(compactProse(procedure)).toContain('amend only authorized work');
  expect(tension).toContain('investigation and deferral do not authorize implementation');
  expect(tension).toContain('challenges wait for the final gate');
  expect(tension).toContain('One answer does not resolve other pending rows');
  expect(tension).toContain('including findings that needed only factual correction');
});

// Guard the complete result routes on every host. This verifies instructions,
// not the quality judge's clarity score or an agent's execution of the workflow.
test('CEO integrates completed native findings before its external-only comparison', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext;
    const review = compactProse(generateCodexPlanReview(ctx));
    expect(review.match(/\*\*Outcome routing:\*\*/g)).toHaveLength(1);
    expect(review).toContain('Enter only when **Outcome routing** selects fallback; do not restart the outside invocation after its failure');
    expect(review).not.toContain('Use this exact route:');
    const stages = ['After a completed external review, go directly', '**Native fallback — provider unavailable or execution failed, with reviews enabled:**',
      '**Bounded outside-voice wait', '**Unavailable path:**', '**Integrate reviewer findings:**',
      '**Cross-model tension:**', '**Persist the result:**'].map(stage => review.indexOf(stage));
    expect(stages.every(position => position >= 0), host.name).toBe(true);
    expect(stages, host.name).toEqual([...stages].sort((a, b) => a - b));
    const [externalStart, nativeStart, boundedStart, unavailableStart, findingsStart, comparisonStart, persistStart] = stages;
    expect(review.slice(externalStart, nativeStart)).toContain('go directly to **Integrate reviewer findings**');
    const bounded = review.slice(boundedStart, unavailableStart);
    expect(bounded).toContain('header, then continue to **Integrate reviewer findings**');
    expect(bounded).toContain('If any check fails or the report cannot be identified, follow step 4');
    expect(bounded).not.toContain('continue to Cross-model tension');
    const unavailable = review.slice(unavailableStart, findingsStart);
    expect(unavailable).toContain('Skip Integrate reviewer findings and Cross-model tension');
    expect(unavailable).toContain('STATUS = "unavailable", SOURCE = "none", OUTSIDE_STATUS = "unavailable"');
    const findings = review.slice(findingsStart, comparisonStart);
    expect(findings).toContain('Enter after either an external reviewer or the bounded native fallback completed with a valid report');
    expect(findings).toContain('Apply Outside Voice Integration Rule to every finding from that report');
    expect(findings).toContain('Native fallback findings count as findings from the current harness, but never as outside coverage');
    expect(findings).toContain('Disabled or unavailable reviews skip this block');
    expect(findings).toContain('Use 0D for new or reopened choices, including both saves and the actual answer');
    const comparison = review.slice(comparisonStart, persistStart);
    expect(comparison).toContain('compare reviews only if an external reviewer completed');
    expect(comparison).toContain('For a same-harness/native fallback, skip this comparison and go to **Persist the result**');
    expect(comparison).toContain('do not write a CROSS-MODEL line');
    expect(comparison).toContain('unknown model identity stays unknown');
    const report = compactProse(generatePlanFileReviewReport(ctx));
    expect(report).toContain('**CROSS-MODEL:** only when native and completed external reviews exist');
    expect(report).toContain("For **Outside Review**, use this run's completed reviewer output and finding dispositions");
    expect(report).toContain('N findings; R resolved; U unresolved');
    expect(report).toContain('With no findings, write "0 findings — completed review"');
    expect(report).toContain('Label native fallback findings as native and keep external coverage unavailable');
    expect(report).toContain('For disabled or unavailable attempts, write the actual reason and "no completed external review"; never imply zero findings');
    expect(report).toContain('If prior history lacks counts, say "finding count not recorded"');
    expect(report).toContain("Preserve each attempt's provider and outcome in OUTSIDE COVERAGE");
  }
});

test('CEO expansion preparation feeds one pending list into the scope decisions', () => {
  const source = compactProse(fs.readFileSync(`${SKELETON}.tmpl`, 'utf8'));
  const framing = source.split('### 0F.')[1]!.split('### 0G.')[0]!;
  const decisions = source.split('### 0G.')[1]!.split('### 0H.')[0]!;
  expect(framing).toContain('Prepare pending candidates for 0G');
  expect(framing).toContain('user experience, concrete addition, S/M/L/XL effort, risk and impact');
  expect(framing).toContain('The user decides each proposal in 0G');
  expect(framing).toContain('balance benefits and tradeoffs without unsupported promises in SELECTIVE EXPANSION');
  expect(framing).toContain('this label does not approve scope');
  expect(decisions).toContain("extend 0F's pending list with this analysis");
  expect(decisions).toContain('then resolve each proposal individually');
  expect(decisions).toContain('For both expansion modes, ask separately for each addition');
});

// Repeated public quality feedback identified these missing execution instructions.
// This guard checks the source contract; native clarity still requires paid evidence.
test('CEO Step 0 defines the decision record, execution order, and mode approval precedence', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const step0 = compactProse(source.split('## Step 0:')[1]?.split('### 0F.')[0] ?? '');
  const startup = ['Choose the review depth and artifact destinations, then open the ledger below',
    'Record 0A–0C evidence; call 0D only for a required approach choice',
    'Select the mode in 0E and follow its route table',
    'Complete Review Sections and its closing sequence; return to Section self-check']
    .map(step => step0.indexOf(step));
  expect(startup.every(position => position >= 0)).toBe(true);
  expect(startup).toEqual([...startup].sort((a, b) => a - b));
  expect(step0).toContain('0D is reusable, not an unconditional question');
  expect(step0).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
  expect(step0).toContain('Keep one decision ledger through Step 0, Spec Review Loop and Outside Voice');
  expect(compactProse(step0)).toContain('cite evidence, conventions and tests; mark unknowns');
  expect(step0).toContain('Count all deliverables, including reused code');
  expect(step0).toContain('reuse, verification coverage');
  expect(step0).toContain('Give independent changes separate ledger rows');
  expect(step0).toContain('Observations do not approve changes');
  expect(step0).toContain('Follow the preamble\'s session rules');
  expect(step0).toContain('An explicit choice skips steps 2–3');
  expect(step0).toContain('For >15 planned changed files, recommend SCOPE REDUCTION');
  expect(step0).toContain('a new product/system (greenfield) → SCOPE EXPANSION');
  expect(step0).toContain('When tuning is false, omit the lookup');
  expect(step0).toContain('When `QUESTION_TUNING: true`, first check `question_id=plan-ceo-review-mode` through the preamble');
  expect(step0).toContain('A check that exits 0 with `AUTO_DECIDE` selects the recommendation');
  expect(step0).toContain('Without that successful check, offer all four modes in one AskUserQuestion');
  expect(step0).toContain('**STOP for the answer**');
  expect(step0).toContain('Selecting a mode does not approve changes');
  expect(step0).toContain('unresolved, approved, reopened, deferred or declined');
  expect(step0).toContain('Recommend without selecting');
  expect(step0).toContain("the user's choice wins");
  expect(step0.indexOf("Follow the preamble's session rules")).toBeLessThan(step0.indexOf('An explicit choice skips steps 2–3'));
  const reduction = compactProse(source.split('**For SCOPE REDUCTION:**')[1]?.split('### 0H.')[0] ?? '');
  expect(reduction).toContain('ask separately per item');
  expect(reduction).toContain('**A)** Defer this item to TODOS.md **B)** Keep it in scope');
  expect(reduction).not.toContain('Remove it without a follow-up');
  expect(reduction).not.toContain('Accepted items govern');
  expect(source).toContain('For both expansion modes, ask separately for each addition');
  expect(source).toContain('Accepted items govern the remaining sections');
  expect(source).toContain('**Skip / Cut:** NOT in scope with the rejection reason; no TODO');
  expect(source).toContain('**Defer:** TODOS.md with context');
  expect(source).toContain('Reuse answered scope decisions without another question or comparison');
  expect(source).toContain("REDUCTION, HOLD and SELECTIVE's HOLD checks");
  expect(compactProse(source)).toContain('present both inputs for final scope-document approval');
});

// Verify the source contract reaches the actual evaluated generated carrier;
// the live AUQ gate still proves model compliance with this instruction.
test('CEO mode recommendation explains a plan-specific consequence without changing routing', () => {
  for (const file of [`${SKELETON}.tmpl`, SKELETON]) {
    const source = fs.readFileSync(file, 'utf8');
    const mode = source.split('### 0E. Mode Selection')[1]!.split('### 0F.')[0]!;
    const recommendation = compactProse(mode.split('2. Recommend without selecting.')[1]!.split('3. Resolve that recommendation.')[0]!);
    expect(recommendation).toContain("In the Recommendation's `because` clause, connect a concrete plan fact or constraint");
    expect(recommendation).toContain("this mode's actual benefit or tradeoff");
    expect(recommendation).toContain('Count/category alone is not a reason');
    expect(recommendation).toContain('For >15 planned changed files, recommend SCOPE REDUCTION');
    expect(recommendation).toContain('a new product/system (greenfield) → SCOPE EXPANSION');
    expect(recommendation).toContain('added capability → SELECTIVE EXPANSION');
    expect(recommendation).toContain('fix/refactor → HOLD SCOPE');
    expect(recommendation).toContain('explain why and recommend HOLD SCOPE');
    expect(mode).toContain("using step 2's recommendation");
    expect(mode).toContain('**STOP for the answer**');
  }
});

// Boundary checks stay on source templates: generated carriers remain the
// integration owner's responsibility, and these do not prove model behavior.
describe('CEO review decision boundaries contract', () => {
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const alternatives = compactProse(skeleton.split('### 0D.')[1]?.split('### 0F.')[0] ?? '');
  const initial = compactProse(skeleton.split('### 0C.')[1]!.split('### 0D.')[0]!);
  const temporal = skeleton.split('### 0I.')[1]?.split('### 0E.')[0] ?? '';
  const continuity = compactProse(section.split('### Working review decisions')[1]!.split('### Section 1:')[0]!);
  const analyze = compactProse(continuity.split('**Analyze.**')[1]!.split('**Resolve.**')[0]!);
  const apply = compactProse(continuity.split('**Apply.**')[1]!);

  test('every approach comparison preserves approvals and separates independent changes', () => {
    expect(compactProse(alternatives)).toContain('preserve requirements, tests and fixes');
    expect(alternatives).toContain('behavior, limits, test method and coverage');
    expect(skeleton).toContain('Set review depth');
    const depth = compactProse(skeleton.split("**Set review depth from the user's request.**")[1]!.split('Plain terms:')[0]!);
    expect(depth).toContain('To expand strategy-only into implementation design, use 0D');
    expect(depth).toContain('**A)** Keep this review strategy-only **B)** Add implementation design for the named capability');
    expect(depth).toContain('Recommend A unless a concrete blocker requires B');
    expect(depth).toContain('wait for the answer');
    expect(depth).toContain('B permits design detail for that capability only');
    expect(compactProse(section)).toContain("Use Step 0's depth-expansion decision before designing endpoint, method or state-machine contracts beyond that depth");
    const outputs = compactProse(section.split('## Required Outputs')[1]!);
    expect(outputs).toContain('For implementation-ready work, list every method that can fail');
    expect(outputs).toContain('For strategy-only work, use capability rows with failure mechanisms');
    expect(outputs).toContain('an owner who must verify each unknown before implementation');
    expect(outputs).toContain('mark unknown rescue/test coverage as unknown and name the verification owner');
    expect(outputs).toContain('Count capability rows in the Completion Summary');
    expect(outputs).not.toContain('___ methods');
    expect(alternatives).toContain('preserve unknowns');
    expect(alternatives).toContain('Give independent changes separate ledger rows');
    expect(alternatives).toContain("Approved change with open test method/coverage | Decide once");
    expect(alternatives).toContain('every option preserves required behavior and approved tests');
    expect(compactProse(section)).toContain('complete 0D through its post-answer save, then continue to Apply below');
    expect(compactProse(section)).toContain("following 0D's test table");
    expect(alternatives).toContain('Code change and required regressions | Keep together; carry both forward once approved');
    expect(alternatives).toContain('Separate independently selectable additions. Tests for undecided behavior stay pending');
    expect(alternatives).toContain('Tests for existing behavior | Separate independently selectable additions');
    expect(alternatives).toContain('Tests for undecided behavior stay pending');
    expect(alternatives).toContain('other rows fixed or pending');
    expect(alternatives).toContain('reuse, verification coverage');
    expect(alternatives).not.toContain('for architecture choices');
    expect(alternatives.indexOf('Record owner, behavior, limits, test method and coverage in Current/Proposed')).toBeLessThan(alternatives.indexOf('Build one `currentDecision`'));
    expect(alternatives).toContain('explain necessary coupling');
    expect(compactProse(alternatives)).toContain('Reuse exact approvals');
    expect(alternatives).toContain("Code change and required regressions | Keep together; carry both forward once approved");
    expect(alternatives).toContain('Tests for existing behavior | Separate independently selectable additions');
    expect(compactProse(skeleton)).toContain("Cite actual instructions/answers and exact scope");
    expect(alternatives).toContain('Weigh diff size and long-term architecture equally');
    expect(compactProse(alternatives)).toContain('including rewrites');
    expect(initial).toContain('Before 0E, call 0D for unresolved approaches');
    expect(initial).toContain('With no required choice, or after those choices settle, go to 0E');
  });

  test('settled approach authority resolves the gate while new choices still require approval', () => {
    const approach = compactProse(alternatives.split('### 0E. Mode Selection')[0]!);
    const reuse = approach.split('**2. Record the pending choice.**')[0]!;
    const gate = approach.split('**STOP for the actual answer, even for a lone option.**')[1] ?? '';
    expect(compactProse(reuse)).toContain('Compare input, source and answers');
    expect(compactProse(reuse)).toContain('Reuse exact approvals');
    const reopenRule = 'Reuse exact approvals. Reopen only for contradictions, changed assumptions or user instructions, never speculation or reviewer agreement';
    expect(compactProse(skeleton)).toContain(reopenRule);
    expect(compactProse(skeleton).indexOf(reopenRule)).toBeLessThan(compactProse(skeleton).indexOf('**2. Record the pending choice.**'));
    expect(approach).toContain('STOP for the actual answer, even for a lone option');
    expect(initial).toContain('With no required choice, or after those choices settle, go to 0E');
    expect(gate).toContain('Return to the calling step with the saved answer; do not ask it again');
    expect(approach).toContain('0D never restarts mode selection');
    expect(approach).toContain('A recommendation is not approval');
    expect(approach).not.toContain('Do NOT proceed to Step 0D or 0F until the user responds to 0C-bis');
    expect(compactProse(approach)).toContain('Ask one row per call with that object unchanged, without recomposing');
    expect(compactProse(approach)).toContain("Use its listed menu and the preamble question transport");
    expect(compactProse(section)).toContain('resolve it through 0D before amending the plan');
    expect(section).toContain('An "obvious fix" still needs approval when it is not covered by an exact accepted choice');
    expect(compactProse(approach)).toContain("Build one `currentDecision` using these fields and the preamble format");
    const generated = fs.readFileSync(SKELETON, 'utf8');
    expect(generated).toContain('### Tool resolution (read first)');
    expect(generated).toContain('SESSION_KIND: spawned');
    expect(generated).toContain('Auto-decide preferences still apply first');
    expect(gate).toContain('Record findings even after resolution');
    expect(gate).toContain('say "No issues, moving on." only with none');
  });

  test('coverage scoring is conditional and legitimate early decisions retain their exact approval', () => {
    expect(alternatives).toContain('Score this row\'s coverage differences');
    const currentAndProposed = alternatives.indexOf('Record owner, behavior, limits, test method and coverage in Current/Proposed');
    expect(currentAndProposed).toBeGreaterThan(0);
    expect(currentAndProposed).toBeLessThan(alternatives.indexOf('Score this row\'s coverage differences'));
    expect(compactProse(alternatives)).toContain("Build one `currentDecision` using these fields and the preamble format");
    expect(alternatives).toContain('10 = all edge cases');
    expect(alternatives).toContain('Note: options differ in kind, not coverage — no completeness score.');
    // Scoring and recommendation details are reused from the existing preamble.
    const generated = fs.readFileSync(SKELETON, 'utf8');
    expect(generated).toContain('10 = complete, 7 = happy path, 3 = shortcut');
    expect(generated).toContain('Recommendation is ALWAYS present');
    expect(generated).toContain('Note: options differ in kind, not coverage — no completeness score.');
    expect(alternatives).not.toContain('These approaches differ in coverage (minimal viable vs ideal architecture)');
    expect(temporal).toContain('Resolve scope and feasibility blockers through 0D now');
    expect(temporal).toContain('Carry the ledger and each answer\'s exact scope into the review sections');
    expect(compactProse(alternatives)).toContain('Reuse exact approvals. Reopen only for contradictions, changed assumptions or user instructions, never speculation or reviewer agreement');
  });

  test('an unresolved section decision is answered before its scoped plan amendment', () => {
    const steps = [
      '**Resolve.** If this section needs a new decision',
      'Check the saved plan against each answer\'s exact scope',
      'Correct discrepancies under the storage policy',
      'Record findings and dispositions',
    ].map(step => continuity.indexOf(step));
    expect(steps.every(position => position >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(continuity).toContain('complete 0D through its post-answer save, then continue to Apply below');
    expect(fs.readFileSync(`${SKELETON}.tmpl`, 'utf8')).toContain('**STOP for the actual answer, even for a lone option.**');
    expect(compactProse(section)).toContain('Check input, source and actual approvals');
    expect(apply).toContain('against each answer\'s exact scope');
    expect(apply).toContain('Preserve existing content, approved behavior, required implementation, tests and success/failure contracts');
    expect(apply).toContain("Correct discrepancies under the storage policy");
  });

  test('pending labels authorize only unresolved notes, not an outcome or future review conclusions', () => {
    expect(apply).toContain('Leave unapproved remedies and extra verification pending');
    expect(apply).toContain('do not put them into tasks or prescribe them in diagrams');
    expect(apply).toContain('Correct discrepancies under the storage policy');
    expect(apply).toContain('if a correction needs approval, resolve it through 0D before repeating this check');
    expect(compactProse(section)).toContain('record unknown risks with their owners and required verification');
    expect(apply).toContain('Do not write its conclusions or tasks before reviewing it');
    expect(apply).toContain('an approval is not proof of implementation or verification');
    expect(apply).toContain('Keep unresolved choices in the ledger and report');
  });
});

// These are source-contract checks, not model-behavior evidence. Read the
// template and resolve its shared clause directly so an old generated carrier
// cannot conceal conflicting per-section instructions during implementation.
describe('CEO review decision continuity contract', () => {
  const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const clauses = ALL_HOST_CONFIGS.map(host => generateAntiShortcutClause({
    skillName: 'plan-ceo-review', host: host.name,
  } as TemplateContext));
  const continuity = compactProse(template.split('### Working review decisions')[1]?.split('### Section 1:')[0] ?? '');

  test('analysis, decision, and approved amendment precede advancing to the next section', () => {
    expect(continuity).not.toBe('');
    const positions = ['**Analyze.**', '**Resolve.**', '**Apply.**'].map(step => continuity.indexOf(step));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(continuity).toContain("Correct discrepancies under the storage policy");
    for (const clause of clauses) {
      expect(clause).toContain('Analyze → resolve → apply');
      expect(clause).toContain('Do not prewrite the remaining sections');
      expect(clause).toContain('Proposed findings are not accepted plan changes');
      expect(clause).toContain('full review and terminal report');
    }
  });

  test('all eleven section gates preserve decisions without manufacturing a question per section', () => {
    const sections = [...template.matchAll(/^### Section (\d+):([^]*?)(?=^### Section \d+:|^## Closing sequence)/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    // One governing checkpoint supplies the same actual-answer rule to all
    // eleven callers; settled findings do not manufacture another question.
    expect(continuity).toContain("At each section's **Decision gate**, follow Analyze → Resolve → Apply below");
    expect(continuity).toContain('complete 0D through its post-answer save, then continue to Apply below');
    expect(compactProse(compactProse(fs.readFileSync(`${SKELETON}.tmpl`, 'utf8')))).toContain('Ask one row per call with that object unchanged, without recomposing');
    expect(continuity).toContain('If all choices are settled, cite their exact answers and go straight to Apply');
    expect(continuity).toContain('Record findings and dispositions, then review the next section');
    expect(compactProse(template)).toContain('say "No issues found" only when there are zero findings');
    expect(continuity).toContain('Check the saved plan against each answer\'s exact scope');
    expect(continuity).toContain('Review only; do not change code');
    expect(template.indexOf('### Working review decisions')).toBeLessThan(template.indexOf('### Section 1:'));
    for (const [, number, body] of sections) {
      expect(body, `Section ${number}`).toContain('**Decision gate.** Complete Analyze → Resolve → Apply above for this section before continuing.');
      expect(body.match(/\*\*Decision gate\.\*\*/g), `Section ${number}`).toHaveLength(1);
    }
    expect(template).not.toContain('If the section has findings, you MUST call AskUserQuestion');
    expect(template).not.toContain('Otherwise, use AskUserQuestion for each finding');
    expect(template).not.toContain('After each section, pause and wait for feedback');
    expect(template).toContain('Evaluate Sections 1–10 in full for every plan');
    expect(compactProse(template)).toContain('Run Section 11 if accepted work adds or changes UI screens, components, user interactions, frontend frameworks, user-visible states, mobile/responsive behavior or the design system. Otherwise record `SKIPPED (no UI scope)`');
    expect(template).toContain('### Completion Summary');
    expect(template).toContain('{{PLAN_FILE_REVIEW_REPORT}}');
  });

  test('the ledger carries exact approvals and declared contracts without claiming implementation', () => {
    const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
    const start = skeleton.indexOf('Keep one decision ledger');
    expect(start).toBeGreaterThan(skeleton.indexOf('## Step 0:'));
    expect(start).toBeLessThan(skeleton.indexOf('### 0D.'));
    const earlyLedger = skeleton.slice(start, skeleton.indexOf('### 0A.'));
    expect(compactProse(earlyLedger)).toContain('cite evidence, conventions and tests; mark unknowns');
    const sources = compactProse(skeleton.split('**1. Check sources and prior answers.**')[1]!.split('**2. Record the pending choice.**')[0]!);
    expect(compactProse(sources)).toContain('Reuse exact approvals. Reopen only for contradictions, changed assumptions or user instructions, never speculation or reviewer agreement');
    expect(compactProse(sources)).toContain('never speculation or reviewer agreement');
    const limits = skeleton.split('**Keep the stated limits.**')[1]!.split('**Storage policy:')[0]!;
    expect(limits).toContain('Record each measure, value, unit and prerequisite');
    expect(limits).toContain('Changing a limit needs evidence and user approval');
    expect(limits).toContain('Count all deliverables, including reused code');
    const limitRecord = skeleton.indexOf('Record each measure, value, unit and prerequisite');
    const alternatives = skeleton.indexOf('### 0D.');
    expect(limitRecord).toBeGreaterThanOrEqual(0);
    expect(alternatives).toBeGreaterThanOrEqual(0);
    expect(limitRecord).toBeLessThan(alternatives);
    const temporal = skeleton.split('### 0I.')[1]?.split('{{SECTION:review-sections}}')[0] ?? '';
    expect(temporal).toContain('Resolve scope and feasibility blockers through 0D now');
    expect(compactProse(temporal)).toContain('Keep other design choices pending unless the user requested implementation planning');
    expect(compactProse(template)).toContain('Diagrams and maps must show candidate boundaries, failure mechanisms, feasibility conditions and unresolved risks');
    expect(compactProse(template)).toContain('Leave non-blocking implementation choices pending with an owner and required verification');
    expect(compactProse(template)).toContain('Resolve material blockers now; revisit priorities when new evidence changes them');
    expect(compactProse(template)).toContain('completing prioritization does not mean the implementation is ready');
    expect(continuity).toContain('Continue the six-column ledger');
    expect(earlyLedger).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
    expect(compactProse(earlyLedger)).toContain('cite evidence, conventions and tests; mark unknowns');
    expect(compactProse(sources)).toContain('Reuse exact approvals');
    expect(continuity).toContain('complete 0D through its post-answer save, then continue to Apply below');
    for (const requirement of ['with each row\'s owner section',
      'Check the saved plan against each answer\'s exact scope',
      'an approval is not proof of implementation or verification',
      'Preserve contracts and mitigations even if later text omits them',
      'record unknown risks with their owners and required verification']) expect(continuity).toContain(requirement);
    // The continued ledger uses Step 0's existing status schema, not a second table.
    expect(earlyLedger).toContain('unresolved, approved, reopened, deferred or declined');
  });

  test('ownership never defers a critical risk or merges distinct choices by topic', () => {
    const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
    expect(continuity).toContain('If this section needs a new decision or evidence warrants reopening one');
    expect(skeleton).toContain('Give independent changes separate ledger rows');
    expect(compactProse(compactProse(skeleton))).toContain('Changes remain separate decisions even if they use the same framework');
    for (const requirement of ['Resolve critical risks now',
      'complete 0D through its post-answer save, then continue to Apply below',
      'Keep independent safety fixes and throughput improvements in separate rows']) expect(continuity).toContain(requirement);
    const testReview = compactProse(template.split('### Section 6: Test Review')[1]!.split('### Section 7:')[0]!);
    expect(testReview).toContain('Carry requested or approved coverage forward, including directly determined tests, without re-asking');
    expect(testReview).toContain('For an unresolved test-method choice or additional verification scope/depth, name the distinct regression existing tests miss and resolve that choice through 0D before prescribing it');
    expect(testReview).toContain('An approved runtime contract alone does not choose extra verification scope');
    const outside = compactProse(template.split('### Outside Voice Integration Rule')[1]!.split('{{CODEX_PLAN_REVIEW}}')[0]!);
    expect(outside).toContain('Apply Analyze above to each outside finding before adding it to the same ledger');
    expect(outside).toContain('Reviewer agreement is not new evidence or approval');
    expect(outside).toContain('resolve it through 0D before amending the plan');
  });

  test('Design preserves decision gating while DX and fallback retain their existing output on every host', () => {
    // SHA-256 of the e801b515 default resolver output; detects collateral changes.
    const original = '82e55bcd35a16a20d243978707c786f25e24ac5d6a197d9fedb2cb0bb223abb7';
    // Pin DX's e15ba218 output independently: Eng now has its own wording.
    const originalDevex = '29fe85565c2ea16c0d205a06a2515e30228342078a44bb688489274c157ddba2';
    for (const host of ALL_HOST_CONFIGS) {
      const fallback = generateAntiShortcutClause({ skillName: 'review', host: host.name } as TemplateContext);
      expect(createHash('sha256').update(fallback).digest('hex'), `review/${host.name}`).toBe(original);
      const devex = generateAntiShortcutClause({ skillName: 'plan-devex-review', host: host.name } as TemplateContext);
      expect(createHash('sha256').update(devex).digest('hex'), `plan-devex-review/${host.name}`).toBe(originalDevex);
      const design = generateAntiShortcutClause({ skillName: 'plan-design-review', host: host.name } as TemplateContext);
      expect(design).toMatch(/Ask once per independent decision, wait for the actual answer, then apply only its accepted scope/);
      expect(design).toContain('Necessary code, tests and docs for an exact previously selected contract do not reopen it');
      expect(design).toContain('does not approve independent remedies or optional verification depth');
    }
  });
});

test('CEO closing route checks approvals before outputs and verifies artifacts before telemetry without a file bounce', () => {
  const skeleton = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const section = fs.readFileSync(`${SECTION}.tmpl`, 'utf8');
  const route = section.split('## Closing sequence')[1]!.split('### Outside Voice Integration Rule')[0]!;
  const routeStages = ['**Outside Voice:**', '**Resolve remaining TODO choices:**', '**Approval readiness:**',
    '**Required Outputs:**', '**Cleanup and history:**', '**Navigation:**', '**Learnings:**']
    .map(stage => route.indexOf(stage));
  expect(routeStages.every(position => position >= 0)).toBe(true);
  expect(routeStages).toEqual([...routeStages].sort((a, b) => a - b));
  expect(route.match(/^\d+\. /gm)).toHaveLength(7);
  expect(route).toContain('Record disabled or unavailable coverage and continue when no reviewer runs');
  expect(route).toContain('check the ledger and record PASS before writing outputs');
  expect(route).toContain('no report or log is needed yet');
  expect(route).toContain('For a substantive answer, call 0D for only that change, repeat Approval readiness and Required Outputs, then repeat step 5');
  expect(route).toContain('Resume navigation without asking settled choices again');
  expect(route).toContain('queue the next skill');
  expect(route).toContain('Its EXIT gate verifies completed work and saved readiness without asking again');
  expect(route).toContain('After a passing gate, refresh the cache, run telemetry last, then exit or return to the caller');

  const sectionStages = ['## Closing sequence', '{{CODEX_PLAN_REVIEW}}', '## Resolve remaining TODO choices',
    '### TODOS.md updates', '{{PLAN_REVIEW_APPROVAL_CHECK}}', '## Required Outputs',
    '{{PLAN_FILE_REVIEW_REPORT}}', '## Review Log', '{{REVIEW_DASHBOARD}}', '## Next Steps — Review Chaining',
    '## docs/designs Promotion', '{{LEARNINGS_LOG}}', '{{GBRAIN_SAVE_RESULTS}}', '{{BRAIN_WRITE_BACK}}',
    "Return to this skill's main `SKILL.md`: Section self-check → EXIT PLAN MODE GATE."]
    .map(stage => section.indexOf(stage));
  expect(sectionStages.every(position => position >= 0)).toBe(true);
  expect(sectionStages).toEqual([...sectionStages].sort((a, b) => a - b));
  expect(section).not.toContain('{{EXIT_PLAN_MODE_GATE}}');
  expect(section).not.toContain('{{BRAIN_CACHE_REFRESH}}');
  expect(section).not.toContain('Run the preamble\'s **Telemetry');

  const actualGate = skeleton.indexOf('{{EXIT_PLAN_MODE_GATE}}');
  expect(actualGate).toBeGreaterThan(skeleton.indexOf('## Section self-check'));
  const terminal = skeleton.slice(actualGate);
  const failed = terminal.split('**Blocked:**')[1]!.split('**Passed with a verified persisted report:**')[0]!;
  expect(compactProse(failed)).toContain('complete plan, report and summary');
  expect(compactProse(failed)).toContain('end without success telemetry, ExitPlanMode or the queued handoff');
  const success = compactProse(terminal.split('**Passed with a verified persisted report:**')[1]!);
  const terminalStages = ['finish the cache refresh below', '{{BRAIN_CACHE_REFRESH}}',
    '**Telemetry (run last)** once', 'The review is now finished', 'Call ExitPlanMode',
    'the chosen next-skill handoff starts a separate workflow'].map(stage => success.indexOf(stage));
  expect(terminalStages.every(position => position >= 0)).toBe(true);
  expect(terminalStages).toEqual([...terminalStages].sort((a, b) => a - b));
  expect(terminal).not.toMatch(/return to (?:the )?section|Closing hooks/);
  expect(terminal).not.toContain('Finish with ExitPlanMode');
  expect(skeleton).not.toContain('Before summaries, review logs or next-step menus, run approval check 0 below');
  expect(success).toContain('then run telemetry as the last review operation');
  for (const host of ALL_HOST_CONFIGS) {
    const refresh = compactProse(generateBrainCacheRefresh({ skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext));
    expect(refresh).toContain('After the exit gate passes, start this nonblocking refresh before telemetry');
    expect(refresh).toContain('Then return to the finalization instructions below');
    expect(refresh).not.toContain('telemetry has logged');
  }

  const governingStages = ['## CRITICAL RULE — How to ask questions', '## Formatting Rules',
    '## Mode Quick Reference', '### Working review decisions', '### Section 1:']
    .map(stage => section.indexOf(stage));
  expect(governingStages.every(position => position >= 0)).toBe(true);
  expect(governingStages).toEqual([...governingStages].sort((a, b) => a - b));
  const questions = section.split('## CRITICAL RULE — How to ask questions')[1]!.split('## Mode Quick Reference')[0]!;
  expect(questions).toContain('`D<N>` question heading and A/B/C option labels');
  expect(questions).toContain('Cite the stable ledger ID separately');
  const formatting = questions.split('## Formatting Rules')[1]!;
  expect(formatting).toContain("Step 0D's exact `currentDecision` fields for the question and option descriptions");
  expect(formatting).not.toContain("put the complete comparison in the question's brief");
  expect(questions).not.toMatch(/NUMBER \+ (?:option )?LETTER|"3A"|One sentence max per option/);
});

describe('plan-ceo-review carve — static ordering', () => {
  const skeleton = fs.readFileSync(SKELETON, 'utf-8');
  const section = fs.readFileSync(SECTION, 'utf-8');

  // Index into the skeleton, -1 if absent.
  const at = (needle: string): number => skeleton.indexOf(needle);

  const STEP0 = '## Step 0: Nuclear Scope Challenge + Mode Selection';
  const STOP = 'sections/review-sections.md'; // appears in the index row + STOP directive
  const GATE = 'GSTACK REVIEW REPORT';

  test('the interactive anti-shortcut contract is available before audit or lazy section loading', () => {
    const contract = '**Anti-shortcut clause:**';
    const audit = skeleton.indexOf('## PRE-REVIEW SYSTEM AUDIT');
    expect(skeleton.indexOf(contract)).toBeGreaterThan(-1);
    expect(skeleton.indexOf(contract)).toBeLessThan(audit);
    expect(skeleton.split(contract)).toHaveLength(2);
    expect(section).not.toContain(contract);
    // CEO's shared contract distinguishes unanswered choices from exact prior
    // approvals; the generic fallback's any-finding rule is not its contract.
    expect(skeleton).toContain(generateAntiShortcutClause({ skillName: 'plan-ceo-review' } as TemplateContext));
    expect(skeleton).toContain('Ask once per unresolved or reopened issue, wait for the answer');
    expect(skeleton).toContain('Cross-referencing settled decisions never replaces the full review and terminal report');
    expect(skeleton).toContain('never invent a question merely because a new section starts');
  });

  test('skeleton emits a STOP-Read directive pointing at the section', () => {
    expect(skeleton).toContain('> **STOP.**');
    expect(skeleton).toContain('plan-ceo-review/sections/review-sections.md');
    expect(skeleton).toContain('## Section index — Read each section when its situation applies');
  });

  test('Step 0 (scope + mode) stays in the skeleton, BEFORE the STOP', () => {
    const step0 = at(STEP0);
    const stop = skeleton.indexOf('> **STOP.**');
    expect(step0).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(step0); // STOP fires only after Step 0
  });

  test('mode selection precedes mode-specific analysis after approach approval', () => {
    const approach = at('### 0D.');
    const mode = at('### 0E. Mode Selection');
    const analysis = at('### 0G. Mode-Specific Analysis');
    expect(approach).toBeGreaterThan(-1);
    expect(mode).toBeGreaterThan(approach);
    expect(analysis).toBeGreaterThan(mode);
    expect(skeleton).toContain('Record 0A–0C evidence; call 0D only for a required approach choice');
    expect(skeleton).toContain('Select the mode in 0E and follow its route table');
    expect(skeleton).toContain('| SCOPE EXPANSION / SELECTIVE EXPANSION | 0F → 0G → 0H (including its spec review loop) → 0I |');
    expect(skeleton).toContain('| HOLD SCOPE | 0G → 0I |');
    expect(skeleton).toContain('| SCOPE REDUCTION | 0G |');
    expect(skeleton.indexOf('## Continue after Step 0 (all modes)')).toBeGreaterThan(skeleton.indexOf('### 0I.'));
    expect(skeleton.indexOf('## Continue after Step 0 (all modes)')).toBeLessThan(skeleton.indexOf('> **STOP.**'));
    expect(compactProse(skeleton)).toContain('ask separately per item');
    expect(skeleton).toContain('Continue to Review Sections, outputs and report');
    expect(skeleton).toContain('For >15 planned changed files, recommend SCOPE REDUCTION');
    expect(skeleton).toContain('a new product/system (greenfield) → SCOPE EXPANSION');
    expect(skeleton).toContain('more than 8 files or more than 2 new classes/services');
    const persist = skeleton.split('### 0H. Persist CEO Plan (EXPANSION and SELECTIVE EXPANSION only)')[1]?.split('### 0I.')[0] ?? '';
    expect(persist).toMatch(/^#### Spec Review Loop$/m);
    expect(persist).toContain('After the loop completes or reports unavailable');
    const handoff = compactProse(persist.slice(persist.indexOf('After the loop completes or reports unavailable')));
    const approval = ['for final scope-document approval', 'Ask with the preamble question transport:',
      '**A)** Approve these documents and continue to 0I', '**B)** Revise these documents', '**C)** Pause this review',
      'Wait and record the answer', 'For B, resolve the requested changes through 0D',
      'update both inputs and repeat document approval', 'C stops',
      'After A, run 0I before Review Sections'].map(stage => handoff.indexOf(stage));
    expect(approval.every(position => position >= 0)).toBe(true);
    expect(approval).toEqual([...approval].sort((a, b) => a - b));
    expect(handoff).toContain('Recommend A only if both reflect the exact decisions');
    expect(handoff).toContain('A accepts these document versions only; unresolved amendments and implementation remain unapproved');
  });

  test('the heavy review body (Sections 1-11) is NOT in the skeleton', () => {
    expect(skeleton).not.toContain('### Section 1: Architecture Review');
    expect(skeleton).not.toContain('### Section 11:');
    // ...it lives in the section instead.
    expect(section).toContain('### Section 1: Architecture Review');
    expect(section).toContain('### Section 11:');
  });

  test('Autoplan CEO uses the loaded Step 0 route before its dual voices and review sections', () => {
    for (const suffix of ['.md.tmpl', '.md']) {
      const phase = fs.readFileSync(path.join(ROOT, 'autoplan/sections/ceo-phase' + suffix), 'utf8');
      const step0 = phase.split('**Required execution checklist (CEO):**')[1]?.split('Step 0.5 (Dual Voices):')[0] ?? '';
      expect(step0.replace(/\s+/g, ' ')).toContain("Complete every Step 0 analysis/output on the loaded skill's SELECTIVE EXPANSION route");
      expect(step0.replace(/\s+/g, ' ')).toContain('CEO scope document and 0H Spec Review Loop before 0I and Review Sections');
      expect(step0).not.toMatch(/^- 0[A-I](?:-bis)?:/m);
      // The headings alone can be ordered while executable reviewer payloads
      // still run ahead of Step 0, or Codex is presented ahead of Claude.
      const prose = phase.replace(/\s+/g, ' ');
      const positions = ['**Required execution checklist (CEO):**', 'Step 0.5 (Dual Voices):',
        'Read `snapshot.json` beside `<CEO_INPUT>`',
        'Send its `nativeDispatchPrompt` verbatim as the Agent prompt', 'Native completion barrier:',
        'Outside prompt: inline the full contents of <CEO_INPUT>',
        suffix === '.md.tmpl' ? '{{OUTSIDE_INVOCATION:autoplan}}' : '_OUTSIDE_EXIT=0',
        'CEO DUAL VOICES — CONSENSUS TABLE:', 'Sections 1-11 —', '**Mandatory outputs from Phase 1:**', '**Close this phase:**',
        suffix === '.md.tmpl' ? '{{SECTION:phase-close}}' : 'Read `~/.claude/skills/gstack/autoplan/sections/phase-close.md` and execute it']
        .map(stage => prose.indexOf(stage));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  test('nothing review-governing sits in the skeleton below the STOP (Codex P1)', () => {
    // Mode Quick Reference + Formatting Rules govern review-time behavior and must
    // travel with the section, not be stranded below the STOP in the skeleton.
    expect(skeleton).not.toContain('## Mode Quick Reference');
    expect(skeleton).not.toContain('## Formatting Rules');
    expect(section).toContain('## Mode Quick Reference');
  });

  test('review report writer lives in the section; the EXIT PLAN MODE GATE stays in the skeleton AFTER the STOP', () => {
    // The report itself is produced inside the section work...
    expect(section).toContain(GATE);
    // ...and the blocking gate that verifies it is the last thing the skeleton runs.
    const stop = skeleton.indexOf('> **STOP.**');
    const gate = skeleton.lastIndexOf(GATE);
    expect(gate).toBeGreaterThan(stop);
  });

  test('the loaded test-review section preserves mandatory behaviors and individual assertion decisions', () => {
    const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf-8');
    for (const document of [template, section]) {
      const testReview = document.split('### Section 6: Test Review')[1]?.split('### Section 7:')[0];
      expect(testReview).toBeDefined();
      const instructions = testReview!.replace(/\s+/g, ' ');
      expect(instructions).toContain("Map it to the user's exact requirement or individually approved remedy.");
      expect(instructions).toContain('A stated outcome plus its retained caller contract can determine the assertion, even without assertion syntax.');
      expect(instructions).toContain('Translate semantic counts, conditions and quantifiers exactly');
      expect(instructions).toContain('never weaken an exact count to a lower bound.');
      expect(instructions).toContain('Reuse these requirements without asking again.');
      expect(instructions).toContain('Ask individually only for an unresolved behavioral choice, new outcome, or independent uncovered failure mode.');
      expect(instructions).toContain('Vague success labels do not settle values');
      expect(instructions).toContain('scope/approach approval does not resolve an individual assertion gap.');
      expect(instructions).toContain("Verify the caller's path; helper coverage alone does not prove it.");
      expect(instructions).toContain('Explain what the existing requirement or approved remedy fails to cover before calling a check missing.');
      expect(instructions).toContain('Never silently add, defer or waive a missing behavioral assertion.');
      expect(instructions).toContain('Keep required behaviors mandatory unless the user explicitly approves changing them');
      expect(instructions).toContain('Honor previously accepted risks and equivalent caller coverage.');
      const phases = ['**Map the requirement.**', '**Reuse settled proof.**', '**Resolve actual gaps.**'].map(phase => instructions.indexOf(phase));
      expect(phases.every(position => position >= 0)).toBe(true);
      expect(phases).toEqual([...phases].sort((a, b) => a - b));
      expect(instructions).toContain('**Decision gate.** Complete Analyze → Resolve → Apply above for this section before continuing.');
      const procedure = document.split('### Working review decisions')[1]!.split('### Section 1:')[0]!.replace(/\s+/g, ' ');
      expect(document.indexOf('### Working review decisions')).toBeLessThan(document.indexOf('### Section 6: Test Review'));
      expect(procedure).toContain("At each section's **Decision gate**, follow Analyze → Resolve → Apply below");
      expect(procedure).toContain('complete 0D through its post-answer save, then continue to Apply below');
      expect(compactProse(compactProse(fs.readFileSync(`${SKELETON}.tmpl`, 'utf8')))).toContain('Ask one row per call with that object unchanged, without recomposing');
      expect(fs.readFileSync(`${SKELETON}.tmpl`, 'utf8')).toContain('**STOP for the actual answer, even for a lone option.**');
      expect(procedure).toContain('Check the saved plan against each answer\'s exact scope');
      expect(procedure).toContain('Record findings and dispositions, then review the next section');
      expect(compactProse(document)).toContain('say "No issues found" only when there are zero findings');
    }
  });

  test('the loaded data-flow review requires evidence across interacting operations', () => {
    const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf-8');
    for (const document of [template, section]) {
      const dataFlow = document.split('### Section 4: Data Flow & Interaction Edge Cases')[1]?.split('### Section 5:')[0];
      expect(dataFlow).toBeDefined();
      const instructions = dataFlow!.replace(/\s+/g, ' ');
      expect(instructions).toContain('Draw a combined ASCII schedule with one column per operation and one for shared state.');
      expect(instructions).toContain('pause, let a competing operation complete, resume, then start a fresh consumer.');
      expect(instructions).toContain('State the invariant and its exact caller/time boundary.');
      expect(instructions).toContain('Show the observed result against the invariant.');
      expect(instructions).toContain('If safe, name the mechanism that prevents the violating schedule.');
      expect(instructions).toContain('Separate diagrams, one favorable schedule, single-thread execution and atomic calls do not prove ordering across awaits.');
      expect(instructions).toContain('An accepted exception needs its exact contract clause; bounded damage is insufficient.');
      expect(instructions).toContain('For each pair of overlapping awaits that can affect that invariant, show both completion orders.');
      expect(instructions).toContain('Exclude an order only by naming the mechanism that prevents it.');
      expect(instructions).toContain('The invariant is a requirement, not proof that the implementation meets it.');
      expect(instructions).toContain('Test the relevant completion orders with controlled pause/release points.');
      expect(instructions).toContain('Compare relevant pairs; exhaustive permutations are unnecessary.');
      const phases = ['**Define the boundary.**', '**Exercise both orders.**', '**Compare the result.**', '**Specify regression proof.**'].map(phase => instructions.indexOf(phase));
      expect(phases.every(position => position >= 0)).toBe(true);
      expect(phases).toEqual([...phases].sort((a, b) => a - b));
    }
  });

  test('the section is generated, not hand-edited', () => {
    expect(section.slice(0, 120)).toContain('AUTO-GENERATED');
  });
});

describe('section capture completion signal', () => {
  // Isolate the runner mock in its own Bun process. Loading a mock in this free
  // shard would replace the real runner for unrelated tests in the same process.
  function captureFixture(exitReason: string, draft: boolean, options: { seed?: string; output?: string; directoryBefore?: boolean; directoryAfter?: boolean } = {}) {
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-capture-result-'));
    try {
      if (options.seed !== undefined) fs.writeFileSync(path.join(planDir, 'REPORT.md'), options.seed);
      if (options.directoryBefore) fs.mkdirSync(path.join(planDir, 'REPORT.md'));
      const script = `
        import { mock } from 'bun:test';
        import { writeFileSync, mkdirSync } from 'node:fs';
        let runnerCalls = 0;
        import { captureSectionReads } from ${JSON.stringify(path.join(ROOT, 'test/helpers/auq-sdk-capture.ts'))};
        mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/session-runner.ts'))}, () => ({
          runSkillTest: async () => {
            runnerCalls++;
            ${options.directoryAfter ? `mkdirSync(${JSON.stringify(path.join(planDir, 'REPORT.md'))});` : ''}
            ${draft ? `writeFileSync(${JSON.stringify(path.join(planDir, 'REPORT.md'))}, '# Review report\\nIN PROGRESS');` : ''}
            return { exitReason: ${JSON.stringify(exitReason)}, toolCalls: [], output: ${JSON.stringify(options.output ?? 'Final review report from stdout')} };
          },
        }));
        try {
        const capture = await captureSectionReads({
          planDir: ${JSON.stringify(planDir)}, skillName: 'plan-ceo-review',
          scenario: 'fixture', testName: 'capture-result-fixture', reportMarker: /review report/i,
        });
        process.stdout.write(JSON.stringify(capture));
        } catch (error) { process.stdout.write(JSON.stringify({ errorCode: error.code, runnerCalls })); }
      `;
      const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: ROOT, timeout: 10_000 });
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe('');
      return JSON.parse(child.stdout.toString());
    } finally {
      fs.rmSync(planDir, { recursive: true, force: true });
    }
  }

  test('an unchanged seeded report marker cannot supply attempt completion', () => {
    expect(captureFixture('success', false, { seed: '# Review report\nSeeded plan', output: 'Nothing completed' }))
      .toMatchObject({ exitReason: 'success', reportWritten: false, reportProduced: false, output: 'Nothing completed' });
  });
  test('unchanged seed preserves a valid successful terminal report fallback', () => {
    expect(captureFixture('success', false, { seed: '# Review report\nSeeded plan' }))
      .toMatchObject({ reportWritten: false, reportProduced: true, output: 'Final review report from stdout' });
  });
  test('changed seeded bytes are this attempt artifact, still gated by native success', () => {
    for (const exitReason of ['success', 'timeout']) {
      expect(captureFixture(exitReason, true, { seed: 'Original plan', output: '' }))
        .toMatchObject({ exitReason, reportWritten: true, reportProduced: exitReason === 'success', output: '# Review report\nIN PROGRESS' });
    }
  });
  test('same-byte rewrite is not new report evidence and empty terminal text stays incomplete', () => {
    expect(captureFixture('success', true, { seed: '# Review report\nIN PROGRESS', output: '' }))
      .toMatchObject({ reportWritten: false, reportProduced: false, output: '' });
  });
  test('a newly created report is retained on successful native completion', () => {
    expect(captureFixture('success', true, { output: '' }))
      .toMatchObject({ reportWritten: true, reportProduced: true, output: '# Review report\nIN PROGRESS' });
  });
  test('report snapshot errors retain their cause before the native attempt', () => {
    expect(captureFixture('success', false, { directoryBefore: true }))
      .toEqual({ errorCode: 'EISDIR', runnerCalls: 0 });
  });
  test('report read errors retain their cause after the native attempt', () => {
    expect(captureFixture('success', false, { directoryAfter: true }))
      .toEqual({ errorCode: 'EISDIR', runnerCalls: 1 });
  });

  test.each(['timeout', 'error_api'])('a draft from %s does not signal shared capture completion', exitReason => {
    const capture = captureFixture(exitReason, true);
    expect(capture).toMatchObject({
      exitReason, reportWritten: true, reportProduced: false, output: '# Review report\nIN PROGRESS',
    });
  });

  test('successful captures preserve the terminal-output fallback', () => {
    const capture = captureFixture('success', false);
    expect(capture).toMatchObject({
      exitReason: 'success', reportWritten: false, reportProduced: true, output: 'Final review report from stdout',
    });
  });
});

describe('CEO review completion evidence', () => {
  const completeReport = [
    '# CEO review — HOLD SCOPE',
    'Keep the cache process-local and invalidate only after a successful write.',
    '### Completion Summary',
    '| Review area | Outcome |',
    '| --- | --- |',
    '| Section 1 (Arch) | 1 issue: centralize the invalidation boundary |',
    '| Section 2 (Errors) | 3 error paths mapped, 1 fallback gap |',
    '| Section 3 (Security) | 1 issue: include tenant identity in keys |',
    '| Section 4 (Data/UX) | 2 edge cases mapped, 0 unhandled |',
    '| Section 5 (Quality) | No issues found |',
    '| Section 6 (Tests) | Diagram produced, 2 test gaps |',
    '| Section 7 (Perf) | 1 issue: cap cached value size |',
    '| Section 8 (Observ) | 1 gap: missing hit-rate metric |',
    '| Section 9 (Deploy) | 1 risk: warm-up load |',
    '| Section 10 (Future) | Reversibility: 5/5, 0 debt items |',
    '| Section 11 (Design) | SKIPPED (no UI scope) |',
    '## GSTACK REVIEW REPORT',
    '| Review | Runs | Status | Findings |',
    '| CEO | 1 | CLEAR | Cache boundaries reviewed |',
    '**VERDICT:** CEO CLEARED',
    'NO UNRESOLVED DECISIONS',
  ].join('\n');
  const completed = { exitReason: 'success', reportWritten: true, output: completeReport };

  test('accepts a complete compact report, including the documented no-UI skip', () => {
    expect(() => validateCeoReviewCompletion(completed)).not.toThrow();
  });

  test('accepts bold Markdown section labels', () => {
    const output = completeReport.replace(/\| (Section \d+ \([^|]+\)) \|/g, '| **$1** |');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('accepts a numbered Completion Summary heading', () => {
    const output = completeReport.replace('### Completion Summary', '### 12. Completion Summary');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('does not require the host plan-mode footer in a standalone report', () => {
    const output = completeReport.split('## GSTACK REVIEW REPORT')[0];
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('accepts completed reviews with unresolved findings and pending decisions', () => {
    const output = completeReport.replace('No issues found', '2 gaps; approval pending; TODO decisions recorded');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('accepts a concrete finding about skipped work', () => {
    const output = completeReport.replace('1 gap: missing hit-rate metric', '1 gap: audit logging is skipped on failures');
    expect(() => validateCeoReviewCompletion({ ...completed, output })).not.toThrow();
  });

  test('rejects a timeout even when the report file exists', () => {
    expect(() => validateCeoReviewCompletion({ ...completed, exitReason: 'timeout' }))
      .toThrow('execution failed: timeout');
  });

  test('rejects report-like stdout when the requested report file is absent', () => {
    expect(() => validateCeoReviewCompletion({ ...completed, reportWritten: false }))
      .toThrow('did not write REPORT.md');
  });

  test('rejects generic prose mentioning a review and completion summary', () => {
    expect(() => validateCeoReviewCompletion({
      ...completed,
      output: 'I reviewed all eleven sections and will produce the Completion Summary and GSTACK REVIEW REPORT. '.repeat(3),
    })).toThrow('missing its Completion Summary');
  });

  test('requires an actual Completion Summary', () => {
    expect(() => validateCeoReviewCompletion({
      ...completed,
      output: completeReport.replace('### Completion Summary', 'The Completion Summary will follow.'),
    })).toThrow('missing its Completion Summary');
  });

  test.each(Array.from({ length: 11 }, (_, index) => index + 1))('requires the Section %i outcome', section => {
    const output = completeReport.split('\n')
      .filter(line => !line.startsWith(`| Section ${section} (`)).join('\n');
    expect(() => validateCeoReviewCompletion({ ...completed, output }))
      .toThrow(`Section ${section} outcome`);
  });

  test.each(['___ issues found', 'TBD', 'reviewed', 'SKIPPED'])('rejects unfinished or skipped non-UI outcomes: %s', outcome => {
    const output = completeReport.replace('No issues found', outcome);
    expect(() => validateCeoReviewCompletion({ ...completed, output }))
      .toThrow('Section 5 outcome');
  });

  test('rejects the original template placeholders as completed outcomes', () => {
    const output = completeReport.replace('SKIPPED (no UI scope)', '___ issues / SKIPPED (no UI scope)');
    expect(() => validateCeoReviewCompletion({ ...completed, output }))
      .toThrow('Section 11 outcome');
  });
});

// Both b176 paid attempts saved a comparison without their complete native choices.
// These guard source ordering and branches; captured controls retain those failures.
describe('CEO complete question persistence before dispatch', () => {
  const source = fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
  const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
  const cycle = compact(source.split('### 0D.')[1]!.split('### 0E.')[0]!);

  test('CEO constructs and verifies one complete row decision before dispatch', () => {
    const stages = [
      '**2. Record the pending choice.**',
      "Cite the source filename/message and section/lines when available",
      "**3. Compare and save that row's options.**",
      'Build one `currentDecision`',
      'Score this row\'s coverage differences',
      '**Pre-question checkpoint:**',
      '**Read-back.**',
      '**4. Ask, record the answer, and amend.**',
      'Copy the verified Read or chat text into one native arguments object:',
      'Compare its question, header, labels and full descriptions literally with the verified fields',
      'Ask one row per call with that object unchanged, without recomposing',
      '**STOP for the actual answer, even for a lone option.**',
      'Save the answer reference and scope in Exact approval and scope',
      '**Post-answer checkpoint:**',
    ].map(stage => cycle.indexOf(stage));
    expect(stages.every(position => position >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    const built = cycle.slice(cycle.indexOf('Build one `currentDecision`'), cycle.indexOf('**Pre-question checkpoint:**'));
    for (const field of ['| `question` | Full brief:', '| `header` and option labels | Final native text within host limits', 'offer 2–3 options', '1–2 sentence summary', 'S/M/L/XL effort', 'low/medium/high risk', 'reuse, verification coverage', 'options differ in kind, not coverage — no completeness score']) expect(built).toContain(field);
    const save = cycle.slice(cycle.indexOf('**Pre-question checkpoint:**'), cycle.indexOf('**4. Ask'));
    expect(save).toContain('Copy the grid and all exact fields below');
    expect(save).toContain('without the illustrative fence delimiters');
    for (const field of ['## currentDecision (ROW-ID)', 'Commitment comparison: <complete grid>',
      'Question: <complete currentDecision.question>', 'Header: <exact currentDecision.header>',
      '<full first option description>', '<full second option description; repeat for all offered options>']) expect(save).toContain(field);
    expect(save).toContain('A grid, summary or pointer is insufficient');
    expect(compactProse(save)).toContain('Verify IDs and fields against `currentDecision`, citations against source');
    // Native 043a questions were recomposed after title-only saves; the final
    // Edit ACK also said a Read was unnecessary. These are workflow guards,
    // not proof that a model followed the instructions.
    expect(built).toContain('Project, ELI10, Stakes, Recommendation and applicable completeness/net text');
    expect(compactProse(save)).toContain('Replace the whole payload on revision');
    expect(compactProse(save)).toContain('Keep answered decisions and their answers under separate headings');
    expect(compactProse(save)).toContain('Read despite Edit\'s current-in-context hint');
    expect(compactProse(save)).toContain('Correct mismatches, save and Read again before dispatch');
    const dispatch = cycle.slice(cycle.indexOf('**4. Ask'), cycle.indexOf('**STOP for the actual answer'));
    // The 6aef retry read every saved field, checked only formatting, then
    // rewrote its question, B label and all descriptions in the actual call.
    // Bind the outgoing object to the saved strings at the dispatch boundary.
    expect(dispatch).toContain('{questions: [{question, header, options: [{label, description}, ...]}]}');
    expect(dispatch).toContain('ignoring only saved selector prefixes such as `A)` or `B)`');
    expect(dispatch).toContain('Compare strings, not format/scores');
    expect(compactProse(dispatch)).toContain('Compare its question, header, labels and full descriptions literally with the verified fields');
    expect(compactProse(dispatch)).toContain('Changes repeat step 3\'s save and Read-back');
  });

  test('CEO finishes native field identity and tradeoffs before saving, then reads the entire payload', () => {
    const built = cycle.slice(cycle.indexOf('Build one `currentDecision`'), cycle.indexOf('**Pre-question checkpoint:**'));
    // Native 749df paired retry omitted its row ID; the distinct attempt added
    // one only at dispatch. Final labels/tradeoffs also drifted in paired try 1.
    expect(built).toContain('`D<N> — <ROW-ID>: <one-line question>`');
    expect(compactProse(built)).toContain("ROW-ID identifies the pending choice");
    expect(compactProse(built)).toContain('D counts questions; ROW-ID identifies the pending choice');
    expect(compactProse(built)).toContain('exactly one label includes `(recommended)`');
    expect(compactProse(built)).toContain("| Each option's `description` |");
    expect(compactProse(built)).toContain('at least 2 ✅ pros and 1 ❌ con');
    expect(compactProse(built)).toContain("Apply the preamble's minimum lengths and destructive-choice exception");
    const checkpoint = cycle.slice(cycle.indexOf('**Pre-question checkpoint:**'), cycle.indexOf('**4. Ask'));
    expect(compactProse(checkpoint)).toContain('Find exactly one row by its assigned ID');
    expect(compactProse(checkpoint)).toContain("Validate every field above before saving");
    expect(built).toContain('within host limits');
    expect(checkpoint).toContain('Correct missing or invalid fields and host-limit violations before saving');
    expect(compactProse(checkpoint)).toContain("through the last option's description");
    expect(compactProse(checkpoint)).toContain('fetch continuations. Verify IDs and fields against `currentDecision`, citations against source');
    const dispatch = cycle.slice(cycle.indexOf('**4. Ask'), cycle.indexOf('**STOP for the actual answer'));
    expect(dispatch).not.toContain('citing its ID');
    expect(compactProse(dispatch)).toContain('Compare its question, header, labels and full descriptions literally with the verified fields');
  });

  test('CEO save verification retains forbidden-write, failed-save, automatic and changed-decision branches', () => {
    const policy = compact(source.split('**Storage policy: choose before writing.**')[1]!.split('Keep one decision ledger')[0]!);
    expect(policy).toContain('When writing is forbidden, continue analysis and decisions without writing');
    expect(policy).toContain('Present complete artifacts as **not persisted**');
    expect(policy).toContain('At finalization, an unsaved plan/report means **completion blocked**');
    expect(policy).toContain('no completion log, success telemetry, ExitPlanMode or next-skill handoff');
    expect(policy).toContain('Stop with the cause; chat cannot replace a failed save');
    const metrics = policy.split('| 0H spec-review metrics |')[1]!.split('| Review, decision')[0]!;
    expect(metrics).toContain('Stop with the cause; reviewer availability does not waive this write');
    const history = policy.split('| Review, decision and question history logs')[1]!.split('These artifacts')[0]!;
    expect(history).toContain('Report cause and unsaved fields; continue');
    expect(history).toContain('The plan\'s ledger is still required');
    expect(cycle).toContain('For chat, verify the complete text labeled **not persisted**');
    expect(cycle).toContain('A failed save stops the review');
    expect(cycle).toContain('Changes repeat step 3\'s save and Read-back');
    expect(compactProse(cycle)).toContain("Only the preamble can authorize prose or auto-decision transport");
    expect(cycle).toContain('Only a preamble-authorized auto-decision resolves this wait; record its authority');
    expect(cycle).toContain('A recommendation is not approval');
    expect(compactProse(cycle)).toContain('amend only authorized work');
    expect(cycle).toContain('With no new answer needed');
    expect(cycle).toContain('invent no alternatives or approval');
    expect(cycle).toContain('otherwise leave the row unresolved and stop for direction');
  });
});
