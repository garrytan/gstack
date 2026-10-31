/**
 * Model panel harness: one fixed panel of gstack-shaped engineering tasks run
 * by several models in the same Claude Code harness, each cell scored by a
 * hidden deterministic check. Shared by the paid periodic run
 * (test/skill-e2e-model-panel.test.ts) and the free selftest
 * (test/model-panel-selftest.test.ts), which proves every check fails on its
 * seed fixture and passes on a reference answer before any money is spent.
 *
 * Preregistered (GSTA-173, 2026-10-30) before the first paid run: the arms,
 * tasks, checks, PANEL_TRIALS, the INFRA classes in classifyCell, the spend
 * reservations and the wording rule in suggestionLine. None of them change
 * after a result is seen.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ROOT, copyDirSync } from './e2e-helpers';
import { buildBehavioralSkill, run, SKILL_NAME, FIXTURES as ARM_FIXTURES } from './arm-benchmark-harness';
import { GATEWAY_MODELS, foreignModels, gatewayOverrides } from './providers/gateway';
import { estimateCostUsd, pricingRow } from './pricing';

export const PANEL_FIXTURES = path.join(ROOT, 'test', 'fixtures', 'model-panel');
export const PANEL_TRIALS = 3;
export const PANEL_MAX_TURNS = 40;
export const PANEL_TIMEOUT_MS = 8 * 60_000;
export const PANEL_CONCURRENCY = 4;
export const PANEL_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'];
/** Completed (non-INFRA) cells an arm needs before the panel publishes anything about it. */
export const PANEL_MIN_COMPLETED = 12;
/** Pass rate below which the panel publishes numbers but no "worth trying" suggestion. */
export const PANEL_USEFULNESS_FLOOR = 0.6;
export const PANEL_SPEND_CAP_USD = 15;

export type PanelArmId = 'opus' | 'sonnet' | 'particle' | 'deepseek';
export interface PanelArm {
  id: PanelArmId;
  label: string;
  model: string;
  route: 'anthropic' | 'openrouter';
  /** Worst-case USD reserved for one cell before it starts; settled to the measured cost after. */
  reserveUsd: number;
}

export const PANEL_ARMS: PanelArm[] = [
  { id: 'opus', label: 'Opus 5.5', model: 'claude-opus-5-5', route: 'anthropic', reserveUsd: 2.0 },
  { id: 'sonnet', label: 'Sonnet 5.5', model: 'claude-sonnet-5-5', route: 'anthropic', reserveUsd: 1.0 },
  { id: 'particle', label: 'particle-1', model: GATEWAY_MODELS.particle, route: 'openrouter', reserveUsd: 0.15 },
  { id: 'deepseek', label: 'DeepSeek V4.1 Flash', model: GATEWAY_MODELS.deepseek, route: 'openrouter', reserveUsd: 0.15 },
];

export interface PanelTask {
  /** E2E_TOUCHFILES / E2E_TIERS key. */
  id: string;
  fixture: string;
  check: string;
  reference: string;
  ticket: string;
}

const fixture = (name: string) => path.join(PANEL_FIXTURES, name);
const check = (name: string) => path.join(PANEL_FIXTURES, 'checks', name + '.js');
const reference = (name: string) => path.join(PANEL_FIXTURES, 'reference', name);
const LEAVE = '\n\nLeave your changes uncommitted in the working tree.';

export const PANEL_TASKS: PanelTask[] = [
  {
    id: 'model-panel-bugfix',
    fixture: path.join(ARM_FIXTURES, 'bugfix-decoys'),
    check: check('bugfix-decoys'),
    reference: reference('bugfix-decoys'),
    ticket: 'Bug report: receipts print $10.5 for a $10.05 item.\n\nYou are in a small git repo. `node run-tests.js` currently fails on formatPrice(1005).\nFix the bug so all tests pass. Verify with: node run-tests.js' + LEAVE,
  },
  {
    id: 'model-panel-crud',
    fixture: path.join(ARM_FIXTURES, 'crud-endpoint'),
    check: check('crud-endpoint'),
    reference: reference('crud-endpoint'),
    ticket: 'Ticket: users need to delete notes.\n\nYou are in a small git repo containing an in-memory notes API (app.js, wired to HTTP in server.js).\nAdd DELETE /notes/:id: respond 204 on success and 404 for an unknown id, and cover the new endpoint in run-tests.js. Verify with: node run-tests.js' + LEAVE,
  },
  {
    id: 'model-panel-review',
    fixture: fixture('review-seeded-bug'),
    check: check('review-seeded-bug'),
    reference: reference('review-seeded-bug'),
    ticket: 'Pre-landing review: PR.md describes a teammate\'s change, which added src/users.js.\n\nReview src/users.js the way a careful reviewer would before it ships: find the bugs that pass a quick read but break in production. Do not edit any source file. Write REVIEW.md with one numbered finding per bug, each naming file:line, what goes wrong, and the fix.' + LEAVE,
  },
  {
    id: 'model-panel-changelog',
    fixture: fixture('changelog'),
    check: check('changelog'),
    reference: reference('changelog'),
    ticket: 'Release 1.4.0: write its CHANGELOG.md entry from COMMITS.md.\n\nRules: the new section goes above 1.3.0 and matches its format; list only changes a user of the app would notice, in everyday words; leave out build, test and tooling changes; do not edit older sections.' + LEAVE,
  },
  {
    id: 'model-panel-investigate',
    fixture: fixture('investigate'),
    check: check('investigate'),
    reference: reference('investigate'),
    ticket: 'Bug: `node run-tests.js` fails, and the report shows the wrong day for some hikes.\n\nFind the root cause before you change anything, then fix it at the root. Do not edit the tests. Verify with: node run-tests.js' + LEAVE,
  },
];

export interface CellDirs { dir: string; seedSha: string }

/** Fresh copy of the task fixture with the build-discipline skill installed (every arm alike) and one seed commit. */
export function setupCell(task: PanelTask, label: string): CellDirs {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-' + label + '-'));
  copyDirSync(task.fixture, dir);
  const skillDir = path.join(dir, '.claude', 'skills', SKILL_NAME);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildBehavioralSkill());
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\n\nSmall fixture repo for one ticket.\n\n## Skill routing\n\nBefore working on any ticket, invoke the ' + SKILL_NAME + ' skill via the Skill tool and follow it while you work.\n');
  if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  run('git', ['init', '-b', 'main'], dir);
  run('git', ['config', 'user.email', 'model-panel@example.com'], dir);
  run('git', ['config', 'user.name', 'Model Panel'], dir);
  run('git', ['config', 'commit.gpgsign', 'false'], dir);
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-m', 'seed fixture'], dir);
  return { dir, seedSha: run('git', ['rev-parse', 'HEAD'], dir).trim() };
}

/** Overlay the task's reference answer (selftest only). */
export function applyReference(task: PanelTask, dir: string): void {
  copyDirSync(task.reference, dir);
}

/** Run the hidden check against a cell directory. Never throws. */
export function runCheck(task: PanelTask, dir: string): { pass: boolean; detail: string } {
  const r = spawnSync(process.execPath, [task.check, dir], { stdio: 'pipe', encoding: 'utf-8', timeout: 60_000 });
  const detail = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n').pop() ?? '';
  return { pass: r.status === 0, detail: detail.slice(0, 400) };
}

/** Extra child env for an arm: nothing for Anthropic arms, the gateway route (no Anthropic credential) otherwise. */
export function armEnv(arm: PanelArm, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return arm.route === 'openrouter' ? gatewayOverrides(arm.model, source) : {};
}

export interface CellUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  modelsBilled: string[];
  isError: boolean;
  apiErrorStatus: number | null;
  turns: number;
}

/** Usage from the CLI's final result event; null when the transcript has none. */
export function usageFromTranscript(transcript: any[]): CellUsage | null {
  const result = [...transcript].reverse().find((e) => e && e.type === 'result');
  if (!result) return null;
  const u = result.usage ?? {};
  return {
    input: u.input_tokens ?? 0,
    cached: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    modelsBilled: result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [],
    isError: result.is_error === true,
    apiErrorStatus: typeof result.api_error_status === 'number' ? result.api_error_status : null,
    turns: result.num_turns ?? 0,
  };
}

/**
 * Measured cost from our price table, not the CLI's total_cost_usd (which
 * prices gateway models at Anthropic rates). Cache writes are billed at 1.25x
 * input for Anthropic models (5-minute writes) and at the input rate for
 * gateway models, whose providers publish no separate write price.
 */
export function cellCostUsd(arm: PanelArm, usage: CellUsage): number {
  const row = pricingRow(arm.model);
  if (!row) throw new Error('no price row for ' + arm.model);
  const writeRate = row.input_per_mtok * (arm.route === 'anthropic' ? 1.25 : 1);
  return +(estimateCostUsd({ input: usage.input, cached: usage.cached, output: usage.output }, arm.model) + usage.cacheWrite * writeRate / 1_000_000).toFixed(6);
}

export type CellVerdict = 'pass' | 'fail' | 'infra';

/**
 * INFRA cells are excluded from pass rates, reported, and never rerun to
 * change a verdict: no result event, a CLI or API error before the model
 * produced a turn, a 402/429/5xx from the API, a startup timeout, or a run
 * that billed any model besides the arm's (MODEL_MIX). A CLI killed at the
 * timeout writes no result event, so it is INFRA too. Everything else is
 * scored by the hidden check.
 */
export function classifyCell(arm: PanelArm, exitReason: string, usage: CellUsage | null): { verdict: 'infra'; reason: string } | { verdict: 'scored' } {
  if (exitReason === 'timeout_startup') return { verdict: 'infra', reason: 'startup timeout' };
  if (!usage) return { verdict: 'infra', reason: 'no result event (' + exitReason + ')' };
  const foreign = foreignModels(arm.model, usage.modelsBilled);
  if (foreign.length) return { verdict: 'infra', reason: 'MODEL_MIX: ' + foreign.join(', ') };
  if (usage.apiErrorStatus !== null && (usage.apiErrorStatus === 402 || usage.apiErrorStatus === 429 || usage.apiErrorStatus >= 500)) {
    return { verdict: 'infra', reason: 'API ' + usage.apiErrorStatus };
  }
  if (usage.isError && usage.turns === 0) return { verdict: 'infra', reason: 'error before the first turn (' + exitReason + ')' };
  return { verdict: 'scored' };
}

export interface PanelRow {
  task: string;
  arm: PanelArmId;
  model: string;
  route: PanelArm['route'];
  trial: number;
  verdict: CellVerdict;
  reason: string;
  exitReason: string;
  costUsd: number | null;
  usage: CellUsage | null;
  durationMs: number;
  consulted: boolean;
}

export interface ArmSummary {
  arm: PanelArmId;
  label: string;
  passes: number;
  completed: number;
  infra: number;
  cells: number;
  passRate: number;
  low: number;
  high: number;
  costPerTaskUsd: number;
}

/** Wilson 95% interval for a pass rate. */
export function wilson(passes: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96, p = passes / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

export function summarize(rows: PanelRow[]): ArmSummary[] {
  return PANEL_ARMS.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm.id);
    const scored = mine.filter((r) => r.verdict !== 'infra');
    const passes = scored.filter((r) => r.verdict === 'pass').length;
    const priced = mine.filter((r) => r.costUsd !== null);
    const { low, high } = wilson(passes, scored.length);
    return {
      arm: arm.id, label: arm.label, passes, completed: scored.length, infra: mine.length - scored.length, cells: mine.length,
      passRate: scored.length ? passes / scored.length : 0, low, high,
      costPerTaskUsd: priced.length ? priced.reduce((s, r) => s + (r.costUsd ?? 0), 0) / priced.length : 0,
    };
  });
}

const money = (usd: number) => '$' + (usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2));

/**
 * The preregistered wording rule. Returns the one line gstack may publish
 * about particle-1, or null with the reason when the panel supports none.
 * It quotes raw pass counts and measured cost per task; it never says
 * "comparable" or "better", says "no measured difference" only when the
 * Wilson intervals overlap, and calls particle-1 cheapest only among the
 * arms measured.
 */
export function suggestionLine(summaries: ArmSummary[], measuredOn: string): { line: string | null; reason: string } {
  const by = (id: PanelArmId) => summaries.find((s) => s.arm === id)!;
  const p = by('particle'), s = by('sonnet'), o = by('opus'), d = by('deepseek');
  const thin = summaries.filter((x) => x.completed < PANEL_MIN_COMPLETED);
  if (thin.length) return { line: null, reason: 'INCOMPLETE: ' + thin.map((x) => x.label + ' ' + x.completed + '/' + x.cells).join(', ') + ' completed cells (need ' + PANEL_MIN_COMPLETED + ')' };
  const vsSonnet = p.high < s.low ? 'below Sonnet 5.5 on this panel' : p.low > s.high ? 'above Sonnet 5.5 on this panel' : 'no measured difference from Sonnet 5.5 on this panel';
  const cheapest = summaries.every((x) => x.arm === 'particle' || p.costPerTaskUsd < x.costPerTaskUsd);
  const counts = 'particle-1 passed ' + p.passes + '/' + p.completed + ' tasks on gstack\'s model panel (Sonnet 5.5 ' + s.passes + '/' + s.completed + ', Opus 5.5 ' + o.passes + '/' + o.completed + ', DeepSeek V4.1 Flash ' + d.passes + '/' + d.completed + ')';
  const cost = ' at ' + money(p.costPerTaskUsd) + ' per task vs ' + money(s.costPerTaskUsd) + ' for Sonnet 5.5' + (cheapest ? ', the cheapest of the four models measured' : '');
  const where = ' (' + vsSonnet + '; measured ' + measuredOn + ' in Claude Code via OpenRouter).';
  if (p.passRate < PANEL_USEFULNESS_FLOOR) return { line: null, reason: 'below the usefulness floor: ' + counts + cost + where };
  return { line: counts + cost + where + ' Worth trying for low-stakes steps; keep blocking reviewers on your main model.', reason: 'ok' };
}
