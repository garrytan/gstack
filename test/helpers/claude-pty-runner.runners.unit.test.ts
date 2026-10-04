/**
 * The three plan-skill runners driven through the fake PTY session driver
 * (scripted frames, injectable clock, no CLI or model). Each runner is run
 * for success, deadline timeout, a permission prompt and plan-ready, and its
 * launch request is checked for the model pin and skill seeding.
 *
 * Value: protects=runner outcomes across the runPtySession extraction; fails_when=the session loop reorders poll, permission, deadline or terminal handling; why_new=the runner loops had no deterministic driver; seam=PtyDriver
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readEngTestPlans, runPlanSkillObservation, runPlanSkillCounting, runPlanSkillFloorCheck } from './claude-pty-runner';
import { createFakePtyDriver, type FakeFrame, type FakeSessionContext } from './pty/fake-session';
import { FORCING_FLOOR_DEVEX } from '../fixtures/forcing-finding-seeds';

const IDLE = 'Claude Code\n> ';
const PLAN_READY = 'Here is the plan.\nReady to execute?\n❯ 1. Yes, and auto-accept edits\n  2. Yes, and manually approve edits\n  3. No, keep planning';
const PERMISSION = 'Create file\n/tmp/unowned-report.md\n────────────────\n 1 # Report\n────────────────\n' +
  'Do you want to create unowned-report.md?\n❯ 1. Yes\n  2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session\n  3. No\nEsc to cancel · Tab to amend';
const QUESTION = { header: 'Architecture', question: 'The plan repeats a custom generator in each service. Should we use the built-in generator?',
  multiSelect: false, options: [{ label: 'Use built-in', description: 'Remove the custom generator.' }, { label: 'Keep custom', description: 'Keep the maintenance burden.' }] };
const TTHW = { header: 'TTHW target', question: 'D2 — Which TTHW target should this journey be measured against?\nThe SDK quickstart has eight steps and an unbounded wait for an emailed API key.',
  multiSelect: false, options: [{ label: 'A) Champion (< 2 min)', description: 'Puts key and database questions on the table; not reachable via docs alone.' },
    { label: 'B) Competitive (2-5 min) (recommended)', description: 'Shows which gaps docs polish closes; still blocked by emailed key and local Postgres.' }] };
const render = (q: typeof QUESTION) => ['☐ ' + q.header, q.question,
  ...q.options.flatMap((o, i) => [`${i ? ' ' : '❯'} ${i + 1}. ${o.label}`, o.description]),
  'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');

/** Native JSONL writer for the fake session's isolated config dir. */
function journal(ctx: FakeSessionContext, sessionId: string, role: 'user' | 'assistant', content: unknown, extra: object = {}) {
  const file = path.join(ctx.configDir!, 'projects', 'owned', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: role, cwd: ctx.launch.cwd, sessionId, isSidechain: false,
    timestamp: new Date(ctx.now).toISOString(), message: { role, content }, ...extra }) + '\n');
}
const floorSession = (ctx: FakeSessionContext) => ctx.launch.extraArgs![ctx.launch.extraArgs!.indexOf('--session-id') + 1]!;

async function withConfigDir<T>(run: (configDir: string) => Promise<T>): Promise<T> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-fake-config-'));
  const saved = { run: process.env.EVALS_RUN_ID, dir: process.env.GSTACK_EVAL_DIR };
  delete process.env.EVALS_RUN_ID; delete process.env.GSTACK_EVAL_DIR;
  try { return await run(configDir); } finally {
    if (saved.run !== undefined) process.env.EVALS_RUN_ID = saved.run;
    if (saved.dir !== undefined) process.env.GSTACK_EVAL_DIR = saved.dir;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

describe('runPlanSkillObservation through the fake driver', () => {
  const observe = (frames: FakeFrame[]) => withConfigDir(async () => {
    const fake = createFakePtyDriver({ frames: [{ screen: IDLE }, ...frames] });
    const obs = await runPlanSkillObservation({ skillName: 'plan-eng-review', timeoutMs: 20_000, model: 'fake-model', driver: fake.driver });
    return { obs, fake };
  });

  test('success: a rendered question is asked', async () => {
    const { obs, fake } = await observe([{ onInput: '/plan-eng-review\r', screen: render(QUESTION) }]);
    expect(obs.outcome).toBe('asked');
    expect(fake.sent).toEqual(['/plan-eng-review\r']);
    expect(fake.closes()).toBe(1);
    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]).toMatchObject({ permissionMode: 'plan', seedSkills: true, model: 'fake-model', env: { GSTACK_PLAN_MODE: 'active' } });
  });

  test('deadline: no terminal frame times out on the injected clock', async () => {
    const { obs, fake } = await observe([{ onInput: '/plan-eng-review\r', screen: 'Thinking…' }]);
    expect(obs.outcome).toBe('timeout');
    expect(obs.summary).toBe('no terminal outcome within 20000ms');
    expect(obs.elapsedMs).toBe(20_000);
    expect(fake.closes()).toBe(1);
  });

  test('permission prompt: never answered and never counted as a question', async () => {
    const { obs, fake } = await observe([{ onInput: '/plan-eng-review\r', screen: PERMISSION }]);
    expect(obs.outcome).toBe('timeout');
    expect(obs.proseAUQEverObserved).toBe(false);
    expect(fake.sent).toEqual(['/plan-eng-review\r']);
  });

  test('plan-ready: the native confirmation ends the observation', async () => {
    const { obs } = await observe([{ onInput: '/plan-eng-review\r', screen: PERMISSION }, { afterMs: 4000, screen: PLAN_READY }]);
    expect(obs.outcome).toBe('plan_ready');
  });
});

describe('runPlanSkillObservation idle turn end (captured CI screens)', () => {
  const captures = JSON.parse(fs.readFileSync(new URL('../fixtures/pty-idle-turn-end.json', import.meta.url), 'utf8'));
  const observe = (frames: FakeFrame[], opts: { timeoutMs: number; requireProseEvidence?: boolean }) => withConfigDir(async () => {
    const fake = createFakePtyDriver({ frames: [{ screen: IDLE }, ...frames] });
    return runPlanSkillObservation({ skillName: 'plan-eng-review', inPlanMode: false, model: 'fake-model', driver: fake.driver,
      ...(opts.requireProseEvidence ? { extraArgs: ['--disallowedTools', 'AskUserQuestion'], requireProseEvidence: true } : {}), timeoutMs: opts.timeoutMs });
  });
  const slash = (screen: string): FakeFrame => ({ onInput: '/plan-eng-review\r', screen });

  test('the 988e985 idle turn end stops promptly as a failure that names it', async () => {
    const obs = await observe([slash(captures.scopePendingIdle.visible)], { timeoutMs: 300_000, requireProseEvidence: true });
    expect(obs.outcome).toBe('timeout');
    expect(obs.elapsedMs).toBeLessThan(30_000);
    expect(obs.summary).toContain('the CLI turn ended at an idle prompt (✻Cooked for 24s · done 12:46 AM) with no question, plan or write');
    expect(obs.summary).toContain('instead of waiting out the 300000ms budget');
    expect(obs.scopeGateQuestionObserved).toBe(false);
  });

  test('a provider error panel is named in the failure', async () => {
    const obs = await observe([slash(captures.apiErrorIdle.visible)], { timeoutMs: 300_000, requireProseEvidence: true });
    expect(obs.outcome).toBe('timeout');
    expect(obs.elapsedMs).toBeLessThan(30_000);
    expect(obs.summary).toContain('after its public error panel: ●API Error: Connection lost mid-response.');
  });

  test('negative control: a visible prose menu before the idle prompt is still asked', async () => {
    const obs = await observe([slash(captures.menuThenIdle.visible)], { timeoutMs: 300_000, requireProseEvidence: true });
    expect(obs.outcome).toBe('asked');
    expect(obs.scopeGateQuestionObserved).toBe(true);
  });

  test('negative controls: thinking, a screen that changes before settling, and an unconsulted judge keep the deadline', async () => {
    const scope: string = captures.scopePendingIdle.visible;
    const thinking = await observe([slash(scope.slice(0, scope.indexOf('●Scope')))], { timeoutMs: 40_000, requireProseEvidence: true });
    expect(thinking).toMatchObject({ outcome: 'timeout', summary: 'no terminal outcome within 40000ms', elapsedMs: 40_000 });
    const resumed = await observe([slash(scope), { afterMs: 6_000, screen: '✶ Thinking… (30s · thinking)' }], { timeoutMs: 40_000, requireProseEvidence: true });
    expect(resumed).toMatchObject({ outcome: 'timeout', summary: 'no terminal outcome within 40000ms', elapsedMs: 40_000 });
    // Without requireProseEvidence the judge could still credit 'asked'; it
    // first runs after 60s, so a shorter budget never stops early.
    const judgeLive = await observe([slash(scope)], { timeoutMs: 50_000 });
    expect(judgeLive).toMatchObject({ outcome: 'timeout', summary: 'no terminal outcome within 50000ms', elapsedMs: 50_000 });
  });
});

describe('runPlanSkillCounting through the fake driver', () => {
  const count = (frames: FakeFrame[], seedTranscript = true) => withConfigDir(async configDir => {
    const fake = createFakePtyDriver({ configDir, frames: [
      { screen: IDLE, effect: ctx => { if (seedTranscript) journal(ctx, 'count', 'assistant', [{ type: 'text', text: 'Ready.' }]); } },
      ...frames] });
    const obs = await runPlanSkillCounting({ skillName: 'plan-eng-review', slashCommand: '/plan-eng-review',
      followUpPrompt: '# Plan: fake counting fixture', isLastStep0AUQ: () => false, isReviewAUQ: () => true,
      reviewCountCeiling: 8, timeoutMs: 60_000, model: 'fake-model', driver: fake.driver });
    return { obs, fake };
  });
  const asked = (ctx: FakeSessionContext) => journal(ctx, 'count', 'assistant', [{ type: 'tool_use', id: 'finding', name: 'AskUserQuestion', input: { questions: [QUESTION] } }]);
  const answered = (ctx: FakeSessionContext) => journal(ctx, 'count', 'user', [{ type: 'tool_result', tool_use_id: 'finding', content: 'Answered.' }],
    { toolUseResult: { answers: { [QUESTION.question]: 'Use built-in' } } });

  test('success: one answered native review question, then the completion summary', async () => {
    const { obs, fake } = await count([
      { onInput: '/plan-eng-review\r', screen: render(QUESTION), effect: asked },
      { onInput: '1', screen: '## Completion Summary\nOne finding resolved.\n> ', effect: answered },
    ]);
    expect(obs.outcome).toBe('completion_summary');
    expect(obs.reviewCount).toBe(1);
    expect(fake.sent).toEqual(['/plan-eng-review\r', '1']);
    expect(fake.closes()).toBe(1);
    expect(fake.launches[0]).toMatchObject({ permissionMode: 'plan', seedSkills: true, model: 'fake-model', observeScreen: true, observePlanReady: true });
  });

  test('deadline: the work window closes with the cleanup reserve kept', async () => {
    const { obs, fake } = await count([{ onInput: '/plan-eng-review\r', screen: 'Thinking…' }]);
    expect(obs.outcome).toBe('timeout');
    expect(obs.summary).toContain('no terminal outcome within 60000ms total budget');
    expect(obs.elapsedMs).toBeLessThanOrEqual(55_000);
  });

  test('permission prompt: granted with the default pick, then plan-ready', async () => {
    const { obs, fake } = await count([
      { onInput: '/plan-eng-review\r', screen: PERMISSION },
      { onInput: '1\r', screen: PLAN_READY },
    ]);
    expect(obs.outcome).toBe('plan_ready');
    expect(fake.sent).toEqual(['/plan-eng-review\r', '1\r']);
  });

  test('plan-ready: needs a complete native transcript', async () => {
    const ready = await count([{ onInput: '/plan-eng-review\r', screen: PLAN_READY }]);
    expect(ready.obs.outcome).toBe('plan_ready');
    expect(ready.obs.reviewCount).toBe(0);
    const missing = await count([{ onInput: '/plan-eng-review\r', screen: PLAN_READY }], false);
    expect(missing.obs.outcome).toBe('transcript_unavailable');
  });
});

describe('runPlanSkillFloorCheck through the fake driver', () => {
  const delivered = (ctx: FakeSessionContext) => journal(ctx, floorSession(ctx), 'user',
    '<command-message>plan-devex-review</command-message>\n<command-name>/plan-devex-review</command-name>\n<command-args>PLAN.md</command-args>');
  const floor = (frames: FakeFrame[]) => withConfigDir(async configDir => {
    const fake = createFakePtyDriver({ configDir, frames: [{ screen: IDLE }, ...frames] });
    const obs = await runPlanSkillFloorCheck({ skillName: 'plan-devex-review', slashCommand: '/plan-devex-review',
      followUpPrompt: FORCING_FLOOR_DEVEX, timeoutMs: 30_000, model: 'fake-model', driver: fake.driver });
    return { obs, fake };
  });

  test('success: the deterministic seeded finding is observed without an answer', async () => {
    const { obs, fake } = await floor([
      { onInput: '/plan-devex-review PLAN.md\r', screen: 'Reviewing PLAN.md', effect: delivered },
      { afterMs: 2000, screen: render(TTHW), effect: ctx => journal(ctx, floorSession(ctx), 'assistant',
        [{ type: 'tool_use', id: 'tthw', name: 'AskUserQuestion', input: { questions: [TTHW] } }]) },
    ]);
    expect(obs.outcome).toBe('auq_observed');
    expect(obs.auqObserved).toBe(true);
    expect(obs.targetDelivery?.status).toBe('ready');
    expect(fake.sent).toEqual(['/plan-devex-review PLAN.md\r']);
    expect(fake.closes()).toBe(1);
    expect(fake.launches[0]).toMatchObject({ permissionMode: 'plan', seedSkills: true, model: 'fake-model', observeScreen: true, observeSetupQuestions: true });
  });

  test('deadline: a delivered target with no question times out', async () => {
    const { obs } = await floor([{ onInput: '/plan-devex-review PLAN.md\r', screen: 'Thinking…', effect: delivered }]);
    expect(obs.outcome).toBe('timeout');
    expect(obs.summary).toBe('no qualifying finding question within 30000ms');
  });

  test('permission prompt: an unowned permission is neither granted nor counted', async () => {
    const { obs, fake } = await floor([
      { onInput: '/plan-devex-review PLAN.md\r', screen: PERMISSION, effect: delivered },
      { afterMs: 6000, screen: PLAN_READY },
    ]);
    expect(obs.outcome).toBe('plan_ready');
    expect(obs.auqObserved).toBe(false);
    expect(fake.sent).toEqual(['/plan-devex-review PLAN.md\r']);
  });

  test('plan-ready: reaching approval without a finding is the regression outcome', async () => {
    const { obs } = await floor([
      { onInput: '/plan-devex-review PLAN.md\r', screen: 'Reviewing PLAN.md', effect: delivered },
      { afterMs: 2000, screen: PLAN_READY },
    ]);
    expect(obs.outcome).toBe('plan_ready');
    expect(obs.summary).toBe('agent reached plan_ready without a qualifying finding question');
  });
});

describe('readEngTestPlans', () => {
  test('returns only /plan-eng-review QA test plans under projects/<slug>/ of the owned state root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-test-plans-'));
    try {
      expect(readEngTestPlans(root)).toEqual([]);
      expect(readEngTestPlans(undefined)).toEqual([]);
      fs.mkdirSync(path.join(root, 'projects', 'fixture-slug'), { recursive: true });
      fs.writeFileSync(path.join(root, 'projects', 'fixture-slug', 'runner-main-eng-review-test-plan-20261004-010203.md'), '# Test Plan\nDashboard');
      fs.writeFileSync(path.join(root, 'projects', 'fixture-slug', 'runner-main-ship-test-plan-20261004-010203.md'), '# Ship plan');
      fs.writeFileSync(path.join(root, 'projects', 'fixture-slug', 'tasks-eng-review-20261004-010203.jsonl'), '{}');
      fs.writeFileSync(path.join(root, 'eng-review-test-plan-outside-projects.md'), 'stray');
      expect(readEngTestPlans(root)).toEqual([{ file: path.join('projects', 'fixture-slug', 'runner-main-eng-review-test-plan-20261004-010203.md'), content: '# Test Plan\nDashboard' }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
