/**
 * PR 2 of GSTA-150: every trial's cost is attributed. A display-label record binds its cost by
 * runSkillTest's testName (cost_case_id) without changing the failed record or failure class; a case
 * with no record takes its sessions' streamed cost; a listed model-free case costs a known $0.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MODEL_FREE_CASES, caseCost, junitCensus } from '../scripts/lib/paid-report';
import { anthropicUsageCostUsd, streamedUsageCostUsd } from '../lib/pricing';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import type { SessionLedgerRow } from './helpers/session-ledger';
import { recordE2E } from './helpers/e2e-helpers';
import { newTranscriptSessionId, pricedTranscript, ptyTranscriptCostUsd, transcriptFiles } from './helpers/pty/transcript-cost';

const ROOT = path.resolve(import.meta.dir, '..');
const session = (over: Partial<SessionLedgerRow>): SessionLedgerRow => ({ key: 'k', runner: 'agent-sdk', started_at: 't', elapsed_ms: 1, end: 'aborted', ...over });

describe('pricing usage', () => {
  test('cache writes bill 1.25x input (5-minute) and 2x (1-hour); reads at the cached rate', () => {
    // claude-opus-5-5: input $4, output $20, cache read $0.20 per Mtok.
    expect(anthropicUsageCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }, 'claude-opus-5-5'))
      .toBeCloseTo(4 + 20 + 0.2 + 5, 6);
    expect(anthropicUsageCostUsd({ cache_creation_input_tokens: 3_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 2_000_000 } }, 'claude-opus-5-5'))
      .toBeCloseTo(5 + 16, 6);
    expect(anthropicUsageCostUsd({ cache_creation_input_tokens: 3_000_000, cache_creation: { ephemeral_1h_input_tokens: 2_000_000 } }, 'claude-opus-5-5'))
      .toBeCloseTo(5 + 16, 6);
    expect(anthropicUsageCostUsd({ input_tokens: 10 }, 'no-such-model')).toBeUndefined();
  });

  test('streamed messages count once per id at their largest output, sidechains included; an unpriced model is unknown', () => {
    const msg = (id: string, output: number, extra: Record<string, unknown> = {}) => ({ message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: output } }, ...extra });
    expect(streamedUsageCostUsd([msg('a', 10), msg('a', 1_000_000), msg('b', 500_000, { parent_tool_use_id: 'tool-1' })])).toBeCloseTo(30, 6);
    expect(streamedUsageCostUsd([{ message: { id: 'a', model: '<synthetic>', usage: { output_tokens: 5 } } }])).toBeUndefined();
    expect(streamedUsageCostUsd([{ message: { id: 'a', model: 'no-such-model', usage: { output_tokens: 5 } } }, msg('b', 5)])).toBeUndefined();
    expect(streamedUsageCostUsd([{ message: { id: 'a', usage: { output_tokens: 1_000_000 } } }], 'claude-opus-5-5')).toBeCloseTo(20, 6);
  });
});

describe('caseCost', () => {
  test('a billed session\'s cost is already in the records; a streamed session adds what no record carries', () => {
    expect(caseCost('x', [{ cost_usd: 0.25 }, { cost_usd: 0.1 }], [session({ billed: true, cost_usd: 9 })])).toEqual({ cost_usd: 0.35 });
    expect(caseCost('x', [{ cost_usd: 0 }], [session({ billed: false, streamed_cost_usd: 0.4 })])).toEqual({ cost_usd: 0.4 });
    expect(caseCost('x', [{ cost_usd: 0.2 }], [session({ runner: 'pty', billed: false })])).toEqual({ cost_usd: 0.2, cost_known: false });
    expect(caseCost('x', [{ cost_usd: 0.2, cost_known: false }], [])).toEqual({ cost_usd: 0.2, cost_known: false });
  });

  test('a case with no record takes its sessions\' billed or streamed cost, else stays unknown', () => {
    expect(caseCost('auq', [], [session({ billed: false, streamed_cost_usd: 0.123 })])).toEqual({ cost_usd: 0.12 });
    expect(caseCost('auq', [], [session({ billed: false })])).toEqual({ cost_usd: 0, cost_known: false });
    expect(caseCost('auq', [], [session({ runner: 'claude-p', billed: true })])).toEqual({ cost_usd: 0, cost_known: false });
  });

  test('only a listed model-free case with neither record nor session costs a known $0', () => {
    expect(caseCost('timeline-event-flow', [], [])).toEqual({ cost_usd: 0 });
    expect(caseCost('some-other-case', [], [])).toEqual({ cost_usd: 0, cost_known: false });
  });

  test('every listed model-free case body starts no model session', () => {
    for (const id of MODEL_FREE_CASES) {
      const file = E2E_TOUCHFILES[id]?.find(entry => /^test\/[^/]+\.test\.ts$/.test(entry));
      expect(file, id).toBeTruthy();
      const source = fs.readFileSync(path.join(ROOT, file!), 'utf8');
      const start = source.search(new RegExp(`IfSelected\\(\\s*['"\`]${id}['"\`]`));
      expect(start, id).toBeGreaterThan(-1);
      const rest = source.slice(start + 1);
      const end = rest.search(/IfSelected\(/);
      const body = end === -1 ? rest : rest.slice(0, end);
      expect(body, id).not.toMatch(/runSkillTest|runAgentSdkTest|runCodex|launchClaudePty|runPtySession|claude-pty|callJudge|judge\w*\(/);
    }
  });
});

describe('recordE2E cost_case_id', () => {
  const entry = (name: string, testName?: string) => {
    const tests: any[] = [];
    const result: any = { toolCalls: [], browseErrors: [], exitReason: 'success', duration: 1, output: '', transcript: [], model: 'claude-opus-5-5',
      costEstimate: { estimatedCost: 0.05, turnsUsed: 1, estimatedTokens: 1 }, ...(testName ? { testName } : {}) };
    recordE2E({ addTest: (t: any) => tests.push(t) } as any, name, 'suite', result);
    return tests[0];
  };

  test('a display-label record carries its registered runSkillTest testName as cost_case_id, and nothing else does', () => {
    expect(entry('browse basic commands', 'browse-basic')).toMatchObject({ name: 'browse basic commands', cost_case_id: 'browse-basic' });
    expect(entry('browse-basic', 'browse-basic').cost_case_id).toBeUndefined();
    expect(entry('browse basic commands', 'not-a-registered-case').cost_case_id).toBeUndefined();
    expect(entry('browse basic commands').cost_case_id).toBeUndefined();
  });
});

describe('junitCensus cost binding', () => {
  const key = 'test/skill-e2e-bws.test.ts';
  const census = (records: any[], ledger: SessionLedgerRow[] = []) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-report-cost-'));
    const shard = path.join(root, 'shards', 'skill-e2e-bws');
    fs.mkdirSync(shard, { recursive: true });
    fs.writeFileSync(path.join(shard, 'junit.xml'), `<testsuites><testsuite name="${key}">
<testcase name="browse-basic" classname="${key}" time="1"></testcase>
<testcase name="browse-snapshot" classname="${key}" time="1"><failure type="AssertionError" message="expected snapshot"/></testcase>
</testsuite></testsuites>`);
    fs.writeFileSync(path.join(shard, 'session-ledger.jsonl'), ledger.map(row => JSON.stringify(row)).join('\n'));
    const manifest: any = { version: 1, tier: 'gate', evalsAll: true, sliceCount: 1, profile: 'full', selection: { e2e: null, judges: null }, entries: [{ file: key, slice: 1, status: 'planned', estimatedMs: 1 }] };
    const result: any = { version: 1, tier: 'gate', profile: 'full', selection: { e2e: null, judges: null }, sliceIndex: 1, sliceCount: 1, attempt: 1,
      outcomes: [{ files: [key], status: 'failed', exitCode: 1, elapsedMs: 10, executedTests: 2, skippedTests: 0 }] };
    try { return junitCensus(manifest, [{ root, result }], new Map([[key, records]]), {}); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  const labelled = [
    { name: 'browse basic commands', passed: true, cost_usd: 0.05, cost_case_id: 'browse-basic' },
    { name: 'browse snapshot flags', passed: false, cost_usd: 0.06, cost_case_id: 'browse-snapshot', exit_reason: 'timeout', failure_class: 'infra', error: 'record error' },
  ];

  test('display-label records bind their cost by cost_case_id in a multi-case shard', () => {
    const cases = census(labelled).ruleCases;
    expect(cases.map(c => [c.id, c.costUsd, c.costKnown])).toEqual([['browse-basic', 0.05, true], ['browse-snapshot', 0.06, true]]);
  });

  test('the failed record and failure class stay what the named records give, as without cost_case_id', () => {
    const bound = census(labelled).ruleCases.find(c => c.id === 'browse-snapshot')!;
    const unbound = census(labelled.map(({ cost_case_id, ...rest }) => rest)).ruleCases.find(c => c.id === 'browse-snapshot')!;
    expect(unbound).toMatchObject({ costUsd: 0, costKnown: false });
    expect({ failureClass: bound.failureClass, error: bound.error, line: bound.line?.replace(/ {2}\[slice.*$/, '') })
      .toEqual({ failureClass: unbound.failureClass, error: unbound.error, line: unbound.line?.replace(/ {2}\[slice.*$/, '') });
    expect(bound.failureClass).toBe('assertion');
  });

  test('a cost-only record never sets the trial\'s model, which keys its pass-rate series', () => {
    const history = census(labelled.map(r => ({ ...r, model: 'claude-opus-5-5' }))).history;
    expect(history.map(h => [h.case, h.model])).toEqual([['browse-basic', undefined], ['browse-snapshot', undefined]]);
  });
});

describe('PTY transcript pricing (GSTA-150 PR 3)', () => {
  const SID = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-2222-4333-8444-555555555555';
  const assistant = (sid: string, id: string, model: string, usage: object, extra: object = {}) =>
    JSON.stringify({ type: 'assistant', sessionId: sid, cwd: '/fixture/cwd', message: { id, model, role: 'assistant', usage }, ...extra });
  const fixture = (write: (project: string) => void) => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-cost-'));
    const project = path.join(config, 'projects', '-fixture-cwd');
    fs.mkdirSync(project, { recursive: true });
    write(project);
    return config;
  };

  test('prices the session, its inline sidechains and subagent files, each message id once at its largest output', () => {
    const config = fixture(project => {
      fs.writeFileSync(path.join(project, `${SID}.jsonl`), [
        JSON.stringify({ type: 'user', sessionId: SID, message: { role: 'user', content: 'hi' } }),
        assistant(SID, 'msg_a', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 10 }),
        assistant(SID, 'msg_a', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 500 }),
        assistant(SID, 'msg_side', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 1000 }, { isSidechain: true }),
        assistant(SID, 'msg_syn', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
        '{"partial":',
      ].join('\n'));
      fs.mkdirSync(path.join(project, SID, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(project, SID, 'subagents', 'agent-x.jsonl'),
        assistant(SID, 'msg_sub', 'claude-opus-5-5', { input_tokens: 0, cache_read_input_tokens: 10000, output_tokens: 0 }) + '\n');
      fs.writeFileSync(path.join(project, `${OTHER}.jsonl`), assistant(OTHER, 'msg_foreign', 'claude-opus-5-5', { input_tokens: 1_000_000 }) + '\n');
    });
    try {
      // opus-5-5: $4 in, $20 out, $0.20 cached per MTok.
      const expected = (1000 * 4 + 500 * 20 + 1000 * 20 + 10000 * 0.2) / 1_000_000;
      expect(ptyTranscriptCostUsd(config, SID)).toBeCloseTo(expected, 6);
      expect(pricedTranscript({ transcriptCostUsd: () => ptyTranscriptCostUsd(config, SID) }).streamed_cost_usd).toBeCloseTo(expected, 6);
    } finally { fs.rmSync(config, { recursive: true, force: true }); }
  });

  test('stays cost-unknown without a transcript, a session id, usage, a priced model or a readable file, and never throws', () => {
    const unpriced = fixture(project => fs.writeFileSync(path.join(project, `${SID}.jsonl`),
      assistant(SID, 'msg_a', 'claude-opus-5-5', { output_tokens: 1 }) + '\n' + assistant(SID, 'msg_b', 'some-unpriced-model', { output_tokens: 1 }) + '\n'));
    const empty = fixture(project => fs.writeFileSync(path.join(project, `${SID}.jsonl`), JSON.stringify({ type: 'user', sessionId: SID }) + '\n'));
    const unreadable = fixture(project => fs.mkdirSync(path.join(project, `${SID}.jsonl`)));
    try {
      expect(ptyTranscriptCostUsd(unpriced, SID)).toBeUndefined();
      expect(ptyTranscriptCostUsd(empty, SID)).toBeUndefined();
      expect(ptyTranscriptCostUsd(empty, OTHER)).toBeUndefined();
      expect(ptyTranscriptCostUsd(unpriced, undefined)).toBeUndefined();
      expect(ptyTranscriptCostUsd(null, SID)).toBeUndefined();
      expect(ptyTranscriptCostUsd(path.join(empty, 'missing'), SID)).toBeUndefined();
      expect(ptyTranscriptCostUsd(unreadable, SID)).toBeUndefined();
      expect(newTranscriptSessionId(unreadable, new Set(), '/fixture/cwd')).toBeUndefined();
      expect(pricedTranscript(undefined)).toEqual({});
      expect(pricedTranscript({})).toEqual({});
    } finally { for (const dir of [unpriced, empty, unreadable]) fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a launch claims only the one transcript it created for its own cwd', () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-cost-cwd-')));
    const line = (sid: string, at: string) => JSON.stringify({ type: 'user', sessionId: sid, cwd: at }) + '\n';
    const config = fixture(project => fs.writeFileSync(path.join(project, `${OTHER}.jsonl`), line(OTHER, cwd)));
    try {
      const before = transcriptFiles(config);
      const project = path.join(config, 'projects', '-fixture-cwd');
      fs.writeFileSync(path.join(project, '22222222-2222-4333-8444-555555555555.jsonl'), line('22222222-2222-4333-8444-555555555555', '/a/concurrent/test'));
      expect(newTranscriptSessionId(config, before, cwd)).toBeUndefined();
      fs.writeFileSync(path.join(project, `${SID}.jsonl`), line(SID, cwd));
      expect(newTranscriptSessionId(config, before, cwd)).toBe(SID);
      fs.writeFileSync(path.join(project, '33333333-2222-4333-8444-555555555555.jsonl'), line('33333333-2222-4333-8444-555555555555', cwd));
      expect(newTranscriptSessionId(config, before, cwd)).toBeUndefined();
    } finally { fs.rmSync(config, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
