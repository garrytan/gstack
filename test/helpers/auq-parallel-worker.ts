import { afterAll, describe, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeNativeAuq } from './auq-native-capture';

const spec = JSON.parse(process.env.AUQ_PARALLEL_SPEC!);
const root = process.env.AUQ_PARALLEL_ROOT!;
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, realNow = Date.now;
const timers = new Map<number, { at: number; callback: () => void }>();
let now = 0, timerId = 0, pumping = false;
if (spec.queryMs) {
  Date.now = () => now;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const id = ++timerId;
    timers.set(id, { at: now + Math.max(0, delay), callback: () => callback(...args) });
    if (!pumping) {
      pumping = true;
      realSetTimeout(function pump() {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { pumping = false; return; }
        timers.delete(next[0]); now = next[1].at; next[1].callback();
        realSetTimeout(pump, 0);
      }, 0);
    }
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
}
const events: Array<{ kind: string; id: string; active?: number; at?: number; caseDeadline?: number }> = [];
const inputs: any[] = [], judges: any[] = [], judgeRequests: any[] = [], fixtures: string[] = [];
const ownedStates: string[] = [];
let settlements: any[] = [];
let active = 0, peak = 0, judging = 0, judgePeak = 0, answers = 0;
const idFrom = (cwd: string) => path.basename(cwd).replace(/-owned$/, '').replace(/^auq-(?:consistency-|ab-)/, '');
const indexFrom = (id: string) => id === 'carved' ? 0 : id === 'verbose' ? 1 : Number(id);
const questionFor = (id: string) => {
  const question = {
    header: 'Mode',
    question: `Run ${id}\nELI10: Review this pricing plan.\nRecommendation: SELECTIVE EXPANSION because the untested premise needs a comparison.\nPros / cons:\nNet: Choose the review scope.`,
    options: ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'].map(label => ({
      label: label + (label === 'SELECTIVE EXPANSION' ? ' (recommended)' : ''),
      description: '✅ Concrete benefit.\n❌ Honest tradeoff.',
    })),
  };
  if (spec.omit && indexFrom(id) === (spec.omitIndex ?? 2)) {
    question.question = question.question.replaceAll(spec.omit, '');
    for (const option of question.options) {
      option.label = option.label.replaceAll(spec.omit, '');
      option.description = option.description.replaceAll(spec.omit, '');
    }
  }
  return question;
};

mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: ({ prompt, options }: any) => {
  const id = idFrom(options.cwd), index = indexFrom(id);
  active++; peak = Math.max(peak, active);
  events.push({ kind: 'query-start', id, active, at: Date.now() });
  inputs.push({ id, prompt, cwd: options.cwd, model: options.model, maxTurns: options.maxTurns,
    systemPrompt: options.systemPrompt, tools: options.tools, allowedTools: options.allowedTools,
    permissionMode: options.permissionMode, settingSources: options.settingSources,
    config: options.env.CLAUDE_CONFIG_DIR, state: options.env.GSTACK_HOME,
    skill: fs.readFileSync(path.join(options.cwd, 'plan-ceo-review/SKILL.md'), 'utf8'),
    plan: fs.readFileSync(path.join(options.cwd, 'plan.md'), 'utf8'),
    sections: fs.existsSync(path.join(options.cwd, 'plan-ceo-review/sections'))
      ? fs.readdirSync(path.join(options.cwd, 'plan-ceo-review/sections')).sort().map(name => [name,
        fs.readFileSync(path.join(options.cwd, 'plan-ceo-review/sections', name), 'utf8')]) : [],
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; active--;
    events.push({ kind: 'query-close', id, active });
  };
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield { type: 'system', subtype: 'init', claude_code_version: 'fixture' };
        await new Promise<void>(resolve => {
          const signal = options.abortController.signal;
          const abort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); },
            spec.queryMs ?? (index === 0 ? 10 : 60));
          signal.addEventListener('abort', abort, { once: true });
        });
        if (options.abortController.signal.aborted) return;
        if (spec.reject === index || spec.rejectAll) throw Error(`capture rejection ${id}`);
        void options.canUseTool('AskUserQuestion', { questions: [questionFor(id)] }, {
          toolUseID: `native-${id}`, signal: options.abortController.signal,
        }).then(() => answers++);
        yield { type: 'assistant', message: { content: [] } };
      } finally { close(); }
    },
    close,
  };
} }));

mock.module('./e2e-gate', () => ({ describeE2ETier: (tier: string) => {
  if (tier !== 'periodic') throw Error(`unexpected tier ${tier}`);
  return describe;
} }));
mock.module('@anthropic-ai/sdk', () => ({ default: class {
  messages = { create: async (request: any) => {
    const id = request.messages[0].content.match(/Run (\w+)/)![1], index = indexFrom(id);
    judgeRequests.push({ id, request });
    await new Promise(resolve => setTimeout(resolve, 90));
    if (spec.judgeReject === index) throw Error(`judge rejection ${id}`);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      reason_substance: spec.scores?.[index] ?? 4, reasoning: 'controlled free verdict',
    }) }] };
  } };
} }));
const judgeHelper = await import('./llm-judge');
const judgeRecommendation = judgeHelper.judgeRecommendation;
mock.module('./llm-judge', () => ({ ...judgeHelper, judgeRecommendation: async (text: string) => {
  const id = text.match(/Run (\w+)/)![1];
  judges.push({ id, text });
  judging++; judgePeak = Math.max(judgePeak, judging);
  events.push({ kind: 'judge-start', id });
  try {
    return await judgeRecommendation(text);
  } finally {
    judging--;
    events.push({ kind: 'judge-settle', id });
  }
} }));

const helper = await import('./auq-sdk-capture');
const captureModeSelectionAuq = helper.captureModeSelectionAuq;
mock.module('./auq-sdk-capture', () => ({ ...helper,
  captureModeSelectionAuq: async (opts: Parameters<typeof helper.captureModeSelectionAuq>[0]) => {
    const id = idFrom(opts.planDir);
    events.push({ kind: 'capture-start', id, at: Date.now(), caseDeadline: opts.caseDeadline });
    try {
      const text = await captureModeSelectionAuq(opts);
      if (text !== serializeNativeAuq(questionFor(id))) throw Error(`native text changed for ${id}`);
      return spec.empty === indexFrom(id) ? '' : text;
    } finally { events.push({ kind: 'capture-settle', id }); }
  },
}));

const make = fs.mkdtempSync, remove = fs.rmSync;
spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string, ...args: any[]) => {
  const name = path.basename(String(prefix));
  if (name === 'gstack-mode-auq-') {
    const dir = make(prefix, ...args);
    ownedStates.push(dir);
    return dir;
  }
  if (path.dirname(String(prefix)) !== root || !/^auq-(?:consistency-|ab-)/.test(name)) return make(prefix, ...args);
  const id = idFrom(name + 'owned');
  if (spec.setupReject === indexFrom(id)) throw Error(`setup rejection ${id}`);
  const dir = path.join(root, name + 'owned');
  fs.mkdirSync(dir);
  if (!fs.realpathSync(dir).startsWith(fs.realpathSync(root) + path.sep)) throw Error('fixture escaped owned root');
  fixtures.push(dir);
  return dir;
}) as typeof fs.mkdtempSync);
spyOn(fs, 'rmSync').mockImplementation((file, options) => {
  if (fixtures.includes(String(file))) {
    const id = idFrom(String(file));
    events.push({ kind: 'cleanup', id, active });
    if (spec.cleanupReject === indexFrom(id)) throw Error(`cleanup rejection ${id}`);
  }
  return remove(file, options);
});

afterAll(() => {
  const receipts = fs.readdirSync(path.join(root, 'artifacts/native-auq'), { recursive: true })
    .filter(file => String(file).endsWith('capture.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(root, 'artifacts/native-auq', String(file)), 'utf8')));
  fs.writeFileSync(path.join(root, 'facts.json'), JSON.stringify({ events, inputs, judges, judgeRequests, receipts,
    fixtures, peak, judgePeak, active, judging, answers, settlements, elapsed: now, pendingTimers: timers.size,
    leftovers: fixtures.filter(dir => fs.existsSync(dir)),
    ownedStateLeftovers: [...ownedStates, ...inputs.flatMap(input => [input.config, input.state])].filter(dir => fs.existsSync(dir)),
  }));
  Date.now = realNow; globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
});

if (spec.suite === 'direct') {
  test('actual native capture admission lifecycle', async () => {
    const dirs: string[] = [];
    try {
      settlements = (await Promise.allSettled(Array.from({ length: spec.runs ?? 3 }, (_, i) => {
        const dir = helper.setupPlanCeoDir({ ...helper.carvedSkill(), tmpPrefix: `auq-consistency-${i}-` });
        dirs.push(dir);
        return captureModeSelectionAuq({ planDir: dir, testName: `direct-${i}`, runId: 'free',
          ...(spec.outerMs === undefined ? {} : { caseDeadline: now + spec.outerMs }) });
      }))).map(result => result.status === 'fulfilled' ? result : { status: result.status, reason: String(result.reason) });
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
} else {
  await import(process.env.AUQ_PARALLEL_SOURCE ?? path.join(import.meta.dir, '..',
    spec.suite === 'consistency' ? 'skill-e2e-auq-consistency.test.ts' : 'skill-e2e-auq-verbose-vs-carved-ab.test.ts'));
}
