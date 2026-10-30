/**
 * review-plan-live — the live plan gstack-review-plan prints, as a library: flag
 * parsing and the git, gstack-diff-scope, gstack-gate-diff and gstack-config reads
 * around lib/review-depth.ts planReview, the fix range included. bin/gstack-review-plan
 * prints it and bin/gstack-review-packet writes one packet per dispatch from it, so the
 * two never select reviewers differently.
 */
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScriptSync } from './script-invocation';
import { collectCommit, collectLive, type Collected } from './review-collect';
import { classifyDiff, planReview, scanNumbers, SCOPED_RANGE_LINES, type Depth, type History, type ReviewPlan } from './review-depth';

export interface PlanFlags {
  base: string; pass: number; last: History['last']; floor?: Depth; gateTagged?: number; rangeBase?: string; pass1Depth: Depth;
  force: readonly string[] | 'all'; gated: string[]; reviewedNumbers?: string; noTiers: boolean;
  fixedBlocking: boolean; fixedBelow: boolean; blockingOpen: boolean; touchedGate: boolean; criticalFound: boolean; adversarialRan: boolean;
}
/** The plan flags: both bins' usage text for them. */
export const PLAN_FLAGS_HELP = `  --base <ref>              the base branch (merge base with HEAD is the diff base); required
  --pass <n>                full review passes already run in this invocation (default 0)
  --last none|full|fix-check  the step that just finished (default none: plan pass 1)
  --fixed-blocking          the finished step fixed a blocking finding (raises light to standard)
  --fixed-below             the finished step fixed findings below the floor
  --blocking-open           a blocking finding is still open in fix scope
  --touched-gate            a fix touched a gate-class path
  --critical-found          a specialist reported a CRITICAL finding (Red Team on code class; raises light to standard)
  --adversarial-ran         Step 11's native adversarial pass already ran (a repeat skips it)
  --gate-tagged <n>         gate hunks the gate scan tagged (default: run gstack-gate-diff; failure means unavailable)
  --gated a,b               specialists the hit-rate stats tag GATE_CANDIDATE
  --force a,b|all           specialists forced by prompt flags (--all-specialists is all)
  --reviewed-numbers <fp>   the numeric-claim fingerprint the outside voice already reviewed
  --depth-floor standard|full  raise the depth to at least this (never lowers it); /ship passes its prompt flag on every run
  --range-base <sha>        the fix range's base (this pass's PASS_HEAD): after a fixed blocker on a diff below full depth, a
                            committed range of at most ${SCOPED_RANGE_LINES} runtime lines plans a scoped pass; anything unread plans the full pass
  --pass1-depth <d>         pass 1's REVIEW_DEPTH depth: full, or absent, keeps pass 2 full`;

export function flagReader(args: readonly string[]) {
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const has = (n: string) => args.includes(n);
  const list = (n: string) => (flag(n) ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return { flag, has, list };
}

/** The plan flags from argv, or the usage error a bin prints before exiting 2. */
export function parsePlanFlags(args: readonly string[], bin: string): PlanFlags | { usage: string } {
  const { flag, has, list } = flagReader(args);
  const base = flag('--base');
  if (!base) return { usage: `${bin}: --base <ref> is required` };
  const last = (flag('--last') ?? 'none') as History['last'];
  if (!['none', 'full', 'fix-check'].includes(last)) return { usage: `${bin}: --last must be none, full or fix-check` };
  const pass1Depth = (flag('--pass1-depth') ?? 'full') as Depth;
  if (!['light', 'standard', 'full'].includes(pass1Depth)) return { usage: `${bin}: --pass1-depth must be light, standard or full` };
  const pass = Number(flag('--pass') ?? '0');
  if (!Number.isInteger(pass) || pass < 0) return { usage: `${bin}: --pass needs an integer >= 0` };
  const floor = flag('--depth-floor') as Depth | undefined;
  if (has('--depth-floor') && floor !== 'standard' && floor !== 'full') return { usage: `${bin}: --depth-floor must be standard or full (a floor only raises the depth)` };
  const rangeBase = flag('--range-base');
  if (has('--range-base') && (!rangeBase || rangeBase.startsWith('-'))) return { usage: `${bin}: --range-base needs the fix range's base commit (this pass's PASS_HEAD)` };
  return {
    base, pass, last, floor, rangeBase, pass1Depth, gateTagged: flag('--gate-tagged') === undefined ? undefined : Number(flag('--gate-tagged')),
    force: flag('--force') === 'all' ? 'all' : list('--force'), gated: list('--gated'), reviewedNumbers: flag('--reviewed-numbers'), noTiers: has('--no-tiers'),
    fixedBlocking: has('--fixed-blocking'), fixedBelow: has('--fixed-below'), blockingOpen: has('--blocking-open'), touchedGate: has('--touched-gate'),
    criticalFound: has('--critical-found'), adversarialRan: has('--adversarial-ran'),
  };
}

export interface FixRange { base: string; runtime_lines: number | null; error?: string; touched_gate?: true }
export interface LivePlan { root: string; head: string; collected: Collected; plan: ReviewPlan; scope: Record<string, string>; gateTagged: number | null; auditEffort: 'host' | 'light'; fixRange?: FixRange }

const git = (a: string[]) => { const r = spawnSync('git', ['-c', 'core.quotePath=false', ...a], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };

/** The plan of the next step at the checkout's root (the process chdirs there); errors are the lines a bin prints before exiting 1. */
export function livePlan(f: PlanFlags, binDir: string, bin: string): LivePlan | { errors: string[] } {
  const root = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!root) return { errors: [`${bin}: run it inside a git checkout`] };
  process.chdir(root);
  const collected = collectLive(root, f.base);
  if (collected.errors.length) return { errors: collected.errors.map(e => `${bin}: git could not list the diff (${e.input}: ${e.detail}); fix: ${e.repair}; no plan is safer than a plan for an empty diff`) };
  const head = git(['rev-parse', 'HEAD'])?.trim() ?? 'unknown';
  const scopeOf = (args: string[]): Record<string, string> => {
    const run = runScriptSync(path.join(binDir, 'gstack-diff-scope'), args, { encoding: 'utf8', timeout: 60_000 });
    const s: Record<string, string> = {};
    for (const l of (run.stdout ?? '').split('\n')) { const m = /^(SCOPE_[A-Z_]+)=(.*)$/.exec(l); if (m) s[m[1]!] = m[2]!; }
    if (run.status !== 0 && !s.SCOPE_ERROR) s.SCOPE_ERROR = `exit ${run.status}`;
    return s;
  };
  const gateTagsOf = (args: string[]): number | null => {
    const g = runScriptSync(path.join(binDir, 'gstack-gate-diff'), args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const m = /GATE_SUMMARY: .*?tagged=\{([^}]*)\}/.exec(g.stdout ?? '');
    return g.status === 0 && m ? m[1]!.split(',').reduce((n, kv) => n + (Number(kv.split(':')[1]) || 0), 0) : null;
  };
  const scope = scopeOf([f.base]);
  let gateTagged = f.gateTagged !== undefined ? f.gateTagged : gateTagsOf([f.base]);
  if (gateTagged !== null && !Number.isFinite(gateTagged)) gateTagged = null;
  const tiersSetting = runScriptSync(path.join(binDir, 'gstack-config'), ['get', 'review_effort_tiers'], { encoding: 'utf8', timeout: 15_000 });
  const auditEffort = f.noTiers || (tiersSetting.stdout ?? '').trim() === 'off' ? 'host' : 'light';
  let fixRange: FixRange | undefined;
  if (f.rangeBase) {
    const rangeBase = f.rangeBase;
    const unread = (error: string): FixRange => ({ base: rangeBase, runtime_lines: null, error });
    const resolved = git(['rev-parse', '--verify', '--quiet', `${rangeBase}^{commit}`])?.trim();
    if (!resolved) fixRange = unread('not a commit in this repository');
    else if (git(['merge-base', '--is-ancestor', resolved, 'HEAD']) === null) fixRange = unread('not an ancestor of HEAD');
    else if (git(['diff', '--quiet', 'HEAD', '--']) === null || collected.untracked.length) fixRange = unread('uncommitted or untracked edits: commit the fixes first');
    else {
      const commit = collectCommit(root, resolved, 'HEAD');
      const range = classifyDiff({ ...commit, registry: collected.registry, scope: scopeOf([resolved, '--head', 'HEAD']), gateTagged: gateTagsOf([resolved]) });
      fixRange = range.errors.length ? unread(range.errors.map(e => `${e.code} ${e.input}`).join('; '))
        : !commit.paths.length ? unread('the fix range is empty: commit the fix after the range base')
        : { base: rangeBase, runtime_lines: range.runtimeLines, ...(range.class === 'gate' ? { touched_gate: true as const } : {}) };
    }
  }
  const plan = planReview({
    ...collected, scope, gateTagged, numbers: scanNumbers(collected.added), force: f.force, gated: f.gated, floor: f.floor,
    criticalFound: f.criticalFound, adversarialRan: f.adversarialRan, reviewedNumbers: f.reviewedNumbers,
    history: { fullPasses: f.pass, last: f.last, fixedBlocking: f.fixedBlocking, fixedBelow: f.fixedBelow, blockingOpen: f.blockingOpen, touchedGate: f.touchedGate || !!fixRange?.touched_gate, pass1Depth: f.pass1Depth, rangeRuntimeLines: fixRange?.runtime_lines },
  });
  return { root, head, collected, plan, scope, gateTagged, auditEffort, ...(fixRange ? { fixRange } : {}) };
}

/** The pass number REVIEW_PLAN: names: a full or scoped next step is a new pass. */
export const planPass = (plan: ReviewPlan, pass: number) => pass + (plan.next.step === 'full' || plan.next.step === 'scoped' ? 1 : 0);
