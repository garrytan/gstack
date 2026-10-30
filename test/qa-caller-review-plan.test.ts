/**
 * #3527 put Step 9's review plan into ship/sections/review-army.md as prose, so the qa-callers transport
 * neither admitted the helper nor said where the plan's Step 11 voices run.
 * - Paid screen 40707142223 (ship-exploratory-plan-checks, slice 10 and its rerun): the only refused call in
 *   both trials was `<runtime>/bin/gstack-review-plan --base main`.
 * - Train 35 rebuild gate 40664336141 (ship-exploratory-late-input, slice 9): the actor never ran the plan,
 *   read Step 11's native adversarial pass as owed by this Steps 8-9 excerpt, and reported pass with it remaining.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunIsolationArgs } from '../lib/bun-isolation';
import {
  createQaCallerFixture, qaCallerCommandAllowed, qaCallerSessionOptions, validateCallerEvidence,
  type QaCallerCase, type QaCallerFixture,
} from './helpers/qa-callers-fixture';

const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/qa-caller-review-plan-40707142223.json'), 'utf8'));
const specialistDiff = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/qa-caller-merge-base-diff-40737741454.json'), 'utf8'));
const SHIP_CASES: QaCallerCase[] = ['ship-exploratory-small-cli', 'ship-exploratory-unavailable', 'ship-exploratory-plan-checks', 'ship-exploratory-late-input'];
const fixtures: QaCallerFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
const fixtureFor = (caseId: QaCallerCase, installRuntime = false) => {
  const fixture = createQaCallerFixture(caseId, { installRuntime });
  fixtures.push(fixture);
  return fixture;
};
const context = (fixture: QaCallerFixture) => ({ runtime: fixture.runtime, fixtureRoot: fixture.cwd });
/** The gate scan block as run 40707142223 rendered it; GSTA-167 PR 3b's block prints only the summary and hunk index on success. */
const CAPTURED_GATE_SUCCESS = `then\n  printf '%s\\n' "$GATE_OUT"\nelse`;
const CURRENT_GATE_SUCCESS = `then\n  printf '%s\\n' "$GATE_OUT" | sed -n '/^GATE_SUMMARY: /p; /^\\[/p; /: unsupported/p'\nelse`;
const currentGateBlock = (command: string) => command.includes('GATE_OUT=$(') ? command.replace(CAPTURED_GATE_SUCCESS, CURRENT_GATE_SUCCESS) : command;

describe('ship Step 9 review plan through the qa-callers transport', () => {
  for (const [run, trial] of Object.entries(captured.runs) as [string, { root: string; commands: { command: string }[] }][]) {
    test(`captured ${run}: every Bash call the actor made is inside the declared interface`, () => {
      const fixture = fixtureFor('ship-exploratory-plan-checks', true);
      const commands = trial.commands.map(({ command }) => currentGateBlock(command.replaceAll(trial.root, fixture.root)));
      const gate = commands.filter(command => command.includes('GATE_OUT=$('));
      expect(gate).toHaveLength(1);
      expect(fixture.workflowCommands).toContain(gate[0]!);
      expect(commands.filter(command => command.includes('/bin/gstack-review-plan '))).toEqual([`${fixture.runtime}/bin/gstack-review-plan --base main`]);
      expect(commands.filter(command => !qaCallerCommandAllowed(command, fixture.workflowCommands, context(fixture)))).toEqual([]);
    });
  }

  test('the helper forms Step 9 names are admitted at the exact installed path, and nothing else is', () => {
    const fixture = fixtureFor('ship-exploratory-late-input');
    const helper = `${fixture.runtime}/bin/gstack-review-plan`;
    const allowed = (command: string) => qaCallerCommandAllowed(command, fixture.workflowCommands, context(fixture));
    for (const args of ['--base main', '--base main --pass 1 --last full', '--base main --pass 2 --last fix-check --fixed-below --adversarial-ran',
      '--base main --pass 1 --last full --blocking-open --touched-gate --critical-found --reviewed-numbers fp:0a1b',
      '--fix-check-prompt --fix-list reports/fix-list.md --hunks reports/hunks.diff --tests reports/tests.txt',
      "--fix-check-prompt --fix-list 'reports/fix list.md' --hunks reports/h.diff --tests reports/t.txt --callers reports/c.txt"]) {
      expect(allowed(`${helper} ${args}`), args).toBe(true);
    }
    for (const command of [`${helper} --base origin/main`, `${helper} --base main --json`, `${helper} --base main --force all`,
      `${helper} --base main --last full --pass 1`, helper, `${helper} --base main | tee reports/plan.txt`, `${helper} --base main; rm -rf reports`,
      `${helper} --base main && git reset --hard`, `${helper} --base "$(git rev-parse HEAD)"`, `${helper} --fix-check-prompt --fix-list $HOME/x --hunks a --tests b`,
      `bun ${helper} --base main`, `${helper}x --base main`, `${fixture.runtime}/bin/gstack-review-planner --base main`,
      '/tmp/elsewhere/bin/gstack-review-plan --base main', '~/.claude/skills/gstack/bin/gstack-review-plan --base main']) {
      expect(allowed(command), command).toBe(false);
    }
    expect(qaCallerCommandAllowed(`${helper} --base main`, fixture.workflowCommands)).toBe(false);
  });

  test.each(SHIP_CASES)('%s: every reviewer the real plan dispatches has a declared route in the transport', caseId => {
    const fixture = fixtureFor(caseId, true);
    const options = qaCallerSessionOptions(fixture, 'free-review-plan');
    expect(qaCallerCommandAllowed(`${fixture.runtime}/bin/gstack-review-plan --base main`, fixture.workflowCommands, context(fixture))).toBe(true);
    const plan = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(fixture.runtime, 'bin/gstack-review-plan'), '--base', 'main'],
      { cwd: fixture.cwd, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 60_000 });
    expect(plan.status, plan.stderr).toBe(0);
    const roles = [...plan.stdout.matchAll(/^DISPATCH: (\S+)/gm)].map(match => match[1]);
    expect(roles).toContain('adversarial-native');
    const prompt = options.prompt.toLowerCase();
    for (const role of roles) expect(prompt.includes(role) || prompt.includes(role.replace('-', ' ')), role).toBe(true);
    expect(options.prompt).toContain("The plan's adversarial-native and outside-voice lines are Step 11's voices, which Step 11 runs in a later stage outside this excerpt; they are not remaining work of this phase.");
  });

  test('review keeps its own Step 4.8 transport and is not told about ship Step 11', () => {
    const prompt = qaCallerSessionOptions(fixtureFor('review-exploratory-small-cli'), 'free-review-plan').prompt;
    expect(prompt).toContain('the native adversarial reviewer (Step 4.8)');
    expect(prompt).not.toContain('gstack-review-plan');
    expect(prompt).not.toContain("Step 11's voices");
  });

  test('captured 40664336141 late-input receipt: pass with remaining work is still a false green', () => {
    const receipt = captured.lateInputReceipt;
    expect(receipt.remaining).toContain('Step 11 native adversarial review (not dispatched)');
    const reportRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qc-late-'));
    const validate = (remaining: string[]) => validateCallerEvidence({ caller: 'ship', result: { exitReason: 'success', transcript: [] }, probes: [],
      receipt: { status: receipt.status, probes: [], remaining }, currentSnapshot: 'none', requiredCharters: [], mutations: [], observerComplete: true,
      reportRoot, checkpointFiles: {}, reportMarkdown: '' });
    try {
      expect(validate(receipt.remaining)).toContain('blocked, failing or incomplete coverage reported green');
      expect(validate([])).not.toContain('blocked, failing or incomplete coverage reported green');
    } finally { fs.rmSync(reportRoot, { recursive: true, force: true }); }
  });
});

/**
 * Paid screen 40737741454 (ship-exploratory-unavailable, slice 11 and its rerun): the plan dispatched the
 * state-machines specialist, review-army tells the parent to write the merge-base sha into the specialist's
 * diff command, and the only refused call in both trials was that child's `git diff <merge-base sha>`.
 */
describe('review-army specialist diff at the literal merge base', () => {
  const mergeBase = (fixture: QaCallerFixture) => spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 }).stdout.trim();

  for (const [run, trial] of Object.entries(specialistDiff.runs) as [string, { root: string; mergeBase: string; commands: { command: string }[] }][]) {
    test(`captured ${run}: every Bash call, the specialist child's included, is inside the declared interface`, () => {
      const fixture = fixtureFor('ship-exploratory-unavailable', true);
      const base = mergeBase(fixture).slice(0, trial.mergeBase.length);
      const commands = trial.commands.map(({ command }) => command.replaceAll(trial.root, fixture.root).replaceAll(trial.mergeBase, base));
      expect(commands).toContain(`git diff ${base}`);
      expect(commands.filter(command => !qaCallerCommandAllowed(command, fixture.workflowCommands, context(fixture)))).toEqual([]);
    });
  }

  test('only the fixture merge base is admitted, bare or in the specialist DIFF_BASE form, and the prompt declares it', () => {
    const fixture = fixtureFor('ship-exploratory-unavailable');
    const base = mergeBase(fixture);
    const allowed = (command: string) => qaCallerCommandAllowed(command, fixture.workflowCommands, context(fixture));
    for (const command of [`git diff ${base}`, `git diff ${base.slice(0, 7)}`, `git diff --stat ${base.slice(0, 12)}`, `git diff ${base} -- scale.ts`,
      `DIFF_BASE=${base} && git diff "$DIFF_BASE"`, `DIFF_BASE=${base.slice(0, 9)} && git diff --name-status "$DIFF_BASE"`]) {
      expect(allowed(command), command).toBe(true);
    }
    const other = base.replace(/^./, base[0] === '0' ? '1' : '0');
    for (const command of [`git diff ${other}`, `git diff ${base.slice(0, 6)}`, `git diff ${base} --output=reports/x`, `git diff --stat ${base} --numstat`,
      `DIFF_BASE=${other} && git diff "$DIFF_BASE"`, `DIFF_BASE=${base} && git diff ${base}`, `DIFF_BASE=${base}; git diff "$DIFF_BASE"`,
      `git diff "$DIFF_BASE"`, `DIFF_BASE=${base} && git diff "$DIFF_BASE" && git status --short`, `git diff ${base.toUpperCase()}`]) {
      expect(allowed(command), command).toBe(false);
    }
    expect(qaCallerCommandAllowed(`git diff ${base}`, fixture.workflowCommands)).toBe(false);
    for (const caseId of ['ship-exploratory-unavailable', 'review-exploratory-small-cli'] as QaCallerCase[]) {
      expect(qaCallerSessionOptions(fixtureFor(caseId), 'free-review-plan').prompt).toContain(
        'The merge base itself, the sha git merge-base origin/main HEAD prints (at least 7 characters), may replace origin/main as a literal diff base');
    }
  });
});
