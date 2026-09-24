import { describe, expect, test } from 'bun:test';
import { pickDevexCheckpointQuestion, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGeneration } from '../scripts/gen-skill-docs';
import { generateAntiShortcutClause, generateCodexPlanReview, generatePlanFileReviewReport } from '../scripts/resolvers/review';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateTestCoverageAuditPlan } from '../scripts/resolvers/testing';
import { ALL_HOST_CONFIGS } from '../hosts';
import { runCapturedCommand } from './helpers/sync-command-capture';

const compactProse = (value: string) => value.replace(/\s+/g, ' ').trim();

describe('CI workflow clarity regressions', () => {
  test('CEO defines narrow depth and sends settled initial choices directly to mode selection', () => {
    const source = compactProse(readFileSync('plan-ceo-review/SKILL.md.tmpl', 'utf8'));
    expect(source).toContain('For one narrow decision, apply every section to that choice and its dependencies');
    const route = source.split("**Choose the question's route first:**")[1]!.split('**1. Check sources')[0]!;
    expect(route).toContain('Use its listed menu and the preamble question transport, then wait and record the answer');
    expect(route).toContain('Skip steps 1–4; this approves no plan changes');
    expect(route).toContain('Start at step 1. Reuse exact prior approvals; run steps 2–4 only when a new answer is needed, even for one option');
    expect(route).toContain('If an admin answer requests a plan change, use the Plan decision route for that change');
    expect(source).toContain('**Pre-question checkpoint:**');
    expect(source).toContain('**Post-answer checkpoint:**');
    expect(source).toContain('With no required choice, or after those choices settle, go to 0E');
    expect(source).not.toContain('skip the lookup and ask below');
  });

  test('Eng defines evidence paths and gives its setup selector short labels with complete descriptions', () => {
    const source = compactProse(readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8'));
    expect(source).toContain('Plan: named existing paths');
    expect(source).toContain('Mark named future paths `not available`');
    expect(source).toContain('history proves nothing about proposed behavior. Never invent paths');
    expect(source).toContain('Branch diff: changed files');
    expect(source).toContain('File/directory: selected path');
    expect(source).toContain('Prior Learnings configuration');
    expect(source).toContain('Use labels `Original arrangement` and `Smaller arrangement`');
    expect(source).toContain("put files/classes in each description. Both retain the same approved feature list");
    expect(source).toContain('Include `Pending remedies not decided here: <ids>` in the question');
    expect(source).not.toContain('`A) Original arrangement: <files/classes>; fixed features: <approved list>`');
  });

  test('plan coverage definitions precede the uninterrupted trace sequence', () => {
    const source = generateTestCoverageAuditPlan({ skillName: 'plan-eng-review', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext);
    const definition = source.indexOf('Definition: a **targeted audit**');
    const trace = source.indexOf('**Step 1. Trace every codepath in the plan:**');
    expect(definition).toBeGreaterThanOrEqual(0);
    expect(definition).toBeLessThan(trace);
    const first = source.slice(source.indexOf('1. **Read the plan.**', trace), source.indexOf('2. **Trace data flow.**', trace));
    expect(first).toContain('dedicated tool call before drawing the diagram');
    expect(first).not.toContain('Definition:');
    expect(first).not.toContain('before Step 2');
    const compact = compactProse(source);
    expect(compact).toContain('For every target, run these five Test steps inside Section 3, after Scope Challenge and the Architecture/Code Quality reviews. Do not restart them');
    expect(compact).toContain('Within Test step 1, read concrete source/tests before tracing or diagramming; Test step 2 adds user flows');
    expect(compact).toContain('Future paths remain proposals, not runnable code');
  });

  test('CEO fallback names the current host mode and needs completed findings before the later report exists', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const source = generateCodexPlanReview({ skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name] } as TemplateContext);
      const mode = host.name === 'codex' ? 'under_current_harness' : 'under_codex';
      expect([...new Set(source.match(/under_codex|under_current_harness/g))]).toEqual([mode]);
      expect(source).toContain('A completed native fallback uses SOURCE=in-host, OUTSIDE_STATUS=unavailable, and STATUS=clean or issues_found from its findings');
      expect(compactProse(source)).toContain('Sections 1-10/11, findings and decision ledger; the final report is written later in Required Outputs');
      expect(source).not.toContain('Sections 1-10/11 and current report');
    }
  });
});

const menu = (labels: string[], header = 'Next review', question = "D12 — What's next?"): NativeQuestion => ({
  header, question, multiSelect: false, options: labels.map(label => ({ label, description: 'Offered choice' })),
});

// Generated instruction ordering only; native completion remains a paid check.
describe('plan report persistence precedes completion logging', () => {
  test('Eng required Review Log failure stops before best-effort decision logging', () => {
    const template = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
    const logSection = template.split('## Review Log')[1]!.split('{{REVIEW_DASHBOARD}}')[0]!;
    const block = logSection.match(/```bash\n([\s\S]*?)\n```/)?.[1];
    expect(block).toBeDefined();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'eng-required-log-')));
    try {
      const bin = join(root, 'bin'); mkdirSync(bin);
      // These are freshly created ordinary files inside this isolated root;
      // never write through a host skill-registration symlink.
      expect(realpathSync(bin)).toBe(join(root, 'bin'));
      for (const [name, label, exitVar] of [
        ['gstack-review-log', 'required', 'FIXTURE_REVIEW_EXIT'],
        ['gstack-decision-log', 'decision', 'FIXTURE_DECISION_EXIT'],
      ]) writeFileSync(join(bin, name!), `#!/bin/sh\nprintf '%s\\n' '${label}' >> "$FIXTURE_CALL_LOG"\nexit "$${exitVar}"\n`, {mode: 0o755, flag: 'wx'});
      const command = block!.replaceAll('~/.claude/skills/gstack/bin/', `'${bin}/'`);
      expect(command).not.toContain('~/.claude/skills');
      for (const [reviewExit, decisionExit, expectedExit, calls] of [
        [23, 0, 23, ['required']],
        [0, 0, 0, ['required', 'decision']],
        [0, 17, 0, ['required', 'decision']],
      ] as const) {
        const file = join(root, `calls-${reviewExit}-${decisionExit}`);
        const result = runCapturedCommand('bash', ['-c', command], {cwd: root,
          env: {...process.env, FIXTURE_CALL_LOG: file, FIXTURE_REVIEW_EXIT: String(reviewExit), FIXTURE_DECISION_EXIT: String(decisionExit)},
          timeout: 5000, captureStdout: true});
        expect(result.status, result.stderr).toBe(expectedExit);
        expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual([...calls]);
      }
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  const plans = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'];
  for (const skill of plans) {
    test(`${skill}: save/readback gate precedes its log and dashboard`, () => {
      const template = readFileSync(`${skill}/sections/review-sections.md.tmpl`, 'utf8');
      const report = template.indexOf('{{PLAN_FILE_REVIEW_REPORT}}');
      const log = template.indexOf('## Review Log');
      const dashboard = template.indexOf('{{REVIEW_DASHBOARD}}');
      expect(report).toBeGreaterThan(0);
      expect(report).toBeLessThan(log);
      expect(log).toBeLessThan(dashboard);
      expect(template.match(/\{\{PLAN_FILE_REVIEW_REPORT\}\}/g)).toHaveLength(1);
      const logPolicy = template.slice(log, dashboard);
      if (skill === 'plan-eng-review') {
        expect(logPolicy).toContain('after successful Read-back');
        expect(logPolicy).toContain('required review log and best-effort decision log each follow the write policy');
        expect(compactProse(template)).toContain('If the required log is forbidden, show its fields as not persisted and take **Blocked outcome**');
        expect(compactProse(template)).toContain('Neither case supplies completion or saved-dashboard credit');
        expect(logPolicy).toContain('FULL_REVIEW for the Scope Challenge result "scope accepted as-is"; SCOPE_REDUCED for "scope reduced per recommendation"');
      } else if (skill === 'plan-ceo-review') {
        const policy = compactProse(logPolicy);
        expect(policy).toContain('successful write and Read-back');
        expect(policy).toContain('A failed plan/report save or verification stops before this block');
        expect(policy).toContain('Both history commands below are best-effort');
        expect(policy).toContain('retain its diagnostic, show its actual unsaved fields');
        expect(policy).toContain('do not claim that entry was recorded');
      } else {
        expect(logPolicy).toContain('successful write and Read-back');
        expect(logPolicy).toContain('report the error and stop');
      }
    });
  }
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: current report does not depend on a premature completion record`, () => {
      for (const skillName of plans) {
        const report = generatePlanFileReviewReport({ skillName, host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext);
        // PLAN.md may be the review input while REPORT.md is the requested output.
        const target = report.slice(report.indexOf(skillName === 'plan-eng-review'
          ? '### Use the selected report file' : '### Detect the plan file'), report.indexOf('### Generate the report'));
        if (skillName === 'plan-eng-review') {
          expect(target).toContain("Use the report file already selected under **Review record and write policy**");
          expect(target).toContain("Do not choose another destination here");
          expect(target).toContain("Do not choose another destination here");
          expect(target).not.toContain('host active plan');
        } else {
          expect(target).toContain('Use an explicitly requested output/report file first.');
          expect(target).toContain('Otherwise use the reviewed plan named by the user, then the host active plan.');
        }
        if (skillName === 'plan-ceo-review') {
          expect(target).toContain('Without a permitted file, produce the complete reviewed plan and report in chat');
          expect(target).not.toContain('skip this section');
        } else if (skillName !== 'plan-eng-review') {
          expect(target).toContain('If no file is in scope, skip this section');
        }
        if (skillName === 'plan-eng-review') {
          expect(target).toContain('Review record and write policy');
          const writer = report.slice(report.indexOf('### Write to the report file'));
          expect(writer).not.toContain('PLAN MODE EXCEPTION — ALWAYS RUN');
          expect(writer).toContain('If the report destination is absent or writing is forbidden');
          expect(writer).toContain('labeled not persisted');
          expect(writer).toContain('Do not run the file-writing steps below');
          expect(writer).toContain('re-read the report file and retry once');
          expect(writer).toContain('Do NOT replace the section in place; delete it and append the new report at EOF');
        }
        expect(report).toContain('prior review entries');
        expect(report).toContain('current Completion Summary');
        if (['plan-ceo-review', 'plan-eng-review'].includes(skillName)) {
          expect(report).not.toContain('DX Scorecard');
          expect(report).toContain('Display `clean` as CLEAR and `issues_open` as ISSUES OPEN');
          expect(report).toContain('retaining freshness and not-persisted labels');
        } else expect(report).toContain('current Completion Summary or DX Scorecard');
        expect(report).toContain('add exactly one to its prior run count');
        expect(report).toContain('Do not pre-log this run');
        expect(report).toContain('full review output');
        if (skillName === 'plan-ceo-review') {
          const writer = compactProse(report.slice(report.indexOf('### Write to the plan file')));
          expect(writer).toContain('If no destination is selected or writing is forbidden');
          expect(writer).toContain("Follow Stage 3's blocked chat return; no completed-review log or handoff");
          expect(writer).toContain('If the destination file exists, Read it now, whether or not step 2 deleted a report');
          expect(writer).toContain('Use Edit with the suffix from this Read, or Write the complete file');
          expect(writer).toContain('If the destination file does not exist, use Write to create the complete file');
          expect(writer).toContain('Save the complete updated plan and review body with the new `## GSTACK REVIEW REPORT` at EOF');
          expect(writer).toContain('In both cases, keep the report last and continue to the Read-back gate');
          expect(writer.indexOf('4. **Read-back gate:**')).toBeGreaterThan(writer.indexOf('In both cases, keep the report last'));
        } else expect(report).toContain('whether or not a prior report existed');
        expect(report).toContain(skillName === 'plan-eng-review'
          ? 'report the error and follow **Blocked outcome** before Review Log or decision logging'
          : 'stop before Review Log or decision logging');
        expect(report.indexOf('Read-back gate')).toBeGreaterThan(report.indexOf(skillName === 'plan-eng-review' ? '### Write to the report file' : '### Write to the plan file'));
        expect(report).not.toContain('After displaying the Review Readiness Dashboard');
        expect(report).not.toContain('review log output you already have');
      }
      for (const skillName of ['codex', 'devex-review']) {
        const report = generatePlanFileReviewReport({ skillName, host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext);
        expect(report).toContain('After displaying the Review Readiness Dashboard');
        expect(report).not.toContain('Do not pre-log this run');
      }
    });
  }
  test('every generated plan-review carrier keeps write/readback before log before dashboard', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'review-persistence-order-'));
    try {
      const generated = await runGeneration({ host: 'all', outputRoot, contentLinkRoot: null, log: () => {} });
      expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
      const carriers = generated.artifacts.filter(artifact => artifact.host === 'claude'
        ? artifact.kind === 'section' && plans.some(skill => artifact.relativePath === `${skill}/sections/review-sections.md`)
        : artifact.kind === 'skill' && plans.some(skill => artifact.relativePath.endsWith(`/gstack-${skill}/SKILL.md`)));
      expect(carriers).toHaveLength(plans.length * ALL_HOST_CONFIGS.length);
      for (const carrier of carriers) {
        const content = readFileSync(join(outputRoot, carrier.relativePath), 'utf8');
        if (carrier.relativePath.includes('plan-eng-review/')) {
          const dispatch = compactProse(content.slice(content.indexOf('### 4. Save the pending record'), content.indexOf('## Scope Challenge')));
          expect(compactProse(dispatch)).toContain('AskUserQuestion({ questions: [currentDecision] })');
          expect(dispatch.indexOf("**STOP until the actual answer arrives.**")).toBeLessThan(dispatch.indexOf('### 6. Apply and refresh'));
          expect(dispatch.indexOf('### 6. Apply and refresh')).toBeLessThan(dispatch.indexOf('Return to step 1'));
        }
        const report = content.indexOf('\n## Plan File Review Report\n');
        const readback = content.indexOf('**Read-back gate:**', report);
        const log = content.indexOf('\n## Review Log\n');
        const dashboard = content.indexOf('\n## Review Readiness Dashboard\n');
        expect({ carrier: carrier.relativePath, ordered: 0 < report && report < readback && readback < log && log < dashboard }).toMatchObject({ ordered: true });
        expect(content.slice(report, readback)).toContain('current Completion Summary');
        expect(content.slice(readback, log)).toContain(carrier.relativePath.includes('plan-eng-review/')
          ? 'report the error and follow **Blocked outcome** before Review Log or decision logging'
          : 'stop before Review Log or decision logging');
      }
    } finally { rmSync(outputRoot, { recursive: true, force: true }); }
  }, 30_000);
});

test('Eng loads its one remedy procedure before Scope Challenge findings and retains consent', async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'eng-decision-order-'));
  let rendered: { skeleton: string; sections: string };
  try {
    const generated = await runGeneration({ host: 'claude', outputRoot, contentLinkRoot: null });
    expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
    rendered = {
      skeleton: readFileSync(join(outputRoot, 'plan-eng-review/SKILL.md'), 'utf8'),
      sections: readFileSync(join(outputRoot, 'plan-eng-review/sections/review-sections.md'), 'utf8'),
    };
  } finally { rmSync(outputRoot, { recursive: true, force: true }); }
  for (const suffix of ['.tmpl', '']) {
    const skeleton = suffix ? readFileSync(`plan-eng-review/SKILL.md${suffix}`, 'utf8') : rendered.skeleton;
    const sections = suffix ? readFileSync(`plan-eng-review/sections/review-sections.md${suffix}`, 'utf8') : rendered.sections;
    const reviewBoundary = skeleton.indexOf('Do not build features, acceptance suites or benchmarks unless explicitly authorized by the user');
    expect(reviewBoundary).toBeGreaterThan(skeleton.indexOf('# Plan Review Mode'));
    expect(reviewBoundary).toBeLessThan(skeleton.indexOf('## Scope gate'));
    expect(skeleton.slice(reviewBoundary, skeleton.indexOf('## Scope gate'))).toContain('Use existing tests, examples or bounded probes of current behavior for evidence');
    const rule = sections.indexOf('## Decision procedure');
    expect(rule).toBeGreaterThan(0);
    expect(rule).toBeLessThan(sections.indexOf('## Scope Challenge'));
    const procedureBody = compactProse(sections.slice(rule, sections.indexOf('## Scope Challenge')));
    expect(sections.match(/^## Decision procedure$/gm)).toHaveLength(1);
    expect(compactProse(procedureBody)).toContain("Keep one behavior with its necessary code, tests and documentation");
    expect(compactProse(procedureBody)).toContain("one question object for one choice");
    const dispatch = procedureBody.slice(procedureBody.indexOf('### 4. Save the pending record'));
    const loop = ['### 5. Ask and wait', 'AskUserQuestion({ questions: [currentDecision] })',
      "**STOP until the actual answer arrives.**", '### 6. Apply and refresh',
      'Return to step 1'].map(step => dispatch.indexOf(step));
    expect(loop.every(index => index >= 0)).toBe(true);
    expect(loop).toEqual([...loop].sort((a, b) => a - b));
    expect(compactProse(dispatch)).toContain('one question object for one choice; other IDs wait');
    expect(procedureBody).toContain('target and Scope Challenge complexity selectors—use local rules without a pre-answer ledger');
    expect(procedureBody).toContain('These answers approve no engineering remedy');
    expect(compactProse(dispatch)).toContain("Use the preamble's tool resolution, failure fallback and authorized auto-decision rules");
    expect(compactProse(dispatch)).toContain("Do not apply a remedy, make another call, start the next section or call ExitPlanMode while the choice awaits an answer");
    expect(compactProse(dispatch)).toContain("Return to step 1 with the updated working plan and answer");
    expect(compactProse(dispatch)).toContain("Keep chosen values fixed in later questions");
    expect(compactProse(dispatch)).toContain('/autoplan uses its authorized decisions and audit trail');
    expect(compactProse(procedureBody)).toContain("Separate instrumentation, follow-ups, guarantees and policies need their own choices");
    expect(skeleton).not.toContain('**Decisions (including Step 0):**');
    expect(skeleton).not.toContain('For every issue or recommendation');
    const scope = compactProse(sections.slice(sections.indexOf('## Scope Challenge'), sections.indexOf('## Review Sections')));
    expect(compactProse(scope)).toContain('8+ files or 2+ new classes/services');
    expect(compactProse(scope)).toContain('STOP before Section 1');
    expect(compactProse(scope)).toContain("Use the preamble's decision-brief format for this complexity gate");
    expect(compactProse(scope)).toContain('Ask each proposed feature cut/deferral separately; wait before changing scope');
    expect(compactProse(scope)).toContain('Compare only the file/class arrangement');
    expect(compactProse(scope)).toContain('Both retain the same approved feature list');
    expect(compactProse(scope)).toContain('contracts and approved security/error/test/performance fixes');
    expect(compactProse(scope)).toContain('unapproved fixes stay pending');
    expect(compactProse(scope)).toContain('Always ask the structure question when this gate trips, even with no cuts');
    expect(compactProse(scope)).toContain('With no proposed cuts, keep the feature list and go directly to the structure question');
    expect(compactProse(scope)).toContain('If no smaller arrangement preserves these commitments');
    expect(compactProse(scope)).toContain('offer confirmation of the original arrangement or a pause to investigate a smaller one. Wait for the answer');
    expect(compactProse(scope)).toContain('Resolve each remedy through Decision procedure, reusing exact answers');
    const complexityRule = scope.indexOf('Initial scope selectors need no grid or **pre-answer** ledger write');
    expect(complexityRule).toBeGreaterThan(0);
    expect(complexityRule).toBeLessThan(scope.indexOf('1. Explain the complexity'));
    expect(compactProse(scope.slice(complexityRule))).toContain('Ask and wait before changes');
    expect(compactProse(scope.slice(complexityRule))).toContain('Save the actual feature and structure answers as one scope record');
    expect(compactProse(scope.slice(complexityRule))).toContain('Save this record under the write policy');
    expect(compactProse(scope.slice(complexityRule))).toContain('no retroactive pending record');
    expect(scope).not.toContain('proceed as-is');
    const stop = skeleton.indexOf('**STOP while a Scope Challenge complexity question');
    const sectionRead = skeleton.indexOf(suffix ? '{{SECTION:review-sections}}' : '> **STOP.** Before starting the Scope Challenge');
    expect(sectionRead).toBeGreaterThan(stop);
    expect(skeleton.slice(stop, sectionRead)).toContain('Do not start Section 1, call ExitPlanMode, or write findings or fixes into a plan file');
    expect(skeleton).toContain('Scope Challenge is mandatory before Section 1');
    expect(skeleton.split(suffix ? '{{SECTION:review-sections}}' : '> **STOP.** Before starting the Scope Challenge')).toHaveLength(2);
    expect(compactProse(scope)).toContain('apply only accepted scope changes');
    expect(compactProse(sections)).toContain("follow the preparation sections below through Confidence Calibration");
    expect(compactProse(sections)).toContain("Read Decision procedure as the rule for later choices. Start the review at Scope Challenge, then complete Sections 1–4 in order");
    const preparationOrder = ['## Review record and write policy',
      suffix ? '{{LEARNINGS_SEARCH}}' : '## Prior Learnings', '## Retrospective learning',
      suffix ? '{{CONFIDENCE_CALIBRATION}}' : '## Confidence Calibration',
      '## Decision procedure', '## Scope Challenge'].map(marker => sections.indexOf(marker));
    expect(preparationOrder.every(position => position >= 0)).toBe(true);
    expect(preparationOrder).toEqual([...preparationOrder].sort((a, b) => a - b));
    expect(sections).not.toContain('{{ANTI_SHORTCUT_CLAUSE}}');
    expect(sections).not.toContain('**Anti-shortcut clause:**');
    expect(skeleton).not.toContain('STOP while a Step 0 question');
    const calibration = sections.indexOf(suffix ? '{{CONFIDENCE_CALIBRATION}}' : '## Confidence Calibration');
    const procedure = sections.indexOf('## Decision procedure');
    const scopeStart = sections.indexOf('## Scope Challenge');
    expect(0 < calibration && calibration < procedure && procedure < scopeStart).toBe(true);
    expect(sections.match(/^## Scope Challenge$/gm)).toHaveLength(1);
    expect(sections).not.toContain('## Step 0 findings');
    expect(compactProse(scope)).toContain('Present numbered Scope Challenge findings with calibrated severity, confidence and source');
    expect(compactProse(scope)).toContain('accepted/rejected/deferred/pending');
    expect(compactProse(scope)).toContain('"No issues found" for an empty list');
    expect(compactProse(scope)).toContain('Findings and scope answers approve no remedies');
    const scopeFinish = ['Below the threshold, start at step 1', '1. Present numbered Scope Challenge findings',
      '2. Resolve each remedy through Decision procedure', '3. Report accepted/rejected/deferred/pending dispositions from those answers',
      'Continue to Section 1 only when no answer is pending'].map(step => scope.indexOf(step));
    expect(scopeFinish.every(position => position >= 0)).toBe(true);
    expect(scopeFinish).toEqual([...scopeFinish].sort((a, b) => a - b));
    const selfCheck = compactProse(skeleton.slice(skeleton.indexOf('## Section self-check'), skeleton.indexOf('**Paused question:**')));
    expect(selfCheck).toContain('Confirm you read the section and completed Scope Challenge, Sections 1–4, Outside Voice and outputs');
    expect(selfCheck).toContain('If evidence is missing, Read `sections/review-sections.md` and repair only gaps through its decision/output recovery steps');
    expect(selfCheck).toContain('Preserve verified work');
    expect(selfCheck).not.toContain('Redo memory-only work');
    const stages = skeleton.indexOf('After target selection, every question uses');
    const prerequisite = skeleton.indexOf(suffix ? '{{BENEFITS_FROM}}' : '## Prerequisite Skill Offer');
    expect(stages).toBeGreaterThan(0);
    expect(stages).toBeLessThan(prerequisite);
    expect(prerequisite).toBeLessThan(skeleton.indexOf('### Step 0: Scope Challenge'));
    expect(skeleton.slice(stages, prerequisite)).toContain("the preamble's full decision brief, transport and continuous D-numbering");
    expect(skeleton.slice(stages, prerequisite)).toContain('Setup, prerequisite and preparation questions do not approve engineering remedies');
    expect(skeleton).not.toContain('**Later question stages:**');
    if (!suffix) expect(skeleton.slice(prerequisite)).toContain('Build the next full decision brief from these facts and options, using the preamble transport, numbering and format');
    const engineering = skeleton.indexOf('## Engineering review');
    expect(engineering).toBeGreaterThan(prerequisite);
    expect(engineering).toBeLessThan(skeleton.indexOf('### Step 0: Scope Challenge'));
    const inventory = sections.indexOf("## Decision procedure");
    expect(inventory).toBeGreaterThan(0);
    expect(inventory).toBeLessThan(sections.indexOf('### 1. Architecture review'));
    const boundary = sections.slice(inventory, sections.indexOf('### 1. Architecture review')).replace(/\s+/g, ' ');
    expect(compactProse(boundary)).toContain("Read the request, source and actual answers");
    expect(compactProse(boundary)).toContain("Run this six-step loop for findings from Scope Challenge, Sections 1–4, Outside Voice, late changes and TODO choices. Finish one choice before the next");
    expect(compactProse(boundary)).toContain('Continue to Section 1 only when no answer is pending');
    expect(compactProse(boundary)).toContain("If the user can accept one while another stays approved or undecided");
    expect(compactProse(boundary)).toContain("they are separate choices even in the same finding, function or patch");
    expect(compactProse(boundary)).toContain("list each current value and proposed change: behavior, approach, guarantee or bound");
    expect(compactProse(boundary)).toContain("optional verification method or depth");
    expect(compactProse(boundary)).toContain("Give each bound a measure and unit");
    expect(compactProse(boundary)).toContain("Keep other approved values fixed and pending choices undecided");
    expect(compactProse(boundary)).toContain("Keep one behavior with its necessary code, tests and documentation");
    expect(compactProse(sections)).toContain("For one fixed approved contract, coverage choices vary implementation or proof depth");
    expect(compactProse(boundary)).toContain("Never cut an established contract or its required proof");
    expect(compactProse(boundary)).toContain("Give independently selectable changes separate IDs");
    expect(compactProse(boundary)).toContain("If an exact prior approval covers the work, cite its answer and disposition");
    expect(compactProse(boundary)).toContain("later-discovered required proof forward without asking again");
    expect(compactProse(boundary)).toContain("one question object for one choice");
    expect(compactProse(boundary)).toContain("If you discover another independent choice, return to step 2 before sending the question");
    expect(compactProse(boundary)).toContain("Separate instrumentation, follow-ups, guarantees and policies need their own choices, and their tests wait for approval");
    expect(compactProse(boundary)).toContain("For a factual correction that changes no behavior, record the correction and evidence");
    // The template delegates outside findings to this resolver; generated
    // sections contain that same consent rule rather than a duplicate alias.
    const outside = suffix ? generateCodexPlanReview({ skillName: 'plan-eng-review', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext) : sections;
    expect(outside).toContain('Run every outside finding through the same Decision procedure and decision records above');
    expect(outside).toContain('Agreement between reviewers is evidence, not approval');
    expect(outside).toContain('new or reopened choices still need their own answers');
  }
}, 30_000);

// Source/renderer contract controls only: native review behavior remains a paid
// regression. Resolve the actual Eng clause on every host without trusting an
// old generated carrier to hide a contradictory unconditional approval gate.
describe('Eng approved-work decision gate', () => {
  const template = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
  const rawGate = template.split("## Decision procedure")[1]?.split('### 1. Architecture review')[0] ?? '';
  const gate = compactProse(rawGate);
  const ledger = rawGate.match(/```markdown\n([\s\S]*?)\n```/)?.[1] ?? '';

  test('preserves the full selected scope and reopens contradictory options before applying them', () => {
    const compare = gate.slice(gate.indexOf('### 3. Compare one choice'), gate.indexOf('### 4. Save the pending record'));
    const apply = gate.slice(gate.indexOf("### 6. Apply and refresh"), gate.indexOf('## Scope Challenge'));
    expect(compare).toContain("each option's full label and description with every row in its grid column");
    expect(compare).toContain("each option's full label and description with every row in its grid column");
    expect(compare).toContain("They must make the same commitments and retain the same conditions");
    expect(compare).toContain("Compare each option's full label and description with every row in its grid column");
    expect(compare).toContain("It approves no implementation, including a conditional fix");
    expect(compare).toContain("Keep that remedy pending");
    expect(compare).toContain("If you discover another independent choice, return to step 2 before sending the question");
    const selected = apply.indexOf("Read the selected saved label, full description and grid column together");
    const conflict = apply.indexOf("preserve the actual answer, explain the conflict and repeat steps 2–5 for another answer");
    const resolution = apply.indexOf("Replace the whole adjacent");
    expect(selected >= 0 && conflict > selected && resolution > conflict).toBe(true);
    expect(compactProse(apply)).toContain("Do not reinterpret a caption, drop a commitment or advance with conflicting approvals");
    expect(compactProse(apply)).toContain("its unique state, actual answer and accepted scope match the complete selected option and grid column");
    // a689 D3's conditional fix was selected, then silently replaced with a
    // probe-only scope. Native behavior remains a paid gate; this guards the
    // producer's prepare/apply/recovery instructions, not that run's outcome.
  });

  test('reconciles operative decision State before approval readiness and unresolved counts', () => {
    const apply = gate.slice(gate.indexOf("### 6. Apply and refresh"), gate.indexOf('## Scope Challenge'));
    expect(compactProse(apply)).toContain("Set State to `approved` for accepted scope");
    expect(compactProse(apply)).toContain('`pending` for an unresolved remedy');
    expect(compactProse(apply)).toContain('move superseded states to History');
    // c6fc retained both pending and approved fields after an acknowledged answer.
    const replace = apply.indexOf("Replace the whole adjacent `State` / `Actual answer` / `Accepted scope` block");
    const save = apply.indexOf("Use a scoped Edit to save this record and only the authorized working-plan amendments");
    const verify = apply.indexOf("its unique state, actual answer and accepted scope match");
    expect(replace).toBeGreaterThan(-1);
    expect(compactProse(apply)).toContain("Each field must occur once outside History");
    const lines = ledger.split('\n');
    const stateAt = lines.findIndex(line => line.startsWith('State:'));
    expect(stateAt).toBeGreaterThan(lines.indexOf('Options:'));
    expect(lines.slice(stateAt, stateAt + 3).map(line => line.split(':')[0])).toEqual([
      'State', 'Actual answer', 'Accepted scope',
    ]);
    expect(lines.filter(line => line.startsWith('State:'))).toHaveLength(1);
    expect(compactProse(apply)).toContain('never update only the answer/scope tail');
    expect(compactProse(apply)).toContain("remove their old occurrences in the same edit");
    expect(compactProse(apply)).toContain("Read the entire resolution block, including State");
    expect(compactProse(apply)).toContain("An answer-only search or current-in-context hint cannot replace Read");
    expect(save).toBeGreaterThan(replace);
    expect(verify).toBeGreaterThan(save);
    expect(apply.indexOf("Correct any discrepancy before advancing")).toBeGreaterThan(verify);
    expect(apply.indexOf('Return to step 1')).toBeGreaterThan(verify);
    const outputs = template.split('## Required outputs')[1]!.split('### "NOT in scope"')[0]!;
    expect(compactProse(outputs)).toContain("Derive unresolved choices from each record's current State, actual answer and accepted scope");
    expect(compactProse(outputs)).toContain("Run this finish sequence after Approval readiness passes");
    expect(compactProse(outputs)).toContain("On recovery, resume at the failed step. Reuse a successful Review Log for unchanged saved outputs; changed outputs must pass steps 1–4 again");
  });

  test('identifies commitments before comparing values, then saves before asking', () => {
    const identify = gate.indexOf("Before drafting options");
    const alternatives = gate.indexOf('### 3. Compare one choice');
    const save = gate.indexOf("### 4. Save the pending record");
    const ask = gate.indexOf('### 5. Ask and wait');
    expect(0 <= identify && identify < alternatives && alternatives < save && save < ask).toBe(true);
    const choice = gate.slice(identify, alternatives);
    expect(compactProse(choice)).toContain("Before drafting options");
    expect(compactProse(choice)).toContain("If the user can accept one while another stays approved or undecided");
    expect(compactProse(gate.slice(alternatives, save))).toContain("Keep other approved values fixed and pending choices undecided");
    expect(compactProse(choice)).toContain("Keep one behavior with its necessary code, tests and documentation");
    expect(compactProse(choice)).toContain("Optional depths of one verification form one choice");
    const options = gate.slice(alternatives, save);
    expect(compactProse(options)).toContain("If you discover another independent choice");
    expect(compactProse(options)).toContain("return to step 2");
    expect(compactProse(options)).toContain("Include shared, fixed and pending choices");
    expect(compactProse(gate.slice(save, ask))).toContain('Save the record, complete grid and exact `currentDecision`');
    expect(compactProse(gate.slice(ask))).toContain("Replace the whole adjacent `State` / `Actual answer` / `Accepted scope` block after the options. Use the actual option and answer reference");
    expect(compactProse(gate.slice(ask))).toContain("Preserve the options");
  });

  test('current contracts and completed comparisons precede saved questions without approving a fix', () => {
    const stages = ['### 1. Establish current state', "Before drafting options",
      '### 3. Compare one choice', "### 4. Save the pending record",
      '### 5. Ask and wait'].map(stage => gate.indexOf(stage));
    expect(stages.every(position => position >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    // A reopened row must use its latest accepted plan, not the seed/runtime
    // value, and rebuild all option states before the existing save/ask gate.
    const baseline = gate.slice(stages[0], stages[1]);
    expect(ledger).toContain('Plan baseline: <last approved value, exact scope and answer reference; otherwise the original proposal>');
    expect(ledger).toContain('Runtime evidence: <observed value and source/probe; unknown if unverified>');
    expect(compactProse(baseline)).toContain("Approval does not prove deployed behavior, and observed behavior does not grant approval");
    expect(compactProse(baseline)).toContain("**Runtime evidence:** what existing code or a probe shows. Mark unverified behavior unknown");
    expect(ledger).toContain('Actual answer: <unanswered, or actual option and answer reference>');
    expect(ledger).toContain('Accepted scope: <exact approved work; none if no change approved>');
    expect(compactProse(baseline)).toContain("retain earlier values, complete briefs and answers in History");
    const options = gate.slice(stages[2], stages[3]);
    expect(compactProse(options)).toContain("its concrete current value, each option's value");
    expect(compactProse(options)).toContain("An Investigate/Defer option must bound the investigation and name what stays unchanged or pending. It approves no implementation");
    expect(compactProse(gate.slice(stages[1], stages[2]))).toContain("Separate instrumentation, follow-ups, guarantees and policies need their own choices");
    const record = gate.slice(stages[3], stages[4]);
    expect(compactProse(options)).toContain("concrete current value, each option's value and work, and any approval citation");
    expect(compactProse(record)).toContain("An older comparison or a critic's advice cannot substitute for this verification");
    const commitments = gate.slice(stages[0], stages[2]);
    expect(compactProse(commitments)).toContain("If an exact prior approval covers the work");
    expect(compactProse(options)).toContain("Treat necessary implementation and proof of an approved contract as common work. Cite its answer");
    expect(compactProse(commitments)).toContain("later-discovered required proof forward without asking again");
    expect(compactProse(commitments)).toContain("Separate instrumentation, follow-ups, guarantees and policies need their own choices");
    expect(compactProse(commitments)).toContain("Optional depths of one verification form one choice");
    expect(compactProse(gate)).toContain("Give each bound a measure and unit");
    expect(compactProse(gate)).toContain("optional verification method or depth");
    expect(compactProse(options)).toContain("build `currentDecision`");
    expect(compactProse(options)).toContain("`options`: every exact label and full description");
    const nativeStart = options.indexOf('Select one pending ID');
    const gridStart = options.indexOf('Build a separate **comparison grid**');
    const reconcile = options.indexOf('**Reconcile before saving.**');
    expect(reconcile).toBeGreaterThan(gridStart);
    expect(nativeStart).toBeGreaterThanOrEqual(0);
    expect(gridStart).toBeGreaterThan(nativeStart);
    const nativeFields = options.slice(nativeStart, gridStart);
    expect(nativeFields).toContain("`question`: the complete D-numbered preamble brief, including Project, ELI10, Stakes, Recommendation");
    expect(nativeFields).toContain("Put the problem and file:line in the native fields");
    expect(nativeFields).toContain("Each option must explain human/CC effort, risk and maintenance. Tie the recommendation to the engineering preferences");
    expect(compactProse(options)).toContain("Build a separate **comparison grid** for the whole brief");
    expect(compactProse(gate)).toContain('Save the record, complete grid and exact `currentDecision`');
    expect(compactProse(gate)).toContain("A failed save blocks the question");
    expect(compactProse(template.split('## Review record and write policy')[1]!.split('{{LEARNINGS_SEARCH}}')[0]!)).toContain("Honor user and host limits, including active-plan-only restrictions");
    expect(compactProse(gate)).toContain("present the complete record and grid as **not persisted**");
    expect(compactProse(gate)).toContain("one question object for one choice");
    expect(ledger).toContain('State: <pending, or approved>');
    expect(compactProse(gate)).toContain("Otherwise leave the remedy pending");
    const headings = [...rawGate.matchAll(/^### ([1-6])\. ([^\n]+)$/gm)].map(match => `${match[1]}. ${match[2]}`);
    expect(headings).toEqual(['1. Establish current state', '2. Separate independent choices',
      '3. Compare one choice', '4. Save the pending record', '5. Ask and wait', '6. Apply and refresh']);
    expect(compactProse(baseline)).toContain("For a factual correction that changes no behavior");
    expect(compactProse(baseline)).toContain("changes no behavior, record the correction and evidence; no question or comparison grid is needed");
    expect(compactProse(baseline)).toContain("Carry its necessary code, tests, documentation and later-discovered required proof forward without asking again");
    expect(gate.indexOf("**STOP until the actual answer arrives.**")).toBeLessThan(gate.indexOf('### 6. Apply and refresh'));
    expect(compactProse(gate.slice(gate.indexOf('### 6. Apply and refresh')))).toContain("only the authorized working-plan amendments");
    expect(compactProse(gate)).toContain("Reopen an approved choice only for a concrete new risk, contradictory evidence or a changed assumption. Explain the reason");
    expect(compactProse(gate)).toContain("If an exact prior approval covers the work, cite its answer and disposition");
  });

  test('assigns independent row IDs before constructing the final question', () => {
    const identify = gate.slice(gate.indexOf("Before drafting options"), gate.indexOf('### 3. Compare one choice'));
    const decompose = identify.indexOf("list each current value and proposed change: behavior, approach, guarantee or bound");
    const mixed = identify.indexOf('If the user can accept one');
    const assign = identify.indexOf('Give independently selectable changes separate IDs');
    expect(decompose >= 0 && decompose < assign && assign < mixed).toBe(true);
    expect(compactProse(identify)).toContain("list each current value and proposed change: behavior");
    expect(ledger).toContain('State: <pending, or approved>');
    expect(ledger).toContain('### R1: <one independently selectable choice>');
    expect(ledger).toContain('Finding: <number, severity, confidence, file:line and reviewer>');
    expect(ledger).toContain('Runtime evidence: <observed value and source/probe; unknown if unverified>');
    expect(ledger).toContain('Actual answer: <unanswered, or actual option and answer reference>');
    expect(ledger).toContain('Accepted scope: <exact approved work; none if no change approved>');
    const audit = gate.slice(gate.indexOf('### 3. Compare one choice'), gate.indexOf("### 4. Save the pending record"));
    expect(compactProse(audit)).toContain("build `currentDecision`");
    expect(compactProse(audit)).toContain("`options`: every exact label and full description");
    expect(compactProse(audit)).toContain("Build a separate **comparison grid** for the whole brief");
    expect(compactProse(audit)).toContain("If you discover another independent choice, return to step 2 before sending the question");
    expect(compactProse(identify)).toContain("Alternative mechanisms for that fixed behavior belong in one question");
    expect(compactProse(identify)).toContain("Give independently selectable changes separate IDs");
    expect(compactProse(identify)).toContain("Alternative mechanisms for that fixed behavior belong in one question");
  });

  test('finishes native fields before save and dispatches the literal final read-back', () => {
    const audit = gate.slice(gate.indexOf('### 3. Compare one choice'), gate.indexOf("### 4. Save the pending record"));
    const save = gate.slice(gate.indexOf("### 4. Save the pending record"), gate.indexOf('### 5. Ask and wait'));
    const send = gate.slice(gate.indexOf('### 5. Ask and wait'));
    expect(compactProse(audit)).toContain("the complete D-numbered preamble brief");
    expect(compactProse(audit)).toContain("build `currentDecision`");
    expect(compactProse(save)).toContain('Save the record, complete grid and exact `currentDecision`');
    expect(compactProse(audit)).toContain("Fit headers and labels to host limits now, before saving");
    expect(compactProse(audit)).toContain("Fit headers and labels to host limits now, before saving");
    expect(compactProse(audit)).toContain("Put all deliberation in the native question/descriptions; a saved-only Pros/cons block cannot supply missing decision context");
    expect(compactProse(save)).toContain("Include every native field, the recommendation and all options");
    expect(compactProse(save)).toContain("A–D record selectors are ledger notation only");
    expect(compactProse(save)).toContain("Compare the label separately from that notation");
    expect(compactProse(save)).toContain("Check the Write/Edit result, then use Read to fetch the entire saved record");
    expect(compactProse(save)).toContain('Compare every native field with `currentDecision`');
    expect(compactProse(save)).toContain("Read after the final edit, even if Edit says the content is current in context");
    expect(compactProse(save)).toContain("Grep, chat references, summaries and planned writes do not verify the record");
    expect(compactProse(save)).toContain("Repair any difference and repeat the complete Read before asking");
    expect(compactProse(save)).toContain("When revising, replace the whole current payload");
    expect(compactProse(save)).toContain("Do not leave duplicate Question, Header or Options fields");
    expect(compactProse(save)).toContain("present the complete record and grid as **not persisted**");
    expect(compactProse(save)).toContain("an unreadable or unverifiable record follows the write policy's recovery and then **Blocked outcome**");
    expect(compactProse(save)).toContain("If any payload field changes, including a shortened label or formatting edit, repeat step 3, replace the whole saved payload and Read it again");
    expect(compactProse(send)).toContain("Copy the verified question, header, labels and descriptions literally");
    expect(compactProse(send)).toContain("Do not add or strip brief paragraphs or rebuild options");
    expect(compactProse(send)).toContain("Send `AskUserQuestion({ questions: [currentDecision] })` after step 4");
    expect(compactProse(send)).toContain("Authorized prose and auto-decisions use this same verified brief");
    expect(compactProse(send)).toContain("one question object for one choice");
    expect(compactProse(send)).toContain("Replace the whole adjacent `State` / `Actual answer` / `Accepted scope` block after the options. Use the actual option and answer reference");
    expect(compactProse(send)).toContain("An answer-only search or current-in-context hint cannot replace Read");
    expect(compactProse(save)).toContain("A failed save blocks the question");
  });

  test('all four section gates and outside voice distinguish pending choices from findings', () => {
    const reviewSections = template.split('## Review Sections (after scope is agreed)')[1]!;
    const sections = [...reviewSections.matchAll(/^### ([1-4])\.([^]*?)(?=^### [1-4]\.|^\{\{CODEX_PLAN_REVIEW\}\})/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual([1, 2, 3, 4]);
    for (const [, number, source] of sections) {
      const body = source.replace('{{TEST_COVERAGE_AUDIT_PLAN}}', () => generateTestCoverageAuditPlan({} as TemplateContext));
      const sectionRule = template.split('## Review Sections (after scope is agreed)')[1]!.split('### 1. Architecture review')[0]!;
      expect(compactProse(sectionRule)).toContain('Evaluate Architecture → Code Quality → Tests → Performance');
      expect(compactProse(sectionRule)).toContain('After each of Sections 1–4, resolve new or reopened choices through Decision procedure, report findings and dispositions, then continue');
      expect(compactProse(gate)).toContain("**STOP until the actual answer arrives.**");
      expect(compactProse(gate)).toContain("Do not apply a remedy, make another call, start the next section or call ExitPlanMode while the choice awaits an answer");
      if (number === '3') {
        expect(body).toContain("Run the decision gate for this section's new or reopened choices");
        expect(body).toContain('**STOP for each pending decision.**');
        const stop = body.indexOf('**STOP for each pending decision.**');
        const artifact = body.indexOf('\n#### Test Plan Artifact\n');
        const report = body.indexOf('After the Test Plan Artifact is saved or presented, report the Test review findings');
        expect(0 <= stop && stop < artifact && artifact < report).toBe(true);
        expect(body.slice(stop, artifact)).not.toContain('and continue');
      }
    }
    expect(compactProse(gate)).toContain("An obvious fix still needs an answer unless exact prior approval covers it");
    expect(compactProse(template)).toContain('{{CODEX_PLAN_REVIEW}}');
    const outside = generateCodexPlanReview({ skillName: 'plan-eng-review', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext);
    expect(outside).toContain('Run every outside finding through the same Decision procedure and decision records above');
    expect(outside).toContain('new or reopened choices still need their own answers');
    expect(compactProse(template)).toContain('Never condense, abbreviate or skip a section');
    expect(compactProse(template)).toContain('{{PLAN_FILE_REVIEW_REPORT}}');
    for (const stale of ['For each issue found in this section',
      'Otherwise, use AskUserQuestion for each finding',
      'Outside voice findings are INFORMATIONAL until the user explicitly approves each one']) {
      expect(template).not.toContain(stale);
    }
  });

  test('every option is recorded against one decision before sending or scoring coverage', () => {
    const rows = gate.indexOf("Before drafting options");
    const compare = gate.indexOf('### 3. Compare one choice');
    const save = gate.indexOf("### 4. Save the pending record");
    const ask = gate.indexOf('### 5. Ask and wait');
    expect(0 <= rows && rows < compare && compare < save && save < ask).toBe(true);
    expect(rawGate.indexOf(ledger)).toBeGreaterThan(rawGate.indexOf("### 4. Save the pending record"));
    expect(rawGate.indexOf(ledger)).toBeLessThan(rawGate.indexOf('### 5. Ask and wait'));
    expect(ledger).toContain('Comparison grid: <complete grid from step 3>');
    expect(ledger).toContain('Question D2:\n<currentDecision.question in full, including its D2 title and recommendation>');
    expect(ledger).toContain('Header: <currentDecision.header>');
    for (const [ordinal, selector] of [['first', 'A'], ['second', 'B']]) {
      expect(ledger).toContain(`<${ordinal} option's exact label, with one ${selector}) record selector>`);
      expect(ledger).toContain(`<${ordinal} option's full description>`);
    }
    expect(compactProse(gate.slice(compare, save))).toContain("Give every selectable behavior, approach, guarantee or bound a row");
    expect(compactProse(gate.slice(compare, save))).toContain("concrete current value, each option's value and work, and any approval citation. Include shared, fixed and pending choices");
    expect(compactProse(gate.slice(compare, save))).toContain("Keep other approved values fixed and pending choices undecided");
    expect(gate).not.toContain('`label: changes; preserves; pending`');
    const format = gate.split('### 3. Compare one choice')[1]!.split('### 4. Save the pending record')[0]!;
    expect(format).toContain("Each option must explain human/CC effort, risk and maintenance");
    expect(format).toContain("For one fixed approved contract, coverage choices vary implementation or proof depth");
    expect(format).not.toContain('After the decision gate validates the options');
    expect(format).not.toContain('per-issue AskUserQuestion');
    expect(template).not.toContain('## CRITICAL RULE — How to ask questions');
  });

  test('finding evidence, stable decision identity and question labels have distinct roles', () => {
    const identity = gate.slice(gate.indexOf('### 1. Establish current state'), gate.indexOf('### 4. Save the pending record'));
    expect(identity).toContain("they are separate choices even in the same finding, function or patch");
    expect(identity).toContain("A reopened choice keeps its ID");
    expect(identity).toContain("retain earlier values, complete briefs and answers in History");
    expect(identity).toContain("receives the next continuous `D<N>`");
    expect(ledger).toContain('### R1: <one independently selectable choice>');
    expect(ledger).toContain('Question D2:\n<currentDecision.question in full, including its D2 title and recommendation>');
    expect(ledger).toContain('History: <earlier values, briefs, answers and reason for reopening>');
    expect(identity).toContain("Test-review scores rate existing/proposed tests, not answer status");
    expect(template).not.toContain('issue NUMBER + option LETTER');
    expect(template).not.toContain('Label with NUMBER + LETTER');
  });

  test('scope bootstrap resolves a target without depending on later session routing or decision briefs', () => {
    const skeleton = readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8');
    const bootstrap = skeleton.split('## Scope gate')[1]!.split('{{PREAMBLE}}')[0]!;
    expect(bootstrap).toContain('Before tools or preamble, resolve from provided messages, listed tools and explicit host metadata only');
    expect(bootstrap).toContain('Do not probe for session state');
    expect(bootstrap).toContain('No decision brief, D-number, completeness, Question Tuning or ledger');
    expect(bootstrap).toContain("After target selection, every question uses the preamble's full decision brief, transport and continuous D-numbering");
    expect(bootstrap).toContain('Setup, prerequisite and preparation questions do not approve engineering remedies');
    expect(bootstrap).toContain('Choose listed, enabled MCP AskUserQuestion, otherwise listed native');
    expect(bootstrap).toContain('First tool call = AskUserQuestion (tool_use). Send this exact menu and wait');
    expect(bootstrap).toContain('If a failed call may have surfaced, keep it pending; do not duplicate it');
    expect(bootstrap).toContain('if unavailable, disallowed (`--disallowedTools`) or failed, send the menu as plain prose and STOP');
    expect(bootstrap).toContain('Options start at column 0, without blockquotes');
    expect(bootstrap).toContain('Never guess a target');
    expect(bootstrap).toContain('Startup sequence');
    expect(bootstrap).toContain('Context Recovery');
    expect(bootstrap).toContain('Keep the reviewed target fixed');
    const namedTarget = bootstrap.indexOf('**User-named target (outside plan mode):**');
    const headless = bootstrap.indexOf('**Headless or spawned session without a target:**');
    expect(0 < namedTarget && namedTarget < headless && headless < bootstrap.indexOf('**Initial selector algorithm')).toBe(true);
    const pending = bootstrap.slice(headless, bootstrap.indexOf('**Initial selector algorithm'));
    expect(pending).toContain('neither rule above supplies an unambiguous target');
    expect(pending).toContain('Scope pending: provide a plan/path or explicitly request branch diff');
    expect(pending).toContain('STOP. Do not run the preamble or review tools');
    expect(pending).toContain('The session type does not choose a target or approve work');
    expect(skeleton).toContain('Copy required command, output and question formats exactly. Apply Voice to newly composed prose');
  });

  test('the review record covers code inputs and per-artifact write limits before any decision is saved', () => {
    const policyStart = template.indexOf('## Review record and write policy');
    const policyEnd = template.indexOf('{{LEARNINGS_SEARCH}}', policyStart);
    expect(policyStart).toBeGreaterThan(0);
    expect(policyEnd).toBeGreaterThan(policyStart);
    const policy = template.slice(policyStart, policyEnd);
    expect(template.indexOf('## Review record and write policy')).toBeLessThan(template.indexOf('## Decision procedure'));
    expect(compactProse(policy)).toContain("Plan or design document | Proposed paths, checked against existing interfaces and tests");
    expect(compactProse(policy)).toContain("Branch diff | Changed behavior and surrounding code, traced from entry points");
    expect(compactProse(policy)).toContain("Specific file or directory | Existing behavior and relevant callers/tests");
    expect(compactProse(policy)).toContain("for code, build a remedy plan from the findings. This is review content, not permission to edit implementation or create another file");
    expect(compactProse(policy)).toContain("When Test review or Outside Voice refers to the plan, use the current working plan and this target evidence");
    expect(compactProse(policy)).toContain("**Report file:** the one destination for the working plan, findings, decision ledger and final structured report");
    expect(compactProse(policy)).toContain("Choose the **report file** before any ledger write:");
    expect(compactProse(policy)).toContain('$GSTACK_STATE_ROOT/projects/$SLUG/$BRANCH-eng-review-{YYYYMMDD-HHMMSS}.md');
    expect(compactProse(policy)).toContain('gstack-paths');
    expect(compactProse(policy)).toContain('gstack-slug');
    expect(compactProse(policy)).toContain("adding a suffix on collision");
    expect(compactProse(policy)).toContain("Never substitute an unrelated active plan");
    expect(compactProse(policy)).toContain("ledger and final structured report");
    expect(compactProse(policy)).toContain("intentionally use legacy discovery paths under");
    expect(compactProse(policy)).toContain("including active-plan-only");
    expect(compactProse(policy)).toContain("**Check each artifact and parent directory's permission before writing.**");
    expect(compactProse(policy)).toContain("Permission for one path authorizes no other");
    expect(compactProse(policy)).toContain("implementation edits require explicit authority");
    expect(compactProse(policy)).toContain("Never substitute an unrelated active plan or silently replace a requested destination");
    expect(compactProse(policy)).toContain("Present each completely as **not persisted** and continue");
    expect(compactProse(policy)).toContain("Ask for a permitted destination if the user can supply one; wait without completion telemetry");
    expect(compactProse(policy)).toContain("If none is permitted, complete the review in chat as **not persisted**, then use **Blocked outcome**");
    expect(compactProse(policy)).toContain("Use the failed step's stated recovery; if saving or read-back still fails, take **Blocked outcome**");
    const routes = Object.fromEntries(policy.split('\n').filter(line => line.startsWith('| '))
      .map(line => line.split('|').slice(1, -1).map(cell => cell.trim())).map(cells => [cells[0], cells[2]]));
    expect(routes["Working plan, ledger and complete review report"]).toContain('wait without completion telemetry');
    expect(routes["Working plan, ledger and complete review report"]).toContain('then use **Blocked outcome**');
    for (const auxiliary of ['QA Test Plan and task JSONL', 'TODOS.md']) {
      expect(routes[auxiliary]).toContain('**not persisted**');
      expect(routes[auxiliary]).toContain('continue');
    }
    expect(routes['Required Review Log']).toContain("the final gate cannot pass without this log");
    expect(compactProse(policy)).toContain("Forbidden auxiliary writes allow the review to continue; unrecovered attempted writes block it");
    expect(compactProse(gate)).toContain("Use Review record/write policy only for saved records, reports and logs");
    const log = template.split('## Review Log')[1]!.split('{{REVIEW_DASHBOARD}}')[0]!;
    expect(log).toContain("Use these commands in finish step 3, after successful Read-back");
    expect(compactProse(template)).toContain('If the required log is forbidden, show its fields as not persisted and take **Blocked outcome**');
    expect(compactProse(template)).toContain('Neither case supplies completion or saved-dashboard credit');
    expect(log).not.toContain('PLAN MODE EXCEPTION — ALWAYS RUN');
  });

  test('approval readiness follows TODO decisions and finalization returns forward exactly once', () => {
    const closing = template.split('## Required outputs')[1]!.split('### "NOT in scope" section')[0]!;
    expect(compactProse(closing)).toContain("Display the Review Readiness Dashboard, then present the saved Completion summary");
    const finish = [...closing.matchAll(/^([1-6])\. \*\*([^*]+)\*\*/gm)].map(match => [match[1], match[2]]);
    expect(finish).toEqual([['1', 'Prepare the review body.'], ['2', 'Save and Read back.'], ['3', 'Log the saved review.'],
      ['4', 'Publish.'], ['5', 'Choose navigation.'], ['6', 'Finish.']]);
    const publication = closing.slice(closing.indexOf('3. **Log the saved review.**'), closing.indexOf('5. **Choose navigation.**'));
    expect(compactProse(publication)).toContain("If the required log is forbidden, show its fields as not persisted and take **Blocked outcome**");
    expect(compactProse(publication)).toContain("Neither case supplies completion or saved-dashboard credit");
    expect(compactProse(closing)).toContain("entrypoint's Section self-check and read-only EXIT PLAN MODE GATE. Run these checks in every host mode");
    expect(compactProse(closing)).toContain("ExitPlanMode only in host plan mode");
    expect(compactProse(closing)).toContain("resolve it through Decision procedure, repeat Approval readiness, and redo the affected outputs from step 1 through publication before asking navigation again");
    expect(compactProse(closing)).toContain("Run Learning hooks, then return to the entrypoint's Section self-check");
    const outputs = ['### TODOS.md updates', '{{PLAN_REVIEW_APPROVAL_CHECK}}', '## Required outputs',
      '{{PLAN_FILE_REVIEW_REPORT}}', '## Review Log', '{{REVIEW_DASHBOARD}}', '## Next Steps — Review Chaining',
      '## Learning hooks', '{{BRAIN_WRITE_BACK}}']
      .map(stage => template.indexOf(stage));
    expect(outputs.every(position => position >= 0)).toBe(true);
    expect(outputs).toEqual([...outputs].sort((a, b) => a - b));
    expect(template.split('{{PLAN_REVIEW_APPROVAL_CHECK}}')).toHaveLength(2);
    expect(template).not.toContain('{{BRAIN_CACHE_REFRESH}}');
    expect(template).not.toContain('Run the preamble\'s **Telemetry');
    expect(closing.match(/return to the entrypoint/g)).toHaveLength(1);
    expect(template.slice(template.indexOf('## Learning hooks'))).not.toContain('Section self-check');
    const ending = template.slice(template.indexOf('{{REVIEW_DASHBOARD}}'));
    const navigation = ending.split('## Learning hooks')[0]!;
    expect(navigation).toContain("follow the repeat path in finish step 5");
    expect(compactProse(navigation)).toContain("Refresh affected tasks, dependencies and parallelization along with the other outputs");
    expect(navigation).toContain("A next-step answer approves no implementation change");
    const skeleton = readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8');
    const final = ['{{SECTION:review-sections}}', '## Section self-check', '**Paused question:**', '**Blocked outcome:**', '{{EXIT_PLAN_MODE_GATE}}',
      'After the gate passes: **Telemetry', '{{BRAIN_CACHE_REFRESH}}', 'After success telemetry and cache dispatch, call ExitPlanMode for the selected next step only when the host is in plan mode.']
      .map(stage => skeleton.indexOf(stage));
    expect(final.every(position => position >= 0)).toBe(true);
    expect(final).toEqual([...final].sort((a, b) => a - b));
    expect(skeleton).not.toContain('run approval check 0 below');
    const pause = skeleton.split('**Paused question:**')[1]!.split('**Blocked outcome:**')[0]!;
    expect(pause).toContain('Wait for its actual answer without completion telemetry or ExitPlanMode');
    const blocked = skeleton.split('**Blocked outcome:**')[1]!.split('{{EXIT_PLAN_MODE_GATE}}')[0]!;
    expect(blocked).toContain('report `BLOCKED`, the missing path/work, actual attempts and what is needed to resume');
    expect(blocked).toContain('Label complete chat-only output **not persisted**; it supplies no saved-review or completion credit');
    expect(blocked).toContain('Stop the review');
    expect(blocked).toContain('If startup values and a permitted telemetry command are available');
    expect(blocked).toContain('`OUTCOME=error` and the actual `ERROR_MESSAGE`/`FAILED_STEP`');
    expect(blocked).toContain('Do not call ExitPlanMode');
    expect(blocked).toContain('Resume at the failed step and repeat affected outputs, read-back and logs');
    expect(skeleton.slice(skeleton.indexOf('After the gate passes:'))).toContain('once with `OUTCOME=success`, then cache refresh');
    expect(skeleton).toContain("Make no further working-plan or approval changes between verification and exit");
  });

  // This parses the actual worked example, not model output or a test-only
  // decision oracle. It proves the instructions expose the observed two-axis
  // option pattern; only native evaluation can prove the model follows them.
  test('worked comparison exposes two independently selectable option values', () => {
    const worked = rawGate.split('For example, jitter and a delay cap can be chosen independently.')[1]?.split('### 4. Save the pending record')[0] ?? '';
    expect(worked).toContain('“both / cap only / neither” bundles them by omitting “jitter only.”');
    expect(worked).toContain('Ask about jitter first:');
    const split = worked.split('Ask about jitter first:')[1]!;
    const separated = [...split.matchAll(/^\| (R[12] [^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
      .map(([, commitment, current, A, B]) => ({ commitment, current, A, B }));
    expect(separated).toEqual([
      { commitment: 'R1 jitter', current: 'unspecified, pending', A: 'on', B: 'off' },
      { commitment: 'R2 delay cap', current: 'unspecified, pending', A: 'unspecified, pending', B: 'unspecified, pending' },
    ]);
    expect(compactProse(gate.slice(gate.indexOf("### 6. Apply and refresh")))).toContain("Keep chosen values fixed in later questions");
    expect(compactProse(gate.slice(gate.indexOf("### 6. Apply and refresh")))).toContain("explain when a choice has become irrelevant rather than asking it again");
    expect(compactProse(gate.slice(gate.indexOf('### 5. Ask and wait')))).toContain("resolve risk and safety choices before readiness");
  });

  test('common new defaults still need approval while necessary contract proof carries forward', () => {
    const compare = gate.split('### 3. Compare one choice')[1]!.split("### 4. Save the pending record")[0]!;
    expect(compare).toContain("A value shared by all options still needs approval if it is new");
    expect(compare).toContain("Include shared, fixed and pending choices");
    const identify = gate.slice(gate.indexOf("Before drafting options"), gate.indexOf('### 3. Compare one choice'));
    expect(compactProse(identify)).toContain("Keep one behavior with its necessary code, tests and documentation");
    expect(compactProse(identify)).toContain("Separate instrumentation, follow-ups, guarantees and policies need their own choices, and their tests wait for approval");
    expect(compactProse(gate)).toContain("If an exact prior approval covers the work");
    expect(compare).toContain("Treat necessary implementation and proof of an approved contract as common work. Cite its answer");
    expect(compare).toContain("instead of creating another approval row");
    expect(compactProse(gate)).toContain("later-discovered required proof forward without asking again");
    expect(compactProse(gate)).toContain("If an exact prior approval covers the work, cite its answer and disposition");
  });

  test('exact prior answers authorize follow-through while new risk and optional depth stay pending', () => {
    const normalized = gate.replace(/\s+/g, ' ');
    expect(normalized).toContain("Read the request, source and actual answers");
    expect(normalized).toContain("For a factual correction that changes no behavior, record the correction and evidence");
    expect(ledger).toContain('Plan baseline: <last approved value, exact scope and answer reference; otherwise the original proposal>');
    expect(normalized).toContain("Use a scoped Edit to save this record and only the authorized working-plan amendments");
    expect(normalized).toContain("Separate instrumentation, follow-ups, guarantees and policies need their own choices");
    expect(normalized).toContain("Reopen an approved choice only for a concrete new risk, contradictory evidence or a changed assumption");
    expect(normalized).toContain("Record remaining unknowns and uncertain risks");
    expect(normalized).toContain("Keep other approved values fixed and pending choices undecided");
    expect(normalized).toContain("their tests wait for approval");
    expect(normalized).toContain("Keep unresolved risks and verification visible");
    expect(normalized).toContain("Drafts, recommendations and reviewer agreement grant neither");
    expect(normalized).toContain("Record remaining unknowns and uncertain risks");
  });

  test('every host resolves the Eng gate without the conflicting generic shortcut clause', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const clause = generateAntiShortcutClause({ skillName: 'plan-eng-review', host: host.name } as TemplateContext);
      expect(clause).toContain('Use the decision gate for all four sections and outside voice');
      expect(clause).toContain('Retain findings and evidence');
      expect(clause).toContain('Ask only for new or reopened choices and apply their exact answers');
      expect(clause).toContain('Never prewrite unapproved remedies or skip sections or the terminal report');
      expect(clause).not.toContain('ANY non-trivial finding');
      expect(clause).not.toContain('Zero findings in every section is the only path');
    }
  });
});

// These checks cover generated instructions, not native model compliance.
describe('outside-voice commitment queue', () => {
  test('Eng selects the other provider and preserves explicit native fallback on every host', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const eng = generateCodexPlanReview({ host: host.name, paths: HOST_PATHS[host.name]!, skillName: 'plan-eng-review' } as TemplateContext);
      const provider = host.name === 'codex' ? 'Claude Code' : 'Codex';
      const mismatch = host.name === 'codex' ? 'under_current_harness' : 'under_codex';
      expect(eng).toContain(`**If \`CODEX_MODE: ready\` — run ${provider}:**`);
      const fallback = eng.slice(eng.indexOf('**Native fallback —'), eng.indexOf('**Bounded outside-voice wait'));
      const routing = eng.slice(eng.indexOf('**Outcome routing:**'), eng.indexOf('**Disabled is a terminal branch'));
      const preflight = eng.match(/```bash\n([\s\S]*?)\n```/)![1];
      expect(preflight).toContain(mismatch);
      expect(routing).toContain('Other preflight mode, including harness mismatch');
      expect(routing).toContain('Outside execution or output validation fails');
      expect(routing).toContain('finish termination, then use Native fallback');
      const bounded = eng.slice(eng.indexOf('**Bounded outside-voice wait'), eng.indexOf('**Cross-model tension:**'));
      expect(bounded).toContain('A native result never supplies outside coverage.');
      expect(eng).toContain('A completed native fallback uses SOURCE=in-host, OUTSIDE_STATUS=unavailable, and STATUS=clean or issues_found from its findings');
      expect(eng).toContain("These findings are the reviewer's, even if later resolved by the parent");
      expect(fallback.replace(/\s+/g, ' ')).toContain('Immediately before dispatch, check the preflight result again: disabled means no replacement');
      expect(eng).not.toContain('No in-host substitute is defined here');
      if (host.name === 'codex') {
        expect(eng).toContain('gstack-claude-code');
        expect(eng).not.toContain('codex exec');
      } else {
        expect(eng).toContain('codex exec');
        expect(eng).toContain('construct the prompt below, then follow **Native fallback**');
        expect(eng).not.toContain("follow the workflow's native-review instructions below");
      }
    }
  });

  const skills = ['plan-ceo-review', 'plan-eng-review', 'plan-devex-review'];
  for (const host of ALL_HOST_CONFIGS) {
    test(`${host.name}: separates changed commitments and preserves scope revision choices`, () => {
      for (const skillName of skills) {
        const tmplPath = `${skillName}/sections/review-sections.md.tmpl`;
        expect(readFileSync(tmplPath, 'utf8')).toContain('{{CODEX_PLAN_REVIEW}}');
        const generated = generateCodexPlanReview({ skillName, tmplPath, host: host.name, paths: HOST_PATHS[host.name]! });
        const start = generated.indexOf(skillName === 'plan-ceo-review'
          ? '**Integrate reviewer findings:**' : '**Cross-model tension:**');
        const end = generated.indexOf('**Persist the result:**', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const queue = generated.slice(start, end);
        // Each review reuses its own gate; DX retains the generic queue.
        if (skillName === 'plan-ceo-review') {
          expect(queue).toContain('same six-column ledger. Use 0D for new or reopened choices');
          expect(queue).toContain('including both saves and the actual answer; do not start a second procedure');
          expect(queue).not.toContain('reference | commitment | current value');
          expect(queue).toContain('original input, inspected source and exact approvals');
          expect(queue).toContain('Correct false premises without changing accepted behavior');
          expect(queue).toContain('Keep uncertainty with its owner and required verification');
          expect(queue).toContain('A credible material risk can require action before confirmation');
          expect(queue).toContain("Use 0D's rules for independent choices, fixed/pending commitments, required proof and new test additions");
          expect(queue).toContain("A) Apply this change; B) Keep this row's current value; C) Investigate before choosing; D) Defer this proposed change only");
          expect(queue).toContain('D leaves this proposal row unresolved');
          expect(queue).toContain('Keep candidate scope, scheduling and other approved or pending choices unchanged; ask separately before changing them');
          expect(queue).toContain('**Whole-candidate scope:** A) Include; B) Defer; C) Cut; D) Hold');
          expect(queue).toContain('Revising two candidates takes two rows');
          expect(queue).toContain('Hold stops for discussion without changing the prior disposition');
          expect(queue).toContain("check the assembled set's capacity and dependencies");
          expect(queue).toContain("A conflict returns to the affected candidate's Include/Defer/Cut/Hold row");
          expect(queue).toContain('retain prior answers, report unresolved conflicts and recheck before confirming the set');
          expect(queue).toContain('Never silently trim or replace another candidate');
          const skeleton = readFileSync('plan-ceo-review/SKILL.md.tmpl', 'utf8').replace(/\s+/g, ' ');
          // Delegation must resolve to the complete procedure, including the
          // saved comparison and separate actual answer, without duplicating it.
          const stages = ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
            'Record pending rows before comparisons;', "**3. Compare and save that row's options.**",
            '**Pre-question checkpoint:**', '**4. Ask, record the answer, and amend.**'].map(stage => skeleton.indexOf(stage));
          expect(stages.every(position => position >= 0)).toBe(true);
          expect(stages).toEqual([...stages].sort((a, b) => a - b));
          expect(skeleton).toContain("`D<N> — <ROW-ID>: <one-line question>`");
          expect(skeleton).toContain("Ask one row per call with that object unchanged, without recomposing");
          expect(skeleton).toContain('Compare its question, header, labels and full descriptions literally with the verified fields');
          expect(skeleton).toContain('ROW-ID identifies the pending choice');
          expect(skeleton).toContain("Save the answer reference and scope");
          expect(skeleton).toContain("amend only authorized work");
          expect(queue).toContain('Keep preserves the current disposition; investigation and deferral do not authorize implementation');
          expect(queue).toContain('preserve authorized auto-decisions, the audit trail and User Challenge rules; challenges wait for the final gate');
          expect(queue).toContain('One answer does not resolve other pending rows');
          expect(queue).toContain('including findings that needed only factual correction');
          continue;
        }
        if (skillName === 'plan-eng-review') {
          expect(queue).toContain('Run every outside finding through the same Decision procedure and decision records above');
          expect(queue).toContain('Record the reviewer and evidence');
          expect(queue).not.toContain('reference | commitment | current value');
          expect(queue).toContain('Agreement between reviewers is evidence, not approval');
          expect(queue).toContain('new or reopened choices still need their own answers');
          expect(queue).toContain('four-option menus instead of the ordinary 2-3 options');
          expect(queue).toContain('Identify one independently answerable change before building its alternatives, then compare and save them as the Decision procedure requires');
          // The outside step delegates authority, saved comparisons and actual
          // answers to the one procedure already checked above, not a second gate.
          const procedure = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
          expect(compactProse(procedure)).toContain("Reopen an approved choice only for a concrete new risk, contradictory evidence or a changed assumption");
          expect(compactProse(procedure)).toContain('Save the record, complete grid and exact `currentDecision`');
          expect(compactProse(procedure)).toContain("Replace the whole adjacent `State` / `Actual answer` / `Accepted scope` block after the options. Use the actual option and answer reference");
          expect(compactProse(procedure)).toContain("Preserve the options");
          expect(compactProse(procedure)).toContain("Use a scoped Edit to save this record and only the authorized working-plan amendments");
          expect(queue).toContain("A) Apply this change; B) Keep this row's current value; C) Investigate before choosing; D) Defer this proposed change only");
          expect(queue).toContain('D leaves this proposal row unresolved');
          expect(queue).toContain('Keep candidate scope, scheduling and other approved or pending choices unchanged; ask separately before changing them');
          expect(queue).toContain('**Whole-candidate scope:** A) Include; B) Defer; C) Cut; D) Hold');
          expect(queue).toContain('Revising two candidates takes two rows');
          expect(queue).toContain('Hold stops for discussion without changing the prior disposition');
          expect(queue).toContain("check the assembled set's capacity and dependencies");
          expect(queue).toContain("return to the affected candidate's Include/Defer/Cut/Hold row");
          expect(queue).toContain('preserve prior answers, report unresolved conflicts, and recheck the set before confirming it');
          expect(queue).toContain('Never silently trim or replace another candidate');
          expect(queue).toContain('Keep necessary code, tests and docs for one approved behavior together');
          expect(queue).toContain("An answer to one row does not resolve the finding's other pending rows");
          expect(queue).toContain("Preserve /autoplan's authorized auto-decisions, audit trail and User Challenge rules; challenges wait for its final gate");
          continue;
        }
        if (skillName === 'plan-devex-review') {
          expect(queue).toContain('same five-field working list and four-step Decision gate');
          expect(queue).not.toContain('reference | commitment | current value');
          const stages = ['1. **Ground the evidence.**', '2. **Classify the finding.**',
            '3. **Check the scope.**', '4. **Draft and answer one decision.**',
            'Use AskUserQuestion', 'Wait for the actual answer',
            'then use a scoped Edit for those amendments before taking the next row.']
            .map(stage => queue.indexOf(stage));
          expect(stages.every(position => position >= 0)).toBe(true);
          expect(stages).toEqual([...stages].sort((a, b) => a - b));
          expect(queue).toContain('Hold every other value fixed or pending in EVERY option');
          expect(queue).toContain('split independently selectable changes');
          expect(queue).toContain('Defer this proposed change only');
          expect(queue).toContain('does not defer its entire candidate or approve a new schedule gate');
          expect(queue).toContain('**Whole-candidate scope:** A) Include; B) Defer; C) Cut; D) Hold');
          expect(queue).toContain('Revising two candidates takes two rows');
          expect(queue).toContain('Hold stops for discussion without changing the prior disposition');
          expect(queue).toContain("check the assembled set's capacity and dependencies");
          expect(queue).toContain("returns to the affected candidate's Include/Defer/Cut/Hold row");
          expect(queue).toContain('preserve prior answers, report unresolved conflicts, and recheck before confirming the set');
          expect(queue).toContain('Never silently trim or replace another candidate');
          expect(queue).toContain('Record its answer reference and exact accepted scope');
          expect(queue).toContain("An answer to one row does not resolve the finding's other pending rows");
          expect(queue).toContain('preserve its authorized auto-decisions, audit trail and User Challenge rules');
          expect(queue).toContain('challenges stay pending for the final gate');
          continue;
        }
        const stages = [
          '**1. Queue one changed commitment per row.**',
          '**2. Draft from one row.**',
          'Use AskUserQuestion.',
          '**3. Obtain the answer.**',
          '**4. Apply the answered row.**',
          'then use a scoped Edit for those amendments before taking the next row.',
        ].map(stage => queue.indexOf(stage));
        expect(stages.every(position => position >= 0)).toBe(true);
        expect(stages).toEqual([...stages].sort((a, b) => a - b));
        const text = queue.replace(/\s+/g, ' ');
        expect(text).toContain('reference | commitment | current value + approval reference | proposed value');
        expect(text).toContain('its reference is not the unit of approval');
        expect(text).toContain('an exhausted-job destination, an optional alert and a replay facility are separate commitments');
        expect(text).toContain('Code, tests and docs establishing that same chosen behavior stay together');
        expect(text).toContain('Hold every other commitment fixed or pending in EVERY option');
        expect(text).toContain('If an option changes another commitment, split it first');
        expect(text).toContain('Defer this proposed change only');
        expect(text).toContain('does not defer its entire candidate or approve a new schedule gate');
        expect(text).toContain('**Whole-candidate scope:** use A) Include; B) Defer; C) Cut; D) Hold');
        expect(text).toContain('Revising two candidates takes two rows, never a swap package');
        expect(text).toContain('Hold stops for discussion; it is not a final disposition');
        expect(text).toContain('preserve prior answers and report any blocking conflict unresolved');
        expect(text).toContain("validate the assembled set's capacity and dependencies");
        expect(text).toContain("a conflict returns to a named candidate's Include/Defer/Cut/Hold row");
        expect(text).toContain('Revalidate before confirming the set');
        expect(text).toContain('Record its answer reference and exact accepted scope');
        expect(text).toContain("one answer does not clear the finding's remaining changes");
        expect(text).toContain('Reopening requires concrete contradictory evidence or a changed assumption');
        expect(text).toContain('Retain unresolved risks and proof');
        expect(text).toContain('preserve its authorized auto-decision and User Challenge rules, audit trail and final gate');
        expect(text).toContain("User Challenges stay pending for /autoplan's final gate");
        expect(text).not.toContain('Cross-model disagreement on [topic]');
      }
    });
  }
});

describe('plan-review manual handoff selection', () => {
  test('selects the retained DX manual handoff over its separate implementation suggestion', () => {
    const labels = ['Run /plan-eng-review next (Recommended)', 'Ready to implement', 'Skip, handle manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps', 'D30 — Next steps: which review runs next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next steps', 'D30 — Next steps: which review runs next?'))).toBe(1);
  });
  test('accepts the retained paired-review short manual handoff by native position', () => {
    const labels = ['A: Run /plan-eng-review next (recommended)', 'B: Skip, handle manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next review', 'D10 — Which review runs next?'))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next review', 'D10 — Which review runs next?'))).toBe(1);
  });
  test('short manual handoff requires a recognized offer and excludes extra actions', () => {
    const run = 'Run /plan-eng-review';
    const skip = 'Skip, handle manually';
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior', skip]))).toBe(1);
    expect(pickPlanReviewQuestion(menu([run, skip], 'Tests', 'D8 — Should the test run a review?'))).toBe(1);
    for (const extra of [' and approve all edits', '; run /ship', ' after implementation']) {
      expect(() => pickPlanReviewQuestion(menu([run, skip + extra]))).toThrow('unambiguous');
    }
    for (const extra of [skip, 'Skip', 'Ship immediately']) {
      expect(() => pickPlanReviewQuestion(menu([run, skip, extra]))).toThrow('unambiguous');
    }
  });
  test('declines the actual colon-labelled CEO handoff by native position', () => {
    const labels = ['A: run /plan-eng-review next (recommended)', 'C: skip, handle reviews manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next review',
      'D13 — Which review should run next on this plan?'))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next review',
      'D13 — Which review should run next on this plan?'))).toBe(1);
  });
  test('colon labels do not broaden handoff authority or accept extra actions', () => {
    const labels = ['A: Run /plan-eng-review', 'C: Skip, handle reviews manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Tests', 'D8 — Should the test run a review?'))).toBe(1);
    for (const extra of [' and approve all edits', '; run /ship', ' after implementation']) {
      expect(() => pickPlanReviewQuestion(menu([labels[0]!, labels[1]! + extra])))
        .toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(menu([...labels, 'D: Skip, handle reviews manually'])))
      .toThrow('unambiguous');
  });
  test('declines the retained native two-option next-review offer', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip — handle reviews manually']))).toBe(2);
  });
  test('selects the retained Engineering readiness offer by its native position', () => {
    const labels = ['C) Ready to implement (recommended)', 'B) Run /plan-ceo-review'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps',
      'Next steps: any further review before implementation?'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next steps',
      'Next steps: any further review before implementation?'))).toBe(2);
  });
  test('selects readiness from the retained Engineering review-first handoff', () => {
    const labels = ['C: Ready to implement — run /ship when done (recommended)', 'B: Run /plan-ceo-review first'];
    const question = 'D17 — Eng review is CLEARED. Chain another review, or proceed to implementation?';
    expect(pickPlanReviewQuestion(menu(labels, 'Next step', question))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next step', question))).toBe(2);
  });
  test('review-first recognition preserves manual precedence and question context', () => {
    const labels = ['Run /plan-ceo-review first (recommended)', 'Ready to implement', 'Skip — handle reviews manually'];
    expect(pickPlanReviewQuestion(menu(labels))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed()))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels, 'Tests', 'D4 — Should this test run a review?'))).toBe(1);
  });
  test.each([
    'Run /plan-ceo-review firstly',
    'Run /plan-ceo-review first next',
    'Run /plan-ceo-review first and approve all edits',
    'Run /plan-ceo-review first; run /ship',
    'Run /plan-unknown-review first',
    'Run /design-shotgun first',
  ])('review-first handoffs reject unknown or extended run labels: %s', label => {
    expect(() => pickPlanReviewQuestion(menu([label, 'Ready to implement — run /ship when done'])))
      .toThrow('unambiguous');
  });
  test.each([
    ['Run /plan-ceo-review', 'Ready to implement now'],
    ['Run /plan-ceo-review', 'Ready to implement and approve all edits'],
    ['Run /plan-ceo-review', 'Ready to implement; run /ship'],
    ['Ready to implement', 'Ready to implement — run /ship when done'],
  ])('rejects added execution authority or ambiguous readiness: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('selects the source-prescribed manual choice after both applicable reviews', () => {
    expect(pickPlanReviewQuestion(menu([
      'A) Run /plan-eng-review next (required gate) (Recommended)',
      'B) Run /plan-design-review next', "C) Skip — I'll handle reviews manually",
    ]))).toBe(3);
  });
  test('recognizes a full next-step brief without depending on its D ordinal', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip – I’ll handle reviews manually'],
      'Handoff', "D24 — What's next?\nProject: payment review\nRecommendation: A"))).toBe(2);
  });
  test.each([
    ['ceo', 3], ['design', 5], ['devex', 4], ['eng', 3],
  ] as const)('supports every current %s review source handoff option', (skill, selected) => {
    const source = readFileSync(`plan-${skill}-review/sections/review-sections.md.tmpl`, 'utf8');
    const handoff = source.split('## Next Steps — Review Chaining')[1]?.split('\n## ')[0] ?? '';
    const labels = [...handoff.matchAll(/^- \*\*([A-E]\))(?:\*\* (.+)| ([^*]+)\*\*)/gm)]
      .map(match => `${match[1]} ${(match[2] ?? match[3]!).replace(/:$/, '')}`);
    expect(labels).toHaveLength(selected);
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps'))).toBe(selected);
    // Native dialogs allow at most four choices. Each applicable source subset
    // keeps its explicit non-running handoff; no absent choice is fabricated.
    for (let i = 0; i < selected - 1; i++) {
      expect(pickPlanReviewQuestion(menu([labels[i]!, labels[selected - 1]!]))).toBe(2);
    }
  });
  test('manual handoff takes precedence over a separate future implementation suggestion', () => {
    expect(pickPlanReviewQuestion(menu([
      'Run /plan-eng-review', 'Ready to implement, run /devex-review after shipping',
      "Skip, I'll handle next steps manually",
    ]))).toBe(3);
  });
  test('does not change ordinary findings, TODOs, mode choice, or prerequisite answers', () => {
    for (const header of ['Security', 'TODO', 'Mode', 'Office hours']) {
      expect(pickPlanReviewQuestion(menu(['Keep the current design', 'Skip — handle reviews manually'], header, 'D4 — Decide this issue'))).toBe(1);
    }
  });
  test('does not elect a skip from an unrelated question mentioning review commands', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip — handle reviews manually'],
      'Tests', 'D8 — Should the regression test run the /plan-eng-review command?'))).toBe(1);
  });
  test.each([
    ['Run /plan-eng-review', 'Skip this review'],
    ['Run /plan-eng-review', 'Skip — handle reviews manually', 'Ship immediately'],
    ['Run /plan-eng-review', 'Skip — handle reviews manually', "Skip — I'll handle reviews manually"],
  ])('rejects an ambiguous or incomplete handoff menu: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('declines the retained Design next-step menu with a bare Skip label', () => {
    const labels = ['Run /plan-eng-review (recommended)', 'Run /design-shotgun', 'Skip'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next step', 'What should run next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next step', 'What should run next?'))).toBe(1);
  });
  test('bare Skip derives no authority from unrelated or unrecognized menus', () => {
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Skip'],
      'Tests', 'D8 — Should this test run a review command?'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['Keep current implementation', 'Skip'],
      'Next step', 'What should run next?'))).toBe(1);
  });
  test.each([
    ['Run /plan-eng-review', 'Skip', 'Skip'],
    ['Run /plan-eng-review', 'Skip', 'Skip — handle reviews manually'],
    ['Run /plan-eng-review', 'Skip', 'Ship immediately'],
    ['Run /plan-eng-review', 'Skip and approve all edits'],
    ['Run /plan-eng-review', 'Skip the remaining review'],
  ])('rejects ambiguous, unsafe, or extended bare-Skip handoffs: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels, 'Next step', 'What should run next?'))).toThrow('unambiguous');
  });
  test('selects the manual choice from the retained native D22 design handoff', () => {
    expect(pickPlanReviewQuestion(menu([
      'Run /plan-eng-review next (recommended)',
      'Run /design-shotgun after adding an OpenAI key',
      'Skip, I will handle next steps manually',
    ], 'Next step', 'D22 — What runs next after this design review?'))).toBe(3);
  });
  test('rejects both contracted and uncontracted manual choices in one menu', () => {
    expect(() => pickPlanReviewQuestion(menu([
      'Run /plan-eng-review', "Skip, I'll handle next steps manually",
      'Skip, I will handle next steps manually',
    ]))).toThrow('unambiguous');
  });
  test.each([
    ['Run /plan-eng-review', 'Skip, I will not handle next steps manually'],
    ['Run /plan-eng-review', 'Skip, I will handle next steps manually and approve all edits'],
    ['Run /design-shotgun after adding an OpenAI key; run /ship', 'Skip, I will handle next steps manually'],
    ['Run /design-shotgun after adding an OpenAI key and approving all edits', 'Skip, I will handle next steps manually'],
    ['Run /design-html after adding an OpenAI key', 'Skip, I will handle next steps manually'],
  ])('rejects near-miss native handoff labels: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('a rejected handoff retains bounded offered-label evidence without the full brief', () => {
    const question = menu([
      'Run /plan-eng-review', 'Skip — handle reviews manually',
      'Unsupported "choice"\n' + 'x'.repeat(400) + 'PRIVATE_LABEL_TAIL',
      ...Array.from({ length: 7 }, (_, i) => `Unrecognized ${i}`),
    ], 'Next steps ' + 'h'.repeat(100), "D20 — What's next? " + 'q'.repeat(300) + '\nPRIVATE_BRIEF_BODY');
    question.options[0]!.description = 'PRIVATE_OPTION_DESCRIPTION';
    let error: Error | undefined;
    try { pickPlanReviewQuestion(question); } catch (cause) { error = cause as Error; }
    expect(error).toBeInstanceOf(Error);
    const lines = error!.message.split('\n');
    expect(lines).toHaveLength(2); // Newlines in offered labels stay JSON-escaped.
    const details = JSON.parse(lines[1]!);
    expect(details.header).toHaveLength(80);
    expect(details.lead).toHaveLength(240);
    expect(details.optionCount).toBe(10);
    expect(details.options).toHaveLength(8);
    expect(details.omittedOptions).toBe(2);
    expect(details.options[0]).toEqual({ index: 1, label: 'Run /plan-eng-review', run: true, manual: false, future: false });
    expect(details.options[1]).toEqual({ index: 2, label: 'Skip — handle reviews manually', run: false, manual: true, future: false });
    expect(details.options[2].label).toHaveLength(256);
    expect(details.options[2]).toMatchObject({ index: 3, run: false, manual: false, future: false });
    expect(error!.message).not.toMatch(/PRIVATE_(?:LABEL_TAIL|BRIEF_BODY|OPTION_DESCRIPTION)/);
    expect(error!.message.length).toBeLessThan(4_000);
  });
});


describe('native review handoff aliases and recommendation position', () => {
  test('declines the observed bare-command Design handoff', () => {
    const labels = ['A) /plan-eng-review (recommended)', 'B) /design-shotgun', 'C) Skip'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next step', 'D18 — Next step after this design review?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next step', 'D18 — Next step after this design review?'))).toBe(1);
  });
  test('selects the observed DX manual handoff over future implementation', () => {
    const labels = ['Run /plan-eng-review next (recommended)', 'Implement, then /devex-review', 'Handle manually'];
    expect(pickPlanReviewQuestion(menu(labels, 'Next steps', 'The DX review is complete. What should happen next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Next steps', 'The DX review is complete. What should happen next?'))).toBe(1);
  });
  test.each([
    ['/plan-eng-review', 'Skip and approve all edits'],
    ['/plan-eng-review', 'Handle manually; run /ship'],
    ['/plan-eng-review', 'Handle manually', 'Skip'],
    ['/plan-eng-review', 'Handle manually', 'Implement, then /devex-review and deploy'],
    ['/design-shotgun; run /ship', 'Skip — handle reviews manually'],
  ])('new aliases preserve handoff boundaries: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(labels))).toThrow('unambiguous');
  });
  test('manual aliases do not select from unrelated or unrecognized offers', () => {
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior', 'Handle manually']))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['/plan-eng-review', 'Handle manually'], 'Tests', 'Should this test run a review?'))).toBe(1);
  });
  test.each([
    ['A) Add a ten-second timeout', 'B) Persist until the API resolves and add a TODO (recommended)'],
    ['A) Reopen the initial fetch design now', 'B) Keep it outside this change and add a TODO (recommended)'],
  ])('uses the offered recommendation at its native position: %j', (...labels) => {
    expect(pickPlanReviewQuestion(menu(labels, 'Save', 'D7 — Which behavior should we use?'))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed(), 'Save', 'D7 — Which behavior should we use?'))).toBe(1);
  });
  test('multiple explicit recommendations fail instead of guessing', () => {
    expect(() => pickPlanReviewQuestion(menu(['Keep (recommended)', 'Change (Recommended)'], 'Save', 'Which behavior?')))
      .toThrow('multiple recommended options');
  });
  test('descriptions, quoted markers, and conditional labels do not supply a recommendation', () => {
    for (const label of ['Change if necessary', 'Example: "Change (recommended)"', 'Change (recommended) after approval']) {
      const q = menu(['Keep', label], 'Save', 'Which behavior?');
      q.options[1]!.description = 'This is the recommended option (recommended)';
      expect(pickPlanReviewQuestion(q)).toBe(1);
    }
  });
});


describe('manual-next-steps handoff alias', () => {
  test('declines the exact retained Design menu in either native order', () => {
    const question: NativeQuestion = {
  "header": "Next step",
  "multiSelect": false,
  "options": [
    {
      "description": "Required shipping gate; validates the interaction specs this review added.",
      "label": "A) Run /plan-eng-review (recommended)"
    },
    {
      "description": "Exit plan mode with the design-reviewed plan; no further review now.",
      "label": "E) Skip, manual next steps"
    }
  ],
  "question": "D12 — What should run next?\nProject/branch/task: main — Settings redesign plan is design-complete (5/10 → 9/10, 7 decisions, 0 unresolved).\nELI10: The design review is done and written into the plan. Before anyone builds it, gstack's shipping gate wants an engineering review of the same plan: it checks that the token scoping, the aria-disabled click guard, the min-width lock, and the 14px audit are technically sound and testable. A CEO review is not warranted: the plan's product direction was never in question. Design exploration skills need a keyed designer, which this environment lacks.\nStakes if we pick wrong: skipping eng review means /ship will report NOT CLEARED later; running it now costs one more review pass.\nRecommendation: A because eng review is the only review that gates shipping, and this design review added interaction specs (busy-button semantics, token ownership) that need an architectural check.\nNote: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Run /plan-eng-review next (recommended)\n  ✅ Clears the required gate while the seven decisions are fresh in the plan\n  ✅ Validates aria-disabled guard, min-width lock, and Settings-scoped token ownership\n  ❌ One more interactive review session before implementation begins\nE) Skip, handle next steps manually\n  ✅ Start implementing T1-T7 immediately from the plan\n  ✅ No further review questions today\n  ❌ /ship will report NOT CLEARED until an eng review runs\nNet: clear the gate now or defer it to ship time."
};
    expect(pickPlanReviewQuestion(question)).toBe(2);
    expect(pickPlanReviewQuestion({ ...question, options: question.options.toReversed() })).toBe(1);
  });
  test('keeps manual preference and requires recognized next-review context', () => {
    const skip = 'E) Skip, manual next steps';
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review', 'Ready to implement', skip], 'Next step', 'What should run next?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior', skip], 'Next step', 'What should run next?'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['Run /plan-eng-review (recommended)', skip], 'Tests', 'D8 — Should this test run a review?'))).toBe(1);
  });
  test.each([
    'Skip, automated next steps',
    'Skip, manual next steps and approve all edits',
    'Skip, manual next steps; run /ship',
    'Skip, manual next steps after implementation',
    'Skip, manual next steps (automatically)',
    'Skip, manual next steps then deploy',
  ])('rejects an automation or extended lookalike: %s', (label) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review', label], 'Next step', 'What should run next?'))).toThrow('unambiguous');
  });
  test.each([
    ['Skip, manual next steps', 'Skip, manual next steps'],
    ['Skip, manual next steps', 'Handle manually'],
    ['Skip, manual next steps', 'Ship immediately'],
  ])('keeps ambiguous or unsafe menus refused: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review', ...labels], 'Next step', 'What should run next?'))).toThrow('unambiguous');
  });
});


describe('DX implement-now future handoff alias', () => {
  test('declines the exact retained DX future-alias menu in either native order', () => {
    const question: NativeQuestion = {
  "header": "Next review",
  "multiSelect": false,
  "options": [
    {
      "description": "Architecture and test review of the amended plan; clears the required ship gate.",
      "label": "Run /plan-eng-review next (recommended)"
    },
    {
      "description": "Start on T1-T9; measure real TTHW with the boomerang after shipping.",
      "label": "Implement now, /devex-review after"
    },
    {
      "description": "End here; no next review scheduled.",
      "label": "Skip, handle manually"
    }
  ],
  "question": "D17 — DX review complete. Which review runs next?\nProject/branch/task: main branch; eval-sdk public beta plan, DX review CLEAR (7/10 → 8/10), 16 decisions logged, zero unresolved.\nELI10: This review changed the plan in ways that touch code: the first-run gate is decoupled in two entrypoints, a new explicit conformance command appears, and five release checks are added. Those are architecture and test decisions, and Eng Review is the one gate that must be clear before shipping. The dashboard shows Eng Review at zero runs, so the verdict is NOT CLEARED. No end-user UI is in scope, so Design Review does not apply. After implementation, /devex-review on the shipped beta is the boomerang that measures whether the 5-minute target held in reality.\nStakes if we pick wrong: skip Eng Review and the gate decoupling ships without an architecture pass on state handling and release-check design; run it and the plan gets validated where the DX changes are riskiest.\nRecommendation: A because the DX changes T1, T2, and T6 are code and test changes that Eng Review exists to validate, and the ship gate requires it anyway.\nNote: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Run /plan-eng-review next (required gate) (recommended)\n  ✅ Validates the gate decoupling, conformance command, and release-check design before any code is written (human: ~30 min / CC: ~10 min)\n  ✅ Clears the only review the ship dashboard requires\n  ❌ Adds a review cycle before implementation starts\nB) Ready to implement; run /devex-review after shipping\n  ✅ Fastest path to code; nine tasks are already specified with verification steps\n  ✅ The post-ship boomerang still measures the real TTHW against the 5-minute target\n  ❌ Ship dashboard stays NOT CLEARED until Eng Review runs on the diff instead of the plan\nC) Skip, I'll handle next steps manually\n  ✅ You keep full control of sequencing\n  ✅ Nothing else runs automatically\n  ❌ No review is scheduled; the required gate is still open\nNet: A clears the required gate on the plan; B defers it to the diff; C leaves it to you."
};
    expect(pickPlanReviewQuestion(question)).toBe(3);
    expect(pickPlanReviewQuestion({ ...question, options: question.options.toReversed() })).toBe(1);
  });
  test('selects the exact future alias only within a recognized handoff', () => {
    const labels = ['Run /plan-eng-review next (recommended)', 'Implement now, /devex-review after'];
    expect(pickPlanReviewQuestion(menu(labels))).toBe(2);
    expect(pickPlanReviewQuestion(menu(labels.toReversed()))).toBe(1);
    expect(pickPlanReviewQuestion(menu(labels, 'Tests', 'Which test behavior?'))).toBe(1);
    expect(() => pickPlanReviewQuestion(menu(['Ready to implement', labels[1]!]))).toThrow('unambiguous');
  });
  test.each([
    'Implement now, /devex-review after and approve all edits',
    'Implement now, /devex-review after; run /ship',
    'Implement now, /devex-review after and deploy',
    'Implement now, /plan-eng-review after',
    'Implement now, /devex-review',
    'Implement later, /devex-review after',
  ])('rejects an extended or different future alias: %s', (label) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review next', label, 'Skip, handle manually']))).toThrow('unambiguous');
  });
  test.each([
    ['Implement now, /devex-review after', 'Ready to implement'],
    ['Implement now, /devex-review after', 'Implement now, /devex-review after'],
    ['Implement now, /devex-review after', 'Skip, handle manually', 'Handle manually'],
    ['Implement now, /devex-review after', 'Skip, handle manually; run /ship'],
  ])('keeps ambiguous or unsafe future-alias menus refused: %j', (...labels) => {
    expect(() => pickPlanReviewQuestion(menu(['Run /plan-eng-review', ...labels]))).toThrow('unambiguous');
  });
});


describe('DX future handoff punctuation', () => {
  const future = 'Ready to implement; run /devex-review after shipping';
  const run = 'Run /plan-eng-review next (required gate) (recommended)';
  const manual = "Skip, I'll handle next steps manually";
  // Exact retained D13 header, first line and labels: fd620d native question
  // toolu_01YLyQ6Zw1mDmhPXs3G1peaK, diagnostic session028cd11a-a8fe-46ba-99c6-e348835678f4.
  // The picker reads only these fields; the full public brief/ID stays in the repair receipt.
  const captured = menu([
    'Run /plan-eng-review next (recommended)',
    'Ready to implement; /devex-review after shipping',
    "Skip, I'll handle next steps manually",
  ], 'Next step', 'D13 — What should happen next after this DX review?');
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  test('replays the captured DX future handoff without a redundant run verb in every option order', () => {
    for (const order of orders) {
      const question = { ...captured, options: order.map(index => captured.options[index]!) };
      expect(pickPlanReviewQuestion(question)).toBe(order.indexOf(2) + 1);
    }
  });
  test('accepts optional run with comma or semicolon while preserving manual priority', () => {
    for (const separator of [',', ';']) for (const verb of ['', 'run ']) {
      const label = `Ready to implement${separator} ${verb}/devex-review after shipping`;
      const labels = [run, label, manual];
      for (const order of orders) {
        expect(pickPlanReviewQuestion(menu(order.map(index => labels[index]!)))).toBe(order.indexOf(2) + 1);
      }
      expect(pickPlanReviewQuestion(menu([run, label]))).toBe(2);
      expect(pickPlanReviewQuestion(menu([label, run]))).toBe(1);
    }
  });
  test('optional run does not admit changed targets, timing, negation or extra actions', () => {
    for (const label of [
      'Ready to implement; /plan-devex-review after shipping',
      'Ready to implement; /devex-review before shipping',
      'Ready to implement; /devex-review after implementation',
      'Ready to implement; /devex-review now',
      'Ready to implement; do not run /devex-review after shipping',
      'Not ready to implement; /devex-review after shipping',
      'Ready to implement; /devex-review not after shipping',
      'Ready to implement; /devex-review after shipping and approve all edits',
      'Ready to implement; /devex-review after shipping; run /ship',
      'Ready to implement; /devex-review after shipping\nrun /ship',
      'Ready to implement:: /devex-review after shipping',
    ]) expect(() => pickPlanReviewQuestion(menu([run, label, manual]))).toThrow('unambiguous');
  });
  test('the captured future label retains context, duplicate and whole-menu refusal', () => {
    const label = captured.options[1]!.label;
    expect(pickPlanReviewQuestion(menu([run, label, manual], 'Tests',
      'D8 — Which regression should cover this label?\nNext step: handle manually.'))).toBe(1);
    for (const extra of [manual, 'Handle manually', 'Ship immediately', '/unknown-review']) {
      expect(() => pickPlanReviewQuestion(menu([run, label, manual, extra]))).toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(menu([run, label, label]))).toThrow('unambiguous');
    expect(() => pickPlanReviewQuestion(menu([run, label, future]))).toThrow('unambiguous');
  });
  test('accepts the native semicolon menu while choosing the offered manual handoff', () => {
    expect(pickPlanReviewQuestion(menu([run, future, manual], 'Next review',
      'D22 — Which review should run next on this plan?'))).toBe(3);
    expect(pickPlanReviewQuestion(menu([manual, future, run]))).toBe(1);
    expect(pickPlanReviewQuestion(menu([run, future]))).toBe(2);
    expect(pickPlanReviewQuestion(menu([future, run]))).toBe(1);
  });
  test('keeps the context, unique-choice, and exact-action boundaries', () => {
    expect(pickPlanReviewQuestion(menu([run, future, manual], 'Tests', 'Choose test coverage'))).toBe(1);
    for (const suffix of [' and approve all edits', '; run /ship', ' then deploy', ' now']) {
      expect(() => pickPlanReviewQuestion(menu([run, future + suffix, manual]))).toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(menu([run, future, future]))).toThrow('unambiguous');
    expect(() => pickPlanReviewQuestion(menu([run, future, manual, 'Ship immediately']))).toThrow('unambiguous');
  });
});


describe('manual handoff punctuation', () => {
  const run = 'A) Run /plan-eng-review next (recommended)';
  const manual = "C) Skip: I'll handle reviews manually";

  test('selects the exact retained paired menu by offered index, not its letter', () => {
    const question = menu([run, manual], 'Next review',
      'Next step: run /plan-eng-review on this plan now?');
    expect(pickPlanReviewQuestion(question)).toBe(2);
    expect(pickPlanReviewQuestion({ ...question, options: question.options.toReversed() })).toBe(1);
  });

  test.each([',', ':', ';', '.', '—', '–', '-'])('accepts the finite manual-action grammar with separator %s', separator => {
    for (const action of ["I'll handle reviews manually", 'I’ll handle next steps manually',
      'I will handle reviews manually', 'handle next steps manually', 'handle manually']) {
      const label = `C) Skip ${separator} ${action}`;
      expect(pickPlanReviewQuestion(menu([run, 'Ready to implement', label]))).toBe(3);
      expect(pickPlanReviewQuestion(menu([label, 'Ready to implement', run]))).toBe(1);
    }
  });

  test('retains handoff context and the short-form recognized-offer requirement', () => {
    expect(pickPlanReviewQuestion(menu([run, manual], 'Tests', 'Choose regression coverage'))).toBe(1);
    expect(pickPlanReviewQuestion(menu(['Keep existing behavior (recommended)', 'Skip: handle manually']))).toBe(1);
    expect(pickPlanReviewQuestion(menu([run, 'Skip: handle manually']))).toBe(2);
  });

  test.each([
    "Skip: I won't handle reviews manually",
    'Skip: I will not handle reviews manually',
    "Skip: I'll handle reviews automatically",
    "Skip: I'll handle reviews manually and approve all edits",
    "Skip: I'll handle reviews manually; run /ship",
    "Skip: I'll handle reviews manually then deploy",
    "Maybe Skip: I'll handle reviews manually",
    "Skip:: I'll handle reviews manually",
    "Skip/ I'll handle reviews manually",
  ])('refuses changed or extended manual intent: %s', label => {
    expect(() => pickPlanReviewQuestion(menu([run, label]))).toThrow('unambiguous');
  });

  test('refuses duplicate manual choices and unknown additional actions', () => {
    for (const extra of [manual, "Skip — I'll handle reviews manually", 'Handle manually', 'Ship immediately']) {
      expect(() => pickPlanReviewQuestion(menu([run, manual, extra]))).toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(menu([run + '; run /ship', manual]))).toThrow('unambiguous');
  });
});


describe('Design native handoff formatting', () => {
  // Exact retained D15 header, first question line, and offered labels. The
  // selector does not consult the longer explanatory body or descriptions.
  const labels = ['A Run /plan-eng-review next (recommended)',
    'C Run /design-shotgun to explore visual variants',
    "E Skip, I'll handle next steps manually"];
  const nativeMenu = (offered: string[]) => menu(offered, 'Next step',
    'D15 — Next step after the design review?');

  test('replays the retained D15 choice at every native position without treating letters as indices', () => {
    for (const [order, expected] of [
      [[0, 1, 2], 3], [[2, 0, 1], 1], [[0, 2, 1], 2],
      [[1, 0, 2], 3], [[1, 2, 0], 2], [[2, 1, 0], 1],
    ] as const) {
      expect(pickPlanReviewQuestion(nativeMenu(order.map(i => labels[i]!)))).toBe(expected);
    }
  });

  const d13Labels = ['A Run /plan-eng-review next (recommended)',
    'C Run /design-shotgun for visual variants',
    "E Skip, I'll handle next steps manually"];
  const d13Menu = (offered: string[]) => menu(offered, 'Next step',
    'D13 — Next step after the design review?');

  test('replays the retained D13 visual-variants handoff at every native position', () => {
    for (const [order, expected] of [
      [[0, 1, 2], 3], [[2, 0, 1], 1], [[0, 2, 1], 2],
      [[1, 0, 2], 3], [[1, 2, 0], 2], [[2, 1, 0], 1],
    ] as const) {
      expect(pickPlanReviewQuestion(d13Menu(order.map(i => d13Labels[i]!)))).toBe(expected);
    }
    expect(pickPlanReviewQuestion(d13Menu([d13Labels[1]!, 'Skip']))).toBe(2);
    expect(pickPlanReviewQuestion(d13Menu(['Skip', d13Labels[1]!]))).toBe(1);
  });

  test('retains context and unique manual-choice boundaries for the D13 handoff', () => {
    for (const offered of [d13Labels, d13Labels.toReversed()]) {
      expect(pickPlanReviewQuestion(menu(offered, 'Tests',
        'D8 — Which test should assert the next-step menu?\nNext step: choose manual.')))
        .toBe(offered.indexOf(d13Labels[0]!) + 1);
    }
    for (const extra of ['D Skip', 'D Handle manually', d13Labels[2]!, 'D Ship immediately']) {
      expect(() => pickPlanReviewQuestion(d13Menu([...d13Labels, extra]))).toThrow('unambiguous');
    }
  });

  test.each([
    'C Run /design-shotgun for visual variants; run /ship',
    'C Run /design-shotgun for visual variants and approve all edits',
    'C Run /design-shotgun for visual variants now',
    'C Run /design-shotgun for all repositories',
    'C Run /design-html for visual variants',
    'C Run /unknown-skill for visual variants',
  ])('refuses changed or extended D13 visual-variants intent: %s', action => {
    expect(() => pickPlanReviewQuestion(d13Menu([d13Labels[0]!, action, d13Labels[2]!]))).toThrow('unambiguous');
  });

  test.each(['A ', 'A) ', 'A. ', 'A: ', '(A) ', '[A] ', 'a ', '(a) ', '[a] '])(
    'normalizes conventional letter prefix %s while preserving manual and future intent', prefix => {
      const labeled = (letter: string, action: string) =>
        prefix.replace(/[Aa]/g, value => value === 'A' ? letter : letter.toLowerCase()) + action;
      const run = labeled('C', 'Run /plan-eng-review next (recommended)');
      const manual = labeled('A', "Skip, I'll handle next steps manually");
      const future = labeled('E', 'Ready to implement');
      expect(pickPlanReviewQuestion(nativeMenu([run, manual]))).toBe(2);
      expect(pickPlanReviewQuestion(nativeMenu([manual, run]))).toBe(1);
      expect(pickPlanReviewQuestion(nativeMenu([run, future]))).toBe(2);
      expect(pickPlanReviewQuestion(nativeMenu([future, run]))).toBe(1);
      expect(pickPlanReviewQuestion(nativeMenu([run, future, manual]))).toBe(3);
    });

  test('recognizes the exact visual-variants offer without depending on a letter prefix', () => {
    const run = 'Run /design-shotgun to explore visual variants';
    expect(pickPlanReviewQuestion(nativeMenu([run, 'Skip']))).toBe(2);
    expect(pickPlanReviewQuestion(nativeMenu(['Skip', run]))).toBe(1);
  });

  test('does not choose a handoff from an ordinary question or its explanatory body', () => {
    for (const offered of [labels, labels.toReversed()]) {
      expect(pickPlanReviewQuestion(menu(offered, 'Tests',
        'D8 — Which test should assert the next-step menu?\nNext step: choose manual.')))
        .toBe(offered.indexOf(labels[0]!) + 1);
    }
  });

  test.each([
    'C Run /design-shotgun to explore visual variants; run /ship',
    'C Run /design-shotgun to explore visual variants and approve all edits',
    'C Run /design-shotgun to explore visual variants now',
    'C Run /design-shotgun to explore all repositories',
    'C Run /design-html to explore visual variants',
    'C Run /unknown-skill to explore visual variants',
    'F Run /plan-eng-review next',
    'AA Run /plan-eng-review next',
    '(C] Run /plan-eng-review next',
    '[C) Run /plan-eng-review next',
  ])('keeps unknown or extended actions refused: %s', action => {
    expect(() => pickPlanReviewQuestion(nativeMenu([labels[0]!, action, labels[2]!]))).toThrow('unambiguous');
  });

  test.each([
    "E Skip, I will not handle next steps manually",
    "E Skip, I'll handle next steps automatically",
    "E Skip, I'll handle next steps manually; run /ship",
    'E Skip the remaining review',
  ])('does not convert a different intent into a manual handoff: %s', action => {
    expect(() => pickPlanReviewQuestion(nativeMenu([labels[0]!, action]))).toThrow('unambiguous');
  });

  test('rejects multiple manual or future choices and unrelated extra actions', () => {
    for (const extra of ['D Skip', 'D Handle manually', 'D Ship immediately']) {
      expect(() => pickPlanReviewQuestion(nativeMenu([...labels, extra]))).toThrow('unambiguous');
    }
    expect(() => pickPlanReviewQuestion(nativeMenu([
      labels[0]!, 'C Ready to implement', 'E Ready to implement — run /ship when done',
    ]))).toThrow('unambiguous');
  });
});

// The native review invented controls from a section name, then reopened an
// accepted treatment. This guards the instructions, not model compliance.
test('Design decision register grounds new items before offering design choices', () => {
  const template = readFileSync('plan-design-review/sections/review-sections.md.tmpl', 'utf8');
  const register = template.split('### Pass 7: Unresolved Design Decisions')[1]!.split('### Post-Pass:')[0]!;
  const grounding = register.indexOf('cite an actual in-scope element');
  expect(grounding).toBeGreaterThan(0);
  expect(grounding).toBeLessThan(register.indexOf('Each decision = one AskUserQuestion'));
  expect(register).toContain('Page/section names and outside-review suggestions do not establish that a control exists');
  expect(register).toContain('if its existence is unknown, keep the item conditional');
  expect(register).toContain('Do not invent controls or reopen accepted treatments for a hypothetical element');
  expect(register).toContain('Surface real missing decisions and concrete conflicts');
});


describe('DX checkpoint optional TODO actor', () => {
  const capture = JSON.parse(readFileSync('test/fixtures/devex-checkpoint-todos.json', 'utf8')) as {
    cases: Array<{ name: string; question: NativeQuestion }>;
  };
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const entry of capture.cases) {
    test(`${entry.name}: retains captured optional work for later in every offered order`, () => {
      for (const order of orders) {
        const question = { ...entry.question, options: order.map(index => entry.question.options[index]!) };
        const selected = pickDevexCheckpointQuestion(question);
        expect(question.options[selected - 1]!.label.replace(/\s*\(recommended\)\s*$/i, '')).toBe('Add to TODOS.md');
      }
    });
  }

  test('normalizes existing option markers and recommendation without approving Build it now', () => {
    const question = menu(['C) Build it now (recommended)', '[A] Add to TODOS.md', '(B) Skip'], 'TODO 1/1', 'D12 — TODO 1 of 1 — Future documentation work?');
    expect(pickDevexCheckpointQuestion(question)).toBe(2);
    expect(pickPlanReviewQuestion(question)).toBe(1);
    const fromLead = { ...question, header: 'Follow-up' };
    expect(pickDevexCheckpointQuestion(fromLead)).toBe(2);
  });

  test.each([
    ['Add to TODOS.md', 'Add to TODOS.md (recommended)', 'Skip'],
    ['Add to TODOS.md', 'Skip'],
    ['Add to TODOS.md', 'Skip', 'Build it now', 'Expand scope'],
    ['Add to TODOS.md and build it now', 'Skip', 'Build it now'],
    ['Add to TODOS.md', 'Skip', 'Build it now and deploy'],
    ['Add to TODOS.md', 'Skip', 'Decide for me'],
    ['Add to TODOS.md (optional)', 'Skip', 'Build it now'],
  ])('refuses an incomplete, ambiguous or extended TODO action set: %j', (...labels) => {
    expect(() => pickDevexCheckpointQuestion(menu(labels, 'TODO 1/1', 'TODO 1 of 1 — Future work?'))).toThrow('DX checkpoint TODO menu');
  });

  test('recognizes the finite actions without a TODO title and regardless of action casing', () => {
    for (const order of orders) {
      const labels = ['aDd To ToDoS.Md', 'sKiP', 'bUiLd It NoW (Recommended)'];
      const question = menu(order.map(index => labels[index]!), 'Later work', 'Keep this for later or include it now?');
      expect(order[pickDevexCheckpointQuestion(question) - 1]).toBe(0);
    }
  });

  test.each([
    ['Add to TODOS.md', 'Skip', 'Build it now', 'Expand scope'],
    ['Add to TODOS.md', 'Skip'],
    ['Build it now', 'Skip'],
    ['Add to TODOS.md and build it now', 'Skip', 'Something else'],
    ['Build it now and deploy', 'Skip', 'Something else'],
    ['Add to TODOS.md', 'Add to TODOS.md (recommended)', 'Skip'],
  ])('refuses malformed or extended recognized actions without relying on the header: %j', (...labels) => {
    expect(() => pickDevexCheckpointQuestion(menu(labels, 'Later work', 'Choose a disposition'))).toThrow('DX checkpoint TODO menu');
  });

  test('refuses multiselect rather than claiming a single disposition', () => {
    expect(() => pickDevexCheckpointQuestion({
      ...menu(['Add to TODOS.md', 'Skip', 'Build it now'], 'TODO 1/1', 'TODO 1 of 1 — Future work?'), multiSelect: true,
    })).toThrow('DX checkpoint TODO menu');
  });

  test('delegates ordinary finding choices, next-review handoffs and malformed recommendations', () => {
    const questions = [
      menu(['Everyone', 'Python app developers (recommended)'], 'Persona', 'Who is the primary developer?'),
      menu(['Move the first-run check (recommended)', 'Keep the existing check'], 'Current remedy', 'Choose the current remedy.\nTODO work is discussed separately.'),
      menu(['Run /plan-eng-review (recommended)', 'Skip, handle manually']),
    ];
    for (const question of questions) expect(pickDevexCheckpointQuestion(question)).toBe(pickPlanReviewQuestion(question));
    const ambiguous = menu(['First (recommended)', 'Second (recommended)'], 'Current remedy', 'Choose a remedy');
    expect(() => pickDevexCheckpointQuestion(ambiguous)).toThrow('multiple recommended');
  });
});
