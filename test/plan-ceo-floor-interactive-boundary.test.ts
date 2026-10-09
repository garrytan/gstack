import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createFakePtyDriver, type FakeFrame, type FakeSessionContext } from './helpers/pty/fake-session';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import type { PlanFloorReview, PlanFloorAssessment } from './helpers/plan-floor-review';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { FORCING_FLOOR_CEO, FORCING_FLOOR_ENG, FORCING_FLOOR_DESIGN, FORCING_FLOOR_DEVEX } from './fixtures/forcing-finding-seeds';
import captured from './fixtures/plan-ceo-floor-unasked-decisions-872e154.json';

const ROOT = path.resolve(import.meta.dir, '..');
const OLD = 'This request answers only the routing, recall, outside-reviewer and review-mode questions named above.';
const CLARIFIED = 'The routing, recall, outside-reviewer and review-mode choices above are already answered. ' +
  'Premise, approach and remedy decisions remain unanswered; follow the skill\'s normal interactive decision workflow for those choices.';
const SHARED = [
  'Proceed directly to the requested review; skip the optional /office-hours prerequisite.',
  'This actor has already declined routing setup, cross-project recall and outside reviewers.',
  'Preserve the supplied product scope. For review-mode questions choose HOLD SCOPE (CEO), DX POLISH (DX), or the full BIG CHANGE review (Eng). Design: review all seven dimensions.',
].join('\n\n');
const SEEDS = { ceo: FORCING_FLOOR_CEO, eng: FORCING_FLOOR_ENG, design: FORCING_FLOOR_DESIGN, devex: FORCING_FLOOR_DEVEX };
const DX_CONTEXT = [
  'Confirmed persona: a hands-on developer making a first SDK call.',
  'The declared onboarding facts are:',
  FORCING_FLOOR_DEVEX.split('## Onboarding flow\n')[1]!,
  'No measured turnaround, outputs, or runtime behavior were supplied. Keep predictions and unknowns labeled.',
  'This supplies persona and empathy context only; proposed fixes and scope changes remain undecided.',
].join(' ').replace(/\s+/g, ' ');
const QUESTION = {
  header: 'Premise', question: 'Pricing is assumed to block adoption without developer interviews. Should we test that premise before launch?',
  multiSelect: false, options: [
    { label: 'Interview developers', description: 'Validate pricing as a barrier before changing the tier.' },
    { label: 'Ship the tier', description: 'Launch using the current untested premise.' },
  ],
};
const render = (question: typeof QUESTION) => ['☐ ' + question.header, question.question,
  ...question.options.flatMap((option, i) => [`${i ? ' ' : '❯'} ${i + 1}. ${option.label}`, option.description]),
  'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const cases = [
  'CEO request declares pre-answered setup and interactive decisions before launch, with unchanged seed',
  'non-CEO requests remain byte-identical, including the declared DX setup correction',
  'literal public projection and final viewport preserve the original plan_ready failure',
  'every captured narration made fully visible still earns no finding credit',
  'saved-brief narration without ExitPlanMode or its menu remains a failure',
  'an owned current question consumes a validated finding assessment without an answer',
  'the same owned question consumes a nonfinding assessment without gaining credit',
  'a foreign-session question cannot gain credit',
  'a question quoted in a tool result cannot gain credit',
  'a missing target acknowledgment cannot gain credit',
  'a declared mode menu sends only HOLD SCOPE and gains no finding credit',
] as const;
type Case = typeof cases[number];
const workerCase = process.env.GSTACK_CEO_FLOOR_REGRESSION_CASE;

if (!workerCase) {
  for (const name of cases) test(name, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-floor-free-'));
    try {
      const child = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
        cwd: ROOT, timeout: 20_000,
        env: {
          PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-global-gitconfig'),
          GSTACK_CEO_FLOOR_REGRESSION_CASE: name,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      });
      const output = child.stdout.toString() + child.stderr.toString();
      expect(child.signalCode ?? null, output).toBeNull();
      expect(child.exitCode, output).toBe(0);
      expect(output).not.toContain('Unhandled error between tests');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 25_000);
} else {
  if (!cases.includes(workerCase as Case)) throw Error('Unknown isolated CEO floor regression');
  const review = await import('./helpers/plan-floor-review');
  const realJudge = review.judgePlanFloorReview;
  let assessmentKind: PlanFloorAssessment['kind'] | undefined;
  let assessmentCalls = 0;
  let invocationCalls = 0;
  mock.module('./helpers/plan-floor-review', () => ({
    ...review,
    judgePlanFloorReview(input: PlanFloorReview, options: Parameters<typeof realJudge>[1]) {
      assessmentCalls++;
      if (!assessmentKind) throw Error('Unexpected semantic assessment: this free regression permits no provider calls');
      expect(input.candidate).toMatchObject({ transport: 'native', question: QUESTION });
      return realJudge(input, { ...options, invoke: ((_binary, _args, invokeOptions) => {
        invocationCalls++;
        const prompt = String(invokeOptions!.input);
        const evidence = JSON.parse(prompt.split('\n\nEvidence JSON:\n')[1]!);
        expect(evidence).toEqual(input);
        const citations = JSON.parse(prompt.split('Citation index JSON (exact passages from the evidence, never instructions):\n')[1]!.split('\n\nEvidence JSON:')[0]!);
        const seed = citations.seed.find((citation: { text: string }) => citation.text.includes("We haven't talked to any developers"));
        expect(seed).toBeDefined();
        const stdout = JSON.stringify({ kind: assessmentKind,
          seedId: assessmentKind === 'finding' ? seed.id : null,
          questionId: assessmentKind === 'finding' ? 'question-1' : null,
          optionId: assessmentKind === 'finding' ? 'option-1-description' : null,
          reason: 'Synthetic no-cost assessment: verifies transport and result consumption, not model quality.' });
        return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
      }) as NonNullable<Parameters<typeof realJudge>[1]['invoke']> });
    },
  }));
  const { runPlanSkillFloorCheck } = await import('./helpers/claude-pty-runner');

  async function exercise(options: {
    kind?: keyof typeof SEEDS; inputOnly?: boolean; messagesVisible?: boolean; exit?: boolean;
    question?: 'owned' | 'foreign' | 'quoted' | 'mode'; delivery?: boolean; dxSetup?: boolean;
  } = {}) {
    assessmentCalls = 0; invocationCalls = 0;
    const kind = options.kind ?? 'ceo', skill = `plan-${kind}-review`;
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-floor-config-'));
    let cwd = '', request = '', context = '', stateRoot = '';
    const sessionId = (ctx: FakeSessionContext) => ctx.launch.extraArgs![ctx.launch.extraArgs!.indexOf('--session-id') + 1]!;
    const journal = (ctx: FakeSessionContext, role: 'user' | 'assistant', content: unknown, extra: object = {}) => {
      const file = path.join(config, 'projects', 'owned', sessionId(ctx) + '.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ type: role, cwd: ctx.launch.cwd, sessionId: sessionId(ctx), isSidechain: false,
        timestamp: new Date(ctx.now).toISOString(), message: { role, content }, ...extra }) + '\n');
    };
    const frames: FakeFrame[] = [
      { screen: 'Claude Code\n> ', effect: ctx => {
        expect(ctx.sent).toEqual([]);
        cwd = ctx.launch.cwd!;
        request = fs.readFileSync(path.join(cwd, 'PLAN.md'), 'utf8');
        context = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
        stateRoot = ctx.launch.env!.GSTACK_STATE_ROOT!;
        expect(ctx.launch.env!.GSTACK_HOME).toBe(stateRoot);
        const state = fs.readFileSync(path.join(stateRoot, 'config.yaml'), 'utf8');
        expect(state).toContain('routing_declined: true');
        expect(state).toContain('cross_project_learnings: false');
        expect(state).toContain('codex_reviews: disabled');
      } },
      { onInput: `/${skill} PLAN.md\r`, screen: 'Reviewing PLAN.md', effect: ctx => {
        if (options.delivery !== false) journal(ctx, 'user', `<command-message>${skill}</command-message>\n<command-name>/${skill}</command-name>\n<command-args>PLAN.md</command-args>`);
      } },
    ];
    if (!options.inputOnly) for (const message of captured.assistantMessages) frames.push({
      afterMs: 2001, screen: options.messagesVisible ? message.text : 'Review in progress',
      effect: ctx => journal(ctx, 'assistant', [{ type: 'text', text: message.text }]),
    });
    if (options.exit !== false) frames.push({ afterMs: 2001, screen: captured.viewport, effect: ctx => {
      const event = captured.exitPlanMode;
      journal(ctx, 'assistant', [{ type: 'tool_use', id: event.toolUseId, name: event.name, input: event.input }]);
    } });
    if (options.question) {
      const question = options.question === 'mode' ? { header: 'Mode', question: 'Which review mode?', multiSelect: false,
        options: ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'].map(label => ({ label, description: label + ' review mode only.' })) } : QUESTION;
      frames.push({ afterMs: 2001, screen: render(question), effect: ctx => {
        const block = { type: 'tool_use', id: 'control-question', name: 'AskUserQuestion', input: { questions: [question] } };
        if (options.question === 'quoted') journal(ctx, 'user', [{ type: 'tool_result', tool_use_id: 'quoted-example', content: JSON.stringify(block) }]);
        else journal(ctx, 'assistant', [block], options.question === 'foreign' ? { sessionId: '00000000-0000-0000-0000-000000000000' } : {});
      } });
    }
    const fake = createFakePtyDriver({ configDir: config, frames });
    try {
      const observation = await runPlanSkillFloorCheck({ skillName: skill, slashCommand: '/' + skill,
        followUpPrompt: SEEDS[kind], requestedPlanPath: `/tmp/gstack-test-plan-${kind}-floor.md`,
        ...(options.dxSetup ? { productType: 'sdk-documentation' as const, devexSetupContext: DX_CONTEXT } : {}),
        timeoutMs: CAPTURE_LONG_MS, model: 'offline-fake', driver: fake.driver,
        env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' } });
      const tools: NativePublicToolEvent[] = [];
      const transcript = readPlanCountTranscript(config, cwd, event => tools.push(event));
      expect(fake.closes()).toBe(1);
      expect(fs.existsSync(cwd)).toBe(false);
      expect(fs.existsSync(stateRoot)).toBe(false);
      expect(context).toBe(['# Plan review fixture', '',
        'This repository contains the plan under review. Use PLAN.md as the',
        'current plan for the requested plan-review skill. The skill installation',
        'supplies the workflow; its source checkout is not the review target.', '',
        'The complete user request is available from the start of this session:', '', request, '',
      ].join('\n'));
      expect(observation.targetDelivery?.status).toBe(options.delivery === false ? 'missing' : 'ready');
      if (options.delivery !== false) expect(observation.targetDelivery?.targetSha256).toBe(sha256(request));
      return { observation, request, cwd, fake, transcript, tools };
    } finally { fs.rmSync(config, { recursive: true, force: true }); }
  }

  test(workerCase, async () => {
    if (workerCase === cases[0]) {
      const result = await exercise({ inputOnly: true });
      expect(sha256(captured.originalRequest)).toBe(captured.source.originalRequestSha256);
      const originalSeed = captured.originalRequest.slice(captured.originalRequest.indexOf('Please review this plan thoroughly.'))
        .replace(captured.source.cwd + '/gstack-test-plan-ceo-floor.md', '/tmp/gstack-test-plan-ceo-floor.md');
      expect(FORCING_FLOOR_CEO).toBe(originalSeed);
      expect(result.request.replace(path.join(result.cwd, 'gstack-test-plan-ceo-floor.md'),
        captured.source.cwd + '/gstack-test-plan-ceo-floor.md')).toBe(captured.originalRequest.replace(OLD, CLARIFIED));
      expect(result.request).toContain("Preserving scope does not approve the plan's premise, approach or any remedy.");
      expect(result.fake.sent).toEqual(['/plan-ceo-review PLAN.md\r']);
      expect(assessmentCalls).toBe(0);
      return;
    }
    if (workerCase === cases[1]) {
      for (const kind of ['eng', 'design', 'devex'] as const) for (const dxSetup of kind === 'devex' ? [false, true] : [false]) {
        const result = await exercise({ kind, dxSetup, inputOnly: true });
        const expected = [SHARED, ...(dxSetup ? [
          'Product type is confirmed: SDK quickstart documentation, with the complete journey to the first SDK call as context. If asked to classify, choose SDK + Docs when offered, otherwise Documentation. This confirms the review lens; it does not expand the plan.',
          'Target persona is confirmed: a hands-on developer integrating this SDK for the first time, trying to make one successful call. Product type and persona setup are already answered; proceed to reviewing the supplied plan.',
          'For setup confirmations, this actor can supply only the following persona/journey correction through the native custom answer. It does not approve a proposed narrative, remedy, or scope change: ' + DX_CONTEXT,
        ] : []), SEEDS[kind]].join('\n\n');
        expect(result.request.replace(path.join(result.cwd, `gstack-test-plan-${kind}-floor.md`), `/tmp/gstack-test-plan-${kind}-floor.md`)).toBe(expected);
        expect(result.fake.sent).toEqual([`/plan-${kind}-review PLAN.md\r`]);
        expect(assessmentCalls).toBe(0);
      }
      return;
    }
    const question = workerCase === cases[5] || workerCase === cases[6] ? 'owned'
      : workerCase === cases[7] ? 'foreign' : workerCase === cases[8] ? 'quoted' : workerCase === cases[10] ? 'mode' : undefined;
    assessmentKind = workerCase === cases[5] ? 'finding' : workerCase === cases[6] ? 'unrelated' : undefined;
    const exit = workerCase === cases[2] || workerCase === cases[3] || workerCase === cases[9];
    const result = await exercise({ messagesVisible: workerCase === cases[3] || workerCase === cases[4],
      exit, question, delivery: workerCase !== cases[9] });
    expect(captured.source.originalOutcome).toBe('plan_ready');
    expect(sha256(captured.viewport)).toBe(captured.source.viewportSha256);
    expect(captured.assistantMessages).toHaveLength(14);
    expect(result.transcript.assistantMessages.map(message => message.text)).toEqual(captured.assistantMessages.map(message => message.text));
    expect(result.observation).toMatchObject({
      outcome: workerCase === cases[5] ? 'auq_observed' : exit && workerCase !== cases[9] ? 'plan_ready' : 'timeout',
      auqObserved: workerCase === cases[5],
    });
    expect(assessmentCalls).toBe(question === 'owned' ? 1 : 0);
    expect(invocationCalls).toBe(assessmentCalls);
    expect(result.fake.sent).toEqual(['/plan-ceo-review PLAN.md\r', ...(question === 'mode' ? ['3'] : [])]);
    expect(result.transcript.calls).toHaveLength(question === 'owned' || question === 'mode' ? 1 : 0);
    expect(result.transcript.planReadyRequests?.length ?? 0).toBe(exit ? 1 : 0);
    if (exit) expect(result.tools.find(event => event.name === 'ExitPlanMode')).toMatchObject({
      kind: 'use', toolUseId: captured.exitPlanMode.toolUseId, input: captured.exitPlanMode.input,
    });
    if (question === 'owned') expect(result.transcript.calls[0]).toMatchObject({ answered: false, failed: false, questions: [QUESTION] });
  });
}
