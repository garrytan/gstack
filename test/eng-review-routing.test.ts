import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateBrainWriteBack } from '../scripts/resolvers/gbrain';
import { generateAskUserFormat } from '../scripts/resolvers/preamble/generate-ask-user-format';
import { generateTestCoverageAuditPlan, generateTestCoverageAuditShip } from '../scripts/resolvers/testing';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ENG_REVIEW_EXCERPT } from './helpers/workflow-excerpt';

const entry = readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8');
const section = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
const compact = (text: string) => text.replace(/\s+/g, ' ');

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

function ordered(text: string, stages: string[]) {
  const positions = stages.map(stage => text.indexOf(stage));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

const scope = section.split('## Scope Challenge\n')[1]?.split('## Review Sections')[0] ?? '';
const assessment = scope.split('### A. Assess the target')[1]?.split('### B. Resolve complexity selectors')[0] ?? '';
const complexity = scope.split('### B. Resolve complexity selectors')[1]?.split('### C. Resolve findings')[0] ?? '';
const findings = scope.split('### C. Resolve findings')[1] ?? '';
const recovery = entry.split('## Recovery routing')[1]?.split('{{EXIT_PLAN_MODE_GATE}}')[0] ?? '';

describe('engineering review routing contracts', () => {
  test('the bounded engineering excerpt includes the recovery rules it references', () => {
    const excerpt = between(entry, ENG_REVIEW_EXCERPT.startMarker, ENG_REVIEW_EXCERPT.endMarker);
    ordered(excerpt, ['{{SECTION:review-sections}}', '## Recovery routing', '**Paused question:**',
      '**Repairable write/read failure:**', '**Late change or missing work:**', '**Blocked outcome:**']);
    expect(compact(entry.slice(entry.indexOf(ENG_REVIEW_EXCERPT.endMarker)))).toContain('use Recovery routing above');
  });

  test('preparation establishes permission and evidence before applying review rules', () => {
    const preparation = between(section, '## Review preparation', '## Review record and write policy');
    ordered(preparation, ['1. Select the report file and permissions under **Review record and write policy**', '2. Run **Prior Learnings**',
      '3. Run **Retrospective learning**', '4. Read **Confidence Calibration**', '**Decision procedure**',
      '**Scope Challenge A → B → C**', 'Sections 1–4 in order']);
    expect(compact(preparation)).toContain('Run **Prior Learnings** and resolve its configuration question');
    expect(compact(preparation)).toContain('as rules, not review passes');
    expect(entry).toContain('Keep the reviewed target fixed');
  });

  test('compression cannot remove mandatory review stages or decision content', () => {
    const priority = between(entry, '## Priority hierarchy', '## My engineering preferences');
    expect(compact(priority)).toContain('Complete every required stage, decision gate and output');
    expect(compact(priority)).toContain('Shorten only optional commentary');
    expect(compact(priority)).toContain('never Scope Challenge, Sections 1–4, the test diagram or required decision/report content');
    expect(priority).not.toContain('Everything else');
    expect(compact(section)).toContain('Never condense, abbreviate or skip a section');
  });

  test('Scope Challenge has one named route and completes all seven assessments first', () => {
    expect([...scope.matchAll(/^### (.+)$/gm)].map(match => match[1])).toEqual([
      'A. Assess the target', 'B. Resolve complexity selectors', 'C. Resolve findings',
    ]);
    expect([...assessment.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(match => match[1])).toEqual([
      'What already solves each sub-problem?', 'What minimum changes achieve the goal?',
      'Complexity check:', 'Search check:', 'TODOS cross-reference:', 'Completeness check:', 'Distribution check:',
    ]);
    expect(compact(assessment)).toContain('Complete these checks before the complexity decision in B');
    expect(compact(assessment)).toContain('Do not apply scope changes or write findings into the plan yet');
    expect(scope).not.toContain('Below the threshold, start at step 1');
  });

  test('below-threshold route skips selectors, never findings or remedy approvals', () => {
    expect(compact(complexity)).toContain("Below both thresholds, skip B's questions and go directly to **C. Resolve findings**");
    expect(findings).toContain('Run C whether B was completed or skipped');
    ordered(compact(findings), ['1. Present numbered Scope Challenge findings',
      '2. Resolve each remedy through Decision procedure',
      '3. Report accepted/rejected/deferred/pending dispositions',
      'Continue to Section 1 only when no answer is pending']);
    expect(findings).toContain('Findings and scope answers approve no remedies');
    expect(findings).toContain('"No issues found" for an empty list');
  });

  test('high complexity retains separate cuts and mandatory arrangement choice', () => {
    expect(compact(complexity)).toContain('At 8+ files or 2+ new classes/services, STOP before Section 1');
    ordered(compact(complexity), ['Initial scope selectors need no grid or **pre-answer** ledger write',
      '1. Explain the complexity', 'Ask each proposed feature cut/deferral separately',
      '2. Always ask the structure question when this gate trips, even with no cuts',
      '3. Save the actual feature and structure answers as one scope record']);
    expect(compact(complexity)).toContain('With no proposed cuts, keep the feature list and go directly to the structure question');
    expect(compact(complexity)).toContain('Both retain the same approved feature list, contracts and approved security/error/test/performance fixes');
    expect(compact(complexity)).toContain('Pending remedies not decided here: <ids>');
  });

  test('no safe smaller arrangement does not authorize scope cuts or bypass the pause', () => {
    ordered(compact(complexity), ['If no smaller arrangement preserves these commitments',
      'offer confirmation of the original arrangement or a pause to investigate a smaller one',
      'A pause leaves the arrangement undecided', 'then return to this structure selector',
      'Do not continue to C until it is settled']);
    expect(compact(complexity)).toContain('investigate only the agreed question');
  });

  test('selector answers are verified after answering without invented pending records', () => {
    const summary = compact(complexity.slice(complexity.indexOf('3. Save the actual')));
    ordered(summary, ['feature answers: <refs>; structure: <A/B + ref>; accepted scope: <exact scope>; pending remedies: <ids or none>',
      'post-answer scope summary, not a remedy\'s pending ledger record', 'Read it back against the actual answers',
      'After verification, apply only accepted scope changes', 'Continue to **C. Resolve findings**']);
    expect(summary).toContain('Do not invent a pre-answer record afterward');
    expect(summary).toContain('A failed save or Read blocks advancement');
    expect(summary).toContain('on the permitted read-only route, present and verify it as **not persisted**');
    expect(compact(section)).toContain('Scope Challenge B saves actual selector answers afterward; it does not use this remedy loop');
  });

  test('engineering remedies still require full save Read ask answer apply Read ordering', () => {
    const procedure = between(section, '## Decision procedure', '## Scope Challenge');
    ordered(procedure, ['### 3. Compare one choice', '### 4. Save the pending record',
      'use Read to fetch the entire saved record', '### 5. Ask and wait',
      'AskUserQuestion({ questions: [currentDecision] })', '**STOP until the actual answer arrives.**',
      '### 6. Apply and refresh', 'Read the entire resolution block, including State',
      'Return to step 1 with the updated working plan and answer']);
    expect(compact(procedure)).toContain('An Investigate/Defer option must bound the investigation');
    expect(compact(procedure)).toContain('It approves no implementation, including a conditional fix');
    expect(compact(procedure)).toContain('Do not apply a remedy, make another call, start the next section or call ExitPlanMode while the choice awaits an answer');
    expect(compact(procedure)).toContain("Apply the preamble's Completeness scores or kind-note accordingly");
    const questions = generateAskUserFormat({ skillName: 'plan-eng-review', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext);
    expect(questions).toContain('10 = complete, 7 = happy path, 3 = shortcut');
    expect(questions).toContain('Note: options differ in kind, not coverage — no completeness score.');
  });

  test('unavailable research preserves an explicit coverage limit and continues review', () => {
    expect(compact(assessment)).toContain('If Aside is unavailable, use host WebSearch for these queries');
    expect(compact(assessment)).toContain('With neither, skip and note: "Search unavailable — proceeding with in-distribution knowledge only."');
    const outside = between(section, '### Continue after Outside Voice', '### TODOS.md updates');
    expect(compact(outside)).toContain('Only completed reviews enter Cross-model tension');
    expect(compact(outside)).toContain('Record the actual coverage, including disabled or unavailable outcomes');
    expect(section).toContain('Outside voice: recorded provider, completed / unavailable / disabled / skipped (reason)');
    expect(compact(outside)).toContain('Resolve the TODO choices, then check Approval readiness before Required outputs');
  });

  test('paused transport and failed persistence have distinct non-success outcomes', () => {
    const pause = between(recovery, '**Paused question:**', '**Repairable write/read failure:**');
    expect(pause).toContain('without completion telemetry or ExitPlanMode');
    expect(compact(pause)).toContain('may have surfaced is still pending; do not duplicate it');
    const failure = between(recovery, '**Repairable write/read failure:**', '**Late change or missing work:**');
    expect(compact(failure)).toContain('Stop before the dependent question or output');
    expect(compact(failure)).toContain('If no recovery is specified or it fails, follow **Blocked outcome**');
    expect(compact(failure)).toContain('Never turn a failed permitted save into a chat-only success');
    const policy = between(section, '## Review record and write policy', '{{LEARNINGS_SEARCH}}');
    expect(compact(policy)).toContain('not the forbidden-write branches above');
    expect(compact(policy)).toContain('Best-effort logs retain their stated non-blocking behavior');
    expect(recovery).toContain('`OUTCOME=error`');
    expect(recovery).not.toContain('`OUTCOME=success`');
  });

  test('late changes rerun affected approvals and outputs before another navigation answer', () => {
    const late = compact(between(recovery, '**Late change or missing work:**', '**Blocked outcome:**'));
    ordered(late, ['Return to the affected review stage', 'new or reopened choices use Decision procedure',
      'Repeat Approval readiness', 'Required outputs steps 1–4', 'before choosing navigation again']);
    expect(late).toContain('Refresh affected tests, tasks, dependencies and parallelization');
    expect(late).toContain('Unchanged saved outputs may reuse their successful Review Log');
    expect(late).toContain('If a final gate discovers stale evidence, follow **Blocked outcome** first');
    const finish = between(section, '## Required outputs', '### Output reference');
    expect(compact(finish)).toContain('A substantive change follows **Recovery routing → Late change or missing work** before navigation resumes');
    expect(compact(finish)).toContain('Navigation grants no implementation authority');
    ordered(finish, ['1. **Prepare the review body.**', '2. **Save and Read back.**',
      '3. **Log the saved review.**', '4. **Publish.**', '5. **Choose navigation.**', '6. **Finish.**']);
  });

  test('plan test diagrams cover proposed paths without inventing existing implementation', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const ctx = { skillName: 'plan-eng-review', host: host.name, paths: HOST_PATHS[host.name] } as TemplateContext;
      const audit = generateTestCoverageAuditPlan(ctx);
      expect(audit).toContain('For each existing or proposed component in the selected target');
      expect(audit).toContain('Every existing or proposed function/method in scope');
      expect(audit).toContain('the selected target. For each existing or proposed feature');
      expect(audit).toContain('Future paths remain proposals, not runnable code');
      for (const obligation of ['Every conditional branch', 'Every error path', 'Every call to another function',
        'Every edge:', 'dedicated tool call before drawing the diagram', 'No skipping regression coverage']) {
        expect(audit).toContain(obligation);
      }
      const ship = generateTestCoverageAuditShip({ ...ctx, skillName: 'ship' });
      expect(ship).toContain('For each changed file, draw an ASCII diagram showing:');
      expect(ship).toContain('Every function/method that was added or modified');
      expect(ship).toContain('the changed code. For each changed feature');
      expect(ship).not.toContain('existing or proposed');
    }
  });

  test('reserved calibration gate is explicitly skipped without enabling a write path', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const ctx = { skillName: 'plan-eng-review', host: host.name, paths: HOST_PATHS[host.name] } as TemplateContext;
      const output = generateBrainWriteBack(ctx);
      ordered(output, ['reserved default-off gate', 'this runtime does not set it',
        'Skip this section and continue the finish sequence', 'Do not enable it or infer permission from brain availability',
        'not an instruction to write now', 'Skip unless']);
      expect(output).toContain('brain_trust_policy@<endpoint-hash>=personal');
      expect(output).toContain('If unknown, skip');
      expect(output).toContain('mcp__gbrain__takes_add');
      expect(output).toContain('mcp__gbrain__put_page');
      expect(output).toContain('source_skill: plan-eng-review');
      expect(output).not.toContain('${BRAIN_CALIBRATION_WRITEBACK');
      for (const skillName of ['office-hours', 'plan-ceo-review', 'plan-design-review', 'plan-devex-review']) {
        const other = generateBrainWriteBack({ ...ctx, skillName });
        expect(other).toStartWith('## Brain Calibration Write-Back (gated)\n\nSkip unless');
        expect(other).not.toContain('reserved default-off gate');
        expect(other).not.toContain('Skip this section and continue the finish sequence');
      }
    }
  });
});
