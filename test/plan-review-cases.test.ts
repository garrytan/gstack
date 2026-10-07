import { describe, expect, test } from 'bun:test';
import { pickDevexCheckpointQuestion, pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGeneration } from '../scripts/gen-skill-docs';
import { generateAntiShortcutClause } from '../scripts/resolvers/spec-review';
import { generateCodexPlanReview } from '../scripts/resolvers/outside-voice-steps';
import { generatePlanFileReviewReport } from '../scripts/resolvers/review-dashboard';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateTestCoverageAuditPlan } from '../scripts/resolvers/testing';
import { ALL_HOST_CONFIGS } from '../hosts';
import { runCapturedCommand } from './helpers/sync-command-capture';
import { expectMentions } from './helpers/prompt-structure';

const compactProse = (value: string) => value.replace(/\s+/g, ' ').trim();
const at = (text: string, anchor: string | RegExp) => typeof anchor === 'string' ? text.indexOf(anchor) : text.search(anchor);
const ordered = (text: string, anchors: Array<string | RegExp>) => {
  const positions = anchors.map(anchor => at(text, anchor));
  expect(positions.every(position => position >= 0), `missing one of ${anchors.map(String).join(' | ')}`).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
};
const expectAll = (text: string, rules: RegExp[]) => { for (const rule of rules) expect(text).toMatch(rule); };

describe('CI workflow clarity regressions', () => {
  test('CEO defines narrow depth and sends settled initial choices directly to mode selection', () => {
    const source = compactProse(readFileSync('plan-ceo-review/SKILL.md.tmpl', 'utf8'));
    const route = source.split("**Choose the question's route first:**")[1]!.split('**1. Check sources')[0]!;
    ordered(route, ['**Admin question:**', '**Plan decision:**']);
    expectAll(route, [/wait and record the answer/i, /this approves no plan changes/i,
      /run steps 2–4 only when a new answer is needed/i, /admin answer requests a plan change, use the Plan decision route/i]);
    ordered(source, ["**Choose the question's route first:**", '**1. Check sources', '**Pre-question checkpoint:**', '**Post-answer checkpoint:**']);
  });

  test('Eng defines evidence paths and gives its setup selector short labels with complete descriptions', () => {
    const source = compactProse(readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8'));
    for (const field of ['Plan: named existing paths', 'Branch diff: changed files', 'File/directory: selected path']) expect(source).toContain(field);
    expectAll(source, [/named future paths `not available`/i, /never invent paths/i, /both retain the same approved feature list/i]);
    for (const token of ['`Original arrangement`', '`Smaller arrangement`', '`Pending remedies not decided here: <ids>`']) expect(source).toContain(token);
    expect(source).not.toContain('`A) Original arrangement: <files/classes>; fixed features: <approved list>`');
  });

  test('Eng initializes a report before its first record without findings or a premature terminal report', () => {
    const source = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
    const requirements = [
      /name the fixed target in the report header/i,
      /read an existing destination and preserve its content/i,
      /findings and fixes first enter through Scope Challenge C's ledger saves, never earlier/i,
      /before an existing `## GSTACK REVIEW REPORT`, or at EOF/i,
      /create that terminal report only at Plan File Review Report/i,
    ];
    const check = (text: string) => {
      const policy = compactProse(text.split('## Review record and write policy')[1]!.split('{{LEARNINGS_SEARCH}}')[0]!);
      const initialization = policy.split('**First report save:**')[1]?.split('**Read-only review:**')[0] ?? '';
      expect(initialization.length).toBeGreaterThan(0);
      const permission = at(policy, /check each artifact and parent directory's permission before writing/i);
      expect(permission).toBeGreaterThanOrEqual(0);
      expect(permission).toBeLessThan(policy.indexOf('**First report save:**'));
      expectAll(initialization, requirements);
      const save = compactProse(text.split('**Pending-record checkpoint.**')[1]!.split('### Send once and wait')[0]!);
      expectAll(save, [/report placement above/i, /use Read to fetch the entire saved record/i]);
    };
    check(source);
    const compact = compactProse(source);
    for (const requirement of requirements) expect(() => check(compact.replace(requirement, ''))).toThrow();
    expect(() => check(source.replace(/\*\*First report save:\*\*[\s\S]*?(?=\*\*Read-only review:\*\*)/, ''))).toThrow();
  });

  test('Eng separates setup selectors from remedy execution and names the exact resume points', () => {
    const source = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
    const setup = compactProse(source.split('## Decision procedure')[1]!.split('### Prepare an unanswered choice')[0]!);
    expectAll(setup, [/without a pre-answer ledger/i, /Scope Challenge B also uses its own selectors/i, /these selections approve no engineering remedy/i]);
    const procedure = compactProse(source.split('## Decision procedure')[1]!.split('## Scope Challenge')[0]!);
    expect(procedure.slice(procedure.indexOf('### Prepare an unanswered choice'))).not.toContain('Context Recovery/prerequisites');
    expect(source).not.toContain('**Setup selectors stop at B.**');
    const entry = compactProse(readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8'));
    expectAll(entry, [/handle a remedy answer under \*\*Record the answer\*\*/i, /may have seen is still pending; do not resend it/i]);
  });

  test('Eng exposes each existing performance concern without a second approval procedure', () => {
    const source = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
    const performance = source.split('### 4. Performance review')[1]!.split('{{CODEX_PLAN_REVIEW}}')[0]!;
    const concerns = performance.match(/^\* .+$/gm)!.join('\n');
    expectAll(concerns, [/N\+1 queries/i, /memory/i, /caching/i, /slow or complex paths/i]);
    expect(performance).not.toContain('AskUserQuestion');
  });

  test('Eng binds unchanged complexity thresholds and MODE to selected work and actual scope changes', () => {
    const source = compactProse(readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8'));
    const scope = source.split('## Scope Challenge')[1]!.split('## Review Sections')[0]!;
    expectMentions(scope, [['not', 'selected', 'evidence']], 'scope');
    expectMentions(scope, [['stop', 'classes/services', 'section']], 'scope');
    const result = scope.slice(scope.indexOf('Record the Scope Challenge result'));
    for (const token of ['`scope reduced per recommendation`', '`scope accepted as-is`']) expect(result).toContain(token);
    expectAll(result, [/smaller arrangement that preserves scope is not a scope reduction/i, /approves no pending remedy/i]);
    expect(source).toContain('FULL_REVIEW for the Scope Challenge result "scope accepted as-is"; SCOPE_REDUCED for "scope reduced per recommendation"');
    expect(source).toContain('**issues_found**: four-section count only');
  });

  test('Eng three-stage transaction rejects missing save, comparison, wait or answer checkpoints', () => {
    const source = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
    const markers: Array<string | RegExp> = ['### Prepare an unanswered choice', '**Pending-record checkpoint.**',
      /use Read to fetch the entire saved record/i, /compare every native field with `currentDecision`/i,
      '### Send once and wait', /copy the verified question, header, labels and descriptions literally/i,
      /stop until the actual answer arrives/i, '### Record the answer',
      /read the selected saved label, full description and grid column/i, /use a scoped Edit to save this record/i,
      /read the entire resolution block/i, /accepted scope match the complete selected option/i, 'For the next choice'];
    const check = (text: string) => ordered(compactProse(text.split('## Decision procedure')[1]!.split('## Scope Challenge')[0]!), markers);
    check(source);
    for (const marker of markers) expect(() => check(compactProse(source).replace(marker, ''))).toThrow();
    expect(source).not.toMatch(/return to step|repeat steps|after step [1-6]/i);
    expectMentions(compactProse(source), [['no', 'continue', 'calling']], 'compactProse(source)');
  });

  test('Eng finalization refreshes the existing Test Plan without repeating its producer', () => {
    const source = readFileSync('plan-eng-review/sections/review-sections.md.tmpl', 'utf8');
    const closing = source.split('## Required outputs')[1]!;
    expect(source.match(/\{\{TEST_COVERAGE_AUDIT_PLAN\}\}/g)).toHaveLength(1);
    expect(source.indexOf('{{TEST_COVERAGE_AUDIT_PLAN}}')).toBeLessThan(source.indexOf('### 4. Performance review'));
    expect(closing.match(/1\. \*\*Prepare the review body\.\*\*/g)).toHaveLength(1);
    const prepare = compactProse(closing.slice(closing.indexOf('1. **Prepare the review body.**'), closing.indexOf('2. **Save and Read back.**')));
    expectMentions(closing, [['do not', 'unchanged', 'recreate']], 'closing');
  });

  test('plan coverage definitions precede the uninterrupted trace sequence', () => {
    const source = generateTestCoverageAuditPlan({ skillName: 'plan-eng-review', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext);
    ordered(source, ['Definition: a **targeted audit**', '**Step 1. Trace every codepath in the plan:**']);
    const trace = source.indexOf('**Step 1. Trace every codepath in the plan:**');
    const first = source.slice(source.indexOf('1. **Read the plan.**', trace), source.indexOf('2. **Trace data flow.**', trace));
    expectMentions(first, [['before', 'dedicated', 'drawing']], 'first');
    expect(first).not.toContain('Definition:');
    expect(first).not.toContain('before Step 2');
    expectAll(compactProse(source), [/five Test steps inside Section 3, after Scope Challenge/i,
      /read concrete source\/tests before tracing or diagramming/i, /future paths remain proposals/i]);
  });

  test('CEO fallback names the current host mode and needs completed findings before the later report exists', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const source = generateCodexPlanReview({ skillName: 'plan-ceo-review', host: host.name, paths: HOST_PATHS[host.name] } as TemplateContext);
      expect([...new Set(source.match(/under_codex|under_current_harness/g))]).toEqual(['under_current_harness']);
      expect(source).toMatch(/SOURCE=in-host, OUTSIDE_STATUS=unavailable, and STATUS=clean or issues_found/);
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
      const logPolicy = compactProse(template.slice(log, dashboard));
      if (skill === 'plan-eng-review') {
        expectAll(compactProse(template), [/at Review Log, use \*\*Blocked outcome\*\* instead of publishing a saved review/i,
          /only a successful required log permits publication as a saved review/i]);
      } else if (skill === 'plan-ceo-review') {
        expectAll(logPolicy, [/successful write and Read-back/i, /failed plan\/report save or verification stops before this block/i,
          /both history commands below are best-effort/i, /do not claim that entry was recorded/i]);
      } else {
        expectAll(logPolicy, [/successful write and Read-back/i, /report the error and stop/i]);
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
          expectAll(target, [/use the report file already selected under \*\*Review record and write policy\*\*/i, /do not choose another destination here/i]);
          expect(target).not.toContain('host active plan');
          const writer = report.slice(report.indexOf('### Write to the report file'));
          expect(writer).not.toContain('PLAN MODE EXCEPTION — ALWAYS RUN');
          expectAll(writer, [/destination is absent or writing is forbidden/i, /not persisted/i, /do not run the file-writing steps below/i,
            /re-read the report file and retry once/i, /do not replace the section in place/i, /append the new report at EOF/i]);
        } else {
          ordered(target, [/explicitly requested output\/report file/i, /reviewed plan named by the user/i, /host active plan/i]);
        }
        if (skillName === 'plan-ceo-review') {
          expectMentions(target, [['without', 'permitted', 'complete']], 'target');
          expect(target).not.toContain('skip this section');
        } else if (skillName !== 'plan-eng-review') {
          expectMentions(target, [['no', 'section', 'scope']], 'target');
        }
        expect(report).toMatch(/prior review entries/i);
        expect(report).toContain('current Completion Summary');
        if (['plan-ceo-review', 'plan-eng-review'].includes(skillName)) {
          expect(report).not.toContain('DX Scorecard');
          expect(report).toContain('`clean` as CLEAR and `issues_open` as ISSUES OPEN');
          expect(report).toMatch(/not-persisted labels/i);
        } else expect(report).toContain('current Completion Summary or DX Scorecard');
        expectAll(report, [/add exactly one to its prior run count/i, /do not pre-log this run/i]);
        if (skillName === 'plan-ceo-review') {
          const writer = compactProse(report.slice(report.indexOf('### Write to the plan file')));
          expectMentions(writer, [['no', 'completed-review', 'blocked']], 'writer');
          ordered(writer, [/if no destination is selected or writing is forbidden/i, 'new `## GSTACK REVIEW REPORT` at EOF',
            /if the destination file exists, Read it now/i, /if the destination file does not exist, use Write/i, /keep the report last/i, '4. **Read-back gate:**']);
        } else expectMentions(report, [['not', 'whether', 'existed']], 'report');
        expect(report).toMatch(skillName === 'plan-eng-review'
          ? /follow \*\*Blocked outcome\*\* before Review Log or decision logging/i
          : /stop before Review Log or decision logging/i);
        expect(report.indexOf('Read-back gate')).toBeGreaterThan(report.indexOf(skillName === 'plan-eng-review' ? '### Write to the report file' : '### Write to the plan file'));
        expect(report).not.toContain('review log output you already have');
      }
      for (const skillName of ['codex', 'devex-review']) {
        const report = generatePlanFileReviewReport({ skillName, host: host.name, paths: HOST_PATHS[host.name]! } as TemplateContext);
      }
    });
  }
  test('every generated plan-review carrier keeps write/readback before log before dashboard', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'review-persistence-order-'));
    try {
      const generated = await runGeneration({ host: 'all', outputRoot, contentLinkRoot: null, log: () => {} });
      expect(generated.exitCode, JSON.stringify(generated.diagnostics)).toBe(0);
      // A carved skill carries the report in sections/review-sections.md (every
      // host since C4 for plan-ceo-review); an inlined one in its SKILL.md.
      const isSection = (artifact: typeof generated.artifacts[number]) => artifact.kind === 'section'
        && plans.some(skill => artifact.relativePath === `${skill}/sections/review-sections.md`
          || artifact.relativePath.endsWith(`/gstack-${skill}/sections/review-sections.md`));
      const carved = new Set(generated.artifacts.filter(isSection).map(a => `${a.host}:${a.relativePath.replace(/\/sections\/review-sections\.md$/, '')}`));
      const carriers = generated.artifacts.filter(artifact => isSection(artifact)
        || (artifact.kind === 'skill' && plans.some(skill => artifact.relativePath.endsWith(`/gstack-${skill}/SKILL.md`))
          && !carved.has(`${artifact.host}:${artifact.relativePath.replace(/\/SKILL\.md$/, '')}`)));
      expect(carriers).toHaveLength(plans.length * ALL_HOST_CONFIGS.length);
      for (const carrier of carriers) {
        const content = readFileSync(join(outputRoot, carrier.relativePath), 'utf8');
        if (carrier.relativePath.includes('plan-eng-review/')) {
          const dispatch = compactProse(content.slice(content.indexOf('**Pending-record checkpoint.**'), content.indexOf('## Scope Challenge')));
          ordered(dispatch, ['AskUserQuestion({ questions: [currentDecision] })', /stop until the actual answer arrives/i, '### Record the answer', 'For the next choice']);
        }
        const report = content.indexOf('\n## Plan File Review Report\n');
        const readback = content.indexOf('**Read-back gate:**', report);
        const log = content.indexOf('\n## Review Log\n');
        const dashboard = content.indexOf('\n## Review Readiness Dashboard\n');
        expect({ carrier: carrier.relativePath, ordered: 0 < report && report < readback && readback < log && log < dashboard }).toMatchObject({ ordered: true });
        expect(content.slice(report, readback)).toContain('current Completion Summary');
        expect(content.slice(readback, log)).toMatch(carrier.relativePath.includes('plan-eng-review/')
          ? /follow \*\*Blocked outcome\*\* before Review Log or decision logging/i
          : /stop before Review Log or decision logging/i);
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
    ordered(skeleton, ['# Plan Review Mode', /do not build features, acceptance suites or benchmarks unless explicitly authorized/i, '## Scope gate']);
    const rule = sections.indexOf('## Decision procedure');
    expect(rule).toBeGreaterThan(0);
    expect(sections.match(/^## Decision procedure$/gm)).toHaveLength(1);
    const procedureBody = compactProse(sections.slice(rule, sections.indexOf('## Scope Challenge')));
    const dispatch = procedureBody.slice(procedureBody.indexOf('**Pending-record checkpoint.**'));
    ordered(dispatch, ['### Send once and wait', 'AskUserQuestion({ questions: [currentDecision] })',
      /stop until the actual answer arrives/i, '### Record the answer', 'For the next choice']);
    expectAll(dispatch, [/one question object for one choice; other IDs wait/i,
      /do not apply a remedy, make another call, start the next section or call ExitPlanMode/i,
      /\/autoplan uses its authorized decisions/i]);
    expect(procedureBody).not.toContain('Setup gates');
    expect(skeleton).not.toContain('**Decisions (including Step 0):**');
    expect(skeleton).not.toContain('For every issue or recommendation');
    const scope = compactProse(sections.slice(sections.indexOf('## Scope Challenge'), sections.indexOf('## Review Sections')));
    expectAll(scope, [/decision-brief format for this complexity gate/i,
      /ask each proposed feature cut\/deferral separately; wait before changing scope/i,
      /unapproved fixes stay pending/i, /always ask the structure question when this gate trips/i,
      /offer confirmation of the original arrangement or a pause to investigate a smaller one\. wait for the answer/i,
      /apply only accepted scope changes/i, /"No issues found" for an empty list/i, /findings and scope answers approve no remedies/i]);
    const complexityRule = at(scope, /initial scope selectors need no grid or \*\*pre-answer\*\* ledger write/i);
    expect(complexityRule).toBeGreaterThan(0);
    expect(complexityRule).toBeLessThan(scope.indexOf('1. Explain the complexity'));
    expectAll(scope.slice(complexityRule), [/ask and wait before changes/i, /one scope record/i,
      /read it back against the actual answers/i, /do not invent a pre-answer record afterward/i]);
    expect(scope).not.toContain('proceed as-is');
    const stop = skeleton.indexOf('**Complexity gate:**');
    const sectionMarker = suffix ? /\{\{SECTION:review-sections\}\}/g : /> \*\*STOP\.\*\* Before starting the Scope Challenge/gi;
    const sectionRead = at(skeleton, new RegExp(sectionMarker.source, sectionMarker.flags.replace('g', '')));
    expect(stop).toBeGreaterThan(0);
    expect(sectionRead).toBeGreaterThan(stop);
    expect(skeleton.slice(skeleton.indexOf('### Step 0: Scope Challenge'), sectionRead)).not.toContain('**STOP');
    expectMentions(compactProse(skeleton.slice(stop, sectionRead)), [['do not', 'exitplanmode', 'findings']], 'section');
    expectMentions(skeleton, [['before', 'challenge', 'mandatory']], 'skeleton');
    expect(skeleton.match(sectionMarker)).toHaveLength(1);
    expectAll(compactProse(sections), [/follow the blocks below in order after startup/i, /reference rules, not additional review passes/i]);
    expect(sections).not.toContain('After startup, prepare in this order:');
    ordered(sections, ['## Review record and write policy',
      suffix ? '{{LEARNINGS_SEARCH}}' : '## Prior Learnings', '## Retrospective learning',
      suffix ? '{{CONFIDENCE_CALIBRATION}}' : '## Confidence Calibration',
      '## Decision procedure', '## Scope Challenge', '### 1. Architecture review']);
    expect(sections).not.toContain('{{ANTI_SHORTCUT_CLAUSE}}');
    expect(sections).not.toContain('**Anti-shortcut clause:**');
    expect(skeleton).not.toContain('STOP while a Step 0 question');
    expect(sections.match(/^## Scope Challenge$/gm)).toHaveLength(1);
    expect(sections).not.toContain('## Step 0 findings');
    ordered(scope, [/fewer than 8 files AND fewer than 2 new classes\/services, skip B's questions/i, '### C. Resolve findings',
      '1. Present numbered Scope Challenge findings', '2. Resolve each remedy through Decision procedure',
      '3. Report accepted/rejected/deferred/pending', /continue to Section 1 only when no answer is pending/i]);
    const selfCheck = compactProse(skeleton.slice(skeleton.indexOf('## Section self-check'), skeleton.indexOf(suffix ? '{{EXIT_PLAN_MODE_GATE}}' : '## EXIT PLAN MODE GATE')));
    expectAll(selfCheck, [/completed Scope Challenge, Sections 1–4, Outside Voice and outputs/i, /preserve verified work/i]);
    expect(selfCheck).toContain('`~/.claude/skills/gstack/plan-eng-review/sections/review-sections.md`');
    expect(selfCheck).not.toContain('Redo memory-only work');
    const stages = at(skeleton, /after target selection, use/i);
    const prerequisite = skeleton.indexOf(suffix ? '{{BENEFITS_FROM}}' : '## Prerequisite Skill Offer');
    ordered(skeleton, [/after target selection, use/i, suffix ? '{{BENEFITS_FROM}}' : '## Prerequisite Skill Offer', '## Engineering review', '### Step 0: Scope Challenge']);
    expectAll(skeleton.slice(stages, prerequisite), [/full decision brief, transport and continuous D-numbering/i, /setup questions approve no engineering remedies/i]);
    expect(skeleton).not.toContain('**Later question stages:**');
    if (!suffix) expect(skeleton.slice(prerequisite)).toMatch(/build the next full decision brief from these facts and options/i);
    const boundary = compactProse(sections.slice(rule, sections.indexOf('### 1. Architecture review')));
    expectAll(boundary, [/read the request, source and actual answers/i, /finish one choice before the next/i,
      /they are separate choices even in the same finding, function or patch/i, /give each bound a measure and unit/i,
      /every column repeats each other approved value unchanged/i, /keep one behavior with its necessary code, tests and documentation/i,
      /coverage choices vary implementation or proof depth/i, /never cut an established contract or its required proof/i,
      /if an exact prior approval covers the work, cite its answer and disposition/i,
      /later-discovered required proof forward without asking again/i,
      /separate it and rebuild this comparison before saving or sending the question/i, /their tests wait for approval/i,
      /for a factual correction that changes no behavior, record the correction and evidence/i]);
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
  const prepare = gate.indexOf('### Prepare an unanswered choice');
  const identify = at(gate, /before drafting options/i);
  const compare = gate.indexOf('**Compare one choice.**');
  const save = gate.indexOf('**Pending-record checkpoint.**');
  const send = gate.indexOf('### Send once and wait');
  const record = gate.indexOf('### Record the answer');

  test('the ledger template keeps one record with its fields, selectors and single State block', () => {
    const lines = ledger.split('\n');
    expect(lines).toContain('### R1: <one independently selectable choice>');
    expect(lines.filter(line => /^[A-Z][A-Za-z ]*(?: D2)?:/.test(line)).map(line => line.split(':')[0])).toEqual([
      'Finding', 'Plan baseline', 'Runtime evidence', 'Comparison grid', 'Question D2', 'Header', 'Options',
      'State', 'Actual answer', 'Accepted scope', 'History',
    ]);
    expect(ledger).toContain('State: <pending, or approved>');
    expect(lines.filter(line => line.startsWith('State:'))).toHaveLength(1);
    expect(ledger).toContain('Question D2:\n<currentDecision.question in full');
    expect(ledger).toContain('Header: <currentDecision.header>');
    for (const selector of ['A', 'B']) expect(ledger).toContain(`with one ${selector}) record selector>`);
    expect(rawGate.indexOf(ledger)).toBeGreaterThan(rawGate.indexOf('**Pending-record checkpoint.**'));
    expect(rawGate.indexOf(ledger)).toBeLessThan(rawGate.indexOf('### Send once and wait'));
  });

  test('preserves the full selected scope and reopens contradictory options before applying them', () => {
    const options = gate.slice(compare, save);
    expectAll(options, [/full label and description with every row in its grid column/i,
      /same commitments and retain the same conditions/i, /approves no implementation, including a conditional fix/i]);
    const apply = gate.slice(record, gate.indexOf('## Scope Challenge'));
    ordered(apply, [/read the selected saved label, full description and grid column together/i,
      /preserve the actual answer, explain the conflict and return to \*\*Prepare an unanswered choice\*\*/i, /replace the whole adjacent/i]);
    expectMentions(apply, [['do not', 'reinterpret', 'conflicting']], 'apply');
    // a689 D3's conditional fix was selected, then silently replaced with a
    // probe-only scope. Native behavior remains a paid gate; this guards the
    // producer's prepare/apply/recovery instructions, not that run's outcome.
  });

  test('reconciles operative decision State before approval readiness and unresolved counts', () => {
    const apply = gate.slice(record, gate.indexOf('## Scope Challenge'));
    expect(apply).toMatch(/set State to `approved` for accepted scope/i);
    expect(apply).toContain('`pending` for an unresolved remedy');
    expectAll(apply, [/move superseded states to History/i, /each field must occur once outside History/i,
      /never update only the answer\/scope tail/i, /cannot replace Read/i, /preserve the options/i]);
    // c6fc retained both pending and approved fields after an acknowledged answer.
    ordered(apply, [/replace the whole adjacent `State` \/ `Actual answer` \/ `Accepted scope` block/i,
      /use a scoped Edit to save this record/i, /its unique state, actual answer and accepted scope match/i, /correct any discrepancy before advancing/i]);
    expect(apply.indexOf('For the next choice')).toBeGreaterThan(at(apply, /its unique state, actual answer and accepted scope match/i));
    const outputs = compactProse(template.split('## Required outputs')[1]!.split('### "NOT in scope"')[0]!);
    expectAll(outputs, [/leave choices pending according to each record's current State/i,
      /use the entrypoint's \*\*Recovery routing\*\*/i, /changed outputs must pass steps 1–4 again/i]);
  });

  test('current contracts and completed comparisons precede saved questions without approving a fix', () => {
    expect(0 <= prepare && prepare < identify && identify < compare && compare < save && save < send && send < record).toBe(true);
    const headings = [...rawGate.split('## Scope Challenge')[0]!.replace(/```markdown[\s\S]*?```/g, '').matchAll(/^### ([^\n]+)$/gm)].map(match => match[1]);
    expect(headings).toEqual(['Prepare an unanswered choice', 'Send once and wait', 'Record the answer']);
    // A reopened row must use its latest accepted plan, not the seed/runtime
    // value, and rebuild all option states before the existing save/ask gate.
    expectAll(gate.slice(prepare, identify), [/observed behavior does not grant approval/i, /mark unverified behavior unknown/i,
      /retain earlier values, complete briefs and answers in History/i]);
    expectAll(gate.slice(identify, compare), [/optional depths of one verification form one choice/i,
      /alternative mechanisms for that fixed behavior belong in one question/i, /a reopened choice keeps its ID/i,
      /receives the next continuous `D<N>`/i]);
    expectMentions(gate.slice(prepare, save), [['not', 'existing/proposed', 'scores']], 'gate.slice(prepare, save)');
    const options = gate.slice(compare, save);
    expectAll(options, [/concrete current value, each option's value and work, and any approval citation/i,
      /include shared, fixed and pending choices/i, /an Investigate\/Defer option must bound the investigation/i,
      /treat necessary implementation and proof of an approved contract as common work/i,
      /still needs approval if it is new/i, /give every selectable behavior, approach, guarantee or bound a row/i]);
    expectMentions(gate.slice(save, send), [['cannot', 'verification', 'substitute']], 'gate.slice(save, send)');
    expectMentions(gate, [['only', 'contradictory', 'assumption']], 'gate');
  });

  test('assigns independent row IDs before constructing the final question', () => {
    ordered(gate.slice(identify, compare), [/list each current value and proposed change/i,
      /give independently selectable changes separate IDs/i, /if the user can accept one/i]);
  });

  test('finishes native fields before save and dispatches the literal final read-back', () => {
    const options = gate.slice(compare, save);
    ordered(options, [/select one pending ID/i, /build a separate \*\*comparison grid\*\*/i, '**Reconcile before saving.**']);
    expect(options).toContain('build `currentDecision`');
    expect(options).toContain('`options`: every exact label and full description');
    expect(options).toMatch(/`question`: the complete D-numbered preamble brief, including Project, ELI10, Stakes, Recommendation/);
    expectAll(options, [/file:line in the native fields/i, /human\/CC effort, risk and maintenance/i,
      /make the header and every label final before saving/i, /under 5 words each/i,
      /saved-only Pros\/cons block cannot supply missing decision context/i]);
    const checkpoint = gate.slice(save, send);
    expect(checkpoint).toMatch(/save the record, complete grid and exact `currentDecision`/i);
    expectAll(checkpoint, [/a failed save blocks the question/i, /include every native field, the recommendation and all options/i,
      /A–D record selectors are ledger notation only/i, /read after the final edit/i, /do not verify the record/i,
      /repeat the complete Read before asking/i, /do not leave duplicate Question, Header or Options fields/i,
      /unreadable or unverifiable records use \*\*Recovery routing\*\*/i, /if any payload field changes[^.]*Read it again/i]);
    const readOnly = compactProse(template.split('**Read-only review:**')[1]!.split('{{LEARNINGS_SEARCH}}')[0]!);
    expectAll(readOnly, [/authorized amendments as \*\*not persisted\*\*/i, /perform the same comparisons on that presentation/i]);
    const recovery = compactProse(readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8'));
    expectAll(recovery, [/repeat its full Read-back verification/i, /if no recovery is specified or it fails, follow \*\*Blocked outcome\*\*/i]);
    const dispatch = gate.slice(send, record);
    expect(dispatch).toContain('`AskUserQuestion({ questions: [currentDecision] })`');
    expectAll(dispatch, [/only after the pending-record checkpoint passes/i, /do not add or strip brief paragraphs or rebuild options/i,
      /authorized prose and auto-decisions use this same verified brief/i]);
  });

  test('all four section gates and outside voice distinguish pending choices from findings', () => {
    const reviewSections = template.split('## Review Sections (after scope is agreed)')[1]!;
    const sectionRule = compactProse(reviewSections.split('### 1. Architecture review')[0]!);
    expect(sectionRule).toContain('Architecture → Code Quality → Tests → Performance');
    const sections = [...reviewSections.matchAll(/^### ([1-4])\.([^]*?)(?=^### [1-4]\.|^\{\{CODEX_PLAN_REVIEW\}\})/gm)];
    expect(sections.map(section => Number(section[1]))).toEqual([1, 2, 3, 4]);
    const tests = sections[2]![2]!.replace('{{TEST_COVERAGE_AUDIT_PLAN}}', () => generateTestCoverageAuditPlan({} as TemplateContext));
    const stop = at(tests, /stop for each pending decision/i);
    const artifact = tests.indexOf('\n#### Test Plan Artifact\n');
    const report = at(tests, /after \*\*Add missing tests to the plan\*\* resolves/i);
    expect(0 <= stop && stop < artifact && artifact < report).toBe(true);
    expect(tests.slice(report)).toMatch(/continue to Performance review/i);
    expect(tests.slice(stop, artifact)).not.toContain('and continue');
    expectMentions(gate.slice(send), [['before', 'readiness', 'resolve']], 'gate.slice(send)');
    expectAll(gate, [/record remaining unknowns and uncertain risks/i, /keep unresolved risks and verification visible/i,
      /drafts, recommendations and reviewer agreement grant neither/i]);
    expect(template).toContain('{{CODEX_PLAN_REVIEW}}');
    expect(template).toContain('{{PLAN_FILE_REVIEW_REPORT}}');
    expectMentions(compactProse(template), [['never', 'abbreviate', 'condense']], 'compactProse(template)');
    for (const stale of ['For each issue found in this section',
      'Otherwise, use AskUserQuestion for each finding',
      'Outside voice findings are INFORMATIONAL until the user explicitly approves each one']) {
      expect(template).not.toContain(stale);
    }
  });

  test('every option is recorded against one decision before sending or scoring coverage', () => {
    expect(gate).not.toContain('`label: changes; preserves; pending`');
    const format = gate.split('**Compare one choice.**')[1]!.split('**Pending-record checkpoint.**')[0]!;
    expect(format).not.toContain('per-issue AskUserQuestion');
    expect(template).not.toContain('## CRITICAL RULE — How to ask questions');
    expect(template).not.toContain('issue NUMBER + option LETTER');
    expect(template).not.toContain('Label with NUMBER + LETTER');
  });

  test('scope bootstrap resolves a target without depending on later session routing or decision briefs', () => {
    const skeleton = readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8');
    const bootstrap = compactProse(skeleton.split('## Scope gate')[1]!.split('{{PREAMBLE}}')[0]!);
    expectAll(bootstrap, [/before discovery tools or preamble/i, /do not probe for session state/i, /no decision brief, D-number/i,
      /enabled MCP AskUserQuestion, otherwise listed native/i, /first tool call = AskUserQuestion \(tool_use\)\. send this exact menu and wait/i,
      /may have seen it, wait; do not resend it/i, /send the menu as plain prose and stop/i, /options start at column 0/i,
      /never guess a target/i, /keep the reviewed target fixed/i]);
    for (const token of ['`--disallowedTools`', 'Startup sequence', 'Context Recovery']) expect(bootstrap).toContain(token);
    ordered(bootstrap, ['**User-named target (outside plan mode):**', '**Initial selector algorithm']);
    // A missing or disallowed tool led models to infer a headless session and
    // end the turn with a separate pending report instead of the menu
    // (988e985 slice 5 and three earlier captures). The menu is the one
    // no-transport outcome, whatever the session type.
    expectMentions(bootstrap, [['never', 'whatever', 'approves']], 'bootstrap');
    expect(bootstrap).not.toContain('Headless or spawned session');
    expect(bootstrap).not.toContain('Scope pending');
  });

  test('the review record covers code inputs and per-artifact write limits before any decision is saved', () => {
    const policyStart = template.indexOf('## Review record and write policy');
    const policyEnd = template.indexOf('{{LEARNINGS_SEARCH}}', policyStart);
    expect(policyStart).toBeGreaterThan(0);
    expect(policyEnd).toBeGreaterThan(policyStart);
    const policy = template.slice(policyStart, policyEnd);
    const prose = compactProse(policy);
    expect(policyStart).toBeLessThan(template.indexOf('## Decision procedure'));
    for (const target of ['| Plan or design document |', '| Branch diff |', '| Specific file or directory |']) expect(policy).toContain(target);
    expect(prose).toContain('**Report file:**');
    expectAll(prose, [/not permission to edit implementation or create another file/i,
      /use the current working plan and this target evidence/i,
      /one destination for the working plan, findings, decision ledger and final structured report/i,
      /choose the \*\*report file\*\* before any ledger write/i, /suffix on collision/i,
      /never substitute an unrelated active plan or silently replace a requested destination/i, /active-plan-only/i,
      /permission for one path authorizes no other/i, /implementation edits require explicit authority/i,
      /ask for a permitted destination/i, /an unrecovered failed write blocks the review/i]);
    for (const command of ['$GSTACK_STATE_ROOT/projects/$SLUG/$BRANCH-eng-review-{YYYYMMDD-HHMMSS}.md', 'gstack-paths', 'gstack-slug']) expect(prose).toContain(command);
    // Discovery paths follow the writers' state root (testing.ts, tasks-section.ts), never a hardcoded home.
    expect(prose).toMatch(/discovery paths `\$GSTACK_STATE_ROOT\/projects\/\{slug\}\/`/);
    expect(prose).not.toContain('~/.gstack/projects/{slug}/');
    expect(prose).toContain('**Failed permitted save** (error or failed Read-back): use **Recovery routing → Repairable write/read failure**');
    const routes = Object.fromEntries(policy.split('\n').filter(line => line.startsWith('| '))
      .map(line => line.split('|').slice(1, -1).map(cell => cell.trim())).map(cells => [cells[0], cells[2]]));
    expect(routes["Working plan, ledger and complete review report"]).toContain('wait without completion telemetry');
    expect(routes["Working plan, ledger and complete review report"]).toContain('then use **Blocked outcome**');
    for (const auxiliary of ['QA Test Plan and task JSONL', 'TODOS.md']) {
      expect(routes[auxiliary]).toContain('**not persisted**');
      expect(routes[auxiliary]).toContain('continue');
    }
    expect(routes['Required Review Log']).toContain('The final gate cannot pass without this log');
    expect(routes['Required Review Log']).toContain('Present its fields as **not persisted**');
    expect(routes['Required Review Log']).toContain('at Review Log, use **Blocked outcome** instead of publishing a saved review');
    const log = template.split('## Review Log')[1]!.split('{{REVIEW_DASHBOARD}}')[0]!;
    expect(log).toMatch(/finish step 3, after successful Read-back/i);
    expect(log).not.toContain('PLAN MODE EXCEPTION — ALWAYS RUN');
  });

  test('approval readiness follows TODO decisions and finalization returns forward exactly once', () => {
    const closing = template.split('## Required outputs')[1]!.split('### "NOT in scope" section')[0]!;
    const finish = [...closing.matchAll(/^([1-6])\. \*\*([^*]+)\*\*/gm)].map(match => [match[1], match[2]]);
    expect(finish).toEqual([['1', 'Prepare the review body.'], ['2', 'Save and Read back.'], ['3', 'Log the saved review.'],
      ['4', 'Publish.'], ['5', 'Choose navigation.'], ['6', 'Finish.']]);
    expectAll(compactProse(closing), [/display the Review Readiness Dashboard, then present the saved Completion summary/i,
      /read-only EXIT PLAN MODE GATE in every host mode/i, /ExitPlanMode only in host plan mode/i,
      /\*\*Recovery routing → Late change or missing work\*\* before navigation resumes/i,
      /only after both pass, run success telemetry/i, /requires \*\*Blocked outcome\*\*, not logging/i]);
    const publication = compactProse(closing.slice(closing.indexOf('3. **Log the saved review.**'), closing.indexOf('5. **Choose navigation.**')));
    expectAll(publication, [/if the required log is forbidden, show fields as not persisted and take \*\*Blocked outcome\*\*/i,
      /neither supplies completion or saved-dashboard credit/i]);
    ordered(template, ['### TODOS.md updates', '{{PLAN_REVIEW_APPROVAL_CHECK}}', '## Required outputs',
      '{{PLAN_FILE_REVIEW_REPORT}}', '## Review Log', '{{REVIEW_DASHBOARD}}', '## Next Steps — Review Chaining',
      '## Learning hooks', '{{BRAIN_WRITE_BACK}}']);
    expect(template.split('{{PLAN_REVIEW_APPROVAL_CHECK}}')).toHaveLength(2);
    expect(template).not.toContain('{{BRAIN_CACHE_REFRESH}}');
    expect(template).not.toContain('Run the preamble\'s **Telemetry');
    expect(closing.match(/return to the entrypoint/g)).toHaveLength(1);
    const navigation = compactProse(template.slice(template.indexOf('{{REVIEW_DASHBOARD}}')).split('## Learning hooks')[0]!);
    expectAll(navigation, [/a next-step answer approves no implementation change/i, /without adding or strengthening them/i,
      /does not make every independent lane wait/i]);
    const skeleton = readFileSync('plan-eng-review/SKILL.md.tmpl', 'utf8');
    ordered(skeleton, ['{{SECTION:review-sections}}', '## Recovery routing', '**Paused question:**', '**Blocked outcome:**', '## Section self-check', '{{EXIT_PLAN_MODE_GATE}}',
      /after the gate passes: \*\*Telemetry/i, '{{BRAIN_CACHE_REFRESH}}', /call ExitPlanMode for the selected next step only when the host is in plan mode/i]);
    expect(skeleton).not.toContain('run approval check 0 below');
    const pause = compactProse(skeleton.split('**Paused question:**')[1]!.split('**Blocked outcome:**')[0]!);
    expectMentions(pause, [['without', 'exitplanmode', 'completion']], 'pause');
    const blocked = compactProse(skeleton.split('**Blocked outcome:**')[1]!.split('{{EXIT_PLAN_MODE_GATE}}')[0]!);
    expect(blocked).toContain('`OUTCOME=error` and the actual `ERROR_MESSAGE`/`FAILED_STEP`');
    expectAll(blocked, [/report `BLOCKED`, the missing path\/work/i, /supplies no saved-review or completion credit/i,
      /stop the review/i, /do not call ExitPlanMode/i, /resume at the failed step using Recovery routing/i]);
    const lateChange = compactProse(skeleton.split('**Late change or missing work:**')[1]!.split('**Blocked outcome:**')[0]!);
    expectAll(lateChange, [/new or reopened choices use Decision procedure/i, /repeat Approval readiness, then Required outputs steps 1–4/i,
      /unchanged saved outputs may reuse their successful Review Log/i]);
    expect(skeleton.slice(skeleton.indexOf('After the gate passes:'))).toContain('once with `OUTCOME=success`, then cache refresh');
    expectMentions(skeleton, [['no', 'working-plan', 'verification']], 'skeleton');
  });

  // This parses the actual worked example, not model output or a test-only
  // decision oracle. It proves the instructions expose the observed two-axis
  // option pattern; only native evaluation can prove the model follows them.
  test('worked comparison exposes two independently selectable option values', () => {
    const example = rawGate.split('**Compare one choice.**')[1]?.split('**Pending-record checkpoint.**')[0] ?? '';
    expectMentions(example, [['only', 'omitting', 'bundles']], 'example');
    const split = example.split('Ask about jitter first:')[1] ?? '';
    const separated = [...split.matchAll(/^\| (R[12] [^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
      .map(([, commitment, current, A, B]) => ({ commitment, current, A, B }));
    expect(separated).toEqual([
      { commitment: 'R1 jitter', current: 'unspecified, pending', A: 'on', B: 'off' },
      { commitment: 'R2 delay cap', current: 'unspecified, pending', A: 'unspecified, pending', B: 'unspecified, pending' },
    ]);
    expectAll(gate.slice(record), [/keep chosen values fixed in later questions/i, /rather than asking it again/i]);
  });

  test('every host resolves the Eng gate without the conflicting generic shortcut clause', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const clause = generateAntiShortcutClause({ skillName: 'plan-eng-review', host: host.name } as TemplateContext);
      expectAll(clause, [/decision gate for all four sections and outside voice/i, /retain findings and evidence/i,
        /ask only for new or reopened choices/i, /never prewrite unapproved remedies or skip sections or the terminal report/i]);
      expect(clause).not.toContain('ANY non-trivial finding');
    }
  });
});

// These checks cover generated instructions, not native model compliance.
describe('outside-voice commitment queue', () => {
  test('Eng selects the other provider and preserves explicit native fallback on every host', () => {
    for (const host of ALL_HOST_CONFIGS) {
      const eng = generateCodexPlanReview({ host: host.name, paths: HOST_PATHS[host.name]!, skillName: 'plan-eng-review' } as TemplateContext);
      const provider = host.name === 'codex' ? 'Claude Code' : 'Codex';
      const mismatch = 'under_current_harness';
      // B1: the heading also admits `unverified`.
      expect(eng).toContain('**If `CODEX_MODE: ready`');
      expect(eng).toContain(`— run ${provider}:**`);
      const fallback = compactProse(eng.slice(eng.indexOf('**Native fallback —'), eng.indexOf('**Bounded outside-voice wait')));
      const routing = eng.slice(eng.indexOf('**Outcome routing:**'), eng.indexOf('**Disabled is a terminal branch'));
      const preflight = eng.match(/```bash\n([\s\S]*?)\n```/)![1];
      expect(preflight).toContain(mismatch);
      expectAll(routing, [/other preflight mode, including harness mismatch/i, /outside execution or output validation fails/i, /then use Native fallback/i]);
      const bounded = eng.slice(eng.indexOf('**Bounded outside-voice wait'), eng.indexOf('**Cross-model tension:**'));
      expectMentions(bounded, [['never', 'supplies', 'coverage']], 'bounded');
      expect(eng).toMatch(/SOURCE=in-host, OUTSIDE_STATUS=unavailable, and STATUS=clean or issues_found/);
      expect(eng).toMatch(/findings are the reviewer's/i);
      expect(fallback).toMatch(/disabled means no replacement/i);
      if (host.name === 'codex') {
        expect(eng).toContain('gstack-claude-code');
        expect(eng).not.toContain('codex exec');
      } else {
        expect(eng).toContain('codex exec');
        expect(eng).toContain('_gstack_codex_role_ready exec');
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
        // Each review reuses its own gate; none falls back to a generic commitment table.
        expect(queue).not.toContain('reference | commitment | current value');
        expect(queue).toContain('**Whole-candidate scope:** A) Include; B) Defer; C) Cut; D) Hold');
        expectAll(compactProse(queue), [/revising two candidates takes two rows/i, /hold stops for discussion without changing the prior disposition/i,
          /assembled set's capacity and dependencies/i, /returns? to the affected candidate's Include\/Defer\/Cut\/Hold row/i,
          /report unresolved conflicts/i, /never silently trim or replace another candidate/i]);
        if (skillName !== 'plan-devex-review') {
          expect(queue).toContain("A) Apply this change; B) Keep this row's current value; C) Investigate before choosing; D) Defer this proposed change only");
          expectAll(queue, [/D leaves this proposal row unresolved/i, /ask separately before changing them/i]);
        }
        if (skillName === 'plan-ceo-review') {
          expectAll(queue, [/same six-column ledger/i, /use 0D for new or reopened choices/i, /do not start a second procedure/i,
            /original input, inspected source and exact approvals/i, /correct false premises without changing accepted behavior/i,
            /keep uncertainty with its owner/i, /credible material risk can require action before confirmation/i,
            /use 0D's rules for independent choices/i, /investigation and deferral do not authorize implementation/i,
            /challenges wait for the final gate/i, /one answer does not resolve other pending rows/i,
            /findings that needed only factual correction/i]);
          const skeleton = compactProse(readFileSync('plan-ceo-review/SKILL.md.tmpl', 'utf8'));
          // Delegation must resolve to the complete procedure, including the
          // saved comparison and separate actual answer, without duplicating it.
          ordered(skeleton, ['**1. Check sources and prior answers.**', '**2. Record the pending choice.**',
            /record pending rows before comparisons/i, "**3. Compare and save that row's options.**",
            '**Pre-question checkpoint:**', '**4. Ask, record the answer, and amend.**']);
          expect(skeleton).toContain('`D<N> — <ROW-ID>: <one-line question>`');
          expectAll(skeleton, [/ask one row per call/i, /literally with the verified fields/i, /ROW-ID identifies the pending choice/i,
            /save the answer reference and scope/i, /amend only authorized work/i]);
          continue;
        }
        if (skillName === 'plan-eng-review') {
          expectAll(queue, [/run every outside finding through the same Decision procedure/i, /record the reviewer and evidence/i,
            /agreement between reviewers is evidence, not approval/i, /new or reopened choices still need their own answers/i,
            /four-option menus instead of the ordinary 2-3 options/i,
            /identify one independently answerable change before building its alternatives/i,
            /keep necessary code, tests and docs for one approved behavior together/i,
            /does not resolve the finding's other pending rows/i, /challenges wait for its final gate/i]);
          continue;
        }
        ordered(queue, ['1. **Ground the evidence.**', '2. **Classify the finding.**',
          '3. **Check the scope.**', '4. **Draft and answer one decision.**',
          'Use AskUserQuestion', /wait for the actual answer/i, /then use a scoped Edit for those amendments before taking the next row/i]);
        expect(queue).toContain('Defer this proposed change only');
        expectAll(queue, [/hold every other value fixed or pending in every option/i, /split independently selectable changes/i,
          /does not defer its entire candidate or approve a new schedule gate/i, /record its answer reference and exact accepted scope/i,
          /does not resolve the finding's other pending rows/i, /challenges stay pending for the final gate/i]);
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
  const register = compactProse(template.split('### Pass 7: Unresolved Design Decisions')[1]!.split('### Post-Pass:')[0]!);
  ordered(register, [/cite an actual in-scope element/i, /each decision = one AskUserQuestion/i]);
  expectAll(register, [/do not establish that a control exists/i, /keep the item conditional/i,
    /do not invent controls or reopen accepted treatments/i]);
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

// CEO split-overflow call floor: stored call shapes for the scope validator.
{
  const { CEO_SCOPE_CANDIDATES } = await import('./helpers/plan-review-cases');
  const { CEO_SPLIT_CALL_FLOOR } = await import('./helpers/ceo-split-question-policy');
  const { validatePlanReviewDecisionResponse } = await import('./helpers/plan-review-decisions');
  type PlanReviewDecision = import('./helpers/plan-review-decisions').PlanReviewDecision;
  type PlanReviewDecisionInput = import('./helpers/plan-review-decisions').PlanReviewDecisionInput;
  type AskUserQuestionFingerprint = import('./helpers/claude-pty-runner').AskUserQuestionFingerprint;
  const PLATFORMS = ['Slack', 'Discord', 'Microsoft Teams', 'Telegram', 'Mattermost'];
  const question = (platform: string, n: number): NativeQuestion => ({
    header: platform, multiSelect: false,
    question: `D3.${n} — ${platform} integration\nELI10: Decide this integration independently. Recommendation: Include.`,
    options: ['Include', 'Defer', 'Cut', 'Hold'].map(label => ({ label, description: `Choose ${label} for ${platform}.` })),
  });
  type NativeCall = AskUserQuestionFingerprint & { toolUseId: string; questions: NativeQuestion[] };
  const call = (id: string, questions: NativeQuestion[]) => ({
    toolUseId: id, questions, selectedOptions: questions.map(() => 1), signature: id,
    promptSnippet: 'diagnostic', options: [], observedAtMs: 1, preReview: true,
  }) as unknown as NativeCall;
  const row = (fp: NativeCall, tab: number, target: string): PlanReviewDecision => ({
    toolUseId: fp.toolUseId, questionIndex: tab, kind: 'scope', targetIds: [target], independentDecisions: 1,
    evidence: [{ field: 'question', optionIndex: null, quote: fp.questions[tab - 1]!.question.split('\n')[0]! }],
    reason: 'This acknowledged question presents the independent decision described by this target.',
    optionActions: (['include', 'defer', 'cut', 'hold'] as const).map((action, i) => ({ optionIndex: i + 1, action })),
  });
  /** Stored shapes: each inner array is one AskUserQuestion call; numbers index PLATFORMS. */
  function run(groups: number[][]) {
    const fingerprints = groups.map((group, i) => call(`native-${i}`, group.map(p => question(PLATFORMS[p]!, p + 1))));
    const input: PlanReviewDecisionInput = { plan: 'Review the five independent integrations in this plan.', kind: 'scope',
      targets: CEO_SCOPE_CANDIDATES, fingerprints, floor: CEO_SPLIT_CALL_FLOOR, deadlineAt: Date.now() + 60_000 };
    const questions = groups.flatMap((group, i) => group.map((p, tab) => row(fingerprints[i]!, tab + 1, `E${p + 1}`)));
    return () => validatePlanReviewDecisionResponse(input, { questions });
  }

  test('the split floor is the minimum number of calls for five options at four per call', () => {
    expect(CEO_SPLIT_CALL_FLOOR).toBe(Math.ceil(PLATFORMS.length / 4));
  });
  test.each([
    ['five sequential calls', [[0], [1], [2], [3], [4]]],
    ['two batched calls', [[0, 1, 2, 3], [4]]],
    ['three batched calls', [[0, 1], [2, 3], [4]]],
  ])('known-good split passes: %s', (_name, groups) => {
    expect(run(groups)().coveredTargetIds).toEqual(CEO_SCOPE_CANDIDATES.map(c => c.id));
  });
  test.each([
    ['a candidate silently dropped', [[0, 1, 2, 3]], 'missing target decisions'],
    ['one call for a dropped fifth candidate', [[0, 1, 2], [3]], 'missing target decisions'],
  ])('known-bad split fails: %s', (_name, groups, message) => {
    expect(run(groups)).toThrow(message);
  });
}
