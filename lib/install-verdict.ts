/**
 * install-verdict — the TypeScript twin of bin/gstack-install-verdict.sh: the
 * one reader of the install verdict gstack-capy-install writes, and the
 * install-admission rule gstack-skill-start (Bash) and gstack-autoplan's
 * mutating verbs share. test/install-verdict.test.ts pins both sides.
 *
 * Verdict file: <state root>/install-verdicts/<sha256(checkout realpath)>/<sha256(project realpath | "none")>.json,
 * then the path the GSTACK_LAUNCH line names as GSTACK_INSTALL_VERDICT, then
 * the schema 1 file keyed by the checkout alone (<sha256(checkout)>.json). An
 * install-profile verdict (for=review-voice) at the first path yields to the
 * launched GSTACK_INSTALL_VERDICT, so a reviewer's install on a shared machine
 * never shadows the session's own verdict (GST-1161).
 * The project is the working directory's git toplevel unless that is the
 * checkout itself. It is the one record the bun shim, the Bash twin,
 * lib/pregate/runtime.ts and admission read.
 *
 * Admission: applies to unattended and spawned sessions. It refuses (exit 3,
 * `status=refused`) in unattended sessions and explicit
 * GSTACK_SESSION_KIND=spawned sessions with GSTACK_CAPY=1 when the running Bun
 * is below gstack's supported minimum and, with GSTACK_CAPY=1 only, when the
 * verdict is missing, failing, for another checkout or HEAD, narrower than
 * the workflow, for another project when the workflow runs the repo's tests,
 * or records a Bun other than the one running (BUN_RESOLUTION_DRIFT). A
 * verdict for an install profile (`for=review-voice`) covers no host, so it
 * refuses every workflow with the full-install `--for <skill>` command. Other
 * spawned sessions only warn.
 * GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 admits and sets `overridden` (the caller
 * records it as a run deviation).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INSTALL_PROFILES, PINS_ADVISORY_SKILLS, SKILL_REQUIREMENTS } from './doctor-components';
import type { ResultCodeName } from './result-codes';
import { resolveStateRoot } from './state-root';

export interface InstallVerdict {
  schema_version: 1 | 2;
  checkout: string;
  head: string;
  for: string;
  required: string[];
  pins_planning_only: boolean;
  ok: boolean;
  trailer: string;
  min_revision: string;
  launch_path: string;
  time: string;
  /** Schema 2: the project realpath ('' for none) and the Bun resolution recorded for it. */
  project?: string;
  pin?: string;
  bun_path?: string;
  bun_version?: string;
  bun_rule?: string;
  bun_install?: string;
}

export interface InstallAdmission {
  /** The session kind is one admission covers (unattended or spawned). */
  applies: boolean;
  /** Stop: print `line`, then `GSTACK_RESULT: skill=<s> status=refused run=<dir>`, exit 3. */
  refuse: boolean;
  /** Ambient spawned session: print `line` and continue. */
  warn: boolean;
  /** GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 admitted a failing check; record `detail` as a deviation. */
  overridden: boolean;
  status: 'ok' | 'runtime' | 'verdict';
  detail: string;
  code?: ResultCodeName;
  /** The `INSTALL: fail|warn …` or `INSTALL_VERDICT: …` line; empty when nothing to say. */
  line: string;
}

type Env = Record<string, string | undefined>;

/** The source checkout behind an install root: its recorded .source-path, else the root itself (realpath). */
export function sourceRoot(gstackRoot: string): string {
  const recorded = path.join(gstackRoot, '.source-path');
  let src = gstackRoot;
  if (fs.existsSync(recorded)) {
    const line = fs.readFileSync(recorded, 'utf8').split('\n')[0].trim();
    if (line && fs.existsSync(line)) src = line;
  }
  return fs.realpathSync(src);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The verdict for (checkout, project); `project` null or '' is "none". */
export function installVerdictPath(checkout: string, stateRoot: string, project: string | null = null): string {
  return path.join(stateRoot, 'install-verdicts', sha256(checkout), `${sha256(project || 'none')}.json`);
}

/** The schema 1 verdict keyed by the checkout alone (read-only fallback). */
export function legacyInstallVerdictPath(checkout: string, stateRoot: string): string {
  return path.join(stateRoot, 'install-verdicts', `${sha256(checkout)}.json`);
}

/** The project a verdict is keyed by for `cwd`: its git toplevel realpath, null outside a repo or inside the checkout. */
export function installProject(checkout: string, cwd: string = process.cwd()): string | null {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10_000 });
  const top = r.status === 0 ? (r.stdout ?? '').trim() : '';
  if (!top) return null;
  try { const real = fs.realpathSync(top); return real === checkout ? null : real; } catch { return null; }
}

/** The verdict file admission reads: (checkout, project), then GSTACK_INSTALL_VERDICT, then the schema 1 file. An install-profile verdict at (checkout, project) admits no workflow, so the launched GSTACK_INSTALL_VERDICT outranks it (GST-1161). */
export function findInstallVerdict(checkout: string, project: string | null, env: Env): string {
  const stateRoot = resolveStateRoot(env);
  const keyed = installVerdictPath(checkout, stateRoot, project);
  if (fs.existsSync(keyed) && !INSTALL_PROFILES.includes(readInstallVerdict(keyed)?.for ?? '')) return keyed;
  if (fs.existsSync(keyed) && (!env.GSTACK_INSTALL_VERDICT || !fs.existsSync(env.GSTACK_INSTALL_VERDICT))) return keyed;
  if (env.GSTACK_INSTALL_VERDICT && fs.existsSync(env.GSTACK_INSTALL_VERDICT)) return env.GSTACK_INSTALL_VERDICT;
  const legacy = legacyInstallVerdictPath(checkout, stateRoot);
  return fs.existsSync(legacy) ? legacy : keyed;
}

export function readInstallVerdict(file: string): InstallVerdict | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && (v.schema_version === 1 || v.schema_version === 2) ? v as InstallVerdict : null;
  } catch {
    return null;
  }
}

const below = (a: string, b: string) => {
  const x = a.split(/[.+-]/).map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return /-/.test(a);
};

function supportedBun(gstackRoot: string): string {
  const text = fs.readFileSync(path.join(gstackRoot, 'bin/gstack-bun-version.sh'), 'utf8');
  return text.match(/^GSTACK_BUN_TESTED="([0-9.]+)"/m)?.[1] ?? '0.0.0';
}

export interface VerdictProblem { detail: string; code: ResultCodeName; fix?: string }

/** Why the install verdict for (checkout, project of `cwd`) does not admit `skill`; null when it does. `bunPath` '' skips the running-Bun check. */
export function verdictProblem(skill: string, gstackRoot: string, env: Env, bunPath: string, bunVersion: string, cwd?: string): VerdictProblem | null {
  const src = sourceRoot(gstackRoot);
  const project = installProject(src, cwd);
  const file = findInstallVerdict(src, project, env);
  const v = readInstallVerdict(file);
  const problem = (detail: string): VerdictProblem => ({ detail, code: 'INSTALL_UNVERIFIED' });
  if (!v && fs.existsSync(file)) return problem(`the install verdict at ${file} is unreadable or has an unsupported schema_version; rerun the installer`);
  if (!v) {
    return { ...problem(`no install verdict at ${file} for ${src}`),
      fix: `run the Capy skill installer (scripts/install.sh --for ${skill}) from ${project ?? 'this directory'}: the verdict is keyed by the project directory the installer runs in, so a run from the skill's own folder does not cover ${project ?? 'it'}; then launch with the GSTACK_LAUNCH line it prints` };
  }
  if (!v.ok) return problem(`the install verdict says: ${v.trailer}`);
  if (v.checkout !== src) return problem(`the install verdict is for checkout ${v.checkout}, not ${src}`);
  const head = spawnSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? '';
  if (!head || v.head !== head) return problem(`the install verdict is for another HEAD (${v.head.slice(0, 12)}; ${src} is at ${head.slice(0, 12)})`);
  const advisory = PINS_ADVISORY_SKILLS.includes(skill);
  if (v.pins_planning_only && !advisory) return problem(`the install verdict is planning-only (pins skipped for ${v.for}) and ${skill} runs the repo's tests`);
  if (v.schema_version !== 1 && !advisory && (v.project ?? '') !== (project ?? '')) {
    return { ...problem(`the install verdict checked ${v.project || 'no project'}, not ${project ?? 'this directory (no project)'}, and ${skill} runs the repo's tests`),
      fix: `run the Capy skill installer (scripts/install.sh --for ${skill}) from ${project ?? 'this directory'}, then launch with the GSTACK_LAUNCH line it prints` };
  }
  const missing = (SKILL_REQUIREMENTS[skill]?.requires ?? []).find(id => !v.required.includes(id));
  if (missing && INSTALL_PROFILES.includes(v.for)) {
    return { ...problem(`the install verdict certified for=${v.for}, which does not cover ${missing} that ${skill} needs (${v.for} certifies only the read-only helpers)`),
      fix: `run GSTACK_CAPY_ROOT=${src} bash ${src}/capy/skill/gstack/scripts/install.sh --for ${skill} (upgrades this checkout in place: ./setup and host profiles, no second clone), then launch with the GSTACK_LAUNCH line it prints` };
  }
  if (missing) return problem(`the install verdict certified for=${v.for}, which does not cover ${missing} that ${skill} needs`);
  if (v.bun_path && bunPath && bunPath !== v.bun_path) {
    return { detail: `bun ${bunVersion} at ${bunPath} is running, but the install verdict recorded bun ${v.bun_version} at ${v.bun_path}`, code: 'BUN_RESOLUTION_DRIFT',
      fix: `launch with the GSTACK_LAUNCH line (PATH=${path.dirname(v.bun_path)}:$PATH), or re-run the Capy skill installer with --check (scripts/install.sh --check --for ${skill}) to see what changed` };
  }
  return null;
}

function realBunPath(): string {
  try { return fs.realpathSync(process.execPath); } catch { return process.execPath; }
}

/**
 * The admission decision for `skill` run from the gstack install at
 * `gstackRoot` (the directory holding bin/). `bunVersion` defaults to the Bun
 * running this process; `env` to process.env.
 */
export function checkInstallAdmission(opts: { skill: string; gstackRoot: string; env?: Env; bunVersion?: string; bunPath?: string; cwd?: string }): InstallAdmission {
  const env = opts.env ?? process.env;
  const kind = env.GSTACK_SESSION_KIND === 'unattended' || env.GSTACK_SESSION_KIND === 'spawned' ? env.GSTACK_SESSION_KIND
    : env.OPENCLAW_SESSION ? 'spawned' : 'other';
  const none: InstallAdmission = { applies: false, refuse: false, warn: false, overridden: false, status: 'ok', detail: '', line: '' };
  if (kind === 'other') return none;
  const capy = env.GSTACK_CAPY === '1';
  const hard = kind === 'unattended' || (env.GSTACK_SESSION_KIND === 'spawned' && capy);
  const minimum = supportedBun(opts.gstackRoot);
  const bun = opts.bunVersion ?? process.versions.bun ?? '0.0.0';
  let status: InstallAdmission['status'] = 'ok', detail = '', fix = '', code: ResultCodeName | undefined;
  if (below(bun, minimum)) {
    status = 'runtime'; code = 'RUNTIME_BELOW_MINIMUM';
    detail = `bun ${bun} is below the supported minimum ${minimum}`;
    fix = `run the Capy skill installer (scripts/install.sh --for ${opts.skill}), then launch with its GSTACK_LAUNCH line`;
  } else if (capy) {
    const p = verdictProblem(opts.skill, opts.gstackRoot, env, opts.bunPath ?? (opts.bunVersion ? '' : realBunPath()), bun, opts.cwd);
    if (p) {
      status = p.code === 'BUN_RESOLUTION_DRIFT' ? 'runtime' : 'verdict'; code = p.code; detail = p.detail;
      fix = p.fix ?? `run the Capy skill installer (scripts/install.sh --for ${opts.skill}) on this machine, then launch with the GSTACK_LAUNCH line it prints`;
    }
  }
  const base = { ...none, applies: true, status, detail, code };
  if (status === 'ok') return base;
  if (env.GSTACK_ALLOW_UNSUPPORTED_RUNTIME === '1') return { ...base, overridden: true, line: `INSTALL_VERDICT: overridden (GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1): ${detail}` };
  const line = `INSTALL: ${hard ? 'fail' : 'warn'} ${status} — ${detail}; fix: ${fix} (${code})`;
  return { ...base, refuse: hard, warn: !hard, line };
}
