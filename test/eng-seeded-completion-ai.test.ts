import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeBunCli } from './helpers/fake-bun-cli';
import { fakePlanSeedPrelude } from './helpers/fake-plan-seed';
import fixture from './fixtures/eng-seeded-completion-ai.json';
import { classifyVisible, extractPlanFilePath } from './helpers/claude-pty-runner';
import * as predicates from './helpers/claude-pty-runner';
import type { PtyDriver } from './helpers/claude-pty-runner';
const gate = '─────\nClaude has written up a plan and is ready to execute. Would you like to proceed?\n❯ 1. Yes, and use auto mode\n2. Yes, manually approve edits\n3. Tell Claude what to change';
const compactGate = 'Exit plan mode?\nClaude wants to exit plan mode\n❯ 1. Yes, and switch to default (ask each time) for this session\n2. No';
const question = 'Which runner should the plan use?\nA) Use the built-in runner\nB) Build a custom runner\nRecommendation: A because it avoids duplicate scheduling logic.\nReply with A or B.';
const classify = (history: string, currentScreen: string) => classifyVisible(history, { strictPlanWrites: true, currentScreen });

test('historical TODO excerpt supplies no current seeded completion or plan file', () => {
  expect(classifyVisible(fixture.visibleReadExcerpt, { strictPlanWrites: true })?.outcome).toBe('plan_ready');
  expect(extractPlanFilePath(fixture.visibleReadExcerpt)).toBeNull();
  expect(classify(fixture.visibleReadExcerpt, fixture.visibleReadExcerpt)).toBeNull();
  expect(classify(fixture.visibleReadExcerpt, fixture.reconstructedScreen)).toBeNull();
  expect(classify(fixture.visibleReadExcerpt, '')).toBeNull();
});

test('only a complete current native approval panel establishes seeded plan_ready', () => {
  for (const current of [gate, compactGate]) {
    expect(classify(fixture.visibleReadExcerpt + '\n' + current, current)?.outcome).toBe('plan_ready');
    for (const invalid of [
      '', 'Still reviewing the draft.', current + '\nStill reviewing the draft.',
      current.split('\n').slice(0, -1).join('\n'), current.replace('❯', ''),
      current.replace(/2\.[^\n]+/, '2. Approve another action'),
      'Example:\n' + current, '```text\n' + current, current.split('\n').map(line => '> ' + line).join('\n'),
    ]) expect(classify(fixture.visibleReadExcerpt + '\n' + current, invalid), invalid).toBeNull();
  }
});

test('ignoring old completion text preserves a genuine current question and stronger failure outcomes', () => {
  for (const history of [fixture.visibleReadExcerpt, gate, compactGate]) {
    expect(classify(history + '\n' + question, question)?.outcome).toBe('asked');
  }
  expect(classify(fixture.visibleReadExcerpt + '\n' + question, fixture.visibleReadExcerpt + '\n' + question)?.outcome).toBe('asked');
  expect(classify('⏺ Write(/tmp/.claude/plans/review.md)\n' + gate, gate)?.outcome).toBe('wrote_findings_before_asking');
  expect(classify('⏺ Write(/tmp/implementation.ts)\n' + fixture.visibleReadExcerpt, '')?.outcome).toBe('silent_write');
  // Callers which do not opt into the current viewport retain their contract.
  expect(classifyVisible('The item is ready to execute.')?.outcome).toBe('plan_ready');
  expect(classifyVisible(question)?.outcome).toBe('asked');
});

test('real PTY waits past old TODO, stale, partial and mismatched panels but accepts the current gate', async () => {
  const scenarios = [
    { name: 'todo', initial: fixture.visibleReadExcerpt, expected: 'asked' },
    { name: 'stale', initial: gate + '\u001b[2J\u001b[HStill reviewing the draft.', expected: 'asked' },
    { name: 'partial', initial: gate.split('\n').slice(0, -1).join('\n'), expected: 'asked' },
    { name: 'mismatch', initial: gate.replace('3. Tell Claude what to change', '3. Delete the draft'), expected: 'asked' },
    { name: 'complete', initial: gate, expected: 'plan_ready' },
    { name: 'cursorless-timeout', initial: gate.replace('❯ ', ''), expected: 'timeout' },
  ];
  const runScenario = async (scenario: typeof scenarios[number]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeded-completion-'));
    const working = path.join(dir, 'repo');
    fs.mkdirSync(working);
    const home = path.join(dir, 'home'), config = path.join(home, '.claude');
    fs.mkdirSync(config, { recursive: true });
    // The native replay implements its own protocol; it needs isolated state,
    // while seeding a complete skill runtime would consume the observation clock.
    const actorEnv: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: config,
      COMPLETION_ARGV: path.join(dir, 'argv.json'), COMPLETION_PHASE: path.join(dir, 'phase.txt') };
    if (process.platform === 'win32') {
      for (const key of Object.keys(process.env)) {
        if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase()) && process.env[key]) actorEnv[key] = process.env[key]!;
      }
      const roaming = path.join(home, 'AppData', 'Roaming'), local = path.join(home, 'AppData', 'Local');
      fs.mkdirSync(roaming, { recursive: true }); fs.mkdirSync(local, { recursive: true });
      Object.assign(actorEnv, { USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, TMP: dir, TEMP: dir, TMPDIR: dir });
    }
    const cli = createFakeBunCli(path.join(dir, 'fake-claude'), fakePlanSeedPrelude() + `
const fs = require('node:fs');
fs.writeFileSync(process.env.COMPLETION_ARGV, JSON.stringify(process.argv.slice(2)));
let sent = false;
const render = text => process.stdout.write('\\x1b[2J\\x1b[H' + text.replace(/\\n/g, '\\r\\n'));
process.on('gstack-seeded-slash', chunk => {
  if (sent || !chunk.toString().includes('/plan-eng-review')) return;
  sent = true;
  fs.writeFileSync(process.env.COMPLETION_PHASE, 'initial');
  render(${JSON.stringify(scenario.initial)});
  if (${JSON.stringify(scenario.expected)} === 'asked') setTimeout(() => {
    fs.writeFileSync(process.env.COMPLETION_PHASE, 'question');
    render(${JSON.stringify(question)});
  }, 2500);
});
setInterval(() => {}, 1000);
`);
    try {
      const runner = pathToFileURL(path.join(import.meta.dir, 'helpers/claude-pty-runner.ts')).href;
      const childFile = path.join(dir, 'observe.ts');
      fs.writeFileSync(childFile, `import { runPlanSkillObservation, resolveClaudeBinary } from ${JSON.stringify(runner)};
if (resolveClaudeBinary() !== process.env.BROWSE_TERMINAL_BINARY) throw new Error('Fake CLI resolution failed');
const obs = await runPlanSkillObservation({ skillName: 'plan-eng-review', inPlanMode: true,
  initialPlanContent: '# Plan: Completion regression\\n\\nReview the existing draft.',
  cwd: ${JSON.stringify(working)}, timeoutMs: 12000,
  env: ${JSON.stringify(actorEnv)} });
console.log(JSON.stringify(obs));
`);
      // Only this isolated child receives the executable override; it verifies
      // the resolver before the real PTY launch, so no provider can be invoked.
      const child = Bun.spawn([process.execPath, childFile], { cwd: process.cwd(),
        env: { ...process.env, ...actorEnv, BROWSE_TERMINAL_BINARY: cli,
          EVALS_RUN_ID: 'seeded-completion-fake', GSTACK_EVAL_DIR: path.join(dir, 'evidence') },
        stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const obs = JSON.parse(stdout.trim().split('\n').at(-1)!);
      expect(obs.outcome, scenario.name).toBe(scenario.expected);
      expect(fs.readFileSync(path.join(dir, 'phase.txt'), 'utf8'), scenario.name).toBe(scenario.expected === 'asked' ? 'question' : 'initial');
      expect(obs.planFile).toBeUndefined();
      expect(obs.scopeGateAutoSelectObserved).toBe(false);
      const args = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
      expect(args.filter((arg: string) => arg === '--session-id')).toHaveLength(1);
      expect(args).toContain('--permission-mode'); expect(args).toContain('plan');
      const saved = JSON.parse(fs.readFileSync(path.join(obs.artifactDir, 'observation.json'), 'utf8'));
      expect(saved.scopeSessionId).toBe(args[args.indexOf('--session-id') + 1]);
      expect(saved.scopeGateAutoSelectObserved).toBe(false);
      expect(saved.capture.claudeConfigDir).toBe(config);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  // Native ConPTY startup for six simultaneous terminals can consume the seed
  // deadline. Keep all scenarios and their budgets while bounding admission.
  const results: PromiseSettledResult<void>[] = [];
  const width = process.platform === 'win32' ? 2 : scenarios.length;
  for (let offset = 0; offset < scenarios.length; offset += width) {
    results.push(...await Promise.allSettled(scenarios.slice(offset, offset + width).map(runScenario)));
  }
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    expect(result.status, `${scenarios[i]!.name}: ${result.status === 'rejected' ? String(result.reason) : 'complete'}`).toBe('fulfilled');
  }
}, 45000);

async function mockedObservation(frames: string[], verdict: 'waiting' | 'working', seeded = true) {
  // Execute the unchanged observer function with its real classifiers, a
  // synthetic clock/session, and a stubbed judge. No CLI or judge is launched.
  const source = fs.readFileSync(path.join(import.meta.dir, 'helpers/pty/runners/observation.ts'), 'utf8');
  const start = source.indexOf('export async function runPlanSkillObservation(');
  expect(start).toBeGreaterThan(0);
  const executable = source.slice(start).replace(/^export /gm, '') + '\nreturn runPlanSkillObservation;';
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(executable);
  let clock = 0, tick = -1, closed = 0, judged = 0, seedSubmittedAt: number | null = null;
  const current = () => frames[Math.min(Math.max(tick, 0), frames.length - 1)]!;
  const args: Record<string, unknown> = {
    path, process: { cwd: () => '/synthetic-owned' }, Date: { now: () => clock }, randomUUID: () => 'owned',
    Bun: { sleep: async (ms: number) => { if (ms === 2000) { tick++; clock += tick === 0 && frames.length > 1 ? 2000 : 61000; } else clock += ms; } },
    launchClaudePty: async () => ({ send: () => {}, mark: () => 0, exited: () => false,
      visibleSince: current, rawOutput: current, currentScreen: async () => current(), hermeticConfigDir: null,
      close: async () => { closed++; } }),
    createPlanCountSnapshotWriter: () => () => ({}), logPtySnapshot: () => {},
    submitPlanSeed: async () => { seedSubmittedAt = clock; }, PlanSeedTimeout: class extends Error {},
    isRejectedSlashCommand: predicates.isRejectedSlashCommand,
    isProseAUQVisible: predicates.isProseAUQVisible, isPlanReadyVisible: predicates.isPlanReadyVisible,
    isUnknownSlashCommandVisible: predicates.isUnknownSlashCommandVisible,
    isScopeGateQuestionVisible: predicates.isScopeGateQuestionVisible,
    isScopeGateAutoSelectVisible: predicates.isScopeGateAutoSelectVisible,
    classifyVisible, extractPlanFilePath, idleTurnEnd: predicates.idleTurnEnd, findNativeAutoDecision: () => null,
    judgePtyState: () => { judged++; return { state: verdict, reasoning: 'synthetic current-frame verdict' }; },
    runPtySession: predicates.runPtySession,
  };
  const run = new Function(...Object.keys(args), js)(...Object.values(args));
  const clockArgs = args as { Date: { now(): number }; Bun: { sleep(ms: number): Promise<void> }; launchClaudePty: PtyDriver['launch'] };
  const driver: PtyDriver = { launch: clockArgs.launchClaudePty, now: clockArgs.Date.now, monotonic: clockArgs.Date.now, sleep: clockArgs.Bun.sleep };
  const obs = await run({ skillName: 'plan-eng-review', timeoutMs: 70000, driver,
    ...(seeded ? { initialPlanContent: '# Plan: Required draft' } : {}) });
  expect(closed).toBe(1);
  return { obs, judged, seedSubmittedAt };
}

test('seeded preflight checks owned readiness without spending eight seconds before submission', async () => {
  const seeded = await mockedObservation([gate], 'working');
  expect(seeded.seedSubmittedAt).toBe(0);
  expect(seeded.obs.outcome).toBe('plan_ready');
  const unseeded = await mockedObservation([gate], 'working', false);
  expect(unseeded.seedSubmittedAt).toBeNull();
  expect(unseeded.obs.outcome).toBe('plan_ready');
});

for (const [name, current] of [
  ['cursorless approval', gate.replace('❯ ', '')],
  ['partial approval', gate.split('\n').slice(0, -1).join('\n')],
] as const) test(`rejected seeded ${name} cannot gain prose or judge waiting credit`, async () => {
    const { obs, judged } = await mockedObservation([current], 'waiting');
    expect(judged).toBeGreaterThan(0);
    expect(obs.outcome).toBe('timeout');
    expect(obs.proseAUQEverObserved).toBe(false); expect(obs.waitingEverObserved).toBe(false);
});

test('rejected completion does not erase a genuine earlier question or change unseeded behavior', async () => {
  const prior = question + '\nDo you want to create draft.md?\n❯ 1. Yes\n2. No\nEsc to cancel · Tab to amend';
  expect(predicates.isProseAUQVisible(prior)).toBe(true);
  expect(classifyVisible(prior)).toBeNull();
  const { obs } = await mockedObservation([prior, gate.replace('❯ ', '')], 'working');
  expect(obs.outcome).toBe('asked'); expect(obs.proseAUQEverObserved).toBe(true);
  expect(obs.waitingEverObserved).toBe(false);
  const unseeded = await mockedObservation([gate.replace('❯ ', '')], 'waiting', false);
  expect(unseeded.obs.outcome).toBe('plan_ready'); expect(unseeded.judged).toBe(0);
});
