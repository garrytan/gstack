/**
 * A dispatched screen's verdict, read from the run itself:
 * never from a lane's prose. evals.yml's report job publishes
 * `gate-binding-a<attempt>` (scripts/gate-reuse.ts: verdict, reconcile exit,
 * flaky cases) and `report-verdict-a<attempt>` (collector-outcomes.json: the
 * panels and the rule-16 flaky lines) on every executed screen; a superseded
 * screen plans nothing and uploads neither (hollowScreen): it concluded
 * success with no slice, so its outcome is `not-run`, never green. The outcome is
 * recorded in the READY receipt (ScreenChoice.verdict) by `ready`,
 * `verify --screen` and `train build`, so the controller reads one line.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REUSE_FILE, parseBinding, parseReuse } from '../scripts/gate-reuse';
import type { QueueContext } from './ship-queue';
import { downloadJson, hollowScreen, runView } from './ship-queue-train-github';
import { nowIso, type ScreenChoice, type ScreenVerdictRecord } from './ship-queue-train-record';

export type ScreenOutcome =
  | { kind: 'pending'; detail: string }
  | { kind: 'not-run'; detail: string }
  | { kind: 'unknown'; detail: string }
  | { kind: 'incomplete'; detail: string; flaky: string[] }
  | { kind: 'green'; detail: string; flaky: string[]; flakyLines: string[] }
  | { kind: 'red'; detail: string; red: string[]; flaky: string[]; flakyLines: string[] };

const BINDING = 'gate-binding';
const REPORT = 'report-verdict';
/** The plan artifact; a confirmed verdict reuse (R2a/R2) leaves its record there and binds nothing new. */
const PLAN = 'paid-plan';

/** The newest attempt's artifact of a name family (`<name>-a<attempt>`); null when the run uploaded none or the list is unreadable. */
function newestArtifact(ctx: QueueContext, slug: string, run: number, name: string): string | null | 'unreadable' {
  const artifacts: Array<{ name?: string; expired?: boolean }> = [];
  for (let page = 1; page <= 20; page++) {
    const r = ctx.gh(['api', `repos/${slug}/actions/runs/${run}/artifacts?per_page=100&page=${page}`]);
    let list: { artifacts?: Array<{ name?: string; expired?: boolean }> } | null = null;
    try { list = r.ok ? JSON.parse(r.out) : null; } catch {}
    if (!Array.isArray(list?.artifacts)) return 'unreadable';
    artifacts.push(...list.artifacts);
    if (list.artifacts.length < 100) break;
  }
  const hits = artifacts.map(a => ({ name: a.name ?? '', expired: !!a.expired, attempt: Number(new RegExp(`^${name}-a(\\d+)$`).exec(a.name ?? '')?.[1]) }))
    .filter(a => Number.isSafeInteger(a.attempt)).sort((a, b) => b.attempt - a.attempt);
  if (!hits.length) return null;
  return hits[0]!.expired ? 'unreadable' : hits[0]!.name;
}

interface Outcomes { panels?: Array<{ case?: string; status?: string; failsLane?: boolean; redClass?: string | null }>; failures?: unknown[]; flakyLines?: string[] }

/** Read one screen run: status, plan, gate binding, panels. */
export function screenVerdict(ctx: QueueContext, slug: string, run: number): ScreenOutcome {
  const view = runView(ctx, slug, run);
  if (!view) return { kind: 'unknown', detail: `run ${run} is unreadable` };
  if (view.status !== 'completed') return { kind: 'pending', detail: `run ${run} is ${view.status}` };
  const plan = hollowScreen(ctx, slug, run);
  if (plan.kind === 'hollow') return { kind: 'not-run', detail: plan.reason };
  if (plan.kind === 'unknown') return { kind: 'unknown', detail: plan.reason };
  const bindingName = newestArtifact(ctx, slug, run, BINDING);
  if (bindingName === 'unreadable') return { kind: 'unknown', detail: `run ${run}'s artifact list is unreadable or its ${BINDING} artifact has expired` };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-screen-verdict-'));
  let binding: ReturnType<typeof parseBinding> = null;
  let outcomes: Outcomes | null = null;
  try {
    if (!bindingName) {
      const reuse = parseReuse(downloadJson(ctx, slug, run, PLAN, scratch, REUSE_FILE));
      if (reuse && view.conclusion === 'success') {
        const flaky = [...(reuse.reused_flaky ?? [])].sort();
        return { kind: 'green', detail: `reused the GREEN verdict of run ${reuse.reused_run_id} (${reuse.kind}): ${reuse.why}${flaky.length ? `, flaky ${flaky.length}` : ''}`, flaky, flakyLines: [] };
      }
      return { kind: 'incomplete', detail: `run ${run} concluded ${view.conclusion ?? 'unknown'} and bound no verdict (no ${BINDING} artifact: the report job did not finish)`, flaky: [] };
    }
    binding = parseBinding(downloadJson(ctx, slug, run, bindingName, scratch, 'gate-binding.json'));
    const reportName = newestArtifact(ctx, slug, run, REPORT);
    outcomes = typeof reportName === 'string' ? downloadJson(ctx, slug, run, reportName, scratch, 'collector-outcomes.json') as Outcomes | null : null;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  if (!binding) return { kind: 'unknown', detail: `run ${run}'s ${bindingName} artifact is unreadable` };
  const flaky = [...(binding.flaky_cases ?? [])].sort();
  const flakyLines = Array.isArray(outcomes?.flakyLines) ? outcomes!.flakyLines!.filter((l): l is string => typeof l === 'string') : [];
  const panelRed = (outcomes?.panels ?? []).filter(p => typeof p.case === 'string' && (p.failsLane === true || (p.status === 'FAIL' && p.redClass === 'VERDICT'))).map(p => p.case!);
  const lineRed = (Array.isArray(outcomes?.failures) ? outcomes!.failures : []).flatMap(l => typeof l === 'string' ? /^✗ (\S+) {2}/.exec(l)?.[1] ?? [] : []);
  const red = [...new Set([...panelRed, ...lineRed])].sort();
  const base = `verdict ${binding.verdict}, reconcile exit ${binding.reconcile_exit}, run concluded ${view.conclusion ?? 'unknown'}${flaky.length ? `, flaky ${flaky.length}` : ''}`;
  if (binding.verdict === 'GREEN' && binding.reconcile_exit === 0 && view.conclusion === 'success') return { kind: 'green', detail: base, flaky, flakyLines };
  if (binding.verdict === 'RED' || binding.reconcile_exit !== 0 || red.length) return { kind: 'red', detail: base, red, flaky, flakyLines };
  return { kind: 'incomplete', detail: base, flaky };
}

/** The receipt field for an outcome that is settled (a pending or unknown run records nothing). */
export function verdictRecord(o: ScreenOutcome, run: number): ScreenVerdictRecord | null {
  if (o.kind === 'pending' || o.kind === 'unknown') return null;
  const outcome = o.kind === 'green' ? 'GREEN' : o.kind === 'red' ? 'RED' : o.kind === 'not-run' ? 'NOT_RUN' : 'INCOMPLETE';
  return { outcome, run, red: o.kind === 'red' ? o.red : [], flaky: 'flaky' in o ? o.flaky : [], detail: o.detail, read_at: nowIso() };
}

/** `SCREEN_VERDICT:` and the per-case `FLAKY:` lines for one PR's screen. */
export function verdictLines(pr: string, run: number, o: ScreenOutcome): string[] {
  const word = o.kind === 'green' ? 'GREEN' : o.kind === 'red' ? 'RED' : o.kind.toUpperCase();
  const red = o.kind === 'red' && o.red.length ? ` red=${o.red.join(',')}` : '';
  const flaky = 'flaky' in o && o.flaky.length ? ` flaky=${o.flaky.join(',')}` : '';
  const lines = [`SCREEN_VERDICT: #${pr} run ${run} ${word}${red}${flaky} (${o.detail})`];
  if ('flakyLines' in o) for (const l of o.flakyLines) lines.push(`FLAKY: ${l}`);
  return lines;
}

/** Apply a read outcome to a receipt's screen choice; returns whether the receipt changed. */
export function recordVerdict(screen: ScreenChoice, o: ScreenOutcome): boolean {
  if (!screen.run) return false;
  const rec = verdictRecord(o, screen.run);
  if (!rec) return false;
  const same = screen.verdict && screen.verdict.outcome === rec.outcome && screen.verdict.run === rec.run && screen.verdict.red.join() === rec.red.join() && screen.verdict.flaky.join() === rec.flaky.join();
  if (same) return false;
  screen.verdict = rec;
  return true;
}
