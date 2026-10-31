/**
 * Model panel selftest (free, no model, no spend): every hidden check fails on
 * its seed fixture and passes on its reference answer, gateway arms carry no
 * Anthropic credential, and the INFRA classes, cost math and preregistered
 * wording rule behave as written, so the paid panel
 * (test/skill-e2e-model-panel.test.ts) never spends on a broken instrument.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import {
  PANEL_ARMS, PANEL_TASKS, PANEL_TRIALS, PANEL_MIN_COMPLETED,
  setupCell, applyReference, runCheck, armEnv, cellCostUsd, classifyCell, summarize, suggestionLine, wilson, usageFromTranscript,
  type CellUsage, type PanelRow, type PanelArmId,
} from './helpers/model-panel-harness';

const arm = (id: PanelArmId) => PANEL_ARMS.find((a) => a.id === id)!;
const usage = (over: Partial<CellUsage> = {}): CellUsage => ({ input: 1000, cached: 0, cacheWrite: 0, output: 100, modelsBilled: [], isError: false, apiErrorStatus: null, turns: 3, ...over });

describe('model panel selftest (free, no API)', () => {
  for (const task of PANEL_TASKS) {
    test(task.id + ': the hidden check fails on the seed and passes on the reference', () => {
      expect(fs.existsSync(task.check)).toBe(true);
      const seed = setupCell(task, 'selftest-seed');
      const ref = setupCell(task, 'selftest-ref');
      try {
        expect(runCheck(task, seed.dir).pass).toBe(false);
        applyReference(task, ref.dir);
        const passed = runCheck(task, ref.dir);
        expect(passed.detail).toBe('PASS');
        expect(passed.pass).toBe(true);
      } finally {
        fs.rmSync(seed.dir, { recursive: true, force: true });
        fs.rmSync(ref.dir, { recursive: true, force: true });
      }
    });
  }

  test('the panel is the preregistered shape: 5 tasks, 4 arms, 3 trials', () => {
    expect(PANEL_TASKS.map((t) => t.id)).toEqual(['model-panel-bugfix', 'model-panel-crud', 'model-panel-review', 'model-panel-changelog', 'model-panel-investigate']);
    expect(PANEL_ARMS.map((a) => a.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'particle-ai/particle-1', 'deepseek/deepseek-v4.1-flash-1017']);
    expect(PANEL_TRIALS).toBe(3);
  });

  test('gateway arms carry no Anthropic credential and pin every alias; Anthropic arms add nothing', () => {
    const source = { OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'sk-ant-real', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real' };
    const env = armEnv(arm('particle'), source);
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(Object.values(env)).not.toContain('sk-ant-real');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-test');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    for (const k of ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
      expect(env[k]).toBe('particle-ai/particle-1');
    }
    expect(armEnv(arm('sonnet'), source)).toEqual({});
    expect(() => armEnv(arm('deepseek'), {})).toThrow('OPENROUTER_API_KEY');
  });

  test('INFRA classes: startup timeout, missing result, MODEL_MIX, 402/429/5xx and pre-turn errors; the rest is scored', () => {
    const p = arm('particle');
    expect(classifyCell(p, 'timeout_startup', null)).toEqual({ verdict: 'infra', reason: 'startup timeout' });
    expect(classifyCell(p, 'error', null).verdict).toBe('infra');
    expect(classifyCell(p, 'success', usage({ modelsBilled: ['particle-ai/particle-1', 'claude-haiku-5-5'] }))).toEqual({ verdict: 'infra', reason: 'MODEL_MIX: claude-haiku-5-5' });
    expect(classifyCell(p, 'success', usage({ modelsBilled: ['particle-1'] }))).toEqual({ verdict: 'scored' });
    for (const status of [402, 429, 503]) expect(classifyCell(p, 'error', usage({ isError: true, apiErrorStatus: status })).verdict).toBe('infra');
    expect(classifyCell(p, 'error', usage({ isError: true, turns: 0 })).verdict).toBe('infra');
    expect(classifyCell(p, 'timeout', usage({ turns: 12 }))).toEqual({ verdict: 'scored' });
    expect(classifyCell(p, 'error_max_turns', usage({ isError: true, turns: 40 }))).toEqual({ verdict: 'scored' });
  });

  test('cost comes from the price table, with cache writes, never the CLI total', () => {
    expect(cellCostUsd(arm('particle'), usage({ input: 1_000_000, cached: 1_000_000, output: 1_000_000 }))).toBeCloseTo(0.25 + 0.03 + 1.0, 6);
    expect(cellCostUsd(arm('opus'), usage({ input: 0, output: 0, cacheWrite: 1_000_000 }))).toBeCloseTo(4.0 * 1.25, 6);
    expect(cellCostUsd(arm('deepseek'), usage({ input: 1_000_000, output: 0 }))).toBeCloseTo(0.15, 6);
    const u = usageFromTranscript([{ type: 'assistant' }, { type: 'result', total_cost_usd: 9.99, num_turns: 4, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }, modelUsage: { 'particle-ai/particle-1': {} } }]);
    expect(u).toEqual({ input: 10, cached: 5, cacheWrite: 1, output: 2, modelsBilled: ['particle-ai/particle-1'], isError: false, apiErrorStatus: null, turns: 4 });
    expect(usageFromTranscript([{ type: 'assistant' }])).toBeNull();
  });

  test('wilson intervals', () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    const w = wilson(12, 15);
    expect(w.low).toBeCloseTo(0.548, 2);
    expect(w.high).toBeCloseTo(0.930, 2);
  });

  const rows = (counts: Record<PanelArmId, [number, number, number]>): PanelRow[] =>
    (Object.entries(counts) as Array<[PanelArmId, [number, number, number]]>).flatMap(([id, [passes, fails, infra]]) => {
      const a = arm(id);
      const cost = { opus: 0.6, sonnet: 0.3, particle: 0.02, deepseek: 0.03 }[id];
      const make = (verdict: PanelRow['verdict'], i: number): PanelRow => ({ task: 't', arm: id, model: a.model, route: a.route, trial: i, verdict, reason: '', exitReason: 'success', costUsd: verdict === 'infra' ? null : cost, usage: null, durationMs: 1, consulted: true });
      return [...Array(passes).fill('pass'), ...Array(fails).fill('fail'), ...Array(infra).fill('infra')].map((v, i) => make(v, i));
    });

  test('wording rule: overlap says no measured difference and quotes counts and cost; never "comparable" or "better"', () => {
    const s = suggestionLine(summarize(rows({ opus: [14, 1, 0], sonnet: [13, 2, 0], particle: [12, 3, 0], deepseek: [11, 4, 0] })), '2026-10-30');
    expect(s.reason).toBe('ok');
    expect(s.line).toContain('particle-1 passed 12/15');
    expect(s.line).toContain('Sonnet 5.5 13/15');
    expect(s.line).toContain('no measured difference from Sonnet 5.5 on this panel');
    expect(s.line).toContain('the cheapest of the four models measured');
    expect(s.line).not.toMatch(/comparable|better/i);
  });

  test('wording rule: a clear gap is named, the usefulness floor withholds the suggestion, thin arms are INCOMPLETE', () => {
    const floor = suggestionLine(summarize(rows({ opus: [15, 0, 0], sonnet: [15, 0, 0], particle: [6, 9, 0], deepseek: [5, 10, 0] })), '2026-10-30');
    expect(floor.line).toBeNull();
    expect(floor.reason).toContain('below the usefulness floor');
    expect(floor.reason).toContain('below Sonnet 5.5 on this panel');
    const thin = suggestionLine(summarize(rows({ opus: [15, 0, 0], sonnet: [15, 0, 0], particle: [8, 2, PANEL_TRIALS * 5 - 10], deepseek: [15, 0, 0] })), '2026-10-30');
    expect(thin.line).toBeNull();
    expect(thin.reason).toStartWith('INCOMPLETE');
    expect(PANEL_MIN_COMPLETED).toBe(12);
  });
});
