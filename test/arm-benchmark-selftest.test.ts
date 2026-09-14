/**
 * Arm-benchmark selftest — FREE (no API key, no model, no spend), runs in
 * `bun run test` on every PR. Pins fixture integrity (planted traps still
 * open, decoy credentials obviously fake), skill extraction, arm-install
 * asymmetry, diff-capture round trips, judge prompt construction/injection
 * framing, parse plumbing, and the bounded retry — so the paid periodic
 * benchmark never burns money on a broken instrument.
 */
import { describe, test, expect } from 'bun:test';
import {
  TASKS, FIXTURES, SKILL_NAME,
  buildBehavioralSkill, run, setupArm, parseDiffStat, captureStagedDiff, runChecks,
} from './helpers/arm-benchmark-harness';
import {
  armJudge, buildArmJudgePrompt, parseArmJudgeResponse,
  ARM_JUDGE_ATTEMPTS, callJudge,
} from './helpers/llm-judge';
import * as fs from 'fs';
import * as path from 'path';

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
      expect(prompt).toContain('Coverage is NOT over-engineering');
      expect(prompt).toContain('MUST name the specific class, function, file, or pattern');
      expect(prompt).toContain('construct MUST be exactly "none"');
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

  test('armJudge: bounded retry-on-malformed — recovers once, then gives up', async () => {
    // Malformed first, valid second: recovers within the 2-attempt bound.
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1
        ? { over_engineering: 9, construct: 'garbage' }
        : { over_engineering: 2, construct: 'repository layer in app.js', reasoning: 'ok' };
    }) as unknown as typeof callJudge;
    const recovered = await armJudge('ticket', 'diff --git a/x b/x\n+1\n', { call: flaky });
    expect(recovered.over_engineering).toBe(2);
    expect(calls).toBe(ARM_JUDGE_ATTEMPTS);

    // Always malformed: throws after exactly ARM_JUDGE_ATTEMPTS attempts.
    let badCalls = 0;
    const alwaysBad = (async () => {
      badCalls++;
      return { nonsense: true };
    }) as unknown as typeof callJudge;
    await expect(armJudge('ticket', 'diff --git a/x b/x\n+1\n', { call: alwaysBad }))
      .rejects.toThrow(/no well-formed verdict after 2 attempts/);
    expect(badCalls).toBe(ARM_JUDGE_ATTEMPTS);
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
