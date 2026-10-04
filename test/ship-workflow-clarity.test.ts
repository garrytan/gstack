import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAdversarialStep } from '../scripts/resolvers/outside-voice-steps';
import { generateQAReview } from '../scripts/resolvers/qa';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { readWorkflowExcerpt } from './helpers/workflow-excerpt';

const readShip = () => readWorkflowExcerpt('ship/SKILL.md', '# Ship:', '## Important Rules');
const readTemplate = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const compact = (text: string) => text.replace(/\s+/g, ' ');
const ordered = (text: string, markers: (string | RegExp)[]) => {
  const positions = markers.map(marker => typeof marker === 'string' ? text.indexOf(marker) : text.search(marker));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
};
const reviewTemplate = readTemplate('ship/sections/review-army.md.tmpl');
const coverageTemplate = readTemplate('ship/sections/test-coverage.md.tmpl');
const entryTemplate = readTemplate('ship/SKILL.md.tmpl');
const controlTemplate = entryTemplate.slice(entryTemplate.indexOf('### Ship control flow'), entryTemplate.indexOf('{{SECTION_INDEX:ship}}'));
const entry = compact(entryTemplate);
const reviewFlow = compact(reviewTemplate);
const finalGate = compact(controlTemplate + entryTemplate.slice(entryTemplate.indexOf('## Step 16:'), entryTemplate.indexOf('## Step 17:')));
const pushFlow = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 17:'), entryTemplate.indexOf('## Step 18:')));
const docsTemplate = readTemplate('ship/sections/documentation.md.tmpl');
const docs = compact(docsTemplate);
const prTemplate = readTemplate('ship/sections/pr-body.md.tmpl');

test('ship QA starts its smoke guard once before probes on every host', () => {
  for (const host of ALL_HOST_CONFIGS) {
    const body = generateQAReview({ host: host.name, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host.name] });
    ordered(body, [/start its smoke guard once/i, '**3. Run smoke and plan checks.**']);
  }
});

test('ship reports QA in the PR template headings, not a second combined report', () => {
  const ship = compact(readShip());
  expect(ship).toContain('`## Exploratory QA`');
  expect(ship).toContain('`## Verification Results`');
  expect(ship).toContain("Read QA's `templates/functional-report-template.md`");
  expect(ship).toMatch(/link every checkpoint; no second report/i);
  expect(ship).not.toContain('## Exploratory QA and Verification Results');
});

test('the invocation record keeps state outside the product tree and scopes approvals', () => {
  expect(entry).toContain('**invocation record**');
  expect(entry).toMatch(/outside the product tree/i);
  expect(entry).toContain('`BUMP_LEVEL`');
  expect(entry).toMatch(/each approval's finding, files and authorized action/i);
  expect(entry).toMatch(/never borrow or replace a token/i);
  const state = compact(entryTemplate.slice(entryTemplate.indexOf('### Keep state'), entryTemplate.indexOf('{{SECTION_INDEX:ship}}')));
  expect(state).toContain('`gstack-review-log --start`');
  expect(state).toContain('`REVIEW_START` for Step 9, a separate `PASS_START` for each Step 11 attempt, and `DESIGN_START` for design');
  expect(state).toContain('`gstack-wtree`');
  expect(entry).toMatch(/every new invocation repeats Steps 1–16, including both reviews and the docs audit/i);
  expect(entry).toContain('Start with Steps 1–21 in order, including 11.5 and 14.5');
});

test('plan obligations precede scope drift, learnings and review', () => {
  const plan = readTemplate('ship/sections/plan-completion.md.tmpl');
  const route = compact(plan.slice(0, plan.indexOf('**Dispatch this step')));
  ordered(route, ['1. Dispatch the audit', '2. Collect', '3. Run Step 8.2 Scope Drift', '4. Run Prior Learnings']);
  ordered(plan, ['{{PLAN_COMPLETION_GATE_SHIP}}', '{{PLAN_VERIFICATION_EXEC}}', '{{SCOPE_DRIFT}}',
    '{{LEARNINGS_SEARCH:query=release ship version changelog merge pr}}']);
  expect(entryTemplate.indexOf('{{SECTION:plan-completion}}')).toBeLessThan(entryTemplate.indexOf('{{SECTION:review-army}}'));
  const section = readTemplate('ship/sections/plan-completion.md');
  ordered(section, ['## Step 8.1:', '## Step 8.2:', '## Prior Learnings']);
  expect(section).toMatch(/N\) Not done — block ship/i);
  expect(section).not.toContain('re-enter the priority-1 gate');
});

test('the parent owns one ordered review phase that persists each pass once', () => {
  expect(reviewFlow).toMatch(/set CYCLES to 0 on first entry only/i);
  expect(reviewFlow).toMatch(/steps 10–11 queue findings without editing/i);
  expect(reviewFlow).toMatch(/changed finding scope needs a new decision/i);
  expect(reviewFlow).toMatch(/gated\/unsupported specialists skip only their dispatch, never QA or Step 11/i);
  expect(reviewTemplate.indexOf('6. Persist the review result')).toBeGreaterThan(-1);
  expect(reviewTemplate.indexOf('6. Persist the review result')).toBeLessThan(reviewTemplate.indexOf('### Decide whether to repeat Step 9'));
  const finalize = compact(reviewTemplate.slice(reviewTemplate.indexOf('4. **'), reviewTemplate.indexOf('5. Output summary:')));
  expect(finalize).toMatch(/increment CYCLES once if fixes were applied/i);
  expect(finalize).toContain('items 5–6 exactly once with the original REVIEW_START');
  expect(finalize).toContain('`converged:false`');
  expect(reviewTemplate).toContain('--finish REVIEW_START');
  expect(reviewFlow).toMatch(/never recapture at persistence to certify unreviewed fixes/i);
  expect(reviewTemplate).toContain('`CONVERGED`: completed with zero fixes');
  expect(reviewFlow).toContain('`status:"unavailable"`, `completed:false` and `converged:false`');
  expect(reviewFlow).toContain('Pre-Landing Review: INCOMPLETE');
  expect(reviewFlow).toContain('`STATUS`: `unavailable` for missing dispatched reviewer output');
});

test('named QA risks need explicit acceptance and never count as passing verification', () => {
  const gate = compact(reviewTemplate.slice(reviewTemplate.indexOf('**Required-probe parent gate:**')));
  expect(gate).toMatch(/AskUserQuestion: stop for repair \(recommended\), or explicitly accept each named probe's concrete risk/i);
  expect(gate).toMatch(/skipping a fix is not risk acceptance or a passing probe/i);
  expect(reviewFlow).toMatch(/record accepted untested risk separately, not as passing verification/i);
});

test('coverage generation has one bounded allowance and the child stays audit-only when told', () => {
  const allowance = compact(coverageTemplate.slice(0, coverageTemplate.indexOf('````text')));
  expect(allowance).toContain('Maximum 2 generation passes total per invocation');
  expect(allowance).toContain('30-path/5-tests-per-pass/2-minute');
  expect(allowance).toMatch(/re-entry never resets it/i);
  expect(allowance).toMatch(/missing permission is not approval/i);
  const prompt = coverageTemplate.split('````text\n')[1]?.split('\n````')[0] ?? '';
  expect(prompt).toContain('Generation: <allowed|audit-only>; passes used: <N> of 2.');
  ordered(prompt, [/audit-only overrides every generation instruction/i, '{{TEST_COVERAGE_AUDIT_SHIP}}']);
  expect(prompt).toMatch(/do not commit or push/i);
  expect(prompt).toMatch(/return unresolved user decisions to the parent/i);
  expect(prompt).toContain('"coverage_pct":N,"gaps":N');
  expect(prompt).toContain('"tests_added":["path",...]');
});

test('design-lite and the Design specialist merge duplicates under the stricter gate', () => {
  const design = compact(reviewTemplate.slice(reviewTemplate.indexOf('{{DESIGN_REVIEW_LITE}}'), reviewTemplate.indexOf('{{REVIEW_ARMY}}')));
  expect(design).toMatch(/one item with both sources and stricter ASK/i);
  expect(design).toMatch(/neither pass substitutes for the other/i);
  ordered(reviewTemplate, ['{{DESIGN_REVIEW_LITE}}', '{{REVIEW_ARMY}}']);
  expect(reviewTemplate).toContain('"dispatched":true,"findings":N,"critical":N,"informational":N');
});

test('late adversarial and comment fixes queue without editing outside Step 9.4', () => {
  const ship = readShip();
  expect(compact(ship.slice(ship.indexOf('## Step 11:'), ship.indexOf('## Step 12:')))).toMatch(/queued for the parent; do not edit during Step 11/i);
  expect(compact(ship.slice(ship.indexOf('## Step 10:'), ship.indexOf('## Step 11:')))).toMatch(/queue the approved fix without editing here/i);
});

test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s: ship adversarial approvals queue without editing and never credit outside coverage', host => {
  const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
  const text = compact(generateAdversarialStep(ctx));
  expect(text).toMatch(/if A: queue the approved findings without editing here/i);
  expect(text).toMatch(/retain the acknowledged findings and failed gate/i);
  expect(text).toMatch(/do not report a clean review/i);
  expect(text).toMatch(/native completion never credits outside coverage/i);
  const standalone = generateAdversarialStep({ ...ctx, skillName: 'review' });
  expect(standalone).not.toContain('Before Step 12:');
  expect(standalone).not.toContain('### Finish the adversarial phase');
  expect(compact(standalone)).toMatch(/queue the findings and this approval for Step 5's Fix-First handling/i);
});

test('outside challenge availability never resets fix limits or bypasses blocking owners', () => {
  const adversarial = compact(readTemplate('ship/sections/adversarial.md'));
  expect(adversarial).toMatch(/an unavailable outside challenge does not block shipping by itself/i);
  expect(adversarial).toMatch(/structured P0\/P1 and non-convergence gates still apply/i);
  expect(adversarial).toMatch(/returning here never resets Step 9's three-cycle fix limit/i);
  const standaloneReview = readTemplate('review/sections/adversarial.md');
  expect(standaloneReview).toContain('Step 5 Fix-First');
  expect(standaloneReview).not.toContain('supported findings still enter Step 11');
});

test('Step 11.5 rejects foreign records and blocks release on any mismatch', () => {
  const receipt = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 11.5:'), entryTemplate.indexOf('## Step 12:')));
  expect(receipt).toContain('~/.claude/skills/gstack/bin/gstack-review-read');
  expect(receipt).toMatch(/reject outside-provider or older invocation records/i);
  expect(receipt).toMatch(/blocks release preparation/i);
  expect(receipt).toContain('**Review records missing or mismatched**');
  for (const stale of ['phase:"core"', 'Step 9.5', 'source:"in-host"', 'status:"clean"']) expect(receipt).not.toContain(stale);
});

test('version recovery and digest generation stay explicit', () => {
  const version = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 12:'), entryTemplate.indexOf('## Step 14:')));
  expect(version).toContain('`baseVersion` to `currentVersion`');
  expect(version).toMatch(/an absent fourth component is zero/i);
  expect(version).toMatch(/not another automatic bump/i);
  expect(version).toContain('ALREADY_BUMPED');
  expect(version).not.toContain('skip if ALREADY_BUMPED');
  expect(version).toContain('`agents-digest/gstack-AGENTS.md`');
  expect(version).toContain('`agentsDigest`');
  expect(version).toContain('`bun scripts/gen-agents-digest.ts`');
  expect(version).toMatch(/before push, verify the committed digest matches generation/i);
});

test('distribution setup asks for unknown targets and never invents credentials', () => {
  const distribution = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 2:'), entryTemplate.indexOf('## Step 3:')));
  expect(distribution).toContain('git diff origin/<base> --diff-filter=A --name-only');
  expect(distribution).toMatch(/ask for unknown targets, registries or access first/i);
  expect(distribution).toMatch(/never invent credentials/i);
  expect(distribution).toMatch(/include the workflow in tests and review/i);
});

test('ambiguous Apple targets and merge conflicts wait for the user', () => {
  const apple = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 0.9:'), entryTemplate.indexOf('## Step 1:')));
  expect(apple).toContain('`Package.swift`');
  expect(apple).toMatch(/AskUserQuestion to identify the target and wait before choosing a release path/i);
  expect(apple).toMatch(/confirmed app, \*{0,2}stop and read/i);
  const merge = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 3:'), entryTemplate.indexOf('{{SECTION:tests}}')));
  expect(merge).toMatch(/ambiguous conflicts, \*{0,2}stop\b/i);
  expect(merge).toMatch(/AskUserQuestion for the needed resolution decision/i);
  expect(merge).toMatch(/wait for the answer before editing or continuing/i);
});

test('missing test suites need a named gap decision rather than a fabricated fresh receipt', () => {
  const tests = compact(readTemplate('ship/sections/tests.md.tmpl'));
  expect(tests).toContain('A) Add tests (recommended), B) Ship with this named testing gap, or C) Stop');
  expect(tests).toMatch(/reuse an actual prior B answer only for the same scope and content/i);
  expect(tests).toMatch(/independent build, eval, review and QA gates still apply/i);
  expect(tests).toMatch(/a declared but unavailable suite is a blocker/i);
  expect(finalGate).toMatch(/explicit untested-scope approval/i);
  expect(finalGate).toMatch(/report the gap, never FRESH/i);
});

test('Step 16 stages run in order and freeze inputs through push', () => {
  ordered(finalGate, ['### 1. Finish writers and prepare outputs', '### 2. Choose the change route',
    '### 3. Resolve documentation freshness', '### 4. Verify the frozen candidate']);
  const route = compact(entryTemplate.slice(entryTemplate.indexOf('### 2. Choose the change route'), entryTemplate.indexOf('### 3. Resolve documentation freshness')));
  ordered(route, ['**Behavior, tests or build inputs changed:**', '**Only authored docs or release metadata changed:**',
    '**No changes, or the docs-only checks still support the plan:**']);
  expect(route).toMatch(/prompts\/templates count as behavior/i);
  expect(route).toMatch(/continue to stage 3 without a new code review/i);
  expect(finalGate).toMatch(/confirm terminal completion or termination before another writer runs/i);
  expect(finalGate).toMatch(/timeout or cancellation acknowledgment alone means stop until confirmed/i);
  expect(finalGate).toContain('**Build failed or prerequisite missing**');
  expect(finalGate).toMatch(/never invent a substitute command/i);
  expect(finalGate).toMatch(/freeze inputs through verification and push/i);
  expect(finalGate).toMatch(/mandatory reviews still run/i);
  expect(finalGate).toMatch(/never resample it/i);
  expect(finalGate).toMatch(/changed or unknown dependencies require a rerun/i);
  expect(finalGate.indexOf('**Reuse a check when its inputs match.**')).toBeGreaterThan(finalGate.indexOf('### 4. Verify the frozen candidate'));
  expect(finalGate).toContain("**Check each test lane's receipt as well.**");
});

test('evidence exemptions cover only release metadata and receipts name their command', () => {
  expect(finalGate).toContain('--allow-paths CHANGELOG.md,VERSION,package.json,agents-digest/gstack-AGENTS.md');
  expect(finalGate).toMatch(/scripts, dependencies and runtime configuration require live tests/i);
  expect(finalGate).toMatch(/uncertain edits cannot be exempted/i);
  expect(finalGate).toContain('| FRESH (exit 0) |');
  expect(finalGate).toContain("--label <lane> --expect-cmd '<exact Step 5 command>'");
  expect(finalGate).toContain('~/.claude/skills/gstack/bin/gstack-wtree');
  expect(finalGate).toContain('git diff <reviewed-tree> <current-tree>');
  expect(finalGate).toContain('snapshot saved before Step 12');
  expect(finalGate).toMatch(/missing snapshots block this comparison, regardless of HEAD equality/i);
});

test('docs attempts count at launch and the collector checks ownership before accepting output', () => {
  expect(docs).toMatch(/increment before each launch or inline takeover, including failed launches/i);
  expect(docs).toMatch(/the request alone is insufficient/i);
  expect(docs).toMatch(/an exited child with missing output is stopped, but its audit is blocked/i);
  expect(docs).toMatch(/HEAD and index must be unchanged/i);
  expect(docs).toContain('`files_updated`');
  expect(docs).toMatch(/protected-file exclusions/i);
  expect(docs).toContain('`documentation_section`');
  expect(docs).toMatch(/a failed check or `blocked` result goes to recovery, even with valid JSON/i);
  expect(docs).toMatch(/only an actual user exception counts/i);
  expect(docs).toMatch(/reports and PRs retain blocked status/i);
  ordered(docsTemplate, ['**Subagent prompt:**', '**Parent processing:**']);
  const freshness = compact(entryTemplate.slice(entryTemplate.indexOf('### 3. Resolve documentation freshness'), entryTemplate.indexOf('### 4. Verify the frozen candidate')));
  expect(freshness).toContain("Step 14.5's saved values");
  const retry = freshness.slice(freshness.indexOf('**An attempt remains, with changed inputs or an available repair:**'), freshness.indexOf('**Otherwise:**'));
  expect(retry.length).toBeGreaterThan(0);
  expect(retry).not.toContain('Continue to stage 4');
  expect(retry).toMatch(/restart Step 16 stage 1/i);
  expect(freshness).toMatch(/covers the same approved scope and exact content/i);
  expect(entryTemplate.indexOf('## Step 14.5:')).toBeLessThan(entryTemplate.indexOf('## Step 17:'));
});

test('late verified outputs are committed before push, without tags or other writers after it', () => {
  const finish = compact(entryTemplate.slice(entryTemplate.indexOf('### 5. Report, then push'), entryTemplate.indexOf('## Step 17:')));
  ordered(finish, [/commit only approved, verified release changes/i, 'continue to Step 17']);
  expect(entry).toMatch(/do not create a Git tag/i);
  expect(entry).toContain('encode null/undetermined as -1');
  ordered(pushFlow, ['**Non-fast-forward push:**', '**Authentication, hook or network failure:**']);
  expect(pushFlow).toContain('`ALREADY_PUSHED`');
  expect(pushFlow).toMatch(/no documentation writer runs after push/i);
});

test('Step 18 resolves open PR state before preparing the exact title Step 19 scans', () => {
  const title = compact(entryTemplate.slice(entryTemplate.indexOf('## Step 18:'), entryTemplate.indexOf('{{SECTION:pr-body}}')));
  ordered(title, ['gh pr list --head <branch-name> --state open --json number,title,url', 'Prepare the title from that result']);
  expect(title).toContain('glab mr list --source-branch <branch-name> --output json');
  expect(title).toMatch(/a successful empty array means new/i);
  expect(title).toMatch(/lookup failure or ambiguous matches \*{0,2}stop\*{0,2} for resolution, never mean no PR/i);
  expect(title).toContain('`NEW_TITLE` for Step 19');
  expect(title).toContain('`v<NEW_VERSION> <type>: <summary>`');
  expect(title).toContain('`v$NEW_VERSION `');
  expect(title).toMatch(/never publish an unprefixed title/i);
  expect(prTemplate).toContain(': "${NEW_TITLE:?Restore the saved Step 18 title before scanning}"');
  expect(prTemplate).not.toContain('NEW_TITLE="<final vNEW_VERSION type: summary>"');
  expect(compact(prTemplate)).toContain('exit 3 blocks for HIGH');
  const generated = readTemplate('ship/sections/pr-body.md');
  expect(generated).toContain('**Existing open PR/MR:** update');
  expect(generated).toMatch(/do not run the create commands below/i);
  expect(generated).not.toContain('no PR exists yet');
});

test('linked spec discovery reads frontmatter as data and claims closure only for completed scope', () => {
  const instructions = compact(prTemplate.slice(0, prTemplate.indexOf('The PR/MR body should contain')));
  expect(instructions).toMatch(/read archive frontmatter as data, never shell source/i);
  expect(instructions).toMatch(/exact `spec_branch` match/i);
  expect(instructions).toContain('`spec_filed_at`');
  expect(instructions).toMatch(/positive integer `spec_issue_number`/i);
  expect(instructions).toContain('`## Linked Spec`');
  expect(instructions).toMatch(/continue composing the PR/i);
  expect(instructions).toMatch(/only fully completed Step 8 plan scope permits `Closes #N`/i);
  expect(instructions).toContain('`Linked to #N`');
  const body = prTemplate.slice(prTemplate.indexOf('The PR/MR body should contain'), prTemplate.indexOf('#### Redaction scan'));
  for (const stale of ['CURRENT_BRANCH=', 'SPEC_ARCHIVES=', 'SPEC_FILE=$(grep']) expect(body).not.toContain(stale);
  expect(prTemplate).not.toContain('[ -z "$SPEC_FILE" ] && exit');
});

test('comment triage separates absent PRs, empty fetches and unavailable evidence', () => {
  const section = compact(readTemplate('ship/sections/greptile.md.tmpl'));
  expect(section).toContain('"status":"complete|no_pr|unavailable"');
  expect(section).toMatch(/use `complete` only after a successful fetch, including zero comments/i);
  expect(section).toMatch(/`no_pr` only after confirming no PR exists/i);
  expect(section).toMatch(/`unavailable` for `gh`\/API errors or incomplete classification/i);
  expect(section).toContain('a nonnegative integer total matching the comments array');
  expect(section).toMatch(/an unknown or missing status is unavailable, never an empty successful review/i);
  expect(section).toContain('"Greptile: no PR exists"');
  expect(section).toContain('"Greptile: fetched, zero comments"');
  expect(section).toContain('`Greptile triage: UNAVAILABLE (dispatch failed)`');
  expect(section).toMatch(/stop a running child and confirm it stopped before continuing/i);
  expect(section).not.toContain('If no PR exists, `gh` fails, the API errors, or there are zero comments');
});

test('ship resolves threshold, branch and installed-asset references without competing instructions', () => {
  expect(entryTemplate).toContain('When Step 7 coverage meets its target');
  expect(entryTemplate).not.toContain('Test coverage gaps within target threshold');
  expect(entryTemplate.indexOf('Save the current branch as `<branch-name>`')).toBeGreaterThan(0);
  expect(entryTemplate.indexOf('Save the current branch as `<branch-name>`')).toBeLessThan(entryTemplate.indexOf('refs/heads/<branch-name>'));
  expect(entryTemplate).toContain('~/.claude/skills/gstack/review/TODOS-format.md');
  expect(entryTemplate).not.toContain('`.claude/skills/review/TODOS-format.md`');
  expect(entry).toContain('## Step 16: Verification Gate');
  const skeleton = readTemplate('ship/SKILL.md');
  const row = skeleton.split('\n').find(line => line.startsWith('| exploratory QA before Fix-First'))!;
  expect(row).toContain('`sections/review-army.md`');
  expect(row).not.toContain('below');
});
