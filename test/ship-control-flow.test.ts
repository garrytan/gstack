import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAdversarialStep } from '../scripts/resolvers/outside-voice-steps';
import { generatePlanCompletionGateShip } from '../scripts/resolvers/plan-gates';
import { generateReviewDashboard } from '../scripts/resolvers/review-dashboard';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { expectMentions } from './helpers/prompt-structure';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const compact = (text: string) => text.replace(/\s+/g, ' ');
const entry = read('ship/SKILL.md.tmpl');
const start = entry.indexOf('### Ship control flow');
const end = entry.indexOf('{{SECTION_INDEX:ship}}');
const controller = entry.slice(start, end);
const review = compact(read('ship/sections/review-army.md.tmpl'));
const adversarial = compact(generateAdversarialStep({ host: 'claude', skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude }));
const gate = compact(entry.slice(entry.indexOf('## Step 16:'), entry.indexOf('## Step 17:')));

describe('ship source controller', () => {
  test('documentation freshness covers selected code paths as well as release metadata', () => {
    const docs = compact(read('ship/sections/documentation.md.tmpl'));
    // Meaning: the snapshot hashes selected release (code) paths, not only release metadata.
    expect(docs).toContain('hashes of release paths, generated outputs and docs');
    expect(docs).toContain('`--select <path>` narrows release paths');
    const freshness = gate.slice(gate.indexOf('### 3.'), gate.indexOf('### 4.'));
    expectMentions(freshness, [['never', 'qualifies', 'decision']], 'freshness');
  });

  test('changed documentation inputs permit only the remaining bounded re-audit', () => {
    const docs = compact(read('ship/sections/documentation.md.tmpl'));
    expect(docs.indexOf('## Blocked recovery')).toBeGreaterThan(-1);
    expect(docs).toMatch(/never a third attempt/i);
    const freshness = gate.slice(gate.indexOf('### 3.'), gate.indexOf('### 4.'));
    expect(freshness).toContain('**An attempt remains, with changed inputs or an available repair:**');
    expect(freshness).toMatch(/\*\*Otherwise:\*\* stop unless the user accepts/i);
    expect(freshness).not.toContain('**No attempt remains or no repair is available:**');
  });

  test('repairs use one ordered work list without a return stack', () => {
    const text = compact(controller);
    expect(compact(entry)).toContain('**Next steps:**');
    expect(text).toContain('5 → 6 → 7 → 8 → 9 → 10 → 11 → 11.5');
    expect(text).toMatch(/initial-plus-one limit never resets/i);
  });

  test('the roadmap and recovery groups define ownership and zero-edit eligibility', () => {
    const text = compact(entry);
    expect(text).toContain('integrate (1–3) → test and review (4–11.5) → prepare the release (12–15) → verify frozen content (16) → push and publish (17–21)');
    expectMentions(text, [['not', 'permission', 'children']], 'text');
    expect(review).toContain('**No edits in this pass:**');
    expectMentions(review, [['only', 'continue', 'clears']], 'review');
    expectMentions(review, [['block', 'failed/unavailable', 'continuation']], 'review');
    expectMentions(review, [['cannot', 'test/security', 'independent']], 'review');
    expectMentions(text, [['never', 'approvals', 'expands']], 'text');
    expect(text).not.toContain('eligible zero-edit pass');
    expect(text).not.toContain('the same waiver');
    expect(text).not.toContain("the controller's detour");
  });

  test('distribution discovery is a shortlist, not a manifest-only artifact decision', () => {
    const distribution = compact(entry.slice(entry.indexOf('## Step 2:'), entry.indexOf('## Step 3:')));
    expect(distribution).toContain('**New artifact without a pipeline');
    expect(distribution).toContain('AskUserQuestion');
    expect(distribution).toMatch(/do not publish a release during `\/ship`/i);
  });

  test('queue qualification exhaustively distinguishes online, git fallback and unusable output', () => {
    const version = compact(entry.slice(entry.indexOf('## Step 12:'), entry.indexOf('{{SECTION:changelog}}')));
    const qualify = version.indexOf('**Qualify first:**');
    const usable = version.indexOf('**Usable candidate:**');
    const missing = version.indexOf('**No usable candidate:**');
    expect(qualify).toBeGreaterThan(0);
    expect(usable).toBeGreaterThan(qualify);
    expect(missing).toBeGreaterThan(usable);
    expect(version).toContain('`NEW_VERSION=CANDIDATE_VERSION`');
    expectMentions(version, [['only', 'approval', 'existing']], 'version');
    expect(version).toContain('`>= NEW_VERSION`');
    expect(version.slice(missing)).toContain('`BUMP_LEVEL`');
    expect(version.slice(missing)).toContain('`currentVersion`');
  });

  test.each(['home', 'override', 'plugin'])('the actual nudge shell honors %s roots, repeat suppression and enabled tuning', mode => {
    const root = mkdtempSync(join(tmpdir(), 'gstack-ship-nudge-'));
    try {
      const home = join(root, 'home');
      const state = mode === 'home' ? join(home, '.gstack') : join(root, 'state root');
      mkdirSync(home, { recursive: true });
      const nudge = entry.slice(entry.indexOf('## Step 21:'), entry.indexOf('## Section self-check'));
      const block = nudge.match(/```bash\n([\s\S]*?)\n```/);
      expect(block).not.toBeNull();
      const script = block![1].replaceAll('~/.claude/skills/gstack', JSON.stringify(resolve(import.meta.dir, '..')));
      const run = () => spawnSync('bash', ['-c', script], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: join(root, 'tmp'),
          ...(mode === 'override' ? { GSTACK_HOME: state } : {}),
          ...(mode === 'plugin' ? { CLAUDE_PLUGIN_ROOT: join(root, 'gstack'), CLAUDE_PLUGIN_DATA: state } : {}),
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const marker = join(state, '.plan-tune-nudge-shown');
      const first = run();
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('Run /plan-tune to opt in');
      expect(existsSync(marker)).toBe(true);
      if (mode !== 'home') expect(existsSync(join(home, '.gstack', '.plan-tune-nudge-shown'))).toBe(false);
      const repeated = run();
      expect(repeated.status).toBe(0);
      expect(repeated.stdout).toBe('');
      rmSync(marker);
      writeFileSync(join(state, 'config.yaml'), 'question_tuning: true\n');
      const enabled = run();
      expect(enabled.status).toBe(0);
      expect(enabled.stdout).toBe('');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('nested repairs resume the unfinished outer range before its destination', () => {
    const text = compact(controller);
    expect(text).toContain('`9 → 10 → 11` before 11.5');
    expect(text).toContain('`5 → 6 → 7 → 8 → 9 → 10 → 11 → 11.5`');
    expect(text).not.toContain('Enter Step 9 before REVIEW_START capture and full review');
  });

  test('shared foreground dispatch stays mandatory at all three owned dispatch sites', () => {
    const coverage = read('ship/sections/test-coverage.md.tmpl');
    const shared = coverage.indexOf('### Shared subagent dispatch');
    expect(shared).toBeGreaterThan(0);
    expect(shared).toBeLessThan(coverage.indexOf('Dispatch the audit through Agent'));
    const contract = compact(coverage.slice(shared, coverage.indexOf('Dispatch the audit through Agent')));
    expect(contract).toContain('use the Agent tool with `run_in_background: false`');
    expectMentions(contract, [['do not', 'instead', 'invoke']], 'contract');
    for (const section of ['test-coverage', 'plan-completion', 'greptile']) {
      const text = read(`ship/sections/${section}.md.tmpl`);
      expect(text).toContain('shared foreground-dispatch rule');
      expect(text).toContain('run_in_background: false');
      expect(text).not.toContain('{{FOREGROUND_DISPATCH_NOTE}}');
    }
    expect(entry).not.toContain('### Shared subagent dispatch');
    for (const section of ['plan-completion', 'greptile']) {
      expect(read(`ship/sections/${section}.md.tmpl`)).toContain("Step 7's shared foreground-dispatch rule");
    }
  });

  test('ship dashboard displays actual historical records without a repeated sample panel', () => {
    const ctx = { host: 'claude' as const, skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude };
    const ship = generateReviewDashboard(ctx);
    expect(ship).toContain('REVIEW READINESS DASHBOARD');
    expect(ship).toContain('| Review | Runs | Last run | Status | Required |');
    expectMentions(ship, [['only', 'required', 'review']], 'ship');
    expect(ship).toContain('{actual status and reason}');
    expect(ship).toContain('VERDICT: {CLEARED or NOT CLEARED} — {reason}');
    expect(ship).not.toContain('+====================================================================+');
    const review = generateReviewDashboard({ ...ctx, skillName: 'review' });
    expect(review).toContain('+====================================================================+');
  });

  test('coverage fallback settles the child and still applies the coverage gate', () => {
    const text = compact(read('ship/sections/test-coverage.md.tmpl'));
    const fallback = text.slice(text.indexOf('**Audit failure:**'), text.indexOf('{{TEST_COVERAGE_GATE_SHIP}}'));
    expectMentions(fallback, [['confirm', 'stopped', 'running']], 'fallback');
    expectMentions(fallback, [['does not', 'coverage', 'bypass']], 'fallback');
    expect(text).not.toContain('partial results are better than none');
  });

  test('no-plan gate skips only the audit and retains verification and the remaining section', () => {
    const text = generatePlanCompletionGateShip({ host: 'claude', skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude });
    const noPlan = compact(text.slice(text.indexOf('**No plan file found:**')));
    expectMentions(noPlan, [['only', 'completion', 'audit']], 'noPlan');
    expect(noPlan).toContain('Step 8.1');
    expect(noPlan).toMatch(/Step 9 QA still runs/i);
    expect(noPlan).not.toContain('Skip entirely');
  });

  test('binding separates record selection, three snapshots and probe outcomes', () => {
    const text = compact(entry.slice(entry.indexOf('## Step 11.5:'), entry.indexOf('## Step 12:')));
    const steps = ['1. **Select', '2. **Compare', '3. **Preserve', '4. **Save'];
    const positions = steps.map(step => text.indexOf(step));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a,b) => a-b));
    expectMentions(text, [['must', 'snapshots', 'three']], 'text');
    expectMentions(text, [['does not', 'failed', 'probes']], 'text');
  });

  test('late classification and docs freshness are ordered decisions, not metadata assumptions', () => {
    const text = compact(entry.slice(entry.indexOf('## Step 16:'), entry.indexOf('## Step 17:')));
    expect(text).toContain('**Behavior, tests or build inputs changed:**');
    expect(text).toContain('**Only authored docs or release metadata changed:**');
    expect(text).toContain('**No changes, or the docs-only checks still support the plan:**');
    expect(text).toContain('| Continue to stage 4');
    expect(text).not.toContain('Every listed change below is metadata:');
  });

  test('one early controller owns detours without replacing local gates', () => {
    expect(start).toBeGreaterThan(entry.indexOf('# Ship:'));
    expect(start).toBeLessThan(end);
    expect(end).toBeLessThan(entry.indexOf('{{BASE_BRANCH_DETECT}}'));
    expect(entry.match(/### Ship control flow/g)).toHaveLength(1);
    const text = compact(controller);
    expect(text).toMatch(/the \*\*parent\*\* running \/ship, own advancement/i);
    expectMentions(text, [['stop', 'askuserquestion', 'repairs']], 'text');
    expectMentions(text, [['never', 'unlisted', 'range']], 'text');
    expectMentions(text, [['does not', 'ending', 'range']], 'text');
    expect(text).not.toContain('| At step |');
    expect(entry.match(/Ship control flow/g)).toHaveLength(1);
    expect(review).toMatch(/captures a fresh REVIEW_START/);
  });

  test('distribution and bootstrap detours end at their exact forward resume', () => {
    const merge = compact(entry.slice(entry.indexOf('## Step 3:'), entry.indexOf('{{SECTION:tests}}')));
    const tests = compact(read('ship/sections/tests.md.tmpl'));
    expect(tests).toContain('A) Add tests (recommended)');
    expectMentions(tests, [['not', 'declining', 'bootstrap']], 'tests');
  });

  test('missing dispatched output outranks the cycle cap, fixes and zero-edit continuation', () => {
    const decisions = review.slice(review.indexOf('### Decide whether to repeat Step 9'));
    const names = ['1. **Dispatched reviewer output missing:**', '2. **Third fixing cycle reached (`CYCLES >= 3`):**', '3. **Fixes applied below the cap:**', '4. **No edits in this pass:**'];
    const positions = names.map(name => decisions.indexOf(name));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const missing = decisions.slice(positions[0], positions[1]);
    expect(missing).toMatch(/^1\. \*\*Dispatched reviewer output missing:\*\* stop\b/i);
    expectMentions(missing, [['cannot', 'dispatched', 'coverage']], 'missing');
    const cap = decisions.slice(positions[1], positions[2]);
    expect(cap).toMatch(/\bstop\b/i);
    expect(cap).toContain('`converged:false`');
    expectMentions(cap, [['do not', 'fourth', 'fixing']], 'cap');
    const fixes = decisions.slice(positions[2], positions[3]);
    expectMentions(fixes, [['before', 'affected', 'pending']], 'fixes');
    expectMentions(fixes, [['approval', 'pre-existing', 'verified']], 'fixes');
    expectMentions(decisions.slice(positions[3]), [['only', 'continue', 'clears']], 'decisions.slice(positions[3])');
    expectMentions(review, [['never', 'inconclusive', 'required']], 'review');
  });

  test('comment fixes resume triage and preserve settled approvals and replies', () => {
    const section = compact(read('ship/sections/greptile.md.tmpl'));
    expectMentions(review, [['before', 'complete', 'applying']], 'review');
    expectMentions(section, [['no', 'continue', 'queued']], 'section');
    expectMentions(section, [['does not', 'optional', 'triage']], 'section');
    expect(section).not.toContain('return to Step 9');
  });

  test('native recovery has one corrected attempt and cannot borrow outside completion', () => {
    const finish = adversarial.slice(adversarial.indexOf('### Finish the adversarial phase'));
    const recovery = finish.slice(finish.indexOf('1. **Required native'), finish.indexOf('2. **Fixes queued'));
    expectMentions(recovery, [['stop', 'confirm', 'stopped']], 'recovery');
    expectMentions(recovery, [['cannot', 'outside-provider', 'replace']], 'recovery');
    expectMentions(recovery, [['only', 'prerequisite', 'correction']], 'recovery');
    expect(recovery).toContain('PASS_START');
    expectMentions(recovery, [['ask', 'blocked', 'repair']], 'recovery');
    const queued = finish.slice(finish.indexOf('2. **Fixes queued'), finish.indexOf('3. **Native complete'));
    expectMentions(queued, [['before', 'pending', 'insert']], 'queued');
    expect(queued).toMatch(/not recovery retries/i);
    expect(finish.slice(finish.indexOf('3. **Native complete'))).toContain('then continue to Step 11.5');
  });

  test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s cannot skip Step 11.5 or change standalone review control flow', host => {
    const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
    const ship = generateAdversarialStep(ctx);
    const finish = compact(ship.slice(ship.indexOf('### Finish the adversarial phase')));
    const branches = ['Required native review incomplete', 'Fixes queued after native completion', 'Native complete with no queued fixes']
      .map(label => finish.indexOf(label));
    expect(branches.every(index => index >= 0)).toBe(true);
    expect(branches).toEqual([...branches].sort((a, b) => a - b));
    expectMentions(finish, [['cannot', 'outside-provider', 'replace']], 'finish');
    expect(finish).toContain('Step 11.5');
    expect(finish).not.toContain('proceed to Step 12');
    expect(finish).not.toContain('return to Step 9');
    const review = generateAdversarialStep({ ...ctx, skillName: 'review' });
    expect(review).not.toContain('Ship control flow');
    expect(review).not.toContain('Step 11.5');
    expectMentions(review, [['do not', 'repair', 'start']], 'review');
  });

  test('Step 11.5 verifies original record identity before any release write', () => {
    const bindingStart = entry.indexOf('## Step 11.5:');
    expect(bindingStart).toBeGreaterThan(entry.indexOf('{{SECTION:adversarial}}'));
    expect(bindingStart).toBeLessThan(entry.indexOf('## Step 12:'));
    const binding = compact(entry.slice(bindingStart, entry.indexOf('## Step 12:')));
    for (const field of ['skill:"review"', 'via:"ship"', 'skill:"adversarial-review"',
      'review_binding.state', 'verified', 'review_binding.start_wtree', 'review_binding.end_wtree']) expect(binding).toContain(field);
    expectMentions(binding, [['never', 'attach', 'tokens']], 'binding');
    expectMentions(binding, [['does not', 'failed', 'probes']], 'binding');
    expect(binding).toContain('`9 → 10 → 11 → 11.5` before Step 12');
  });

  test('late build and behavior changes complete bounded ranges before docs', () => {
    const build = gate.slice(gate.indexOf('### 1.'), gate.indexOf('### 2.'));
    expect(build).toMatch(/repeat stage 1/i);
    expect(build).toMatch(/continue to stage 2/i);
    const behavior = gate.slice(gate.indexOf('1. **Behavior'), gate.indexOf('2. **Only authored'));
    expect(behavior).toContain('Insert `5–11.5 → 12–14 → 16` before the pending Step 17');
    expect(behavior).toMatch(/excludes Step 14\.5/i);
    expectMentions(behavior, [['before', 'rebuild', 'compare']], 'behavior');
    const plan = gate.slice(gate.indexOf('2. **Only authored'), gate.indexOf('3. **No changes'));
    expectMentions(plan, [['only', 'decision', 'return']], 'plan');
    expectMentions(plan, [['never', 'yourself', 'counts']], 'plan');
  });

  test('docs freshness has bounded re-audit and exact-content exception routes', () => {
    const docs = gate.slice(gate.indexOf('### 3.'), gate.indexOf('### 4.'));
    expect(docs).toContain('**An attempt remains, with changed inputs or an available repair:** insert `14.5 → 15 → 16` before Step 17');
    expectMentions(docs, [['stop', 'documentation', 'unwaivable']], 'docs');
    expect(docs).toMatch(/never run a third audit/i);
    expect(docs).toContain('`Documentation: blocked`');
    expect(docs).toMatch(/never silently refresh hashes/i);
  });

  test('tests, absent test approval and new writes reopen final verification', () => {
    const tests = gate.slice(gate.indexOf('### 4.'), gate.indexOf('### 5.'));
    expect(tests).toMatch(/\*\*New, changed or unwaived test failure:\*\* stop publication\. Run Steps 5–15/i);
    expectMentions(tests, [['no', 'including', 'no-tests']], 'tests');
    expectMentions(tests, [['does not', 'authorize', 'attempt']], 'tests');
    expectMentions(gate, [['before', 'complete', 'restart']], 'gate');
  });

  test('push failure kinds and publication races have distinct resumes', () => {
    const push = compact(entry.slice(entry.indexOf('## Step 17:'), entry.indexOf('## Step 18:')));
    expectMentions(push, [['no', 'publication', 'fails']], 'push');
    expectMentions(push, [['before', 'returning', 'steps']], 'push');
    expect(push).toMatch(/never rewrite history/i);
    expect(push).toMatch(/never bypass failed guards/i);
    const publication = compact(read('ship/sections/pr-body.md.tmpl'));
    expect(publication).toMatch(/repeat Step 18's identity\/title preparation/i);
    expectMentions(publication, [['before', 'publishing', 'redaction']], 'publication');
  });
});
