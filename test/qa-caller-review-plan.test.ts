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

describe('ship Step 9 review plan through the qa-callers transport', () => {
  for (const [run, trial] of Object.entries(captured.runs) as [string, { root: string; commands: { command: string }[] }][]) {
    test(`captured ${run}: every Bash call the actor made is inside the declared interface`, () => {
      const fixture = fixtureFor('ship-exploratory-plan-checks', true);
      const commands = trial.commands.map(({ command }) => command.replaceAll(trial.root, fixture.root));
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

/**
 * 2026-10-29 flaky pass (GSTA-162). Nine paid ship qa-callers reds after #3553 had two causes:
 * - Six trials (late-input, plan-checks, small-cli): the parent paraphrased its specialist prompt ("run
 *   \`git diff origin/main\` in <dir>"; checklist paths as braces or "(same directory)"), and the child ran the one
 *   call refused in each trial: \`git -C <dir> diff\` or a cd into the checklist directory.
 * - Three late-input trials: error_max_turns at 25 of 25 parent turns. Each ran Step 9's gate scan only after
 *   writing the receipt, or never reached it; the passing reruns batched it with the review plan and used 18 to 21.
 */
describe('ship qa-callers child handoff and Step 9 scheduling (2026-10-29 captures)', () => {
  const captures = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/qa-caller-child-handoff-2026-10-29.json'), 'utf8'));

  for (const [run, trial] of Object.entries(captures.childHandoff) as [string, { childPrompt: string; childCommands: string[] }][]) {
    test(`captured ${run}: the child's paraphrased-boundary call stays refused, and the parent is told how to hand boundaries down`, () => {
      const caseId = run.split(' ').pop() as QaCallerCase;
      const fixture = fixtureFor(caseId);
      const base = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf8', timeout: 5000 }).stdout.trim();
      const commands = trial.childCommands.map(command => command.replaceAll('<root>', fixture.root).replace(/\b[0-9a-f]{40}\b/g, base));
      const refused = commands.filter(command => !qaCallerCommandAllowed(command, fixture.workflowCommands, context(fixture)));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatch(/^git -C |^cd /);
      expect(qaCallerCommandAllowed('git diff origin/main', fixture.workflowCommands, context(fixture))).toBe(true);
      const prompt = qaCallerSessionOptions(fixture, 'free-child-handoff').prompt;
      expect(prompt).toContain('Pass these same command and write boundaries to any child, which starts in this product directory');
      expect(prompt).toContain('no \`in <dir>\` paraphrase, cd or git -C');
      expect(prompt).toContain('each file it should Read as its own literal path (Read takes no braces or globs)');
    });
  }

  test('captured max-turns reds: the gate scan they ran late is an admitted block, and the ship contract schedules it with diff discovery', () => {
    const { maxTurns, failures, gateScanCommand, passingReruns } = captures.turnBudget;
    for (const [run, trial] of Object.entries(failures) as [string, { parentTurns: number; receiptWriteTurn: number; gateScanTurn: number | null }][]) {
      expect(trial.parentTurns, run).toBe(maxTurns);
      if (trial.gateScanTurn !== null) expect(trial.gateScanTurn, run).toBeGreaterThan(trial.receiptWriteTurn);
    }
    for (const turns of Object.values(passingReruns) as number[]) expect(turns).toBeLessThan(maxTurns - 2);
    const discovery = (caseId: QaCallerCase) => {
      const contract = qaCallerSessionOptions(fixtureFor(caseId), 'free-turns').appendSystemPrompt!;
      return contract.match(/Read-only discovery is ([^.;]*);/)?.[1] ?? '';
    };
    const ship = fixtureFor('ship-exploratory-late-input', true);
    expect(qaCallerCommandAllowed(gateScanCommand.replaceAll('<root>', ship.root), ship.workflowCommands, context(ship))).toBe(true);
    expect(qaCallerSessionOptions(ship, 'free-turns').maxTurns).toBe(maxTurns);
    for (const caseId of SHIP_CASES) expect(discovery(caseId)).toContain("Step 9's review-plan command and gate-scan block, which belong with the first diff discovery");
    expect(discovery('review-exploratory-small-cli')).not.toContain('gate-scan');
  });
});
