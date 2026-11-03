/**
 * pregate/runtime — the Bun a repo command runs under, and the TypeScript twin
 * of the one Bun resolution contract (`gstack_bun_resolve` in
 * bin/gstack-bun-version.sh; test/bun-resolve.test.ts runs both on one
 * layout). Candidates, first eligible wins: the project's exact pin and
 * gstack's install default in the versioned runtime store
 * (`<state root>/runtimes/bun/<version>/bun`), `$BUN_INSTALL/bin`,
 * `~/.bun/bin`, then every `bun` on PATH. Eligible: it runs, is at or above
 * gstack's supported minimum, and satisfies gstack's own `engines.bun` and
 * every project pin (lib/runtime-pins.ts); a file carrying the bun shim's
 * marker is never a candidate.
 *
 * The install verdict for (checkout, project) is the one record install,
 * the shim and admission share. Under the admission condition (GSTACK_CAPY=1,
 * or a verdict exists for this checkout and project) it is validated as
 * workflow admission validates it and the lanes run the Bun it recorded; an
 * invalid verdict (INSTALL_UNVERIFIED) or a recorded Bun that is gone, changed
 * or no longer satisfies the pins (BUN_RESOLUTION_DRIFT) makes the lanes and
 * guards incomplete before anything launches. Otherwise the verdict check is
 * skipped with an explain line (contributors, CI).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { admittedVerdict, findInstallVerdict, installProject, readInstallVerdict, sourceRoot } from '../install-verdict';
import { resultCodeSuffix } from '../result-codes';
import { collectPins, evaluatePins, exactPlan, parseVersion, satisfies } from '../runtime-pins';
import { resolveStateRoot } from '../state-root';

type Env = NodeJS.ProcessEnv;

const GSTACK_ROOT = path.resolve(import.meta.dir, '..', '..');
const VERSIONS = fs.readFileSync(path.join(GSTACK_ROOT, 'bin/gstack-bun-version.sh'), 'utf8');
const shellValue = (name: string) => VERSIONS.match(new RegExp(`^${name}="([^"]*)"`, 'm'))?.[1] ?? '';

export const BUN_TESTED = shellValue('GSTACK_BUN_TESTED');
export const BUN_DEFAULT = shellValue('GSTACK_BUN_DEFAULT');
export const BUN_VERIFIED = shellValue('GSTACK_BUN_VERIFIED').split(/\s+/).filter(Boolean);
export const BUN_SHIM_MARKER = shellValue('GSTACK_BUN_SHIM_MARKER');

/** `gstack_bun_status <v> = ok`: parseable and not below the supported minimum (a prerelease of it is below). */
export function bunStatusOk(version: string): boolean {
  const m = version.replace(/^v/, '').replace(/\+.*$/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  const min = BUN_TESTED.split('.').map(Number);
  if (!m) return false;
  for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== min[i]) return Number(m[i + 1]) > min[i];
  return !m[4];
}

/** `gstack_bun_install_version`: GSTACK_BUN_INSTALL_VERSION or the default; null when not a verified Bun at or above the minimum. */
export function bunInstallVersion(env: Env): string | null {
  const v = env.GSTACK_BUN_INSTALL_VERSION || BUN_DEFAULT;
  return BUN_VERIFIED.includes(v) && bunStatusOk(v) ? v : null;
}

export const bunStore = (stateRoot: string) => path.join(stateRoot, 'runtimes', 'bun');

export type BunRule = 'pin' | 'default' | 'BUN_INSTALL' | 'home' | 'PATH';
export interface BunResolution { bin: string; version: string; rule: BunRule }

function isShim(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('latin1').includes(BUN_SHIM_MARKER);
  } catch { return false; }
}

function bunVersionOf(bin: string, env: Env): string {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, env });
  return r.status === 0 ? (r.stdout ?? '').split('\n')[0].replace(/[^A-Za-z0-9.+-]/g, '') : '';
}

/**
 * The resolution contract. `accept` is the caller's project-pin check;
 * `judged` lists the candidates that ran and were refused.
 */
export function resolveBun(opts: { store: string; env: Env; pinExact?: string | null; accept?: (version: string, bin: string) => boolean }): { resolution: BunResolution | null; judged: string[] } {
  const { store, env } = opts;
  const installVersion = bunInstallVersion(env);
  const candidates: [BunRule, string][] = [];
  if (opts.pinExact) candidates.push(['pin', path.join(store, opts.pinExact, 'bun')]);
  if (installVersion) candidates.push(['default', path.join(store, installVersion, 'bun')]);
  if (env.BUN_INSTALL) candidates.push(['BUN_INSTALL', path.join(env.BUN_INSTALL, 'bin', 'bun')]);
  if (env.HOME) candidates.push(['home', path.join(env.HOME, '.bun', 'bin', 'bun')]);
  for (const dir of (env.PATH ?? '').split(':')) if (dir) candidates.push(['PATH', path.join(dir, 'bun')]);
  const seen = new Set<string>();
  const judged: string[] = [];
  for (const [rule, file] of candidates) {
    let real: string;
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      if (isShim(file)) continue;
      real = fs.realpathSync(file);
    } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const version = bunVersionOf(real, env);
    if (!bunStatusOk(version) || (opts.accept && !opts.accept(version, real))) { judged.push(`bun ${version || 'unknown'} at ${real} (${rule})`); continue; }
    return { resolution: { bin: real, version, rule }, judged };
  }
  return { resolution: null, judged };
}

function enginesBun(file: string): string | null {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8'))?.engines?.bun; return typeof v === 'string' && v.trim() ? v.trim() : null; } catch { return null; }
}

const byVersionDesc = (a: string, b: string) => { const x = parseVersion(a)!, y = parseVersion(b)!; return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; };

/**
 * The project's pins as the resolver's eligibility hook, and the exact Bun to
 * prefer (read_pins in bin/gstack-capy-install): the one non-CI exact pin,
 * else among the CI alternatives the install version, the highest verified,
 * or the highest.
 */
export function projectBunPins(repoRoot: string | null, env: Env = process.env): { pinExact: string | null; accept: (version: string) => boolean } {
  const gstackPin = enginesBun(path.join(GSTACK_ROOT, 'package.json'));
  const pins = repoRoot ? collectPins(repoRoot).filter(p => p.tool === 'bun') : [];
  const plan = exactPlan(pins, 'bun');
  const alts = plan.ciAlternatives.filter(v => parseVersion(v)).sort(byVersionDesc);
  const installVersion = bunInstallVersion(env);
  const pinExact = plan.required.length ? (plan.required.length === 1 && parseVersion(plan.required[0].version) ? plan.required[0].version : null)
    : alts.find(v => v === installVersion) ?? alts.find(v => BUN_VERIFIED.includes(v) && bunStatusOk(v)) ?? alts[0] ?? null;
  return {
    pinExact,
    accept: (version: string) => (!gstackPin || satisfies(version, gstackPin) === true) && evaluatePins(pins, { bun: version }).failures.length === 0,
  };
}

export interface LaunchRuntime {
  dir: string | null;
  version: string | null;
  env: NodeJS.ProcessEnv;
  label: string;
  /**
   * The install-verdict check: ok, drift (recorded Bun gone, changed or no
   * longer satisfying the pins), unverified (no verdict under GSTACK_CAPY=1,
   * or one that is not ok, for another HEAD, planning-only, another project or
   * too narrow) or skipped (no GSTACK_CAPY=1 and no verdict: contributors, CI).
   */
  verdict: 'ok' | 'drift' | 'unverified' | 'skipped';
  verdictLine: string;
  /** Set for drift and unverified: the lanes and guards return it before launching anything. */
  refusal: { status: 'incomplete'; code: 'BUN_RESOLUTION_DRIFT' | 'INSTALL_UNVERIFIED'; detail: string; fix: string } | null;
}

/**
 * The Bun the lanes and guards run under, its dir first on PATH; the env is
 * unchanged when nothing qualifies. Under the admission condition the install
 * verdict for (checkout, project) is validated as workflow admission does
 * (admittedVerdict: ok, HEAD, pins, project, coverage, for /ship; else /ship's own record) and its
 * recorded Bun is the one launched; the gstack checkout itself binds the
 * 'none' verdict (installProject).
 */
export function launchRuntime(repoRoot: string, env: NodeJS.ProcessEnv): LaunchRuntime {
  const checkout = sourceRoot(GSTACK_ROOT);
  const project = installProject(checkout, repoRoot);
  const admitted = admittedVerdict('ship', checkout, findInstallVerdict(checkout, project, env), project, '', '');
  const recorded = readInstallVerdict(admitted.file);
  let pinsRoot: string | null = null;
  try { pinsRoot = fs.realpathSync(repoRoot); } catch { /* unresolvable: no pins */ }
  const { pinExact, accept } = projectBunPins(pinsRoot, env);
  const result = (dir: string | null, version: string | null, label: string, verdict: LaunchRuntime['verdict'], verdictLine: string, refusal: LaunchRuntime['refusal'] = null): LaunchRuntime =>
    ({ dir, version, env: dir ? { ...env, PATH: [dir, env.PATH ?? ''].filter(Boolean).join(path.delimiter) } : env, label: `${label}${verdictLine ? `; ${verdictLine}` : ''}`, verdict, verdictLine, refusal });
  const refuse = (code: 'BUN_RESOLUTION_DRIFT' | 'INSTALL_UNVERIFIED', detail: string, fix: string) =>
    result(null, null, 'not launched', code === 'BUN_RESOLUTION_DRIFT' ? 'drift' : 'unverified', `install verdict: ${detail}; fix: ${fix} ${resultCodeSuffix(code)}`, { status: 'incomplete', code, detail: `install verdict: ${detail}`, fix });
  const installer = 'run the Capy skill installer here (scripts/install.sh --for ship), then rerun gstack-pregate with the GSTACK_LAUNCH line it prints';
  let verdict: LaunchRuntime['verdict'] = 'skipped';
  let verdictLine = '';
  if (env.GSTACK_CAPY !== '1' && !recorded) {
    verdictLine = 'install verdict: not checked (no GSTACK_CAPY=1 and no verdict for this checkout and project)';
  } else {
    const { problem } = admitted;
    if (problem) return refuse('INSTALL_UNVERIFIED', problem.detail, problem.fix ?? installer);
    verdict = 'ok';
    if (recorded!.bun_path) {
      const now = fs.existsSync(recorded!.bun_path) ? bunVersionOf(recorded!.bun_path, env) : '';
      const why = !now ? 'is gone' : now !== recorded!.bun_version ? `now reports ${now}` : !accept(now) ? 'no longer satisfies the project pins' : '';
      if (why) return refuse('BUN_RESOLUTION_DRIFT', `recorded bun ${recorded!.bun_version} at ${recorded!.bun_path} ${why}`, 're-run the Capy skill installer with --check (scripts/install.sh --check --for ship) and follow its fix');
      let launchBun = '';
      try { launchBun = fs.realpathSync(path.join(recorded!.launch_path, 'bun')); } catch { /* no Bun in the launch dir */ }
      const launch = recorded!.launch_path && fs.existsSync(recorded!.launch_path) && (!launchBun || launchBun === recorded!.bun_path) ? recorded!.launch_path : path.dirname(recorded!.bun_path);
      return result(launch, now, `bun ${now} at ${recorded!.bun_path} (recorded by the install verdict)`, 'ok', '');
    }
  }
  const { resolution } = resolveBun({ store: bunStore(resolveStateRoot(env)), env, pinExact, accept });
  if (resolution) return result(path.dirname(resolution.bin), resolution.version, `bun ${resolution.version} at ${resolution.bin} (resolved: ${resolution.rule})`, verdict, verdictLine);
  return result(null, null, 'PATH (no eligible Bun in the runtime store, $BUN_INSTALL/bin, ~/.bun/bin or PATH)', verdict, verdictLine);
}
