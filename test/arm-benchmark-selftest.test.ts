/**
 * Arm-benchmark selftest — FREE (no API key, no model, no spend), runs in
 * `bun run test` on every PR. Pins fixture integrity (planted traps still
 * open, decoy credentials obviously fake), skill extraction, arm-install
 * asymmetry, diff-capture round trips, judge prompt construction/injection
 * framing, parse plumbing, and the bounded retry — so the paid periodic
 * benchmark never burns money on a broken instrument.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import {
  TASKS, FIXTURES, SKILL_NAME,
  buildBehavioralSkill, run, setupArm, parseDiffStat, captureStagedDiff, runChecks,
  ARMS, ARM_IDENTITY, ARM_MODEL, ARM_TRIALS, ARM_TIMEOUT_MS, ARM_JUDGE_MS, ARM_SETUP_MS, ARM_PAIR_MS, ARM_TASK_SLACK_MS,
  TASK_TEST_TIMEOUT_MS, ARM_SPEND_CAP_USD, ARM_CELL_RESERVE_USD, ARM_JUDGE_RESERVE_USD,
  armRunOptions, armCellInfra, metered, renderArmResults, ArmBudgetStop,
  type ArmCellRecord, type ArmPairRecord,
} from './helpers/arm-benchmark-harness';
import {
  armJudge, buildArmJudgePrompt, parseArmJudgeResponse,
  callJudge, ARM_JUDGE_MODEL, ARM_JUDGE_SCHEMA, type CallJudgeOptions,
} from './helpers/llm-judge';
import {
  ARM_PAIR_RUBRIC, ARM_PAIR_CALIBRATION, ARM_PAIR_JUDGE_MODEL, EMPTY_DIFF_TEXT,
  armPairJudge, buildArmPairPrompt, meteredJudgeCall, pairCalibrationBar, pairJudgeDecides,
} from './helpers/arm-pair-judge';
import { loadCorpus, loadCalibrationConfigs, type SampleRecord } from '../scripts/judge-calibration';
import { armIdentities, armModel, checkPrereg } from '../lib/eval-plan';
import { checkResults } from '../lib/eval-plan-report';
import { readLedger, summarize as spendSummary } from '../lib/spend-ledger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expectMentions } from './helpers/prompt-structure';

describe('arm benchmark selftest (free, no API)', () => {
  test('fixtures exist with their planted content; decoy credentials are obviously fake', () => {
    for (const task of TASKS) {
      expect(fs.existsSync(path.join(FIXTURES, task.fixture))).toBe(true);
    }
    // Task 1: the form exists and has NO date input yet (the trap is open).
    const html = fs.readFileSync(path.join(FIXTURES, 'native-overbuild', 'index.html'), 'utf-8');
    expect(html).toContain('booking-form');
    expect(html).not.toContain('type="date"');
    // Task 2: GET/POST exist, DELETE does not.
    const app = fs.readFileSync(path.join(FIXTURES, 'crud-endpoint', 'app.js'), 'utf-8');
    expect(app).toContain("'GET'");
    expect(app).toContain("'POST'");
    expect(app).not.toContain('DELETE');
    // Task 3: planted bug is live and the decoy credential can't trip a
    // live-format scanner.
    const price = fs.readFileSync(path.join(FIXTURES, 'bugfix-decoys', 'src', 'format-price.js'), 'utf-8');
    expect(price).toContain("'$' + dollars + '.' + rem");
    const config = fs.readFileSync(path.join(FIXTURES, 'bugfix-decoys', 'src', 'config.js'), 'utf-8');
    expect(config).toContain('not-a-real-credential');
    expect(config).not.toMatch(/sk-[a-zA-Z0-9]{16,}/);
    // Decoy over-build invitations are planted.
    const readme = fs.readFileSync(path.join(FIXTURES, 'bugfix-decoys', 'README.md'), 'utf-8');
    expect(readme).toContain('plugin architecture');
  });

  test('behavioral skill is an extraction (ladder + bounded closer), not a whole-file copy', () => {
    const skill = buildBehavioralSkill();
    expect(skill).toContain(`name: ${SKILL_NAME}`);
    expect(skill).toContain('## Search Before Building');
    expect(skill).toContain('first rung that holds');
    expect(skill).toContain('## Voice');
    expect(skill).toContain('**Bounded closer.**');
    // Telemetry tail stripped: a hermetic child must not write to the
    // operator's real ~/.gstack.
    expect(skill).not.toContain('Eureka');
    // Extraction proof: none of ship's workflow rode along.
    expect(skill).not.toContain('## Preamble (run first)');
    expect(skill).not.toContain('Review Readiness');
    expect(skill.length).toBeLessThan(8192);
  });

  test('with-arm installs the skill + routing line; without-arm installs neither; both get git + bare origin', () => {
    const withArm = setupArm(TASKS[0], 'with-skill');
    const withoutArm = setupArm(TASKS[0], 'without-skill');
    try {
      const skillPath = path.join(withArm.dir, '.claude', 'skills', SKILL_NAME, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.readFileSync(path.join(withArm.dir, 'CLAUDE.md'), 'utf-8')).toContain('## Skill routing');

      expect(fs.existsSync(path.join(withoutArm.dir, '.claude'))).toBe(false);
      expect(fs.readFileSync(path.join(withoutArm.dir, 'CLAUDE.md'), 'utf-8')).not.toContain('Skill routing');

      // Both arms: seeded commit + working bare origin (merge-base-style
      // commands must work inside the arm).
      for (const arm of [withArm, withoutArm]) {
        expect(run('git', ['rev-parse', 'HEAD'], arm.dir).trim()).toMatch(/^[0-9a-f]{40}$/);
        expect(run('git', ['remote', 'get-url', 'origin'], arm.dir).trim()).toBe(arm.originDir);
        expect(run('git', ['merge-base', 'origin/main', 'HEAD'], arm.dir).trim()).toMatch(/^[0-9a-f]{40}$/);
      }
    } finally {
      for (const arm of [withArm, withoutArm]) {
        fs.rmSync(arm.dir, { recursive: true, force: true });
        fs.rmSync(arm.originDir, { recursive: true, force: true });
      }
    }
  });

  test('diff capture: stat parsing + a real zero-diff and non-zero-diff round trip', () => {
    expect(parseDiffStat(' 3 files changed, 120 insertions(+), 4 deletions(-)\n'))
      .toEqual({ filesChanged: 3, insertions: 120, deletions: 4, net: 116 });
    expect(parseDiffStat(' 1 file changed, 2 insertions(+)\n'))
      .toEqual({ filesChanged: 1, insertions: 2, deletions: 0, net: 2 });
    expect(parseDiffStat(''))
      .toEqual({ filesChanged: 0, insertions: 0, deletions: 0, net: 0 });

    const arm = setupArm(TASKS[2], 'without-skill');
    try {
      // Zero-diff arm: a VALID cell, zeros across the board.
      const clean = captureStagedDiff(arm.dir, arm.seedSha);
      expect(clean.filesChanged).toBe(0);
      expect(clean.net).toBe(0);
      expect(clean.patch.trim()).toBe('');

      // Modify + add a file: counts appear, patch carries the change.
      fs.appendFileSync(path.join(arm.dir, 'README.md'), 'appended line\n');
      fs.writeFileSync(path.join(arm.dir, 'new-file.txt'), 'one\ntwo\n');
      const dirty = captureStagedDiff(arm.dir, arm.seedSha);
      expect(dirty.filesChanged).toBe(2);
      expect(dirty.insertions).toBe(3);
      expect(dirty.deletions).toBe(0);
      expect(dirty.net).toBe(3);
      expect(dirty.patch).toContain('appended line');
    } finally {
      fs.rmSync(arm.dir, { recursive: true, force: true });
      fs.rmSync(arm.originDir, { recursive: true, force: true });
    }
  });

  test('judge prompt construction embeds the rubric, the ticket, and the reference diffs', () => {
    const goodDiff = fs.readFileSync(path.join(FIXTURES, 'reference', 'good-diff.patch'), 'utf-8');
    const badDiff = fs.readFileSync(path.join(FIXTURES, 'reference', 'bad-diff.patch'), 'utf-8');
    for (const diff of [goodDiff, badDiff]) {
      const prompt = buildArmJudgePrompt(TASKS[0].ticket, diff, 'pinned0000');
      expect(prompt).toContain('<<<UNTRUSTED_DIFF_pinned0000>>>');
      expect(prompt).toContain('<<<END_UNTRUSTED_DIFF_pinned0000>>>');
      expect(prompt).toContain(diff);
      expect(prompt).toContain(TASKS[0].ticket);
      expect(prompt).toContain('0-3 scale');
      expect(prompt).toContain('"none"');
      expectMentions(prompt, [['coverage', 'not', 'over-engineering'], ['name', 'specific', 'class'], ['construct', 'exactly', '"none"']], 'arm judge prompt');
    }
    // The reference diffs are what the rubric anchors describe: the bad diff
    // carries a hand-rolled widget replacing a native element, the good one
    // uses the platform.
    expect(badDiff).toContain('class CalendarWidget');
    expect(goodDiff).toContain('type="date"');

    // Injection hardening: without an explicit sentinel, each call gets its
    // own random block markers — an arm diff cannot pre-write a closing
    // marker it has never seen.
    const a = buildArmJudgePrompt(TASKS[0].ticket, goodDiff);
    const b = buildArmJudgePrompt(TASKS[0].ticket, goodDiff);
    const marker = (p: string) => /<<<UNTRUSTED_DIFF_([a-z0-9]+)>>>/.exec(p)?.[1];
    expect(marker(a)).toBeTruthy();
    expect(marker(b)).toBeTruthy();
    expect(marker(a)).not.toBe(marker(b));
  });

  test('judge response parsing: reference-shaped verdicts accepted, malformed rejected', () => {
    // Canned verdicts the judge should return for the reference diffs.
    const goodVerdict = parseArmJudgeResponse({
      over_engineering: 0,
      construct: 'none',
      reasoning: 'Native date input with a min attribute; nothing unrequested.',
    });
    expect(goodVerdict.over_engineering).toBe(0);
    expect(goodVerdict.construct).toBe('none');

    const badVerdict = parseArmJudgeResponse({
      over_engineering: 3,
      construct: 'hand-rolled CalendarWidget + DatePickerFactory in calendar.js',
      reasoning: 'A custom calendar widget layer replaces <input type="date">.',
    });
    expect(badVerdict.over_engineering).toBe(3);
    expect(badVerdict.construct).toContain('CalendarWidget');

    // Malformed shapes throw — that throw is what the bounded retry catches.
    expect(() => parseArmJudgeResponse({ over_engineering: 7, construct: 'x' })).toThrow(/integer 0-3/);
    expect(() => parseArmJudgeResponse({ over_engineering: 1.5, construct: 'x' })).toThrow(/integer 0-3/);
    expect(() => parseArmJudgeResponse({ over_engineering: 2 })).toThrow(/construct missing/);
    expect(() => parseArmJudgeResponse({ over_engineering: 2, construct: 'none' })).toThrow(/must name the specific construct/);
    expect(() => parseArmJudgeResponse({ over_engineering: 0, construct: 'a helper' })).toThrow(/construct "none"/);
    expect(() => parseArmJudgeResponse(null)).toThrow();
  });

  test('armJudge: zero diff scores deterministically as none with no API call', async () => {
    // No ANTHROPIC client is ever constructed on this path — safe keyless.
    const score = await armJudge(TASKS[0].ticket, '   \n');
    expect(score.over_engineering).toBe(0);
    expect(score.construct).toBe('none');
  });

  test('armJudge: a malformed verdict is a failed sample, never re-asked', async () => {
    let calls = 0;
    const malformedFirst = (async () => {
      calls++;
      return calls === 1
        ? { over_engineering: 9, construct: 'garbage' }
        : { over_engineering: 2, construct: 'repository layer in app.js', reasoning: 'ok' };
    }) as unknown as typeof callJudge;
    await expect(armJudge('ticket', 'diff --git a/x b/x\n+1\n', { call: malformedFirst }))
      .rejects.toThrow(/malformed verdict \(never resampled\)/);
    expect(calls).toBe(1);

    const received: Array<{ model?: string; opts?: CallJudgeOptions }> = [];
    const wellFormed = (async (_prompt: string, model?: string, opts?: CallJudgeOptions) => {
      received.push({ model, opts });
      return { over_engineering: 2, construct: 'repository layer in app.js', reasoning: 'ok' };
    }) as unknown as typeof callJudge;
    expect((await armJudge('ticket', 'diff --git a/x b/x\n+1\n', { call: wellFormed })).over_engineering).toBe(2);
    expect(received).toEqual([{ model: ARM_JUDGE_MODEL, opts: { jsonSchema: ARM_JUDGE_SCHEMA } }]);
  });
});

describe('functional checks (correctness before LOC)', () => {
  test('every fixture with a run-tests.js oracle declares checkCmd; the trap fixtures behave as planted', () => {
    for (const task of TASKS) {
      const oracle = path.join(FIXTURES, task.fixture, 'run-tests.js');
      if (fs.existsSync(oracle)) {
        expect(task.checkCmd, `${task.key} has run-tests.js but no checkCmd — its cells would report checks=none`).toEqual(['node', 'run-tests.js']);
      } else {
        expect(task.checkCmd).toBeUndefined();
      }
    }

    // Pre-fix, the bugfix fixture MUST fail its own oracle (the planted bug),
    // and a task with no oracle reports 'none' — never a throw.
    const arm = setupArm(TASKS[2], 'without-skill');
    const noOracle = setupArm(TASKS[0], 'without-skill');
    try {
      expect(runChecks(TASKS[2], arm.dir)).toBe('fail');
      expect(runChecks(TASKS[0], noOracle.dir)).toBe('none');
    } finally {
      for (const a of [arm, noOracle]) {
        fs.rmSync(a.dir, { recursive: true, force: true });
        fs.rmSync(a.originDir, { recursive: true, force: true });
      }
    }
  });
});

// GST-469: the no-gstack arm, trials, ledger, paired judge and results.md.
const PREREG = path.join(FIXTURES, 'PREREG.md');
const LEAN = 'diff --git a/app.js b/app.js\n+  if (method === "DELETE") return remove(id);\n';
const OVERBUILT = 'diff --git a/repo.js b/repo.js\n+class NotesRepositoryFactory { /* OVERBUILT */ }\n';
const verdict = (score: number, construct = score ? 'NotesRepositoryFactory' : 'none') => ({ over_engineering: score, construct, reasoning: 'r' });
const block = (prompt: string, label: 'A' | 'B') => new RegExp(`<<<UNTRUSTED_DIFF_${label}_([a-z0-9]+)>>>\\n([\\s\\S]*?)\\n<<<END_UNTRUSTED_DIFF_${label}_`).exec(prompt)?.[2] ?? '';
/** A judge that scores by content: the OVERBUILT marker is a 3, anything else a 0. */
const contentJudge = (prompts: string[]) => (async (prompt: string) => {
  prompts.push(prompt);
  return { diff_a: verdict(block(prompt, 'A').includes('OVERBUILT') ? 3 : 0), diff_b: verdict(block(prompt, 'B').includes('OVERBUILT') ? 3 : 0) };
}) as unknown as typeof callJudge;
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); tmpDirs.push(d); return d; };

describe('no-gstack arm, trials, ledger and paired judge (GST-469, free)', () => {
  afterAll(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  test('candidate-visible folder names and git identity carry no instrument, arm or eval word', () => {
    const banned = /\b(arms?|bench(mark)?|evals?|fixtures?|trials?|panel|gstack|skills?|with|without|loadout|no-gstack)\b/i;
    for (const task of TASKS) {
      const prefixes: string[] = [];
      for (const arm of ARMS) {
        const dirs = setupArm(task, arm);
        try {
          const visible = [
            path.basename(dirs.dir).slice(0, -6),
            path.basename(dirs.originDir).slice(0, -6),
            run('git', ['config', 'user.name'], dirs.dir).trim(),
            run('git', ['config', 'user.email'], dirs.dir).trim(),
            run('git', ['log', '--format=%an%n%ae%n%cn%n%ce%n%s'], dirs.dir).trim(),
          ];
          for (const s of visible) expect(s, `${task.key} ${arm}: "${s}"`).not.toMatch(banned);
          prefixes.push(visible[0]!);
        } finally {
          fs.rmSync(dirs.dir, { recursive: true, force: true });
          fs.rmSync(dirs.originDir, { recursive: true, force: true });
        }
      }
      expect(prefixes[0], 'both arms get the same project-shaped folder name').toBe(prefixes[1]);
    }
  });

  test('ARM_TRIALS is 3 and the task timeout covers 3 sequential pairs of 2 concurrent cells plus judge calls', () => {
    expect(ARM_TRIALS).toBe(3);
    expect(ARM_PAIR_MS).toBe(ARM_SETUP_MS + ARM_TIMEOUT_MS + 2 * ARM_JUDGE_MS);
    expect(TASK_TEST_TIMEOUT_MS).toBe(ARM_TRIALS * ARM_PAIR_MS + ARM_TASK_SLACK_MS);
    expect(TASK_TEST_TIMEOUT_MS).toBeGreaterThan(ARM_TRIALS * (ARM_TIMEOUT_MS + 2 * ARM_JUDGE_MS));
  });

  test('every (task, arm, trial) has a unique test name, and the runner gets the model PREREG.md names', () => {
    const names = TASKS.flatMap(task => ARMS.flatMap(arm => Array.from({ length: ARM_TRIALS }, (_, i) => {
      const opts = armRunOptions(task, arm, '/tmp/x', i + 1);
      expect(opts.model).toBe(ARM_MODEL);
      expect(opts.testName).toContain(task.key);
      expect(opts.testName).toContain(`t${i + 1}`);
      return opts.testName;
    })));
    expect(new Set(names).size).toBe(TASKS.length * ARMS.length * ARM_TRIALS);
    // The skill arm's prompt still asks for the skill; the no-gstack prompt is the ticket alone.
    expect(armRunOptions(TASKS[0], 'with-skill', '/tmp/x', 1).prompt).toContain(`invoke the ${SKILL_NAME} skill`);
    expect(armRunOptions(TASKS[0], 'without-skill', '/tmp/x', 1).prompt).toBe(TASKS[0].ticket);

    const prereg = fs.readFileSync(PREREG, 'utf-8');
    const ids = armIdentities(prereg);
    expect(ids.sort()).toEqual(Object.values(ARM_IDENTITY).sort());
    for (const id of ids) expect(armModel(id)).toBe(ARM_MODEL);
  });

  test('a cell that asked for or was billed for another model is INFRA', () => {
    expect(armCellInfra(ARM_MODEL, [])).toBeNull();
    expect(armCellInfra(ARM_MODEL, [ARM_MODEL, 'claude-haiku-4-5'])).toBeNull();
    expect(armCellInfra('claude-sonnet-5-5', [])).toMatch(/^INFRA: ran claude-sonnet-5-5/);
    expect(armCellInfra(ARM_MODEL, ['claude-sonnet-5-5'])).toMatch(/^INFRA: billed claude-sonnet-5-5/);
  });

  test('the paired prompt carries the armJudge rubric and labels the diffs A and B only', () => {
    expect(ARM_PAIR_RUBRIC).toContain('0-3 scale');
    expect(buildArmJudgePrompt('t', 'd', 's')).toContain(ARM_PAIR_RUBRIC);
    const prompt = buildArmPairPrompt(TASKS[1].ticket, LEAN, OVERBUILT, 'pin0');
    expect(prompt).toContain(ARM_PAIR_RUBRIC);
    expect(prompt).toContain(TASKS[1].ticket);
    expect(block(prompt, 'A')).toBe(LEAN);
    expect(block(prompt, 'B')).toBe(OVERBUILT);
    expect(prompt).not.toMatch(/\b(arms?|with-skill|without-skill|no-gstack|gstack|skills?|baseline|control|treatment)\b/i);
    expect(block(buildArmPairPrompt('t', '  \n', LEAN, 'pin1'), 'A')).toBe(EMPTY_DIFF_TEXT);
  });

  test('both orders are judged and a win counts only when they agree', async () => {
    const prompts: string[] = [];
    const agree = await armPairJudge('ticket', LEAN, OVERBUILT, { call: contentJudge(prompts) });
    expect(prompts).toHaveLength(2);
    expect(block(prompts[0]!, 'A')).toBe(LEAN);
    expect(block(prompts[1]!, 'A')).toBe(OVERBUILT);
    expect(agree.winner).toBe('x');
    expect(agree.mean).toEqual({ x: 0, y: 3 });
    expect((await armPairJudge('ticket', OVERBUILT, LEAN, { call: contentJudge([]) })).winner).toBe('y');

    // A judge that always prefers position A disagrees with itself across orders: a tie, never a win.
    const biased = (async () => ({ diff_a: verdict(0), diff_b: verdict(2) })) as unknown as typeof callJudge;
    const tie = await armPairJudge('ticket', LEAN, OVERBUILT, { call: biased });
    expect(tie.winner).toBe('tie');
    expect(tie.orders.map(o => o.preferred)).toEqual(['x', 'y']);
    const equal = (async () => ({ diff_a: verdict(1, 'helper'), diff_b: verdict(1, 'helper') })) as unknown as typeof callJudge;
    expect((await armPairJudge('ticket', LEAN, OVERBUILT, { call: equal })).winner).toBe('tie');
  });

  test('one empty diff is judged as "(no changes)"; two empty diffs tie with no call; malformed verdicts are never resampled', async () => {
    const prompts: string[] = [];
    const v = await armPairJudge('ticket', '', OVERBUILT, { call: contentJudge(prompts) });
    expect(prompts).toHaveLength(2);
    expect(block(prompts[0]!, 'A')).toBe(EMPTY_DIFF_TEXT);
    expect(block(prompts[1]!, 'B')).toBe(EMPTY_DIFF_TEXT);
    expect(v.winner).toBe('x');

    let calls = 0;
    const none = (async () => { calls++; return {}; }) as unknown as typeof callJudge;
    expect((await armPairJudge('ticket', ' \n', '', { call: none })).winner).toBe('tie');
    expect(calls).toBe(0);
    await expect(armPairJudge('ticket', LEAN, OVERBUILT, { call: none })).rejects.toThrow(/malformed verdict \(never resampled\)/);
    expect(calls).toBe(2);
  });

  test('the ledger reserves every cell and judge call, settles unknown at its reservation, and stops at the cap', async () => {
    const spend = path.join(tmp(), 'spend.json');
    expect(await metered(spend, 'cell-1', ARM_CELL_RESERVE_USD, ARM_MODEL, async () => ({ value: 'ok', costUsd: 0.4 }))).toBe('ok');
    await metered(spend, 'cell-2', ARM_CELL_RESERVE_USD, ARM_MODEL, async () => ({ value: null, costUsd: null }));
    await expect(metered(spend, 'cell-3', ARM_CELL_RESERVE_USD, ARM_MODEL, async () => { throw new Error('session died'); })).rejects.toThrow('session died');

    // Judge calls: each paired order and each per-diff call reserves and settles its priced usage.
    const priced = (async (prompt: string, _model?: string, opts?: CallJudgeOptions) => {
      opts?.onResponse?.({ id: null, model: ARM_PAIR_JUDGE_MODEL, stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 300 } });
      return prompt.includes('UNTRUSTED_DIFF_A_') ? { diff_a: verdict(0), diff_b: verdict(0) } : verdict(0);
    }) as unknown as typeof callJudge;
    const call = meteredJudgeCall(spend, 'task:t1', priced);
    await armPairJudge('ticket', LEAN, OVERBUILT, { call });
    await armJudge('ticket', LEAN, { call });

    const ledger = readLedger(spend);
    expect(ledger.reserved).toEqual([]);
    expect(ledger.settled.map(s => s.attempt).sort()).toEqual(['cell-1', 'cell-2', 'cell-3', 'task:t1:judge1', 'task:t1:judge2', 'task:t1:judge3']);
    expect(ledger.settled.find(s => s.attempt === 'cell-2')).toMatchObject({ usd: 'unknown', reserved_usd: ARM_CELL_RESERVE_USD });
    expect(ledger.settled.find(s => s.attempt === 'cell-3')).toMatchObject({ usd: 'unknown', reserved_usd: ARM_CELL_RESERVE_USD });
    for (const j of ledger.settled.filter(s => s.attempt.includes('judge'))) {
      expect(j.reserved_usd).toBe(ARM_JUDGE_RESERVE_USD);
      expect(j.usd).toBeGreaterThan(0);
    }
    expect(spendSummary(ledger).cap_usd).toBe(ARM_SPEND_CAP_USD);

    // At the cap: the reservation is refused, the work never runs, and the stop names its reason.
    const full = path.join(tmp(), 'spend.json');
    await metered(full, 'big', ARM_SPEND_CAP_USD - 1, ARM_MODEL, async () => ({ value: null, costUsd: null }));
    let ran = false;
    const refused = metered(full, 'next', ARM_CELL_RESERVE_USD, ARM_MODEL, async () => { ran = true; return { value: null, costUsd: 1 }; });
    await expect(refused).rejects.toBeInstanceOf(ArmBudgetStop);
    await expect(metered(full, 'next', ARM_CELL_RESERVE_USD, ARM_MODEL, async () => ({ value: null, costUsd: 1 }))).rejects.toThrow(/^STOP: reason=budget_exhausted/);
    expect(ran).toBe(false);
  });

  test('PREREG.md passes prereg --check with the $25 cap and the calibration bar; rendered results.md passes results --check', () => {
    const prereg = fs.readFileSync(PREREG, 'utf-8');
    const check = checkPrereg(prereg);
    expect(check.ok, JSON.stringify(check)).toBe(true);
    expect(check.no_gstack.arms).toEqual([ARM_IDENTITY['without-skill']]);
    expect(prereg).toContain(`ARM_SPEND_CAP_USD = ${ARM_SPEND_CAP_USD}`);
    expect(ARM_SPEND_CAP_USD).toBe(25);
    expect(prereg).toContain('pairCalibrationBar');
    expect(prereg).toContain('run --config arm-pair');

    const cells: ArmCellRecord[] = TASKS.flatMap(task => ARMS.flatMap(arm => [1, 2, 3].map(trial => ({
      task: task.key, trial, arm, infra: null, checks: task.checkCmd ? 'pass' as const : 'none' as const,
      perDiff: arm === 'with-skill' ? 0 : 1, judgeError: false, costUsd: 0.5,
    }))));
    const pairs: ArmPairRecord[] = TASKS.flatMap(task => [1, 2, 3].map(trial => ({
      task: task.key, trial, winner: trial === 1 ? 'with-skill' as const : 'tie' as const, mean: { 'with-skill': 0, 'without-skill': trial === 1 ? 2 : 0 },
    })));
    const md = renderArmResults({ runId: 'run-1', decider: 'per-diff', cells, pairs });
    expect(checkResults(prereg, md)).toMatchObject({ ok: true, missing: [] });
    expect(md).toContain('| `claude-opus-5-5#no-gstack` | 9 | 0 | 6/6 | 0/6/3 |');
    expect(md).toContain('| `claude-opus-5-5#build-discipline` | 9 | 0 | 6/6 | 3/6/0 |');
    expect(checkResults(prereg, md.split('\n').filter(l => !l.includes('#no-gstack')).join('\n')).missing).toEqual([ARM_IDENTITY['without-skill']]);
  });

  test('paired calibration items come from the arm corpus in both orders and run through scripts/judge-calibration.ts', async () => {
    const { all, w2 } = await loadCalibrationConfigs();
    expect(all.find(c => c.id === 'arm-pair')).toBe(ARM_PAIR_CALIBRATION);
    expect(w2.find(c => c.id === 'arm-pair')).toBeUndefined();

    const dir = path.join(import.meta.dir, 'fixtures', 'judge-calibration', 'arm-pair');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf-8'));
    for (const item of raw.items) {
      for (const key of ['task', 'diff_a', 'diff_b']) {
        const v = item.inputs[key];
        if (typeof v === 'object') expect(v.file, item.id).toMatch(/^\.\.\/(arm\/inputs\/|\.\.\/arm-benchmark\/reference\/)/);
      }
    }
    expect(raw.items.find((i: any) => i.id === 'x01-ab').inputs.task).toBe(TASKS[0].ticket);
    const items = loadCorpus('arm-pair');
    const crossing = items.filter(i => i.inputs.better !== 'tie');
    expect(crossing).toHaveLength(12);
    for (const ab of crossing.filter(i => i.id.endsWith('-ab'))) {
      const ba = items.find(i => i.id === ab.inputs.pair + '-ba')!;
      expect([ba.inputs.diff_a, ba.inputs.diff_b]).toEqual([ab.inputs.diff_b, ab.inputs.diff_a]);
      expect([ab.inputs.better, ba.inputs.better, ab.expected, ba.expected]).toEqual(['A', 'B', 'pass', 'fail']);
    }
    expect(items.filter(i => i.inputs.better === 'tie').every(i => i.inputs.diff_a === i.inputs.diff_b && i.expected === 'fail')).toBe(true);
    expect(ARM_PAIR_CALIBRATION.build(items[0]!.inputs)).toContain(items[0]!.inputs.diff_a!.trim());
    expect(() => ARM_PAIR_CALIBRATION.validate({ diff_a: verdict(2) })).toThrow(/diff_b/);
    expect(ARM_PAIR_CALIBRATION.verdict([{ diff_a: verdict(0), diff_b: verdict(2) }, { diff_a: verdict(0), diff_b: verdict(3) }, { diff_a: verdict(1, 'x'), diff_b: verdict(1, 'x') }])).toBe('pass');

    // The bar on canned samples: a content-faithful judge meets it, an A-biased judge misses it.
    const sample = (item: typeof items[number], phase: SampleRecord['phase'], value: unknown, n: number): SampleRecord => ({
      config: 'arm-pair', item: item.id, split: 'dev', phase, sample: n, status: 'ok', value, latency_ms: 1, stop_reason: 'end_turn', usage: null, cost_usd: 0,
    });
    const faithful = items.flatMap(i => [0, 1, 2].map(n => sample(i, 'new', i.inputs.better === 'tie'
      ? { diff_a: verdict(1, 'x'), diff_b: verdict(1, 'x') }
      : i.inputs.better === 'A' ? { diff_a: verdict(0), diff_b: verdict(2) } : { diff_a: verdict(2), diff_b: verdict(0) }, n)));
    const met = pairCalibrationBar(items, faithful);
    expect(met).toMatchObject({ met: true, pairs: 6, reversed: [], ties: [], incomplete: [], position_bias: [] });
    const aBiased = items.flatMap(i => [0, 1, 2].map(n => sample(i, 'new', { diff_a: verdict(0), diff_b: verdict(2) }, n)));
    const missed = pairCalibrationBar(items, aBiased);
    expect(missed.met).toBe(false);
    expect(missed.ties).toHaveLength(6);
    expect(missed.position_bias).toHaveLength(4);
    expect(pairCalibrationBar(items, faithful.slice(1)).incomplete.length).toBeGreaterThan(0);
    // No committed calibration run yet: the per-diff judge decides.
    expect(pairJudgeDecides(path.join(tmp(), 'no-runs'))).toMatchObject({ decides: false });
  });
});
