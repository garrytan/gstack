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
import { generateAntiShortcutClause, generateSpecReviewLoop } from '../scripts/resolvers/spec-review';
import { generatePlanFileReviewReport } from '../scripts/resolvers/review-dashboard';
import { generatePlanReviewApprovalCheck, generateExitPlanModeGate } from '../scripts/resolvers/plan-gates';
import { generateCodexPlanReview } from '../scripts/resolvers/outside-voice-steps';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateTasksSectionEmit } from '../scripts/resolvers/tasks-section';
import { generateBrainCacheRefresh } from '../scripts/resolvers/gbrain';
import { runGeneration } from '../scripts/gen-skill-docs';
import { ASK_QUESTIONS_HEADING } from './helpers/workflow-excerpt';

const ROOT = path.resolve(import.meta.dir, '..');
const SKELETON = path.join(ROOT, 'plan-ceo-review', 'SKILL.md');
const SECTION = path.join(ROOT, 'plan-ceo-review', 'sections', 'review-sections.md');

// Prose wrapping is not the contract; keep raw documents for line/heading guards.
const compactProse = (value: string) => value.replace(/\s+/g, ' ').trim();

// Anchors are exact labels, headings, placeholders or table cells (strings) or
// case-insensitive meaning checks (RegExp); they must all exist, in this order.
const ordered = (text: string, anchors: Array<string | RegExp>) => {
  const positions = anchors.map(anchor => typeof anchor === 'string' ? text.indexOf(anchor) : text.search(anchor));
  expect(positions.every(position => position >= 0), `missing one of ${anchors.map(String).join(' | ')}`).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
};

const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(-1);
  return text.slice(from + start.length, to);
};

const skeletonSource = () => fs.readFileSync(`${SKELETON}.tmpl`, 'utf8');
const sectionSource = () => fs.readFileSync(`${SECTION}.tmpl`, 'utf8');

// Source-order and meaning guards; the selected judge remains the clarity proof.
test('CEO decision cycle returns to its caller with two complete persistence checkpoints', () => {
  const cycle = compactProse(between(skeletonSource(), '### 0D.', '### 0E.'));
  ordered(cycle, ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
    "**3. Compare and save that row's options.**", 'Commitment | Source/approval or pending | Current | A | B | C',
    '**Pre-question checkpoint:**', '**4. Ask, record the answer, and amend.**', '**Post-answer checkpoint:**']);
  expect(cycle.match(/\*\*(?:Pre-question|Post-answer) checkpoint:\*\*/g)).toHaveLength(2);
  expect(cycle).toMatch(/0D returns to its caller, not to mode selection/i);
  expect(cycle.split('**Post-answer checkpoint:**')[1]).toMatch(/return to the calling step with the saved answer; do not ask it again/i);
});

test('CEO mode provenance separates an explicit instruction from asked and automatic question logs', () => {
  const mode = between(skeletonSource(), '### 0E.', '### 0F.');
  const rows = mode.split('\n').filter(line => /^- \*\*(Explicit user choice|Successful preference check|Actual question answer):\*\*/.test(line));
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatch(/no question log/i);
  expect(rows[1]).toContain('`auto_decided: true`');
  expect(rows[2]).toContain('`auto_decided: false`');
  expect(mode.indexOf('**Explicit user choice:**')).toBeGreaterThan(mode.indexOf('4. **Mode handoff:**'));
});

test('CEO scope destinations preserve deferrals without asking their already answered TODO again', () => {
  const scope = compactProse(between(skeletonSource(), '### 0G.', '### 0H.'));
  ordered(scope, ['**Defer:**', '**Skip / Cut:**']);
  const defer = between(scope, '**Defer:**', '**Skip / Cut:**');
  expect(defer).toContain('TODOS.md');
  expect(defer).toContain('NOT in scope');
  expect(scope.split('**Skip / Cut:**')[1]).toMatch(/NOT in scope[^.]*; no TODO/i);
  const todoMenu = compactProse(between(sectionSource(), '### TODOS.md updates', '{{PLAN_REVIEW_APPROVAL_CHECK}}'));
  expect(todoMenu).toMatch(/only unanswered TODO proposals reach this menu/i);
  expect(todoMenu).toMatch(/do not ask again about an item already deferred, skipped or kept/i);
  expect(todoMenu).toMatch(/one per question/i);
  const readiness = compactProse(generatePlanReviewApprovalCheck({ skillName: 'plan-ceo-review' } as TemplateContext));
  expect(readiness).toMatch(/approved delivery-scope deferral is settled/i);
  expect(readiness).toMatch(/leaves that choice unresolved/i);
  expect(readiness).toMatch(/out of accepted work/i);
});

test('CEO completion facts precede summary and report while publication follows readback', () => {
  const section = sectionSource();
  ordered(section, ['{{PLAN_REVIEW_APPROVAL_CHECK}}', '### Review facts', '### Completion Summary',
    '{{PLAN_FILE_REVIEW_REPORT}}', '**Publish the Completion Summary:**', '## Review Log']);
  expect(compactProse(section)).toMatch(/derive facts from the approved ledger/i);
});

// These source scenarios guard instruction branches, not native execution.
test('CEO handoff allows no pending choice without inventing an approval', () => {
  const source = skeletonSource();
  const initial = compactProse(between(source, '### 0C.', '### 0D.'));
  const approach = compactProse(between(source, '### 0D.', '### 0E.'));
  const handoff = compactProse(between(source, '**Mode handoff:**', '### 0F.'));
  const noChoice = approach.search(/no new answer needed/i);
  expect(noChoice).toBeGreaterThan(0);
  expect(noChoice).toBeLessThan(approach.indexOf('**2. Record the pending choice.**'));
  expect(approach).toMatch(/invent no alternatives or approval/i);
  expect(initial).toMatch(/before 0E, call 0D for unresolved approaches/i);
  ordered(initial, ['A) current/requested plan', 'B) smallest scoped alternative', 'C) larger approach/rewrite only with evidence']);
  expect(handoff).toContain('No new approach decision was needed');
  expect(handoff).toMatch(/preserve 0D approvals/i);
});

test('CEO handoff carries all answered rows instead of one synthetic approach', () => {
  const handoff = between(skeletonSource(), '**Mode handoff:**', '### 0F.');
  expect(compactProse(handoff)).toMatch(/every governing approved row's ID, answer reference and accepted scope/i);
  expect(handoff).toContain('Auto-decided review mode → <selected mode> (your preference)');
  expect(handoff).toContain('Mode: <selected mode>; approved decisions: <rows or none>');
  expect(handoff).not.toContain('<approved 0D approach>');
});

// Guards the public handoff instruction, not model compliance or posture detection.
test('CEO mode handoff applies the selected mode before the next question', () => {
  const selection = between(skeletonSource(), '### 0E. Mode Selection', '### 0F.');
  const handoffStart = selection.indexOf('4. **Mode handoff:**');
  const routeStart = selection.indexOf("Follow the selected mode's route:");
  expect(handoffStart).toBeGreaterThan(0);
  expect(routeStart).toBeGreaterThan(handoffStart);
  const handoff = selection.slice(handoffStart, routeStart);
  const instruction = handoff.split('\n')[0]!;
  expect(instruction).toMatch(/before other tools or further questions, run `[^`]*gstack-ceo-mode-handoff/i);
  expect(instruction).toMatch(/chat.*mode.s application and rationale/i);
  const selectionSteps = compactProse(selection.slice(0, handoffStart));
  expect(selectionSteps).toMatch(/explicit choice skips steps 2–3/i);
  expect(selectionSteps).toMatch(/exits 0 with `AUTO_DECIDE` selects the recommendation/i);
  expect(selectionSteps).toMatch(/stop for the answer/i);
  const loggingStart = handoff.search(/record mode provenance after the handoff/i);
  expect(loggingStart).toBeGreaterThan(handoff.indexOf('- Other selections:'));
  expect(loggingStart).toBeLessThan(handoff.search(/selecting a mode does not approve changes/i));
  const formats = handoff.split('\n').filter(line => /^- (`plan-ceo-review-mode:|Other selections:)/.test(line));
  expect(formats).toHaveLength(2);
  for (const format of formats) {
    expect(format).toContain('<Application and rationale>');
    expect(format).toContain('<rows or none>');
  }
});

test('SELECTIVE baseline cuts preserve prior answers until their own scope decision', () => {
  const modeWork = between(skeletonSource(), '### 0G.', '### 0H.');
  expect(compactProse(modeWork)).toMatch(/run all three HOLD SCOPE checks/i);
  const holdChecks = between(modeWork, '**For HOLD SCOPE**', '**For SCOPE REDUCTION:**');
  expect([...holdChecks.matchAll(/^\d+\. /gm)]).toHaveLength(3);
  expect(holdChecks).toContain('more than 8 files or more than 2 new classes/services');
  const cuts = compactProse(modeWork.split('**Deferring current scope**')[1]!);
  ordered(cuts, ['**A)** Defer this item to TODOS.md', '**B)** Keep it in scope']);
  expect(cuts).toMatch(/all four 0D steps for each unanswered addition or deferral/i);
  ordered(cuts, [/wait for the answer/i, /deferral changes only delivery scope/i, /beside the prior approval/i]);
});

// These check the storage branches and their order, not model compliance.
test('CEO defines pending choices and storage before its first decision procedure', () => {
  const source = skeletonSource();
  const step0 = compactProse(source.split('## Step 0:')[1]!);
  ordered(step0, ['**Required choice:**', '**Storage policy: choose before writing.**', '### 0D.']);
  expect(step0).toMatch(/honor user\/host write and cleanup limits/i);
  expect(step0).toMatch(/native Write for a missing file and scoped Edit for checkpoints/i);
  expect(step0).toMatch(/retain all current content/i);
  const compare = between(step0, '**3. Compare and save', '**4. Ask, record');
  // Native c6fc D3 saved and asked Effort 0; cdd D3 cited a missing ledger row.
  expect(compare).toMatch(/use effort S[^.]*never effort 0/i);
  expect(compare).toContain('S/M/L/XL effort, low/medium/high risk');
  ordered(compare, ['**Pre-question checkpoint:**', /find exactly one row by its assigned ID/i,
    /one listed value, never a range/i, /correct missing or invalid fields/i, '**Read-back.**']);
  expect(compare).toMatch(/read the ledger row and full payload/i);
  const persistence = between(step0, '### 0H.', '### 0I.');
  ordered(persistence, ['**Save or present both inputs under the storage policy.**',
    'mkdir -p', '**Otherwise:**', '**CEO summary format — use for both saved and chat output:**',
    '# CEO Plan: {Feature Name}', '{{SPEC_REVIEW_LOOP}}']);
  expect(source).toContain('## Reviewer Concerns\n- {unresolved spec-review issues with their owning input, or "None"}');
});

test('CEO chat storage still supplies both spec inputs and the full report without claiming file completion', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext;
    const spec = compactProse(generateSpecReviewLoop(ctx));
    expect(spec).toMatch(/both complete labeled texts/i);
    expect(spec).toMatch(/all five dimensions/i);
    expect(spec).toMatch(/at most three reviewer launches/i);
    expect(spec).toMatch(/a successful reviewer result is not required/i);
    expect(spec).toMatch(/if a required save fails, stop before claiming completion/i);
    const report = generatePlanFileReviewReport(ctx);
    ordered(report, ['### Generate the report', '### Write to the plan file', '**Read-back gate:**']);
    expect(report).toContain('not persisted');
    expect(report).not.toContain('retry once');
    const writing = compactProse(report);
    expect(writing).toMatch(/Stage 3's blocked chat return/i);
    ordered(writing, [/if the destination file exists, read it now/i, /if the destination file does not exist, use Write/i,
      /keep the report last/i]);
    const tasks = compactProse(generateTasksSectionEmit(ctx, ['ceo-review']));
    expect(tasks).toMatch(/write when permitted, including zero tasks/i);
    expect(tasks).toMatch(/do not choose implementation contracts/i);
    expect(tasks).toMatch(/"to be determined" and use an empty JSONL files array/i);
    const outside = generateCodexPlanReview(ctx);
    if (outside) expect(compactProse(outside)).toMatch(/include the CEO scope summary/i);
    const gate = compactProse(generateExitPlanModeGate(ctx));
    expect(gate).toMatch(/do not call ExitPlanMode until all checks pass/i);
    ordered(gate, [/missing plan\/report saves/i, '1. Read the plan file']);
    expect(gate).toMatch(/for forbidden history, confirm no write was attempted/i);
    expect(gate).toContain('**Gate outcome: Blocked**');
  }
});

// The original 660 judge found competing routes. These guards verify the
// instruction branches and ordering; only the selected judge proves clarity.
test('CEO routes administrative menus separately while scope and TODO retain the full decision protocol', () => {
  const main = compactProse(skeletonSource());
  const decisions = between(main, '### 0D.', '### 0E.');
  ordered(decisions, ['- **Admin question:**', '- **Plan decision:**', '**1. Check sources']);
  expect(decisions).toMatch(/if an admin answer requests a plan change, use the Plan decision route/i);
  expect(decisions).toMatch(/one column per option/i);
  ordered(main, ["**A)** Add to this plan's scope", '**B)** Defer to TODOS.md', '**C)** Skip']);
  expect(main).toMatch(/reuse answered scope decisions without another question/i);
  const section = compactProse(sectionSource());
  expect(section).toMatch(/through all four steps of 0D/i);
  ordered(section, ['**A)** Add to TODOS.md', '**B)** Skip — not valuable enough', '**C)** Keep in the current plan as required work']);
});

test('CEO output stages prepare body before report and publish only after verification with a blocked chat return', () => {
  const raw = sectionSource();
  const section = compactProse(raw);
  ordered(section, ['### Stage 1 — Prepare', '### Review facts', '### Completion Summary',
    '### Stage 2 — Save and verify', '{{PLAN_FILE_REVIEW_REPORT}}', '### Stage 3 — Publish', '## Review Log']);
  expect(section).toMatch(/before the terminal report/i);
  expect(section).toMatch(/no stage depends on a completion log written later/i);
  expect(section).toMatch(/after the report read-back gate passes/i);
  expect(section).toMatch(/do not append it after the report/i);
  const chatStart = raw.search(/if no plan\/report write is permitted/i);
  expect(chatStart).toBeGreaterThan(-1);
  const chatEnd = raw.indexOf('\n## ', chatStart);
  expect(chatEnd).toBeGreaterThan(chatStart);
  const chat = compactProse(raw.slice(chatStart, chatEnd));
  expect(chat).toContain('**Gate outcome: Blocked**');
  expect(chat).toMatch(/without claiming saved completion/i);
  expect(chat).toMatch(/skip Review Log, success telemetry and the next-skill handoff/i);
  const main = compactProse(skeletonSource());
  const blocked = between(main, '- **Blocked:**', '- **Passed with');
  expect(blocked).toMatch(/complete plan, report and summary/i);
  expect(blocked).toContain('**not persisted**');
  expect(blocked).toContain('**completion blocked**');
  expect(blocked).toMatch(/missing logs do not unsave a verified report/i);
  expect(blocked).toMatch(/without success telemetry, ExitPlanMode or the queued handoff/i);
  expect(main).toMatch(/failed required writes still block/i);
  const gate = compactProse(generateExitPlanModeGate({ skillName: 'plan-ceo-review' } as TemplateContext));
  const precheck = gate.slice(0, gate.indexOf('Verify `Approval readiness: PASS`'));
  expect(precheck).toMatch(/missing plan\/report saves and failed permitted 0H metrics block completion/i);
  expect(precheck).toMatch(/best-effort history does not/i);
  // Optional task/archive/TODO restrictions cannot block verified required artifacts.
  expect(precheck).not.toMatch(/Forbidden storage|(?:task|archive|TODO).*forbidden/);
});

test('CEO prior unresolved count remains a final report bullet for prior-only and mixed unresolved cases', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext;
    const report = compactProse(generatePlanFileReviewReport(ctx));
    const status = between(report, '**Unresolved-decisions status', '### Write to the plan file');
    expect(status).toContain('`NO UNRESOLVED DECISIONS`');
    expect(status).toContain('`- + N unresolved from prior reviews`');
    expect(status).toMatch(/not counted twice/i);
    expect(status).toMatch(/one bullet per current open item/i);
    expect(status).toMatch(/even if there are no current items/i);
    expect(status).toMatch(/final non-whitespace line/i);
    expect(status).toMatch(/append no separate count line/i);
  }
});

test('CEO saves compared proposals before recording an actual answer in its separate field', () => {
  const procedure = compactProse(between(skeletonSource(), '### 0D.', '### 0E. Mode Selection'));
  ordered(procedure, [/record pending rows before comparisons; never prewrite approval or tasks/i,
    '**3. Compare and save', /in Proposed, compare every commitment/i, '**4. Ask, record',
    /save the answer reference and scope/i, /amend only authorized work/i, /before taking another row/i]);
  expect(procedure).toMatch(/a failed save stops the review/i);
});

// A topic row alone did not expose the independently selectable test additions.
// This guards the executable representation/order, not the model's compliance.
test('CEO value comparisons and decline-all outcomes stay explicit before approval', () => {
  const procedure = compactProse(between(skeletonSource(), '### 0D.', '### 0E.'));
  ordered(procedure, [/record pending rows before comparisons/i, 'Commitment | Source/approval or pending | Current | A | B | C',
    /save\/present the complete current plan, pending rows and comparisons/i, '**4. Ask, record']);
  const comparison = between(procedure, 'Commitment | Source/approval or pending', '**4. Ask, record');
  expect(comparison).toMatch(/show unchanged, shared and pending values/i);
  expect(comparison).toMatch(/keep independent changes separate even within one framework/i);
  expect(comparison).toMatch(/preserve requirements, tests and fixes/i);
  expect(procedure).toMatch(/if all options are declined, continue only if the answer retains a viable current approach/i);
  expect(procedure).toMatch(/leave the row unresolved and stop for direction/i);
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
      ordered(approach, ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
        /record owner, behavior, limits, test method and coverage/i, /record pending rows before comparisons/i,
        "**3. Compare and save that row's options.**", 'Build one `currentDecision`', '**Pre-question checkpoint:**',
        '**4. Ask, record the answer, and amend.**', /ask one row per call/i, '**Post-answer checkpoint:**']);
      expect(between(approach, '**4. Ask', '**Post-answer checkpoint:**'), file).toMatch(/stop for the actual answer/i);
      expect(source).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
      expect(source.indexOf('| ID and owner |')).toBeLessThan(source.indexOf('**2. Record the pending choice.**'));
      expect(source.indexOf('### 0D.')).toBeLessThan(source.indexOf('### 0E. Mode Selection'));
    }
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }); }
}, 30_000);

// A saved topic row did not prevent the captured paired menu from combining
// separately proposed coverage. Main review also asked about a draft-created
// recovery promise before reconciling it with the original contract.
test('CEO decision units and factual reconciliation precede menu synthesis', () => {
  const section = sectionSource();
  expect(compactProse(between(section, '**Analyze.**', '**Resolve.**'))).toMatch(/correct false claims/i);
  ordered(section, ['### Outside Voice Integration Rule', '{{CODEX_PLAN_REVIEW}}']);
});

test('CEO outside findings reuse authority-first decisions without turning unknown facts into policies', () => {
  const section = fs.readFileSync(SECTION, 'utf8');
  const tension = compactProse(between(section, '**Integrate reviewer findings:**', '**Cross-model tension:**'));
  // The outside branch delegates to the original procedure, not a second approval loop.
  expect(tension).toMatch(/same six-column ledger/i);
  expect(tension).toMatch(/including both saves and the actual answer/i);
  expect(tension).toMatch(/do not start a second procedure/i);
  expect(tension).not.toContain('reference | commitment | current value');
  expect(tension).toMatch(/correct false premises without changing accepted behavior/i);
  expect(tension).toMatch(/keep uncertainty with its owner/i);
  expect(tension).toMatch(/merely imagining another behavior is not evidence/i);
  expect(tension).toMatch(/need no behavior-change menu/i);
  expect(tension).toMatch(/preserve the requested mode/i);
  expect(tension).toContain('A) Apply this change; B) Keep');
  expect(tension).toContain('A) Include; B) Defer; C) Cut; D) Hold');
  expect(tension).toMatch(/revising two candidates takes two rows/i);
  expect(tension).toMatch(/never silently trim or replace another candidate/i);
  expect(tension).toMatch(/investigation and deferral do not authorize implementation/i);
  expect(tension).toMatch(/challenges wait for the final gate/i);
  expect(tension).toMatch(/one answer does not resolve other pending rows/i);
});

// Guard the complete result routes on every host. This verifies instructions,
// not the quality judge's clarity score or an agent's execution of the workflow.
test('CEO integrates completed native findings before its external-only comparison', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const ctx = { skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext;
    const review = compactProse(generateCodexPlanReview(ctx));
    expect(review.match(/\*\*Outcome routing:\*\*/g)).toHaveLength(1);
    expect(review).toMatch(/do not restart the outside invocation after its failure/i);
    const anchors = [/after a completed external review, go directly/i, '**Native fallback — provider unavailable or execution failed, with reviews enabled:**',
      '**Bounded outside-voice wait', '**Unavailable path:**', '**Integrate reviewer findings:**',
      '**Cross-model tension:**', '**Persist the result:**'];
    ordered(review, anchors);
    const [externalStart, nativeStart, boundedStart, unavailableStart, findingsStart, comparisonStart, persistStart] =
      anchors.map(anchor => typeof anchor === 'string' ? review.indexOf(anchor) : review.search(anchor));
    expect(review.slice(externalStart, nativeStart)).toMatch(/go directly to \*\*Integrate reviewer findings\*\*/i);
    const bounded = review.slice(boundedStart, unavailableStart);
    expect(bounded).toMatch(/continue to \*\*Integrate reviewer findings\*\*/i);
    expect(bounded).toMatch(/follow step 4/i);
    expect(bounded).not.toContain('continue to Cross-model tension');
    const unavailable = review.slice(unavailableStart, findingsStart);
    expect(unavailable).toMatch(/skip Integrate reviewer findings and Cross-model tension/i);
    expect(unavailable).toContain('STATUS = "unavailable", SOURCE = "none", OUTSIDE_STATUS = "unavailable"');
    const findings = review.slice(findingsStart, comparisonStart);
    expect(findings).toMatch(/never as outside coverage/i);
    expect(findings).toMatch(/disabled or unavailable reviews skip this block/i);
    expect(findings).toMatch(/use 0D for new or reopened choices/i);
    const comparison = review.slice(comparisonStart, persistStart);
    expect(comparison).toMatch(/only if an external reviewer completed/i);
    expect(comparison).toMatch(/skip this comparison and go to \*\*Persist the result\*\*/i);
    expect(comparison).toMatch(/do not write a CROSS-MODEL line/);
    expect(comparison).toMatch(/unknown model identity stays unknown/i);
    const report = compactProse(generatePlanFileReviewReport(ctx));
    expect(report).toMatch(/\*\*CROSS-MODEL:\*\* only when native and completed external reviews exist/i);
    expect(report).toContain('N findings; R resolved; U unresolved');
    expect(report).toContain('"0 findings — completed review"');
    expect(report).toContain('"no completed external review"');
    expect(report).toMatch(/never imply zero findings/i);
    expect(report).toContain('"finding count not recorded"');
    expect(report).toMatch(/label native fallback findings as native/i);
    expect(report).toMatch(/provider and outcome in OUTSIDE COVERAGE/);
  }
});

test('CEO expansion preparation feeds one pending list into the scope decisions', () => {
  const source = compactProse(skeletonSource());
  const framing = between(source, '### 0F.', '### 0G.');
  const decisions = between(source, '### 0G.', '### 0H.');
  expect(framing).toMatch(/prepare 0G candidates/i);
  expect(framing).toContain('S/M/L/XL effort, risk and impact');
  expect(framing).toContain('`(recommended)`');
  expect(framing).toMatch(/the user still decides each proposal in 0G/i);
  expect(decisions).toMatch(/extend 0F's pending list/i);
  expect(decisions).toMatch(/ask separately for each addition/i);
});

// Repeated public quality feedback identified these missing execution instructions.
// This guard checks the source contract; native clarity still requires paid evidence.
test('CEO Step 0 defines the decision record, execution order, and mode approval precedence', () => {
  const source = skeletonSource();
  const step0 = compactProse(source.split('## Step 0:')[1]?.split('### 0F.')[0] ?? '');
  ordered(step0, [/1\. choose the review depth/i, /2\. record 0A–0C evidence/i, /3\. select the mode in 0E/i,
    /4\. complete review sections/i]);
  expect(step0).toMatch(/0D is reusable, not an unconditional question/i);
  expect(step0).toMatch(/observations do not approve changes/i);
  ordered(step0, [/follow the preamble's session rules/i, /an explicit choice skips steps 2–3/i]);
  expect(step0).toMatch(/recommend without selecting/i);
  expect(step0).toMatch(/the user's choice wins/i);
  expect(step0).toContain('`question_id=plan-ceo-review-mode`');
  expect(step0).toContain('`gstack-question-preference --check`');
  expect(step0).toMatch(/when tuning is false, omit the lookup/i);
  expect(step0).toMatch(/offer all four modes in one AskUserQuestion/i);
  const reduction = compactProse(source.split('**For SCOPE REDUCTION:**')[1]?.split('### 0H.')[0] ?? '');
  expect(reduction).toMatch(/ask separately per item/i);
  ordered(reduction, ['**A)** Defer this item to TODOS.md', '**B)** Keep it in scope']);
  expect(reduction).not.toContain('Remove it without a follow-up');
  expect(reduction).not.toContain('Accepted items govern');
  expect(source).toMatch(/accepted items govern the remaining sections/i);
});

// Verify the source contract reaches the actual evaluated generated carrier;
// the live AUQ gate still proves model compliance with this instruction.
test('CEO mode recommendation explains a plan-specific consequence without changing routing', () => {
  for (const file of [`${SKELETON}.tmpl`, SKELETON]) {
    const source = fs.readFileSync(file, 'utf8');
    const mode = between(source, '### 0E. Mode Selection', '### 0F.');
    const recommendation = compactProse(between(mode, '2. Recommend without selecting.', '3. Resolve that recommendation.'));
    expect(recommendation).toMatch(/connect a concrete plan fact or constraint/i);
    expect(recommendation).toMatch(/not just its count\/category/i);
    expect(recommendation).toContain('For >15 planned changed files, recommend SCOPE REDUCTION');
    expect(recommendation).toContain('(greenfield) → SCOPE EXPANSION');
    expect(recommendation).toContain('added capability → SELECTIVE EXPANSION');
    expect(recommendation).toContain('fix/refactor → HOLD SCOPE');
    expect(recommendation).toContain('recommend HOLD SCOPE');
    const resolve = compactProse(between(mode, '3. Resolve that recommendation.', '4. **Mode handoff:**'));
    expect(resolve).toMatch(/using step 2's recommendation/i);
    expect(resolve).toMatch(/stop for the answer/i);
  }
});

// Boundary checks stay on source templates: generated carriers remain the
// integration owner's responsibility, and these do not prove model behavior.
describe('CEO review decision boundaries contract', () => {
  const skeleton = skeletonSource();
  const section = sectionSource();
  const alternatives = compactProse(skeleton.split('### 0D.')[1]?.split('### 0F.')[0] ?? '');
  const temporal = compactProse(skeleton.split('### 0I.')[1]?.split('### 0E.')[0] ?? '');
  const continuity = compactProse(between(section, '### Working review decisions', '### Section 1:'));
  const apply = compactProse(continuity.split('**Apply.**')[1]!);

  test('every approach comparison preserves approvals and separates independent changes', () => {
    const depth = compactProse(between(skeleton, "**Set review depth from the user's request.**", 'Plain terms:'));
    ordered(depth, ['**A)** Keep this review strategy-only', '**B)** Add implementation design']);
    expect(depth).toMatch(/recommend A unless a concrete blocker requires B/i);
    expect(depth).toMatch(/wait for the answer/i);
    expect(depth).toMatch(/B permits design detail for that capability only/i);
    expect(compactProse(section)).toMatch(/use Step 0's depth-expansion decision before designing/i);
    const outputs = compactProse(section.split('## Required Outputs')[1]!);
    expect(outputs).toMatch(/for implementation-ready work, list every method that can fail/i);
    expect(outputs).toMatch(/for strategy-only work, use capability rows/i);
    expect(outputs).toMatch(/count capability rows in the Completion Summary/i);
    expect(outputs).not.toContain('___ methods');
    expect(alternatives).toContain('| Code change and required regressions | Keep together; carry both forward once approved. |');
    expect(alternatives).toContain('| Approved change with open test method/coverage | Decide once;');
    expect(alternatives).toContain('| Tests for existing behavior | Separate independently selectable additions.');
    expect(compactProse(section)).toMatch(/following 0D's test table/i);
    expect(alternatives).toMatch(/preserve unknowns/i);
    expect(alternatives).toMatch(/give independent changes separate ledger rows/i);
    expect(alternatives).toMatch(/weigh diff size and long-term architecture equally/i);
    expect(compactProse(skeleton)).toMatch(/cite actual instructions\/answers and exact scope/i);
  });

  test('settled approach authority resolves the gate while new choices still require approval', () => {
    const approach = alternatives.split('### 0E. Mode Selection')[0]!;
    const reuse = approach.split('**2. Record the pending choice.**')[0]!;
    expect(reuse).toMatch(/compare input, source and answers/i);
    expect(reuse).toMatch(/reopen only for contradictions, changed assumptions or user instructions/i);
    expect(reuse).toMatch(/never speculation or reviewer agreement/i);
    expect(approach).toMatch(/a recommendation is not approval/i);
    expect(approach).not.toContain('0C-bis');
    expect(compactProse(section)).toMatch(/resolve it through 0D before amending the plan/i);
    expect(section).toMatch(/"obvious fix" still needs approval/i);
    const generated = fs.readFileSync(SKELETON, 'utf8');
    expect(generated).toContain('### Tool resolution (read first)');
    expect(generated).toContain('SESSION_KIND: spawned');
    expect(generated).toMatch(/auto-decide preferences still apply first/i);
    const afterAnswer = approach.split('**Post-answer checkpoint:**')[1]!;
    expect(afterAnswer).toMatch(/record findings even after resolution/i);
    expect(afterAnswer).toContain('"No issues, moving on."');
  });

  test('coverage scoring is conditional and legitimate early decisions retain their exact approval', () => {
    ordered(alternatives, [/record owner, behavior, limits, test method and coverage/i, /score this row's coverage differences/i]);
    expect(alternatives).toContain('10 = all edge cases');
    expect(alternatives).toContain('Note: options differ in kind, not coverage — no completeness score.');
    // Scoring and recommendation details are reused from the existing preamble.
    const generated = fs.readFileSync(SKELETON, 'utf8');
    expect(generated).toContain('10 = complete, 7 = happy path, 3 = shortcut');
    expect(generated).toContain('(recommended)');
    expect(generated).toContain('AUTO_DECIDE depends on it');
    expect(generated).toContain('Note: options differ in kind, not coverage — no completeness score.');
    expect(temporal).toMatch(/resolve scope and feasibility blockers through 0D now/i);
    expect(temporal).toMatch(/carry the ledger and each answer's exact scope/i);
  });

  test('an unresolved section decision is answered before its scoped plan amendment', () => {
    ordered(continuity, ['**Resolve.**', '**Apply.**', /check the saved plan against each answer's exact scope/i,
      /correct discrepancies under the storage policy/i, /record findings and dispositions/i]);
    expect(continuity).toMatch(/check input, source and actual approvals/i);
    expect(apply).toMatch(/preserve existing content, approved behavior/i);
  });

  test('pending labels authorize only unresolved notes, not an outcome or future review conclusions', () => {
    expect(apply).toMatch(/leave unapproved remedies and extra verification pending/i);
    expect(apply).toMatch(/if a correction needs approval, resolve it through 0D/i);
    expect(apply).toMatch(/do not write its conclusions or tasks before reviewing it/i);
    expect(apply).toMatch(/an approval is not proof of implementation or verification/i);
  });
});

// These are source-contract checks, not model-behavior evidence. Read the
// template and resolve its shared clause directly so an old generated carrier
// cannot conceal conflicting per-section instructions during implementation.
describe('CEO review decision continuity contract', () => {
  const template = sectionSource();
  const clauses = ALL_HOST_CONFIGS.map(host => generateAntiShortcutClause({
    skillName: 'plan-ceo-review', host: host.name,
  } as TemplateContext));
  const continuity = compactProse(template.split('### Working review decisions')[1]?.split('### Section 1:')[0] ?? '');

  test('analysis, decision, and approved amendment precede advancing to the next section', () => {
    ordered(continuity, ['**Analyze.**', '**Resolve.**', '**Apply.**']);
    for (const clause of clauses) {
      const text = compactProse(clause);
      expect(text).toContain('Analyze → resolve → apply');
      expect(text).toMatch(/do not prewrite the remaining sections/i);
      expect(text).toMatch(/proposed findings are not accepted plan changes/i);
      expect(text).toMatch(/full review and terminal report/i);
    }
  });

  test('every section has one decision gate wired to the shared procedure', () => {
    const declared = Number(template.match(/^## Review Sections \((\d+) sections/m)?.[1]);
    const sections = [...template.matchAll(/^### Section (\d+):([^]*?)(?=^### Section \d+:|^## Closing sequence)/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual(Array.from({ length: declared }, (_, i) => i + 1));
    for (const [, number, body] of sections) {
      expect(body.match(/\*\*Decision gate\.\*\*/g), `Section ${number}`).toHaveLength(1);
      expect(body, `Section ${number}`).toMatch(/\*\*Decision gate\.\*\* Complete Analyze → Resolve → Apply/);
    }
    ordered(template, ['### Working review decisions', '### Section 1:']);
    expect(continuity).toMatch(/at each section's \*\*Decision gate\*\*, follow Analyze → Resolve → Apply/i);
    expect(continuity).toMatch(/0D's Plan decision route through its post-answer save/i);
    expect(continuity).toMatch(/review only; do not change code/i);
    expect(compactProse(template)).toMatch(/say "No issues found" only when there are zero findings/i);
    expect(template).toMatch(/evaluate Sections 1–10 in full/i);
    expect(compactProse(template)).toMatch(/run Section 11 if accepted work adds or changes UI/i);
    expect(template).toContain('`SKIPPED (no UI scope)`');
    ordered(template, ['### Completion Summary', '{{PLAN_FILE_REVIEW_REPORT}}']);
  });

  test('the ledger carries exact approvals and declared contracts without claiming implementation', () => {
    const skeleton = skeletonSource();
    const start = skeleton.search(/keep one decision ledger/i);
    expect(start).toBeGreaterThan(skeleton.indexOf('## Step 0:'));
    expect(start).toBeLessThan(skeleton.indexOf('### 0D.'));
    const earlyLedger = skeleton.slice(start, skeleton.indexOf('### 0A.'));
    expect(earlyLedger).toContain('| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |');
    expect(earlyLedger).toContain('unresolved, approved, reopened, deferred or declined');
    expect(compactProse(earlyLedger)).toMatch(/cite evidence, conventions and tests; mark unknowns/i);
    const limits = compactProse(between(skeleton, '**Keep the stated limits.**', '**Storage policy:'));
    expect(limits).toMatch(/record each measure, value, unit and prerequisite/i);
    expect(limits).toMatch(/changing a limit needs evidence and user approval/i);
    expect(skeleton.indexOf('**Keep the stated limits.**')).toBeLessThan(skeleton.indexOf('### 0D.'));
    const temporal = compactProse(skeleton.split('### 0I.')[1]?.split('{{SECTION:review-sections}}')[0] ?? '');
    expect(temporal).toMatch(/keep other design choices pending unless the user requested implementation planning/i);
    expect(compactProse(template)).toMatch(/leave non-blocking implementation choices pending/i);
    expect(compactProse(template)).toMatch(/completing prioritization does not mean the implementation is ready/i);
    expect(continuity).toMatch(/continue the six-column ledger with each row's owner section/i);
    expect(continuity).toMatch(/preserve contracts and mitigations even if later text omits them/i);
    expect(continuity).toMatch(/record unknown risks with their owners/i);
  });

  test('ownership never defers a critical risk or merges distinct choices by topic', () => {
    expect(continuity).toMatch(/resolve critical risks now/i);
    expect(continuity).toMatch(/keep independent safety fixes and throughput improvements in separate rows/i);
    const testReview = compactProse(between(template, '### Section 6: Test Review', '### Section 7:'));
    expect(testReview).toMatch(/carry requested or approved coverage forward[^.]*without re-asking/i);
    expect(testReview).toMatch(/resolve that choice through 0D before prescribing it/i);
    expect(testReview).toMatch(/an approved runtime contract alone does not choose extra verification scope/i);
    const outside = compactProse(between(template, '### Outside Voice Integration Rule', '{{CODEX_PLAN_REVIEW}}'));
    expect(outside).toMatch(/apply Analyze above to each outside finding/i);
    expect(outside).toMatch(/reviewer agreement is not new evidence or approval/i);
  });

  test('Design preserves decision gating while DX and fallback retain their existing output on every host', () => {
    // Pin DX's e15ba218 output independently: Eng now has its own wording.
    const originalDevex = '29fe85565c2ea16c0d205a06a2515e30228342078a44bb688489274c157ddba2';
    const fallbacks = new Set<string>();
    for (const host of ALL_HOST_CONFIGS) {
      const fallback = generateAntiShortcutClause({ skillName: 'review', host: host.name } as TemplateContext);
      fallbacks.add(fallback);
      // Default clause keeps its constraints: the plan cannot replace the interactive review,
      // findings go through AskUserQuestion before the plan, only zero findings skip asking.
      expect(fallback).toMatch(/cannot replace|not a substitute/i);
      expect(fallback).toMatch(/finding[\s\S]*AskUserQuestion/i);
      expect(fallback).toMatch(/zero findings[\s\S]*ExitPlanMode/i);
      const devex = generateAntiShortcutClause({ skillName: 'plan-devex-review', host: host.name } as TemplateContext);
      expect(createHash('sha256').update(devex).digest('hex'), `plan-devex-review/${host.name}`).toBe(originalDevex);
      const design = compactProse(generateAntiShortcutClause({ skillName: 'plan-design-review', host: host.name } as TemplateContext));
      expect(design).toMatch(/ask once per independent decision, wait for the actual answer/i);
      expect(design).toMatch(/previously selected contract do not reopen it/i);
      expect(design).toMatch(/does not approve independent remedies/i);
    }
    expect(fallbacks.size, 'default clause is host-independent').toBe(1);
  });
});

test('CEO closing route checks approvals before outputs and verifies artifacts before telemetry without a file bounce', () => {
  const skeleton = skeletonSource();
  const section = sectionSource();
  const route = between(section, '## Closing sequence', '### Outside Voice Integration Rule');
  const routeStages = ['**Outside Voice:**', '**Resolve remaining TODO choices:**', '**Approval readiness:**',
    '**Required Outputs:**', '**Cleanup and history:**', '**Navigation:**', '**Learnings:**'];
  ordered(route, routeStages);
  expect(route.match(/^\d+\. /gm)).toHaveLength(routeStages.length);
  const steps = compactProse(route);
  expect(steps).toMatch(/record disabled or unavailable coverage and continue when no reviewer runs/i);
  expect(steps).toMatch(/record PASS before writing outputs/i);
  expect(steps).toMatch(/call 0D for only that change, repeat Approval readiness and Required Outputs, then repeat step 5/i);
  expect(steps).toMatch(/without asking settled choices again/i);
  expect(steps).toMatch(/queue the next skill/i);
  expect(steps).toMatch(/refresh the cache, run telemetry last/i);

  ordered(section, ['## Closing sequence', '{{CODEX_PLAN_REVIEW}}', '## Resolve remaining TODO choices',
    '### TODOS.md updates', '{{PLAN_REVIEW_APPROVAL_CHECK}}', '## Required Outputs',
    '{{PLAN_FILE_REVIEW_REPORT}}', '## Review Log', '{{REVIEW_DASHBOARD}}', '## Next Steps — Review Chaining',
    '## docs/designs Promotion', '{{LEARNINGS_LOG}}', '{{GBRAIN_SAVE_RESULTS}}', '{{BRAIN_WRITE_BACK}}',
    "Return to this skill's main `SKILL.md`: Section self-check → EXIT PLAN MODE GATE."]);
  expect(section).not.toContain('{{EXIT_PLAN_MODE_GATE}}');
  expect(section).not.toContain('{{BRAIN_CACHE_REFRESH}}');
  expect(section).not.toContain('Run the preamble\'s **Telemetry');

  const actualGate = skeleton.indexOf('{{EXIT_PLAN_MODE_GATE}}');
  expect(actualGate).toBeGreaterThan(skeleton.indexOf('## Section self-check'));
  const terminal = skeleton.slice(actualGate);
  const success = compactProse(terminal.split('**Passed with a verified persisted report:**')[1]!);
  ordered(success, [/finish the cache refresh below/i, '{{BRAIN_CACHE_REFRESH}}',
    '**Telemetry (run last)** once', /the review is now finished/i, 'Call ExitPlanMode',
    /next-skill handoff starts a separate workflow/i]);
  expect(terminal).not.toMatch(/return to (?:the )?section|Closing hooks/);
  for (const host of ALL_HOST_CONFIGS) {
    const refresh = compactProse(generateBrainCacheRefresh({ skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext));
    expect(refresh).toMatch(/after the exit gate passes, start this nonblocking refresh before telemetry/i);
    expect(refresh).toMatch(/return to the finalization instructions/i);
    expect(refresh).not.toContain('telemetry has logged');
  }

  const askQuestions = section.search(ASK_QUESTIONS_HEADING);
  const governingStages = [askQuestions, ...['## Formatting Rules',
    '## Mode Quick Reference', '### Working review decisions', '### Section 1:']
    .map(stage => section.indexOf(stage))];
  expect(governingStages.every(position => position >= 0)).toBe(true);
  expect(governingStages).toEqual([...governingStages].sort((a, b) => a - b));
  const questions = section.slice(askQuestions).split('\n').slice(1).join('\n').split('## Mode Quick Reference')[0]!;
  expect(questions).toContain('Use `D<N>` and A/B/C labels');
  expect(compactProse(questions)).toMatch(/cite the stable ledger ID separately/i);
  const formatting = questions.split('## Formatting Rules')[1]!;
  expect(formatting).toMatch(/0D's exact `currentDecision` question and option descriptions/i);
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
      expect(procedure).toContain('0D\'s Plan decision route through its post-answer save, then return here to Apply');
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
  const source = skeletonSource();
  const cycle = compactProse(between(source, '### 0D.', '### 0E.'));
  const built = between(cycle, 'Build one `currentDecision`', '**Pre-question checkpoint:**');
  const checkpoint = between(cycle, '**Pre-question checkpoint:**', '**4. Ask');
  const dispatch = between(cycle, '**4. Ask', '**Post-answer checkpoint:**');

  test('CEO constructs and verifies one complete row decision before dispatch', () => {
    ordered(cycle, ['**2. Record the pending choice.**', /cite the source filename\/message/i,
      "**3. Compare and save that row's options.**", 'Build one `currentDecision`', /score this row's coverage differences/i,
      '**Pre-question checkpoint:**', '**Read-back.**', '**4. Ask, record the answer, and amend.**',
      /copy the verified read or chat text into one native arguments object/i,
      /compare its question, header, labels and full descriptions literally/i, /ask one row per call with that object unchanged/i,
      /stop for the actual answer/i, /save the answer reference and scope/i, '**Post-answer checkpoint:**']);
    for (const field of ['| `question` | Full brief:', '| `header` and option labels |', 'Project, ELI10, Stakes, Recommendation',
      'offer 2–3 options', '1–2 sentence summary', 'S/M/L/XL effort', 'low/medium/high risk', 'reuse, verification coverage',
      'Note: options differ in kind, not coverage — no completeness score.']) expect(built).toContain(field);
    for (const field of ['## currentDecision (ROW-ID)', 'Commitment comparison: <complete grid>',
      'Question: <complete currentDecision.question>', 'Header: <exact currentDecision.header>',
      '<full first option description>', '<full second option description; repeat for all offered options>']) expect(checkpoint).toContain(field);
    expect(checkpoint).toMatch(/not a grid, summary or pointer/i);
    expect(checkpoint).toMatch(/verify IDs and fields against `currentDecision`, citations against source/i);
    // Native 043a questions were recomposed after title-only saves; the final
    // Edit ACK also said a Read was unnecessary.
    expect(checkpoint).toMatch(/replace the whole payload on revision/i);
    expect(checkpoint).toMatch(/read despite Edit's current-in-context hint/i);
    expect(checkpoint).toMatch(/correct mismatches, save and read again before dispatch/i);
    // The 6aef retry rewrote its saved fields in the actual call; bind the
    // outgoing object to the saved strings at the dispatch boundary.
    expect(dispatch).toContain('{questions: [{question, header, options: [{label, description}, ...]}]}');
    expect(dispatch).toMatch(/ignoring only saved selector prefixes/i);
    expect(dispatch).toMatch(/compare strings, not format\/scores/i);
    expect(dispatch).toMatch(/changes repeat step 3's save and read-back/i);
  });

  test('CEO finishes native field identity and tradeoffs before saving, then reads the entire payload', () => {
    // Native 749df paired retry omitted its row ID; final labels/tradeoffs also drifted.
    expect(built).toContain('`D<N> — <ROW-ID>: <one-line question>`');
    expect(built).toMatch(/D counts questions; ROW-ID identifies the pending choice/i);
    expect(built).toMatch(/exactly one label includes `\(recommended\)`/i);
    expect(built).toContain("| Each option's `description` |");
    expect(built).toContain('at least 2 ✅ pros and 1 ❌ con');
    expect(built).toMatch(/within host limits/i);
    expect(built).toMatch(/destructive-choice exception/i);
    expect(checkpoint).toMatch(/through the last option's description/i);
    expect(checkpoint).toMatch(/fetch continuations/i);
  });

  test('CEO save verification retains forbidden-write, failed-save, automatic and changed-decision branches', () => {
    const policy = compactProse(between(source, '**Storage policy: choose before writing.**', '| ID and owner |'));
    expect(policy).toMatch(/when writing is forbidden, continue analysis and decisions without writing/i);
    expect(policy).toContain('**not persisted**');
    expect(policy).toContain('**completion blocked**');
    expect(policy).toMatch(/no completion log, success telemetry, ExitPlanMode or next-skill handoff/i);
    expect(policy).toMatch(/stop with the cause; chat cannot replace a failed save/i);
    expect(between(policy, '| 0H spec-review metrics |', '| Review, decision')).toMatch(/stop with the cause; reviewer availability does not waive this write/i);
    const history = policy.split('| Review, decision and question history logs |')[1]!;
    expect(history).toMatch(/report cause and unsaved fields; continue/i);
    expect(history).toMatch(/the plan's ledger is still required/i);
    expect(cycle).toMatch(/for chat, verify the complete text labeled \*\*not persisted\*\*/i);
    expect(cycle).toMatch(/only the preamble can authorize prose or auto-decision transport/i);
    expect(dispatch).toMatch(/only a preamble-authorized auto-decision resolves this wait/i);
  });
});
