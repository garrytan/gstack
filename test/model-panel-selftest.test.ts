/**
 * Model panel selftest (free, no model, no spend): every hidden check fails on
 * its seed fixture and passes on its reference answer, gateway arms carry no
 * Anthropic credential, and the INFRA classes, cost math and preregistered
 * wording rule behave as written, so the paid panel
 * (test/skill-e2e-model-panel.test.ts) never spends on a broken instrument.
 * GST-468: each model also runs as `<model>#no-gstack` (no skill folder, no
 * routing line), every key is the arm identity, the candidate's view names a
 * project rather than the instrument or arm, the summary reads one campaign,
 * and the rendered results.md passes `results --check` against PREREG.md.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  PANEL_ARMS, PANEL_TASKS, PANEL_TRIALS, PANEL_MIN_COMPLETED, PANEL_PREREG, PANEL_SPEND_CAP_USD,
  setupCell, applyReference, runCheck, armEnv, cellCostUsd, cellKeys, classifyCell, summarize, suggestionLine, renderResults, wilson, usageFromTranscript,
  type CellUsage, type PanelCampaign, type PanelRow, type PanelArmId,
} from './helpers/model-panel-harness';
import { buildBehavioralSkill, run, SKILL_NAME } from './helpers/arm-benchmark-harness';
import { armIdentities, checkPrereg } from '../lib/eval-plan';
import { checkResults } from '../lib/eval-plan-report';

const arm = (id: PanelArmId) => PANEL_ARMS.find((a) => a.id === id)!;
const usage = (over: Partial<CellUsage> = {}): CellUsage => ({ input: 1000, cached: 0, cacheWrite: 0, output: 100, modelsBilled: [], isError: false, apiErrorStatus: null, turns: 3, ...over });
const CAMPAIGN: PanelCampaign = { runId: 'campaign-1', preregSha: 'a'.repeat(64) };
const MAIN_SKILL_CLAUDE_MD = '# Project\n\nSmall fixture repo for one ticket.\n\n## Skill routing\n\nBefore working on any ticket, invoke the ' + SKILL_NAME + ' skill via the Skill tool and follow it while you work.\n';
const PLAIN_CLAUDE_MD = '# Project\n\nSmall fixture repo for one ticket.\n';

function tree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (p === '.git') continue;
    if (e.isDirectory()) Object.assign(out, tree(dir, p));
    else out[p] = fs.readFileSync(path.join(dir, p), 'utf-8');
  }
  return out;
}

describe('model panel selftest (free, no API)', () => {
  for (const task of PANEL_TASKS) {
    test(task.id + ': the hidden check fails on the seed and passes on the reference', () => {
      expect(fs.existsSync(task.check)).toBe(true);
      const seed = setupCell(task, 'skill');
      const ref = setupCell(task, 'skill');
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

  test('the panel is the preregistered shape: 5 tasks, 8 arms (4 models, each with and without the skill), 3 trials', () => {
    expect(PANEL_TASKS.map((t) => t.id)).toEqual(['model-panel-bugfix', 'model-panel-crud', 'model-panel-review', 'model-panel-changelog', 'model-panel-investigate']);
    expect(PANEL_ARMS.map((a) => a.identity)).toEqual([
      'claude-opus-5-5', 'claude-opus-5-5#no-gstack',
      'claude-sonnet-5-5', 'claude-sonnet-5-5#no-gstack',
      'particle-ai/particle-1', 'particle-ai/particle-1#no-gstack',
      'deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash-1017#no-gstack',
    ]);
    expect(PANEL_ARMS.filter((a) => a.loadout === 'skill').map((a) => a.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'particle-ai/particle-1', 'deepseek/deepseek-v4.1-flash-1017']);
    expect(PANEL_TRIALS).toBe(3);
    expect(PANEL_SPEND_CAP_USD).toBe(15);
  });

  test('each model has a #no-gstack arm with the same model, route, reservation and child env', () => {
    const source = { OPENROUTER_API_KEY: 'sk-or-test', ANTHROPIC_API_KEY: 'sk-ant-real', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real' };
    const skill = PANEL_ARMS.filter((a) => a.loadout === 'skill');
    expect(skill).toHaveLength(4);
    for (const s of skill) {
      const plain = PANEL_ARMS.filter((a) => a.loadout === 'no-gstack' && a.id === s.id);
      expect(plain).toHaveLength(1);
      expect(plain[0]!.identity).toBe(s.model + '#no-gstack');
      expect({ model: plain[0]!.model, route: plain[0]!.route, reserveUsd: plain[0]!.reserveUsd }).toEqual({ model: s.model, route: s.route, reserveUsd: s.reserveUsd });
      expect(armEnv(plain[0]!, source)).toEqual(armEnv(s, source));
    }
  });

  test('PREREG.md passes prereg --check and its Arms are exactly the panel identities', () => {
    const text = fs.readFileSync(PANEL_PREREG, 'utf-8');
    const r = checkPrereg(text);
    expect(r.ok).toBe(true);
    expect(r.comparison.stack).toBe('loaded');
    expect(armIdentities(text)).toEqual(PANEL_ARMS.map((a) => a.identity));
    expect(r.no_gstack.arms).toEqual(PANEL_ARMS.filter((a) => a.loadout === 'no-gstack').map((a) => a.identity));
  });

  test('every (task, identity, trial) ledger attempt and test name is unique across the 8 arms', () => {
    const keys = PANEL_TASKS.flatMap((t) => PANEL_ARMS.flatMap((a) => Array.from({ length: PANEL_TRIALS }, (_, i) => cellKeys(t, a, i + 1, CAMPAIGN.runId))));
    expect(keys).toHaveLength(5 * 8 * 3);
    expect(new Set(keys.map((k) => k.attempt)).size).toBe(keys.length);
    expect(new Set(keys.map((k) => k.testName)).size).toBe(keys.length);
    const k = cellKeys(PANEL_TASKS[0]!, PANEL_ARMS[1]!, 2, CAMPAIGN.runId);
    expect(k.attempt).toBe('model-panel-bugfix:claude-opus-5-5#no-gstack:2:campaign-1');
  });

  const skillTree = (task: (typeof PANEL_TASKS)[number]): Record<string, string> => {
    const fixture = tree(task.fixture);
    return { ...fixture, 'CLAUDE.md': MAIN_SKILL_CLAUDE_MD, [path.join('.claude', 'skills', SKILL_NAME, 'SKILL.md')]: buildBehavioralSkill(), ...('.gitignore' in fixture ? {} : { '.gitignore': 'node_modules/\n' }) };
  };

  test('setupCell: the skill cell\'s tree is main\'s, byte for byte (only the folder name and git author change)', () => {
    for (const task of PANEL_TASKS) {
      const cell = setupCell(task, 'skill');
      try {
        expect(tree(cell.dir)).toEqual(skillTree(task));
        expect(run('git', ['status', '--porcelain'], cell.dir)).toBe('');
      } finally {
        fs.rmSync(cell.dir, { recursive: true, force: true });
      }
    }
  });

  test('setupCell: the no-gstack cell has no skill folder and no routing line, and is otherwise the skill cell\'s tree', () => {
    for (const task of PANEL_TASKS) {
      const cell = setupCell(task, 'no-gstack');
      try {
        expect(fs.existsSync(path.join(cell.dir, '.claude'))).toBe(false);
        const { [path.join('.claude', 'skills', SKILL_NAME, 'SKILL.md')]: _skill, ...rest } = skillTree(task);
        expect(tree(cell.dir)).toEqual({ ...rest, 'CLAUDE.md': PLAIN_CLAUDE_MD });
        expect(run('git', ['status', '--porcelain'], cell.dir)).toBe('');
      } finally {
        fs.rmSync(cell.dir, { recursive: true, force: true });
      }
    }
  });

  test('the candidate\'s view (folder, git log, CLAUDE.md, ticket) carries no eval, arm or loadout word', () => {
    const evalWords = /\b(?:evals?|judge|experiment|rubric|score|compare|benchmark|candidate|arena)\b/i;
    const armWords = /\b(?:panel|arms?|trials?|loadout|gstack|opus|sonnet|particle|deepseek|claude-[a-z0-9-]+)\b/i;
    for (const task of PANEL_TASKS) {
      for (const loadout of ['skill', 'no-gstack'] as const) {
        const cell = setupCell(task, loadout);
        try {
          const folder = path.basename(cell.dir);
          const log = run('git', ['log', '--format=%an %ae %cn %ce %s'], cell.dir);
          const claudeMd = fs.readFileSync(path.join(cell.dir, 'CLAUDE.md'), 'utf-8');
          for (const [where, text] of [['folder', folder], ['git log', log], ['CLAUDE.md', claudeMd], ['ticket', task.ticket]] as const) {
            expect(text, task.id + ' ' + loadout + ' ' + where).not.toMatch(evalWords);
            expect(text, task.id + ' ' + loadout + ' ' + where).not.toMatch(armWords);
          }
          for (const text of [folder, log, claudeMd]) expect(text).not.toMatch(/test/i);
          if (loadout === 'no-gstack') expect(claudeMd).not.toMatch(/skill/i);
        } finally {
          fs.rmSync(cell.dir, { recursive: true, force: true });
        }
      }
    }
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

  /** Rows keyed by arm identity; a bare model id (opus, sonnet, particle, deepseek) names that model's skill arm. */
  const rows = (counts: Record<string, [number, number, number]>, campaign: PanelCampaign = CAMPAIGN): PanelRow[] =>
    Object.entries(counts).flatMap(([key, [passes, fails, infra]]) => {
      const a = PANEL_ARMS.find((x) => x.identity === key) ?? PANEL_ARMS.find((x) => x.id === key && x.loadout === 'skill')!;
      const cost = { opus: 0.6, sonnet: 0.3, particle: 0.02, deepseek: 0.03 }[a.id] * (a.loadout === 'no-gstack' ? 0.5 : 1);
      const make = (verdict: PanelRow['verdict'], i: number): PanelRow => ({ ...campaign, task: 't', arm: a.identity, loadout: a.loadout, model: a.model, route: a.route, trial: i, verdict, reason: '', exitReason: 'success', costUsd: verdict === 'infra' ? null : cost, usage: null, durationMs: 1, consulted: a.loadout === 'skill' });
      return [...Array(passes).fill('pass'), ...Array(fails).fill('fail'), ...Array(infra).fill('infra')].map((v, i) => make(v, i));
    });

  test('wording rule: overlap says no measured difference and quotes counts and cost; never "comparable" or "better"', () => {
    const s = suggestionLine(summarize(rows({ opus: [14, 1, 0], sonnet: [13, 2, 0], particle: [12, 3, 0], deepseek: [11, 4, 0] }), CAMPAIGN), '2026-10-30');
    expect(s.reason).toBe('ok');
    expect(s.line).toContain('particle-1 passed 12/15');
    expect(s.line).toContain('Sonnet 5.5 13/15');
    expect(s.line).toContain('no measured difference from Sonnet 5.5 on this panel');
    expect(s.line).toContain('the cheapest of the four models measured');
    expect(s.line).not.toMatch(/comparable|better/i);
  });

  test('wording rule: a clear gap is named, the usefulness floor withholds the suggestion, thin arms are INCOMPLETE', () => {
    const floor = suggestionLine(summarize(rows({ opus: [15, 0, 0], sonnet: [15, 0, 0], particle: [6, 9, 0], deepseek: [5, 10, 0] }), CAMPAIGN), '2026-10-30');
    expect(floor.line).toBeNull();
    expect(floor.reason).toContain('below the usefulness floor');
    expect(floor.reason).toContain('below Sonnet 5.5 on this panel');
    const thin = suggestionLine(summarize(rows({ opus: [15, 0, 0], sonnet: [15, 0, 0], particle: [8, 2, PANEL_TRIALS * 5 - 10], deepseek: [15, 0, 0] }), CAMPAIGN), '2026-10-30');
    expect(thin.line).toBeNull();
    expect(thin.reason).toStartWith('INCOMPLETE');
    expect(PANEL_MIN_COMPLETED).toBe(12);
  });

  test('wording rule reads only the skill arms: 8-arm rows with cheaper no-gstack arms give the 4-arm line byte for byte', () => {
    const four = { opus: [14, 1, 0], sonnet: [13, 2, 0], particle: [12, 3, 0], deepseek: [11, 4, 0] } as Record<string, [number, number, number]>;
    const plain = { 'claude-opus-5-5#no-gstack': [15, 0, 0], 'claude-sonnet-5-5#no-gstack': [2, 1, 0], 'particle-ai/particle-1#no-gstack': [1, 1, 13], 'deepseek/deepseek-v4.1-flash-1017#no-gstack': [15, 0, 0] } as Record<string, [number, number, number]>;
    const base = suggestionLine(summarize(rows(four), CAMPAIGN), '2026-10-30');
    const eight = suggestionLine(summarize(rows({ ...four, ...plain }), CAMPAIGN), '2026-10-30');
    expect(base.reason).toBe('ok');
    expect(eight).toEqual(base);
    expect(summarize(rows({ ...four, ...plain }), CAMPAIGN).find((s) => s.arm === 'particle-ai/particle-1#no-gstack')!.costPerTaskUsd).toBeLessThan(0.02);
  });

  test('summarize reads only the current campaign and refuses a duplicate cell', () => {
    const current = rows({ opus: [2, 1, 0], 'claude-opus-5-5#no-gstack': [1, 2, 0] });
    const otherRun = rows({ opus: [0, 9, 0] }, { runId: 'campaign-0', preregSha: CAMPAIGN.preregSha });
    const otherPrereg = rows({ opus: [9, 0, 0] }, { runId: CAMPAIGN.runId, preregSha: 'b'.repeat(64) });
    const legacy = rows({ opus: [5, 0, 0] }).map(({ runId: _r, preregSha: _p, ...r }) => ({ ...r, arm: 'opus' }) as unknown as PanelRow);
    const s = summarize([...otherRun, ...current, ...otherPrereg, ...legacy], CAMPAIGN);
    expect(s.find((x) => x.arm === 'claude-opus-5-5')).toMatchObject({ passes: 2, completed: 3, cells: 3 });
    expect(s.find((x) => x.arm === 'claude-opus-5-5#no-gstack')).toMatchObject({ passes: 1, completed: 3, cells: 3 });
    expect(s.map((x) => x.arm)).toEqual(PANEL_ARMS.map((a) => a.identity));
    expect(() => summarize([...current, current[0]!], CAMPAIGN)).toThrow('duplicate cell');
  });

  test('renderResults: one row per identity, and results.md passes results --check against PREREG.md', () => {
    const prereg = fs.readFileSync(PANEL_PREREG, 'utf-8');
    const all = rows(Object.fromEntries(PANEL_ARMS.map((a) => [a.identity, [12, 2, 1]])));
    const md = renderResults(summarize(all, CAMPAIGN), { ...CAMPAIGN, measuredOn: '2026-10-31' });
    expect(md).toContain('campaign-1');
    expect(md).toContain('| `claude-opus-5-5#no-gstack` | no-gstack | 12/14 | ');
    const thin = renderResults(summarize(rows({ opus: [2, 1, 0] }), CAMPAIGN), { ...CAMPAIGN, measuredOn: '2026-10-31' });
    expect(thin).toContain('| `claude-opus-5-5` | skill | 2/3 INCOMPLETE | ');
    expect(thin).toContain('| `claude-opus-5-5#no-gstack` | — | — |');
    for (const a of PANEL_ARMS) expect(md).toContain('| `' + a.identity + '` |');
    const r = checkResults(prereg, md);
    expect(r).toMatchObject({ ok: true, missing: [] });
    expect(r.found).toEqual(PANEL_ARMS.map((a) => a.identity));
    const skillOnly = renderResults(summarize(rows({ opus: [12, 2, 1], sonnet: [12, 2, 1], particle: [12, 2, 1], deepseek: [12, 2, 1] }), CAMPAIGN), { ...CAMPAIGN, measuredOn: '2026-10-31' });
    const refused = checkResults(prereg, skillOnly);
    expect(refused.ok).toBe(false);
    expect(refused.missing).toEqual(PANEL_ARMS.filter((a) => a.loadout === 'no-gstack').map((a) => a.identity));
  });
});
