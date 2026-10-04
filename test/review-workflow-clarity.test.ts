import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { generateCrossReviewDedup, generateSharedCodeReuse, generateScopeDrift } from '../scripts/resolvers/review-scope';
import { generatePlanCompletionAuditReview, generatePlanCompletionAuditShip, generatePlanCompletionGateShip, PLAN_AUDIT_NOT_RUN } from '../scripts/resolvers/plan-gates';
import { generateQAReview } from '../scripts/resolvers/qa';
import { generateConfidenceCalibration } from '../scripts/resolvers/confidence';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const root = join(import.meta.dir, '..');
const skill = readFileSync(join(root, 'review/SKILL.md.tmpl'), 'utf8');
const adversarial = readFileSync(join(root, 'review/sections/adversarial.md.tmpl'), 'utf8');

test('review audits deliverables before deferring behavioral plan checks to the QA preflight', () => {
  const ctx: TemplateContext = { skillName: 'review', tmplPath: '', host: 'claude', paths: HOST_PATHS.claude };
  const audit = generatePlanCompletionAuditReview(ctx).replace(/\s+/g, ' ');
  for (const rule of [
    /separate static audit evidence from behavioral checks/i,
    /never DONE from a diff/,
    /zero audited deliverables do not waive these checks/i,
    /for each audited deliverable/i,
    /leave the item UNVERIFIABLE and defer the command to Step 4\.7/,
    /do not start applications, exercise APIs or mutate state during this audit/i,
  ]) expect(audit).toMatch(rule);
  const inspect = audit.search(/inspect the validator and its hooks before running it/i);
  expect(inspect).toBeGreaterThan(-1);
  expect(inspect).toBeLessThan(audit.search(/if found and verified safe above, invoke it/i));
  expect(audit).not.toContain('For each extracted plan item, run the verification dispatch');
});

test('review prior-Skip matching includes adversarial and Greptile findings without relaxing eligibility', () => {
  const dedup = generateCrossReviewDedup({ skillName: 'review', tmplPath: '', host: 'claude', paths: HOST_PATHS.claude });
  expect(dedup).toMatch(/for every combined finding, including core, specialist, exploratory QA, adversarial and valid actionable Greptile findings/i);
  expect(dedup).toMatch(/suppress only when all conditions hold: the user skipped the same unchanged finding/i);
  expect(dedup).toMatch(/never use a skipped advisory to suppress a real defect/i);
  expect(dedup).toMatch(/only suppress `skipped` findings — never `fixed` or `auto-fixed`/i);
  expect(skill).toContain('Step 5.0 severity/prior-skip dedup');
});

test('Review audit and prior-Skip clarifications do not route Ship through Review steps', () => {
  for (const host of Object.keys(HOST_PATHS) as TemplateContext['host'][]) {
    const ctx: TemplateContext = { skillName: 'ship', tmplPath: '', host, paths: HOST_PATHS[host] };
    const audit = generatePlanCompletionAuditShip(ctx);
    expect(audit).toContain('Step 8.1/9');
    expect(audit).not.toContain('Step 4.7');
    expect(audit).not.toContain('Separate static audit evidence from behavioral checks');
    const dedup = generateCrossReviewDedup(ctx);
    expect(dedup).toContain('Step 9.3: Cross-review finding dedup');
    expect(dedup).not.toContain('Step 5.0');
    expect(dedup).not.toContain('For every combined finding');
  }
});

test('review collects every source before its single parent fix phase', () => {
  const markers = [
    '## Step 4: Critical pass', '### TODOS cross-reference',
    '### Documentation staleness check', '{{SECTION:review-army}}',
    '{{QA_REVIEW}}', '{{SECTION:adversarial}}',
    '## Step 5: Fix-First Review', '{{CROSS_REVIEW_DEDUP}}',
    '### Step 5a:', '### Step 5b:', '### Step 5c:', '### Step 5d:',
    '## Step 5.8: Persist Eng Review result',
  ];
  const positions = markers.map(marker => skill.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(skill.match(/## Step 5: Fix-First Review/g)).toHaveLength(1);
  expect(skill.replace(/\s+/g, ' ')).toMatch(/do not edit reviewed source until Step 5/i);
  expect(skill.replace(/\s+/g, ' ')).toMatch(/every dispatched reader has returned or is confirmed stopped/i);
});

test('review settles adversarial attempts before fixing and has one full-pass back edge', () => {
  const generated = readFileSync(join(root, 'review/sections/adversarial.md'), 'utf8');
  const decision = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result')).replace(/\s+/g, ' ');
  expect(generated).toContain('## Step 4.8: Adversarial review');
  expect(generated).toMatch(/do not edit during Step 4\.8/i);
  expect(generated).toMatch(/return all findings and structured-review decisions to Step 5/i);
  expect(decision).toMatch(/a pass covers Steps 3–5/i);
  expect(decision).toContain('Below 3, repeat Steps 3–5 with a new REVIEW_START');
  expect(decision).not.toContain('Route Step');
  expect(decision).not.toContain('Steps 5.0–5d');
  expect(decision).toMatch(/without a clean summary or a fourth pass/i);
});

test('review small-diff and failed-reader paths retain QA and the required adversarial pass', () => {
  const army = generateReviewArmy({ skillName: 'review', tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude', paths: HOST_PATHS.claude });
  expect(army.replace(/\s+/g, ' ')).toMatch(/Continue to Step 4\.6 [^.]*Exploratory QA step and Step 4\.8 \(adversarial review\), then Step 5/i);
  expect(army).not.toContain('design-lite');
  expect(army.replace(/\s+/g, ' ')).toMatch(/missing dispatched coverage remains incomplete, never completed or clean/i);
  expect(army.replace(/\s+/g, ' ')).toMatch(/independent Step 4\.7 QA and Step 4\.8 adversarial review/i);
  expect(army).not.toContain("Exploratory QA step, then continue to Step 5.");
  expect(army).not.toContain('If the Red Team subagent fails or times out, skip silently');
});

test('review defines QA confidence, severity, impact selection and numeric version comparison', () => {
  const flat = skill.replace(/\s+/g, ' ');
  expect(flat).toContain('confidence (1–10)');
  expect(flat).toMatch(/retain Step 4\.7's severity/i);
  expect(flat).toMatch(/if impact is uncertain, rerun it/i);
  expect(flat).toMatch(/compare dotted version components as integers/i);
});

test('review emits scope check after the plan audit and before the checklist', () => {
  const markers = [
    '{{SCOPE_DRIFT}}', '{{SECTION:plan-completion}}',
    '## Step 2: Read the checklist',
  ];
  const positions = markers.map(marker => skill.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  const audit = readFileSync(join(root, 'review/sections/plan-completion.md'), 'utf8').replace(/\s+/g, ' ');
  expect(audit).toMatch(/emit the single final Scope Check/i);
  expect(skill).not.toContain('Finish Step 1.5 here');
});

test('review composes confidence-tagged findings into one final report with explicit incomplete coverage', () => {
  const flat = skill.replace(/\s+/g, ' ');
  expect(flat).toContain('CRITICAL/INFORMATIONAL');
  const report = flat.slice(flat.indexOf('### Report the final review'), flat.indexOf('{{LEARNINGS_LOG}}'));
  expect(report).toMatch(/one final report/i);
  expect(report).toMatch(/unresolved non-advisory defects/i);
  expect(report).toMatch(/[Ss]tate INCOMPLETE if `COMPLETED` is false/);
  expect(report).toContain('`## Exploratory QA and Verification Results`');
  expect(report).toMatch(/neither coverage gaps nor advice are defects/i);
});

test('small-diff persistence uses an empty specialist map without manufacturing skipped coverage', () => {
  const army = generateReviewArmy({ skillName: 'review', tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude', paths: HOST_PATHS.claude });
  expect(army).toContain('DIFF_LINES < 50, keep `specialists: {}`');
  expect(skill.replace(/\s+/g, ' ')).toMatch(/Step 4\.6's `specialists` object unchanged/i);
  const ship = readFileSync(join(root, 'ship/sections/review-army.md.tmpl'), 'utf8');
  expect(ship).toContain('`specialists`: `{}` for a small-diff skip');
  expect(skill.replace(/\s+/g, ' ')).toMatch(/every required Step 4\.7 probe passes/i);
  expect(ship.replace(/\s+/g, ' ')).toMatch(/all required probes pass/i);
});

test('caller QA runs charter and setup after resource loading and has a severity for unmatched functional failures', () => {
  for (const skillName of ['review', 'ship']) {
    const body = generateQAReview({ skillName, tmplPath: '', host: 'claude', paths: HOST_PATHS.claude });
    const preparation = body.indexOf(skillName === 'review'
      ? '**1. Set the charter and isolation.**'
      : 'Run the shared preflight;');
    const probes = body.indexOf('**3. Run smoke and plan checks.**');
    expect(preparation).toBeGreaterThan(-1);
    if (skillName === 'review') {
      const readiness = body.indexOf('**2. Check readiness and list required checks.**');
      expect(readiness).toBeGreaterThan(preparation);
      expect(probes).toBeGreaterThan(readiness);
      expect(body.slice(preparation, readiness).replace(/\s+/g, ' ')).toMatch(/isolation\/permission preflight before setup/i);
    } else expect(preparation).toBeGreaterThan(body.indexOf('**2. List required checks.**'));
    expect(probes).toBeGreaterThan(preparation);
    expect(body.replace(/\s+/g, ' ')).toContain('`functional-contract`, `CRITICAL`');
    expect(body).toMatch(/setup\/permission blockers are not defects/i);
    expect(body).toMatch(/test creation needs user approval/i);
    expect(body).toMatch(/return verified defects to Fix-First/i);
    expect(body).not.toContain('for parent approval');
  }
});

test('review prepares context and deduplicates before classifying findings', () => {
  const positions = [
    '## Step 3.5: Slop scan', '## Step 3.6: Gather review context',
    '{{LEARNINGS_SEARCH}}', '{{ASIDE_RESEARCH}}', '## Step 4: Critical pass',
    '## Step 5: Fix-First Review', '{{CROSS_REVIEW_DEDUP}}',
    '**Keep decisions through fix cycles:**', '### Step 5a: Classify each finding',
  ].map(marker => skill.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(skill).toMatch(/before Step 5a classification/i);
});

test('review owns the complete persistence contract after the adversarial read', () => {
  const step = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  expect(skill.indexOf('{{SECTION:adversarial}}')).toBeLessThan(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  expect(adversarial).not.toContain('### Before persisting Eng Review (Step 5.8)');
  for (const token of [
    'repeat Steps 3–5', 'at most 3 fix cycles', 'original `evidence_paths`/`helper_target`',
    'snapshot_covered_paths', 'REVIEW_START', 'COMPLETED', 'CONVERGED', 'CYCLES', 'Step 4.7',
    'native Step 4.8 adversarial pass', 'named-risk', 'zero counts', '`completed:false`',
    '`specialists`', '`findings`', 'explicit Skip', 'sharedLibsFingerprint', '`review_binding`',
  ]) expect(step.toLowerCase().replace(/\s+/g, ' ')).toContain(token.toLowerCase());
  expect(step.indexOf('### 1. Re-review after edits'))
    .toBeLessThan(step.indexOf('### 2. Fill the record'));
  expect(step.indexOf('### 2. Fill the record'))
    .toBeLessThan(step.indexOf('~/.claude/skills/gstack/bin/gstack-review-log'));
  expect(step).toContain('`quality_score`');
  expect(step.indexOf('Pre-Landing Review: N issues (X critical, Y informational)'))
    .toBeGreaterThan(step.indexOf('~/.claude/skills/gstack/bin/gstack-review-log'));
  expect(step).toContain('`## Exploratory QA and Verification Results`');
});

test('review distinguishes required native coverage from optional outside coverage', () => {
  const section = readFileSync(join(root, 'review/sections/adversarial.md'), 'utf8');
  expect(section).toMatch(/only this optional outside adversarial pass is non-blocking/i);
  expect(section).not.toContain('All errors are non-blocking');
  expect(section).toMatch(/native pass is required for Step 5\.8 completion/i);
});

test('review identifies probe selection, report assets and the detected diff base', () => {
  const generated = generateQAReview({ skillName: 'review', tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude', paths: HOST_PATHS.claude });
  const checklist = readFileSync(join(root, 'review/checklist.md'), 'utf8');
  expect(generated).toContain('5 minutes/12 probes');
  expect(generated).toContain("Read QA\'s `templates/functional-report-template.md`");
  expect(generated).toMatch(/link every checkpoint/i);
  expect(generated).toMatch(/no second report/i);
  expect(checklist).toMatch(/merge-base diff from the caller/i);
  expect(checklist).not.toContain('git diff origin/main');
});

test('caller QA defines execution, evidence ownership and report adaptation before handoff', () => {
  for (const skillName of ['review', 'ship']) {
    const generated = generateQAReview({ skillName, tmplPath: `${skillName}/SKILL.md.tmpl`,
      host: 'claude', paths: HOST_PATHS.claude }).replace(/\s+/g, ' ');
    expect(generated).toMatch(/never overwrite another run/i);
    expect(generated).toMatch(/with current inputs, even without updates/i);
    expect(generated).toContain('Use checklist severity');
    if (skillName === 'review') {
      expect(generated).toContain('`## Exploratory QA and Verification Results`');
      expect(generated).toContain('`### Browser results`');
      expect(generated).toMatch(/continue to Step 4\.8 even if blocked/i);
      expect(generated).toMatch(/Step 5\.8 appends this section once/i);
    } else {
      expect(generated).toContain('`## Exploratory QA`');
    }
  }
});

test('review section index follows the actual pre-fix execution order', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'review/sections/manifest.json'), 'utf8'));
  expect(manifest.sections.map((section: { id: string }) => section.id)).toEqual([
    'plan-completion', 'review-army', 'adversarial', 'shared-code-reuse',
  ]);
});

test('review finalization ownership: initialize invocation state and capture the core token before reading', () => {
  const start = skill.slice(skill.indexOf('## Step 3: Get the diff'), skill.indexOf('## Step 3.4:'));
  expect(start).toContain('CYCLES=0');
  expect(skill.match(/CYCLES=0/g)).toHaveLength(1);
  expect(start).toContain('gstack-review-log --start review\ngit diff "$DIFF_BASE"');
  const flat = start.replace(/\s+/g, ' ');
  expect(flat).toMatch(/REVIEW_START for this core candidate before reading its diff/i);
  expect(flat).toMatch(/new token before reading, never at log time/i);
  expect(flat).toMatch(/separate PASS_START tokens, not REVIEW_START/);
  expect(flat).toMatch(/finishes only the final core token/i);
});

test('review finalization ownership: late findings use Fix-First before the bounded parent transition', () => {
  const flat = skill.replace(/\s+/g, ' ');
  const markers = [
    '{{SECTION:adversarial}}',
    '## Step 5: Fix-First Review',
    'Structured approval does not waive advisory/test_stub ASK gates',
    '## Step 5.8: Persist Eng Review result',
    'Edited: increment CYCLES once',
    'No edits: fill the record below',
    '### 2. Fill the record',
    '--finish REVIEW_START',
  ];
  const positions = markers.map(marker => flat.indexOf(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(flat).toContain('at most 3 fix cycles');
  expect(flat).toContain('At 3, persist `converged:false`');
  const limit = flat.slice(flat.indexOf('At 3,'), flat.indexOf('No edits:'));
  expect(limit).toMatch(/then stop this invocation/i);
  expect(limit).toMatch(/without a clean summary or a fourth pass/i);
});

test('review finalization ownership: affected QA reuse cannot replace a full review or erase decisions', () => {
  const step = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  const flat = step.replace(/\s+/g, ' ');
  expect(flat).toContain('execute Steps 3–5 in order');
  expect(flat).toMatch(/reuse only this invocation's unchanged-input QA evidence/i);
  expect(flat).toMatch(/reusing a probe never skips a review step/i);
  expect(flat).toMatch(/earlier fixes do not suppress them/i);
  expect(flat).toContain('logger computes `snapshot_covered_paths`');
  expect(flat).toMatch(/never carry prior-cycle, supplied or prior-record coverage forward or build this proof yourself/i);
});

test('review finalization ownership: required native completion and optional outside records stay separate', () => {
  const step = skill.slice(skill.indexOf('### 2. Fill the record'));
  const flat = step.replace(/\s+/g, ' ');
  expect(flat).toMatch(/any failed, blocked, inconclusive or not-run required probe means false, as does a failed native review/i);
  expect(flat).toMatch(/`\/ship` named-risk acceptance cannot complete `\/review`/i);
  expect(flat).toMatch(/cannot substitute for the native result, or vice versa/i);
  expect(flat).toMatch(/structured-review gate still applies/i);
  expect(flat).toContain('zero counts and `completed:false`');
  expect(flat).toContain('`CONVERGED`: true only for a completed zero-edit pass');
});

test('review finalization ownership: finish only the final core token without log-time capture', () => {
  const step = skill.slice(skill.indexOf('## Step 5.8: Persist Eng Review result'));
  const flat = step.replace(/\s+/g, ' ');
  expect(step.match(/--finish REVIEW_START/g)).toHaveLength(1);
  expect(step).not.toContain('--start review');
  expect(step).not.toContain('--finish PASS_START');
  expect(flat).toMatch(/never invent a binding or replace REVIEW_START at log time/i);
  expect(flat).toMatch(/finish only the final core token/i);
  expect(step).toContain('"completed":COMPLETED,"converged":CONVERGED,"cycles":CYCLES');
});

test('review finalization ownership: the plan audit retains its high-impact gate before the final scope check', () => {
  const plan = readFileSync(join(root, 'review/sections/plan-completion.md.tmpl'), 'utf8');
  expect(plan).toContain('HIGH-impact discrepancy question');
  expect(plan).toMatch(/resolve that gate before the final Scope Check/i);
  expect(plan).not.toContain('never blocks the review');
  expect(plan).toContain('{{PLAN_COMPLETION_AUDIT_REVIEW}}');
  const audit = readFileSync(join(root, 'review/sections/plan-completion.md'), 'utf8');
  const gate = audit.indexOf('**HIGH-impact plan-file discrepancies** trigger AskUserQuestion');
  expect(gate).toBeGreaterThan(-1);
  expect(gate).toBeLessThan(audit.indexOf('When continuing after the audit (no HIGH-impact gate, or option B/C)'));
  const flatAudit = audit.replace(/\s+/g, ' ');
  expect(flatAudit).toMatch(/A ends this invocation before code review or implementation/i);
  expect(flatAudit).toMatch(/not this read-only audit/i);
  expect(flatAudit).toContain('B/C continue to the final Scope Check and Step 2');
  expect(flatAudit).toMatch(/none of these choices authorizes shipping or waives required verification/i);
});

test('review scope notes remain provisional until the plan section emits the only final scope check', () => {
  const scope = generateScopeDrift({ skillName: 'review', tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude', paths: HOST_PATHS.claude }).replace(/\s+/g, ' ');
  expect(scope).toMatch(/keep these notes provisional/i);
  expect(scope).toMatch(/single final Scope Check before Step 2/i);
  expect(scope).not.toContain('Scope Check: [CLEAN');
  expect(scope).not.toContain('available plan-audit results');
});

test('review confidence uses its severity labels without an undefined P0 exception', () => {
  const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude', paths: HOST_PATHS.claude };
  const confidence = generateConfidenceCalibration(ctx);
  expect(confidence).toContain('[CRITICAL]');
  expect(confidence).toContain('[CRITICAL|INFORMATIONAL]');
  expect(confidence).not.toMatch(/\bP[012]\b/);
  const flat = confidence.replace(/\s+/g, ' ');
  for (const row of [
    /\| 9-10 \|[^|]*\| Show normally \|/, /\| 7-8 \|[^|]*\| Show normally \|/,
    /\| 5-6 \|[^|]*\| Show with caveat/, /\| 3-4 \|[^|]*\| Suppress from main report/,
    /\| 1-2 \|[^|]*\| Only report a suspected release-blocking catastrophe/,
  ]) expect(flat).toMatch(row);
  expect(flat).toMatch(/explicitly speculative/i);
  expect(flat).toMatch(/the finding is unverified/i);
  expect(flat).toContain('file:line');
  expect(flat).toMatch(/force its confidence to 4-5/i);
  expect(flat).toMatch(/never invent speculative confidence 7\+/i);
  expect(confidence.indexOf('Pre-emit verification gate')).toBeLessThan(confidence.indexOf('| Score |'));
  expect(confidence).not.toContain('FP classes the gate kills');
  expect(confidence).not.toContain('1539-framework-aware-review.md');
  expect(generateConfidenceCalibration({ ...ctx, skillName: 'ship' })).toContain('Only report if severity would be P0');
});

test('review names the lifecycle and record owners before using their persistence rules', () => {
  const start = skill.slice(skill.indexOf('## Step 3: Get the diff'), skill.indexOf('## Step 3.4:')).replace(/\s+/g, ' ');
  expect(start).toContain('REVIEW_START / PASS_START |');
  expect(start).toContain('`review_binding` |');
  expect(start).toContain('`snapshot_covered_paths` |');
  expect(start).toMatch(/a matching key alone never proves a prior Skip is reusable/i);
  expect(start).toMatch(/never supplied by the reviewer/i);
});

test('review invocation-local advice reuse keeps raw-source and changed-decision gates', () => {
  const decisions = skill.slice(skill.indexOf('**Keep decisions through fix cycles:**'),
    skill.indexOf('### Step 5a:')).replace(/\s+/g, ' ');
  expect(decisions).toMatch(/save completed AUTO-FIX\/fix and explicit Skip actions/i);
  expect(decisions).toContain("`advisory`, `evidence_paths` and `helper_target`");
  expect(decisions).toMatch(/require a new question/i);
  expect(decisions).toMatch(/cannot suppress new\/recurring defects/i);
});

for (const skillName of ['review', 'ship']) {
  const ctx: TemplateContext = { skillName, tmplPath: `${skillName}/SKILL.md.tmpl`,
    host: 'claude', paths: HOST_PATHS.claude };
  const army = generateReviewArmy(ctx);
  const flat = army.replace(/\s+/g, ' ');

  test(`${skillName} clarity: terminal failure permits independent work but never certifies coverage`, () => {
    expect(flat).toMatch(/confirm that each task has finished or is stopped/i);
    expect(flat).toMatch(/a timeout alone does not prove termination/i);
    expect(flat).toMatch(/stop path without edits/i);
    expect(flat).toMatch(/missing dispatched coverage remains incomplete, never completed or clean/i);
    expect(flat).not.toContain('Specialists are additive — partial results are better than no results');
    const redTeam = flat.slice(flat.indexOf('### Red Team dispatch'));
    expect(redTeam).toMatch(/confirm it stopped and record its review as incomplete/i);
    expect(redTeam).toContain('stages 1–7');
  });

  test(`${skillName} clarity: ordered specialist merge separates validation from scoring and provenance`, () => {
    const markers = ['#### 1. Parse outputs', '#### 2. Validate severity',
      '#### 3. Identify and merge', '#### 4. Apply specialist confidence gates',
      '#### 5. Score and present specialists', '#### 6. Save specialist activity',
      '#### 7. Hand off to Fix-First'];
    const positions = markers.map(marker => army.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const validation = flat.slice(flat.indexOf('#### 2.'), flat.indexOf('#### 3.'));
    expect(validation).toContain('remove `advisory` and retain its `CRITICAL` severity');
    expect(validation).toMatch(/never downgrade severity/i);
    const merge = flat.slice(flat.indexOf('#### 3.'), flat.indexOf('#### 4.'));
    expect(merge.indexOf('Partition defects and advisories')).toBeLessThan(merge.indexOf('grouping by fingerprint'));
    for (const token of ['sharedLibsFingerprint', 'literal JSON on stdin', '+1 (cap at 10)']) expect(merge).toContain(token);
    for (const rule of [/never trust a supplied hash/i, /missing\/malformed metadata cannot deduplicate/i,
      /core findings never earn a specialist confidence boost/i]) expect(merge).toMatch(rule);
    for (const gate of ['Confidence 7+', 'Confidence 5-6', 'Confidence 3-4', 'Confidence 1-2']) expect(army).toContain(gate);
    const scoring = flat.slice(flat.indexOf('#### 5.'), flat.indexOf('#### 6.'));
    expect(scoring).toMatch(/only specialist findings enter this header and `quality_score`/i);
    expect(scoring).toMatch(/non-advisory/i);
    expect(scoring).toContain('quality_score = max(0, 10 - (critical_count * 2 + informational_count * 0.5))');
    expect(flat).toMatch(/advisory findings count in the stats `findings` field/i);
    expect(flat).toMatch(/count only findings that specialist actually returned/i);
    expect(flat).toMatch(/core-only advice must not create a specialist dispatch or finding/i);
    expect(flat).toContain('ASK-only');
  });

  test(`${skillName} clarity: shared-code reuse gives executable decisions and retains checker safeguards`, () => {
    const reuse = generateSharedCodeReuse(ctx).replace(/\s+/g, ' ');
    const markers = ['1. **Read the evidence.**', '2. **Run the checker.**',
      '3. **Act on its result.**', '4. **Persist through the logger.**'];
    const positions = markers.map(marker => reuse.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const token of ['--check-shared-libs REVIEW_START', "<<'GSTACK_SHARED_LIBS_REUSE_JSON'", 'literal JSON on stdin',
      '`reusable: true`', 'sharedLibsFingerprint', 'explicit Skip', 'logger-versioned `snapshot_covered_paths`',
      'canReuseSharedLibsAdvisory']) expect(reuse).toContain(token);
    for (const rule of [/false, command failure or unreadable output[^.]*never suppression/i,
      /do not supply your own snapshot, prior record or coverage/i, /unknown evidence fails closed/i,
      /real defects retain normal Fix-First handling/i]) expect(reuse).toMatch(rule);
  });
}

test('review clarity: settlement gates edits separately from incomplete required coverage', () => {
  const fix = skill.slice(skill.indexOf('## Step 5: Fix-First Review'), skill.indexOf('{{CROSS_REVIEW_DEDUP}}')).replace(/\s+/g, ' ');
  expect(fix).toMatch(/every dispatched reader has returned or is confirmed stopped/i);
  expect(fix).toMatch(/persist incomplete at Step 5\.8 and stop without edits/i);
  expect(fix).toMatch(/missing required output still makes the pass incomplete/i);
});

test('review clarity: Greptile reply choices never substitute for Fix-First approval', () => {
  const fix = skill.slice(skill.indexOf('## Step 5: Fix-First Review'), skill.indexOf('{{CROSS_REVIEW_DEDUP}}'));
  expect(fix).toContain('VALID & ACTIONABLE Greptile findings');
  const greptile = skill.slice(skill.indexOf('### Greptile comment resolution'), skill.indexOf('## Step 5.8:'));
  const flat = greptile.replace(/\s+/g, ' ');
  expect(flat).toMatch(/Step 5c alone supplies A\) Fix \/ B\) Skip/i);
  expect(flat).not.toContain('A: Fix it now, B: Acknowledge, C: False positive');
  expect(flat).toMatch(/reply decisions, not code approval/i);
  expect(flat).toContain('B) Propose a code change');
  expect(flat).toContain('Steps 5c–5d');
  expect(flat).toMatch(/wait for approval before editing/i);
  expect(flat).toMatch(/no new fix permission/i);
});

test('ship review clarity: parent settlement gate precedes classification and cannot waive coverage', () => {
  const ship = readFileSync(join(root, 'ship/sections/review-army.md.tmpl'), 'utf8');
  const gate = ship.slice(ship.indexOf('## Step 9.4:'), ship.indexOf('1. **Classify')).replace(/\s+/g, ' ');
  expect(gate).toMatch(/wait for return or confirm termination/i);
  expect(gate).toMatch(/log incomplete through items 5–6 and stop without edits/i);
  expect(gate).toMatch(/missing dispatched output still blocks continuation, even with a QA exception/i);
});

test('review keeps its smoke-clock, setup-authority, plan-gate and findings-source rules', () => {
  const ctx = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext;
  const qa = generateQAReview(ctx).replace(/\s+/g, ' ');
  expect(qa).toMatch(/\/review sets none; only an invoker-supplied EARLIER_UTC counts/);
  expect(qa).toMatch(/report-only \/review never runs setup, installs or cookie import/i);
  expect(qa).toMatch(/otherwise they stay blocked/i);
  expect(qa).not.toContain('Ask for setup/permission');
  expect(generateQAReview({ ...ctx, skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl' })).not.toContain('/review sets none');
  const audit = generatePlanCompletionAuditReview(ctx).replace(/\s+/g, ' ');
  // F1 (#2768): no bound plan prints the exact not-run line instead of the old notice.
  expect(audit).toContain(PLAN_AUDIT_NOT_RUN);
  expect(audit).toMatch(/use the Fallback Intent Sources below/);
  expect(audit).not.toMatch(/skip dispatch/);
  expect(audit).toContain('**HIGH-impact plan-file discrepancies** trigger AskUserQuestion');
  expect(audit).toMatch(/derived only from fallback sources[\s\S]{0,80}never trigger this question/i);
  const shipCtx = { ...ctx, skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl' };
  expect(generatePlanCompletionGateShip(shipCtx, ['discovery'])).toMatch(/skip dispatch and record zero counts/);
  expect(generatePlanCompletionAuditShip(shipCtx)).toContain('Do not search for another plan');
  const persist = skill.slice(skill.indexOf('### 2. Fill the record')).replace(/\s+/g, ' ');
  expect(persist).toMatch(/combined final-pass findings \(core, specialist, adversarial, actionable Greptile, verified exploratory QA findings\)/i);
});

// INV-1 consumers: an outside review that reports `unverified` or
// `unavailable` is missing coverage in /ship's readiness note, its PR body
// and /review's completion, never a pass.
test('ship and review count unverified or unavailable outside reviews as missing coverage', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf-8').replace(/\s+/g, ' ');
  for (const rel of ['ship/SKILL.md', 'ship/sections/pr-body.md', 'review/SKILL.md']) {
    expect(read(rel)).toMatch(/`unverified` or `unavailable` is (listed as )?missing coverage[^.]*never (as )?(a )?pass/i);
  }
});
