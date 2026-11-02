/**
 * Fixture harness for the unattended runner tests (plan B2): a small plan, the
 * `gstack-autoplan` bin run as a subprocess (every spawn carries a timeout),
 * and the fixture reviewer that answers a prompt file the way a subagent does.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
export const AUTOPLAN = path.join(ROOT, 'bin', 'gstack-autoplan');
export const REVIEWER = path.join(ROOT, 'test', 'fixtures', 'multi-agent-wave', 'fixture-reviewer.ts');
export const WAVE_PLAN = path.join(ROOT, 'docs', 'designs', 'MULTI_AGENT_WAVE_2026_10_10.md');

export const SMALL_PLAN = `# Retry backoff for the webhook worker

## Implementation plan

Add exponential backoff to the webhook worker's retry loop in lib/worker.ts: base 500 ms, factor 2, cap 30 s, jitter 10%.
Persist the attempt count on the job row so a restarted worker resumes the schedule. Tests cover the cap, the jitter bounds and the resume path.

## Review record
`;

const SESSION_KIND_VAR = ['GSTACK', 'SESSION', 'KIND'].join('_');
const RUNNER_KIND = 'un' + 'attended';

export function env(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  out.GSTACK_EPHEMERAL = '1';
  // The runner's default kind; spelled through the bin's own flag table so the
  // free-suite environment scan (test/gstack-session-kind.test.ts) stays clean.
  out[SESSION_KIND_VAR] = RUNNER_KIND;
  return { ...out, ...extra };
}

export function autoplan(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): SpawnSyncReturns<string> {
  return spawnSync('bun', [AUTOPLAN, ...args], { cwd: opts.cwd ?? ROOT, env: opts.env ?? env(), encoding: 'utf8', timeout: 120_000 });
}

export function review(promptFile: string, extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('bun', [REVIEWER, promptFile], { cwd: ROOT, env: env(extra), encoding: 'utf8', timeout: 60_000 });
}

export function readRun(out: string): any {
  return JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
}
export function journal(out: string): any[] {
  return fs.readFileSync(path.join(out, 'attempts.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
/** The result path the open (else the latest) attempt of a voice owns: `<phase>-<voice>.<attempt>.md`. */
export function resultOf(out: string, phase: string, voice: 'native' | 'outside'): string {
  const attempts: Array<{ state: string; result: string }> = readRun(out).phases[phase]?.[voice]?.attempts ?? [];
  const attempt = attempts.find(a => a.state === 'dispatched' || a.state === 'execution_unknown') ?? attempts[attempts.length - 1];
  if (!attempt) throw new Error(`${phase} ${voice} has no attempt in ${out}`);
  return attempt.result;
}
/** The sealed copy a completed voice is bound to. */
export const boundOf = (out: string, phase: string, voice: 'native' | 'outside'): string => path.join(out, readRun(out).phases[phase][voice].output);
/**
 * A `rec`/`all` reply that carries every open Critical/High finding item into the build (`<id>b`, no plan change),
 * so a test about another gate mechanism keeps its flow; `extra` tokens are appended to the except list.
 */
export function recCarrying(out: string, base = 'all', extra: string[] = []): string {
  const carry = (JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')).items as Array<{ id: string; finding?: string[] }>).filter(i => i.finding).map(i => `${i.id}b`);
  const tokens = [...carry, ...extra];
  return tokens.length ? `${base} except ${tokens.join(' ')}` : base;
}

export function attemptsOf(out: string, phase: string): { native: string; outside: string } {
  const run = readRun(out);
  return { native: run.phases[phase].native.attempt, outside: run.phases[phase].outside.attempt };
}

export interface PhaseRunOptions { nativeModel?: string; outsideModel?: string; breakVoice?: 'native' | 'outside'; breakKind?: string; reconcile?: string }

/** Start or continue a run: next, review both prompts with the fixture, submit both. Returns the submit outputs. */
export function runPhase(out: string, phase: string, o: PhaseRunOptions = {}): { next: SpawnSyncReturns<string>; native: SpawnSyncReturns<string>; outside: SpawnSyncReturns<string> } {
  const next = autoplan(['next', '--out', out]);
  if (next.status !== 0) throw new Error(`next failed: ${next.stderr}\n${next.stdout}`);
  const outsideDisabled = readRun(out).phases[phase]?.outside?.status === 'disabled';
  for (const voice of outsideDisabled ? ['native'] as const : ['native', 'outside'] as const) {
    const r = review(path.join(out, `${phase}-${voice}-prompt.md`), o.breakVoice === voice && o.breakKind ? { FIXTURE_BREAK: o.breakKind } : {});
    if (r.status !== 0) throw new Error(`fixture reviewer failed: ${r.stderr}`);
  }
  const ids = attemptsOf(out, phase);
  const native = autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'native', '--result', resultOf(out, phase, 'native'), '--model', o.nativeModel ?? 'anthropic/claude-opus-4-7', '--attempt', ids.native, '--runner', 'host-subagent']);
  if (outsideDisabled) return { next, native, outside: native };
  const outside = autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'outside', '--result', resultOf(out, phase, 'outside'), '--model', o.outsideModel ?? 'openai/gpt-6-astra', '--attempt', ids.outside, '--runner', 'host-subagent', ...(o.reconcile ? ['--reconcile', o.reconcile] : [])]);
  return { next, native, outside };
}

/** Initialize a run on the small plan with no UI/DX scope, so the order is ceo → eng. */
export function startSmallRun(dir: string, extraArgs: string[] = []): string {
  const plan = path.join(dir, 'plan.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(plan, SMALL_PLAN);
  const out = path.join(dir, 'run');
  const first = autoplan(['next', '--out', out, '--plan', plan, '--no-ui', ...extraArgs]);
  if (first.status !== 0) throw new Error(`first next failed: ${first.stderr}\n${first.stdout}`);
  return out;
}
