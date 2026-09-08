/** Free behavioral coverage for the isolated, preloaded plan-count workspace. */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanCountFixture } from './helpers/plan-count-fixture';
import { getHermeticDirs } from './helpers/hermetic-env';

const ROOT = path.resolve(import.meta.dir, '..');
const PROMPT = '# Seeded settings plan\n\nReview each issue separately.\n' +
  'Literal text: "quotes" \'single quotes\' `touch never` $(touch never)\n';

function gitRoot(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  return fs.realpathSync(result.stdout.trim());
}

describe('plan-count fixtures', () => {
  test('preloads the literal plan and initial context in a separate git repository', () => {
    const fixture = createPlanCountFixture(PROMPT);
    try {
      expect(fs.realpathSync(fixture.cwd)).not.toBe(fs.realpathSync(ROOT));
      expect(gitRoot(fixture.cwd)).toBe(fs.realpathSync(fixture.cwd));
      expect(fs.readFileSync(path.join(fixture.cwd, 'PLAN.md'), 'utf8')).toBe(PROMPT);
      const context = fs.readFileSync(path.join(fixture.cwd, 'CLAUDE.md'), 'utf8');
      expect(context).toContain('PLAN.md');
      expect(context).toContain(PROMPT);
      expect(fs.existsSync(path.join(fixture.cwd, 'DESIGN.md'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.cwd, 'TODOS.md'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.cwd, 'never'))).toBe(false);
      expect(fixture.env).toEqual({}); // Mode-routing callers keep normal config.
    } finally {
      fixture.cleanup();
    }
    expect(fs.existsSync(fixture.cwd)).toBe(false);
  });

  test('native count config owns independent state and preserves shared onboarding seeds', () => {
    const shared = getHermeticDirs().gstackHome;
    const before = fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8');
    const markers = fs.readdirSync(shared).filter(name => name.startsWith('.'));
    const first = createPlanCountFixture('first native plan', { nativeReviewOnly: true });
    const second = createPlanCountFixture('second native plan', { nativeReviewOnly: true });
    try {
      expect(first.env.GSTACK_HOME).not.toBe(shared);
      expect(first.env.GSTACK_HOME).not.toBe(second.env.GSTACK_HOME);
      expect(first.env.GSTACK_STATE_ROOT).toBe(first.env.GSTACK_HOME);
      expect(fs.readFileSync(path.join(first.env.GSTACK_HOME, 'config.yaml'), 'utf8'))
        .toBe(before.replace(/^codex_reviews:.*(?:\r?\n|$)/gm, '') + '\ncodex_reviews: disabled\n');
      for (const marker of markers) {
        expect(fs.readFileSync(path.join(first.env.GSTACK_HOME, marker), 'utf8'))
          .toBe(fs.readFileSync(path.join(shared, marker), 'utf8'));
      }
      first.cleanup();
      first.cleanup();
      expect(fs.existsSync(first.env.GSTACK_HOME)).toBe(false);
      expect(fs.existsSync(second.env.GSTACK_HOME)).toBe(true);
      expect(fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8')).toBe(before);
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(fs.existsSync(second.env.GSTACK_HOME)).toBe(false);
  });

  test('concurrent fixtures have independent content and cleanup owns only its directory', () => {
    const first = createPlanCountFixture('first plan');
    const second = createPlanCountFixture('second plan');
    try {
      expect(first.cwd).not.toBe(second.cwd);
      first.cleanup();
      first.cleanup();
      expect(fs.existsSync(first.cwd)).toBe(false);
      expect(fs.readFileSync(path.join(second.cwd, 'PLAN.md'), 'utf8')).toBe('second plan');
      expect(gitRoot(second.cwd)).toBe(fs.realpathSync(second.cwd));
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(fs.existsSync(second.cwd)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('cleans the fixture when the PTY executable cannot launch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-launch-failure-'));
    const fixtureTmp = path.join(dir, 'fixtures');
    const workerPath = path.join(dir, 'worker.ts');
    const brokenCli = path.join(dir, 'not-executable');
    fs.mkdirSync(fixtureTmp);
    fs.writeFileSync(brokenCli, 'This file deliberately has no executable permission.', { mode: 0o644 });
    const runnerUrl = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
    fs.writeFileSync(workerPath, `
import { runPlanSkillCounting } from ${JSON.stringify(runnerUrl)};
try {
  await runPlanSkillCounting({
    skillName: 'plan-design-review', slashCommand: '/plan-design-review',
    followUpPrompt: 'Review this launch-failure fixture.',
    isLastStep0AUQ: () => false, reviewCountCeiling: 8,
  });
  process.exitCode = 1;
} catch (error) {
  process.stdout.write('launch failed as expected');
}
`);
    try {
      const result = spawnSync(process.execPath, [workerPath], {
        cwd: ROOT,
        env: { ...process.env, BROWSE_TERMINAL_BINARY: brokenCli, EVALS_HERMETIC: '1', TMPDIR: fixtureTmp },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('launch failed as expected');
      expect(fs.readdirSync(fixtureTmp)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);

  // Bun's real PTY spawn and executable shebangs are POSIX-only. The direct
  // fixture tests above still exercise repository setup/cleanup on Windows.
  test.skipIf(process.platform === 'win32')(
    'real PTY children see preloaded isolated plans, shipped skills, and only the bare slash command',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-subprocess-'));
      const fakePath = path.join(dir, 'fake-claude');
      const workerPath = path.join(dir, 'worker.ts');
      const resultPath = path.join(dir, 'result.json');
      const hostState = path.join(dir, 'host-state');
      const hostConfig = 'codex_reviews: enabled\nexplain_level: expert\n';
      fs.mkdirSync(hostState);
      fs.writeFileSync(path.join(hostState, 'config.yaml'), hostConfig);
      const cases = [
        { name: 'design', skillName: 'plan-design-review', prompt: PROMPT, mode: 'complete' },
        { name: 'ceo', skillName: 'plan-ceo-review', prompt: '# Independent CEO plan\nUnique product context.', mode: 'complete' },
        { name: 'exited', skillName: 'plan-eng-review', prompt: '# Early-exit plan\nStill clean up.', mode: 'exit' },
        { name: 'skip-first', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'prerequisite', skipIndex: 1 },
        { name: 'skip-second', skillName: 'plan-devex-review', prompt: '# Native DX plan', mode: 'prerequisite', skipIndex: 2 },
      ].map((item) => ({ ...item, record: path.join(dir, `${item.name}.jsonl`) }));

      // The fake snapshots its environment BEFORE installing the first stdin
      // handler. It never dispatches a model or invokes the real Claude CLI.
      fs.writeFileSync(fakePath, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const record = (event) => fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(event) + '\n');
const skillDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', process.env.FIXTURE_SKILL);
const planPath = path.join(process.cwd(), 'PLAN.md');
const contextPath = path.join(process.cwd(), 'CLAUDE.md');
const config = (key) => {
  const result = spawnSync('bash', [process.env.FIXTURE_CONFIG_BIN, 'get', key], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error('Fixture config failed: ' + result.stderr);
  return result.stdout;
};
record({
  type: 'startup', pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2),
  stateRoot: process.env.GSTACK_STATE_ROOT, gstackHome: process.env.GSTACK_HOME,
  codexReviews: config('codex_reviews'), explainLevel: config('explain_level'),
  onboarding: fs.readdirSync(process.env.GSTACK_HOME).filter(name => name.startsWith('.')),
  gitRoot: spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim(),
  plan: fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : null,
  context: fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf8') : null,
  inheritedDesign: fs.existsSync('DESIGN.md'), inheritedTodos: fs.existsSync('TODOS.md'),
  skill: fs.existsSync(path.join(skillDir, 'SKILL.md')) ? fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8') : null,
  sections: fs.existsSync(path.join(skillDir, 'sections', 'review-sections.md'))
    ? fs.readFileSync(path.join(skillDir, 'sections', 'review-sections.md'), 'utf8') : null,
});
fs.writeFileSync(path.join(process.env.GSTACK_HOME, 'child-owned'), 'isolated');
if (process.env.FIXTURE_MODE === 'exit') process.stdout.write('\x1b[?25lSTARTUP_DIAGNOSTIC fixture CLI booted\x1b[?25h\n');
process.stdin.setRawMode?.(true);
let firstInput = true;
let completion;
let question = 0;
let selected = '';
process.stdin.on('data', (data) => {
  const input = data.toString('utf8');
  record({ type: 'input', data: input });
  if (!firstInput) {
    if (process.env.FIXTURE_MODE !== 'prerequisite') return;
    if (question === 1 && input.includes('\r')) {
      record({ type: 'generic-answer', input });
      question = 2;
      const labels = ['Run /office-hours now', 'Skip — proceed with standard review'];
      if (process.env.FIXTURE_SKIP_INDEX === '1') labels.reverse();
      process.stdout.write('\r☐ Prerequisite\rNo design doc found. Run /office-hours first?\r❯1.' + labels[0] + '\r2.' + labels[1] + '\r');
      return;
    }
    selected += input.replace(/\r/g, '');
    if (input.includes('\r')) {
      record({ type: 'prerequisite-answer', selected });
      process.stdout.write(selected === process.env.FIXTURE_SKIP_INDEX ? '\nGSTACK REVIEW REPORT\n' : '\nWRONG_PREREQUISITE_CHOICE\n');
    }
    return;
  }
  firstInput = false;
  if (process.env.FIXTURE_MODE === 'exit') process.exit(7);
  if (process.env.FIXTURE_MODE === 'prerequisite') {
    question = 1;
    process.stdout.write('\r☐ Setup\rWhich fixture setup should be used?\r❯1.First setup\r2.Second setup\r');
    return;
  }
  // Longer than the old 3 s delayed fixture send: record that regression
  // even if the helper would otherwise return on our completion marker.
  completion = setTimeout(() => process.stdout.write('\nGSTACK REVIEW REPORT\n'), 4100);
});
process.on('SIGINT', () => {
  clearTimeout(completion);
  record({ type: 'closed', at: Date.now() });
  process.exit(0);
});
process.stdin.resume();
`);
      fs.chmodSync(fakePath, 0o755);
      const runnerUrl = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;
      const hermeticUrl = pathToFileURL(path.join(ROOT, 'test/helpers/hermetic-env.ts')).href;
      fs.writeFileSync(workerPath, `
import { runPlanSkillCounting } from ${JSON.stringify(runnerUrl)};
import { getHermeticDirs } from ${JSON.stringify(hermeticUrl)};
import * as fs from 'node:fs';
import * as path from 'node:path';
const shared = getHermeticDirs().gstackHome;
fs.appendFileSync(path.join(shared, 'config.yaml'), 'codex_reviews: enabled\\nexplain_level: beginner\\n');
const sharedBefore = fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8');
const onboarding = fs.readdirSync(shared).filter(name => name.startsWith('.'));
const cases = ${JSON.stringify(cases)};
const results = await Promise.all(cases.map(async (item) => ({
  name: item.name,
  observation: await runPlanSkillCounting({
    skillName: item.skillName,
    slashCommand: '/' + item.skillName,
    followUpPrompt: item.prompt,
    isLastStep0AUQ: () => false,
    reviewCountCeiling: 8,
    timeoutMs: 15000,
    firstAUQPick: () => 2,
    env: {
      FIXTURE_RECORD: item.record, FIXTURE_SKILL: item.skillName, FIXTURE_MODE: item.mode,
      FIXTURE_SKIP_INDEX: String(item.skipIndex ?? ''), FIXTURE_CONFIG_BIN: ${JSON.stringify(path.join(ROOT, 'bin/gstack-config'))},
      GSTACK_HOME: ${JSON.stringify(hostState)}, GSTACK_STATE_ROOT: ${JSON.stringify(hostState)},
    },
  }),
})));
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ results, onboarding, sharedBefore,
  sharedAfter: fs.readFileSync(path.join(shared, 'config.yaml'), 'utf8'),
  sharedHasChildFile: fs.existsSync(path.join(shared, 'child-owned')),
}));
`);

      const startedAt = Date.now();
      const child = Bun.spawn([process.execPath, workerPath], {
        cwd: ROOT,
        env: { ...process.env, BROWSE_TERMINAL_BINARY: fakePath, EVALS_HERMETIC: '1', GSTACK_HOME: hostState, GSTACK_STATE_ROOT: hostState },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), 35_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stdout + stderr).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(35_000);
        const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const results = report.results;
        expect(report.sharedAfter).toBe(report.sharedBefore);
        expect(report.sharedHasChildFile).toBe(false);
        expect(fs.readFileSync(path.join(hostState, 'config.yaml'), 'utf8')).toBe(hostConfig);
        expect(fs.readdirSync(hostState)).toEqual(['config.yaml']);
        const cwds = new Set<string>();
        const stateRoots = new Set<string>();
        for (const item of cases) {
          const events = fs.readFileSync(item.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
          const startup = events[0];
          expect(startup.type).toBe('startup');
          expect(startup.cwd).not.toBe(ROOT);
          expect(startup.gitRoot).toBe(startup.cwd);
          expect(startup.stateRoot).toBe(startup.gstackHome);
          expect(startup.stateRoot).not.toBe(hostState);
          expect(startup.codexReviews).toBe('disabled');
          expect(startup.explainLevel).toBe('beginner');
          expect(startup.onboarding).toEqual(report.onboarding);
          expect(startup.plan).toBe(item.prompt);
          expect(startup.context).toContain('PLAN.md');
          expect(startup.context).toContain(item.prompt);
          expect(startup.argv[startup.argv.indexOf('--permission-mode') + 1]).toBe('plan');
          expect(startup.inheritedDesign).toBe(false);
          expect(startup.inheritedTodos).toBe(false);
          expect(startup.skill).toContain(`name: ${item.skillName}`);
          expect(startup.sections).toBe(fs.readFileSync(path.join(ROOT, item.skillName, 'sections/review-sections.md'), 'utf8'));
          expect(events.filter((event) => event.type === 'input').map((event) => event.data).join(''))
            .toBe(`/${item.skillName}\r` + (item.mode === 'prerequisite' ? `2\r${item.skipIndex}\r` : ''));
          expect(fs.existsSync(startup.cwd)).toBe(false);
          expect(fs.existsSync(startup.stateRoot)).toBe(false);
          expect(() => process.kill(startup.pid, 0)).toThrow();
          const result = results.find((result) => result.name === item.name);
          expect(result.observation.outcome).toBe(item.mode === 'exit' ? 'exited' : 'completion_summary');
          if (item.mode === 'exit') {
            expect(result.observation.evidence).toContain('exitCode=7');
            expect(result.observation.evidence).toContain('STARTUP_DIAGNOSTIC fixture CLI booted');
            expect(result.observation.evidence).not.toContain('\x1b');
          }
          if (item.mode === 'complete') expect(events.at(-1).type).toBe('closed');
          if (item.mode === 'prerequisite') {
            expect(events.find(event => event.type === 'prerequisite-answer').selected).toBe(String(item.skipIndex));
            expect(result.observation.step0Count).toBe(2);
            expect(result.observation.reviewCount).toBe(0);
          }
          cwds.add(startup.cwd);
          stateRoots.add(startup.stateRoot);
        }
        expect(cwds.size).toBe(cases.length);
        expect(stateRoots.size).toBe(cases.length);
      } finally {
        clearTimeout(killer);
        child.kill('SIGKILL');
        // A failed worker assertion must not leave its PTY fakes running.
        for (const item of cases) {
          if (!fs.existsSync(item.record)) continue;
          const startup = JSON.parse(fs.readFileSync(item.record, 'utf8').split('\n')[0]);
          try { process.kill(startup.pid, 'SIGKILL'); } catch { /* already reaped */ }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
