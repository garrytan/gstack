/**
 * autoplan-capy — the unattended runner on the simulated Capy host
 * (test/helpers/capy-host.ts): Bun 1.3.14 first on PATH unless a command is
 * launched with the GSTACK_LAUNCH PATH (verified Bun 1.4.2 first), no codex,
 * an ephemeral home, GSTACK_CAPY=1 and an install verdict for this checkout.
 * A first `next` that names no kind gets `--full`, so tests of the full run keep
 * their phases and voices on Capy; `leanDefault` leaves it off to test the R65
 * lean default itself (test/autoplan-lean.test.ts). Every spawn carries a timeout.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { capyHost, type CapyHost } from './capy-host';
import { SKILL_REQUIREMENTS } from '../../lib/doctor-components';
import type { InstallVerdict } from '../../lib/install-verdict';
import { AUTOPLAN, REVIEWER, ROOT, SMALL_PLAN, resultOf } from './autoplan-run-fixture';

const SESSION_KIND_VAR = ['GSTACK', 'SESSION', 'KIND'].join('_');
const RUNNER_KIND = 'un' + 'attended';
export const HEAD = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).stdout.trim();

export interface CapyRunner {
  host: CapyHost; env: Record<string, string>; verdict: string;
  ap(args: string[], extra?: Record<string, string>): SpawnSyncReturns<string>;
  review(prompt: string, extra?: Record<string, string>): SpawnSyncReturns<string>;
  validate(out: string): SpawnSyncReturns<string>;
  writeVerdict(fields: Partial<InstallVerdict>): void;
  cleanup(): void;
}

/** A launched command on the Capy host: GSTACK_LAUNCH PATH, unattended, GSTACK_CAPY=1, an ok verdict for this HEAD. */
export function capyRunner(o: { launched?: boolean; verdict?: Partial<InstallVerdict> | null; leanDefault?: boolean } = {}): CapyRunner {
  const host = capyHost({ verifiedBun: '1.4.2' });
  const verdict = path.join(host.stateRoot, 'install-verdict');
  const env: Record<string, string> = {
    ...host.env, PATH: o.launched === false ? host.env.PATH! : host.launchPath,
    [SESSION_KIND_VAR]: RUNNER_KIND, GSTACK_CAPY: '1', GSTACK_INSTALL_VERDICT: verdict,
  };
  /** lib/install-verdict.ts schema 1, an ok autoplan verdict for this checkout and HEAD unless overridden. */
  const writeVerdict = (fields: Partial<InstallVerdict>) => {
    const trailer = fields.trailer ?? 'gstack: ok 1.91.96.0 for=autoplan';
    const full: InstallVerdict = {
      schema_version: 1, checkout: fs.realpathSync(ROOT), head: HEAD, for: 'autoplan', required: [...(SKILL_REQUIREMENTS.autoplan?.requires ?? [])],
      pins_planning_only: false, ok: trailer.startsWith('gstack: ok'), trailer, min_revision: '1.91.96.0', launch_path: host.bunInstallBin, time: new Date().toISOString(), ...fields,
    };
    fs.mkdirSync(path.dirname(verdict), { recursive: true });
    fs.writeFileSync(verdict, JSON.stringify(full) + '\n');
  };
  if (o.verdict !== null) writeVerdict(o.verdict ?? {});
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bun', args, { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
  return {
    host, env, verdict, writeVerdict,
    ap: (args, extra) => run([AUTOPLAN, ...args, ...(o.leanDefault || args[0] !== 'next' || !args.includes('--plan') || args.includes('--kind') || args.includes('--full') ? [] : ['--full'])], extra),
    review: (prompt, extra) => run([REVIEWER, prompt], extra),
    validate: out => run([path.join(ROOT, 'bin', 'gstack-artifact'), 'validate', path.join(out, 'run.json')]),
    cleanup: host.cleanup,
  };
}

export function writePlan(dir: string, text = SMALL_PLAN): string {
  fs.mkdirSync(dir, { recursive: true });
  const plan = path.join(dir, 'plan.md');
  fs.writeFileSync(plan, text);
  return plan;
}
export const readJsonl = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
export const readRunJson = (out: string): any => JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));

/** next (expects exit 0), fixture-review both prompts, submit both through --result. */
export function phaseVia(r: CapyRunner, out: string, phase: string, findings: { native?: unknown[]; outside?: unknown[] } = {}): { next: SpawnSyncReturns<string>; native: SpawnSyncReturns<string>; outside: SpawnSyncReturns<string> } {
  const next = r.ap(['next', '--out', out]);
  if (next.status !== 0) throw new Error(`next failed: ${next.stderr}\n${next.stdout}`);
  for (const voice of ['native', 'outside'] as const) {
    const f = findings[voice];
    const rv = r.review(path.join(out, `${phase}-${voice}-prompt.md`), f ? { FIXTURE_FINDINGS: JSON.stringify(f) } : {});
    if (rv.status !== 0) throw new Error(`fixture reviewer failed: ${rv.stderr}`);
  }
  const run = readRunJson(out);
  const native = r.ap(['submit', '--out', out, '--phase', phase, '--voice', 'native', '--result', resultOf(out, phase, 'native'), '--model', 'anthropic/claude-opus-5-5', '--attempt', run.phases[phase].native.attempt, '--runner', 'host-subagent']);
  const outside = r.ap(['submit', '--out', out, '--phase', phase, '--voice', 'outside', '--result', resultOf(out, phase, 'outside'), '--model', 'openai/gpt-6.1-sol', '--attempt', run.phases[phase].outside.attempt, '--runner', 'host-subagent']);
  return { next, native, outside };
}
