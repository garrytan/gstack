/**
 * pregate/config — `.gstack/pregate.json` (plan C8): the repo's declarations
 * for the pre-gate. Read from the committed copy on origin/<base> under the
 * C1 trust boundary (lib/ship-policy.ts loaders are the model); file presence
 * never authorizes a command. Keys:
 *
 *   runner        the test command with a `{files}` placeholder (default: detected)
 *   dependencies  glob → test files for subprocess targets, runtime reads and
 *                 generated inputs the import graph cannot see; `[]` declares
 *                 "no lane needed" for docs and the like
 *   empty_lanes   extra globs for the docs/no-tests empty lane (any Markdown
 *                 file already qualifies without a pin file when no test
 *                 depends on it; source code and test trees never do)
 *   selection     `<workflow.yml>/<job>` → the runner-owned command that lists
 *                 the lane's test files when the matrix is planner-computed
 *   warn          check ids downgraded to warn (never `secrets`; `lanes` keeps
 *                 its required-lane and requires-remote verdicts)
 *   strays.allow  root files or new top-level directories that are intentional
 *   local         `<workflow.yml>/<job>` lanes a local run satisfies (a
 *                 platform-agnostic toolchain, or a repo whose CI is off):
 *                 their tests run here instead of becoming requires-remote
 *   guards        `{ id, when: [globs], command, fix?, timeout_s? }`: a repo
 *                 command that must pass when a touched file matches `when`
 *                 (manifest checks, CLI goldens); never downgradable
 *   serial_patterns globs of test files the lanes check runs one process each
 *                 (default: every `*.serial.test.*` file)
 *   sealed        the sealed-output guard's rules (lib/sealed-guard.ts; read by
 *                 the pre-push hook and `gstack-pregate sealed`, not by `run`)
 *   price_file    the call-plan data file `gstack-eval-plan price-gate` prices
 *                 a paid gate from (GSTACK_EVAL_CALLS v1; never executed)
 *   stall_timeout_s seconds without test output before the lanes check kills
 *                 the runner's process group (default 300; 0 disables)
 *   remote_gate   the repo's remote test gate command: under 8 cores the test
 *                 tier is a requires-remote obligation naming it, and
 *                 `--remote` runs it (it prints `PREGATE_REMOTE: tree=… tests=… failed=…`)
 *
 * A repo that keeps `.gstack/` out of git can hold the same file at
 * `<state root>/projects/<slug>/pregate.json` (lib/state-root.ts), honoured
 * only when the base carries none. It must sit outside the repo, so a PR
 * cannot reach it; a path inside the checkout is ignored (pregate/context).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ResultCodeName } from '../result-codes';
import { sealedErrors } from '../sealed-guard';
import { containedRelative, globToRegExp } from '../ship-policy';

export const PREGATE_CONFIG_PATH = '.gstack/pregate.json';
export const PREGATE_CONFIG_SCHEMA = 'https://github.com/garrytan/gstack/docs/pregate.md#pregate-v1';
export const NON_DOWNGRADABLE = ['secrets', 'guards'] as const;
export const DEFAULT_SERIAL_PATTERNS = ['**/*.serial.test.*'];

export interface PregateConfig {
  $schema?: string;
  runner: string | null;
  dependencies: Record<string, string[]>;
  /** Extra docs/no-tests globs. Built-in Markdown always qualifies when no test depends on it. */
  empty_lanes: string[];
  selection: Record<string, string>;
  warn: string[];
  strays: { allow: string[] };
  local: string[];
  guards: Guard[];
  serial_patterns: string[];
  price_file: string | null;
  stall_timeout_s: number | null;
  remote_gate: string | null;
}
export interface Guard { id: string; when: string[]; command: string; fix?: string; timeout_s?: number }
export const DEFAULT_CONFIG: PregateConfig = { runner: null, dependencies: {}, empty_lanes: [], selection: {}, warn: [], strays: { allow: [] }, local: [], guards: [], serial_patterns: DEFAULT_SERIAL_PATTERNS, price_file: null, stall_timeout_s: null, remote_gate: null };
export interface ConfigError { code: ResultCodeName; path: string; message: string }

export const MAX_LIST = 256;
const MAX_COMMAND = 512;
const KEYS = ['runner', 'dependencies', 'empty_lanes', 'selection', 'warn', 'strays', 'local', 'guards', 'serial_patterns', 'price_file', 'sealed', 'stall_timeout_s', 'remote_gate'];
const LANE_ID = /^[A-Za-z0-9_.-]+\.ya?ml\/[A-Za-z0-9_-]+$/;
const MAX_GUARDS = 32;
const GUARD_KEYS = ['id', 'when', 'command', 'fix', 'timeout_s'];

function globError(g: string): string | null {
  const why = containedRelative(g);
  if (why) return why;
  try { globToRegExp(g); } catch (e: any) { return e.message; }
  return null;
}
function commandError(c: unknown): string | null {
  if (typeof c !== 'string' || !c.trim()) return 'must be a non-empty string';
  if (c.length > MAX_COMMAND || /[\0\r\n]/.test(c)) return `must be one line under ${MAX_COMMAND} characters`;
  return null;
}

function guardErrors(raw: unknown, errors: ConfigError[]): void {
  const bad = (p: string, message: string) => errors.push({ code: 'PREGATE_CONFIG_INVALID', path: p, message });
  if (!Array.isArray(raw)) { bad('guards', 'must be an array of { id, when, command, fix?, timeout_s? }'); return; }
  if (raw.length > MAX_GUARDS) bad('guards', `more than ${MAX_GUARDS} guards`);
  const seen = new Set<string>();
  raw.forEach((g, i) => {
    const at = `guards[${i}]`;
    if (!g || typeof g !== 'object' || Array.isArray(g)) { bad(at, 'must be an object { id, when, command, fix?, timeout_s? }'); return; }
    const o = g as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!GUARD_KEYS.includes(k)) bad(`${at}.${k}`, `unknown key; valid keys: ${GUARD_KEYS.join(', ')}`);
    if (typeof o.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.id)) bad(`${at}.id`, 'must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
    else if (seen.has(o.id)) bad(`${at}.id`, `duplicate guard id ${o.id}`);
    else seen.add(o.id);
    if (!Array.isArray(o.when) || o.when.length === 0 || o.when.some(w => typeof w !== 'string')) bad(`${at}.when`, 'must be a non-empty array of globs');
    else (o.when as string[]).forEach((w, j) => { const why = globError(w); if (why) bad(`${at}.when[${j}]`, `${JSON.stringify(w)} ${why}`); });
    const cmd = commandError(o.command);
    if (cmd) bad(`${at}.command`, cmd);
    if ('fix' in o && commandError(o.fix)) bad(`${at}.fix`, commandError(o.fix)!);
    if ('timeout_s' in o && (!Number.isInteger(o.timeout_s) || (o.timeout_s as number) < 1 || (o.timeout_s as number) > 3600)) bad(`${at}.timeout_s`, 'must be an integer number of seconds from 1 to 3600');
  });
}

export function validateConfig(raw: unknown, knownChecks: readonly string[] = []): ConfigError[] {
  const errors: ConfigError[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'PREGATE_CONFIG_INVALID', path: '', message: 'config must be a JSON object' }];
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (key !== '$schema' && !KEYS.includes(key)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: key, message: `unknown key; valid keys: ${KEYS.join(', ')}` });
  if ('runner' in obj && obj.runner !== null) {
    const why = commandError(obj.runner);
    if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'runner', message: why });
    else if (!(obj.runner as string).includes('{files}')) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'runner', message: 'must contain the {files} placeholder' });
  }
  if ('price_file' in obj && obj.price_file !== null) {
    const why = typeof obj.price_file === 'string' ? containedRelative(obj.price_file) : 'must be a repo-relative path or null';
    if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'price_file', message: why });
  }
  if ('stall_timeout_s' in obj && obj.stall_timeout_s !== null && (!Number.isInteger(obj.stall_timeout_s) || (obj.stall_timeout_s as number) < 0 || (obj.stall_timeout_s as number) > 86_400)) {
    errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'stall_timeout_s', message: 'must be an integer number of seconds from 0 (disabled) to 86400, or null' });
  }
  if ('remote_gate' in obj && obj.remote_gate !== null) {
    const why = commandError(obj.remote_gate);
    if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'remote_gate', message: why });
  }
  if ('guards' in obj) guardErrors(obj.guards, errors);
  if ('sealed' in obj) for (const e of sealedErrors(obj.sealed)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: e.path, message: e.message });
  if ('serial_patterns' in obj) {
    const list = obj.serial_patterns;
    if (!Array.isArray(list) || list.some(g => typeof g !== 'string')) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'serial_patterns', message: 'must be an array of globs' });
    else (list as string[]).forEach((g, i) => { const why = globError(g); if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `serial_patterns[${i}]`, message: `${JSON.stringify(g)} ${why}` }); });
  }
  if ('empty_lanes' in obj) {
    const list = obj.empty_lanes;
    if (!Array.isArray(list) || list.some(g => typeof g !== 'string')) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'empty_lanes', message: 'must be an array of globs (extra docs/no-tests paths; source files and test trees never qualify)' });
    else (list as string[]).forEach((g, i) => { const why = globError(g); if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `empty_lanes[${i}]`, message: `${JSON.stringify(g)} ${why}` }); });
  }
  if ('dependencies' in obj) {
    const deps = obj.dependencies;
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'dependencies', message: 'must be an object of glob → test file list' });
    else {
      const entries = Object.entries(deps as Record<string, unknown>);
      if (entries.length > MAX_LIST) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'dependencies', message: `more than ${MAX_LIST} entries` });
      for (const [glob, tests] of entries) {
        const why = globError(glob);
        if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `dependencies[${JSON.stringify(glob)}]`, message: `${JSON.stringify(glob)} ${why}` });
        if (!Array.isArray(tests) || tests.some(t => typeof t !== 'string')) { errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `dependencies[${JSON.stringify(glob)}]`, message: 'must be an array of test file paths ([] declares no lane needed)' }); continue; }
        (tests as string[]).forEach((t, i) => { const w = containedRelative(t); if (w) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `dependencies[${JSON.stringify(glob)}][${i}]`, message: `${JSON.stringify(t)} ${w}` }); });
      }
    }
  }
  if ('selection' in obj) {
    const sel = obj.selection;
    if (!sel || typeof sel !== 'object' || Array.isArray(sel)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'selection', message: 'must be an object of <workflow.yml>/<job> → command' });
    else for (const [lane, command] of Object.entries(sel as Record<string, unknown>)) {
      if (!LANE_ID.test(lane)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `selection[${JSON.stringify(lane)}]`, message: 'key must be <workflow file>/<job id>' });
      const why = commandError(command);
      if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `selection[${JSON.stringify(lane)}]`, message: why });
    }
  }
  if ('warn' in obj) {
    if (!Array.isArray(obj.warn) || obj.warn.some(w => typeof w !== 'string')) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'warn', message: 'must be an array of check ids' });
    else for (const w of obj.warn as string[]) {
      if ((NON_DOWNGRADABLE as readonly string[]).includes(w)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'warn', message: `${w} cannot be downgraded to warn` });
      else if (knownChecks.length && !knownChecks.includes(w)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'warn', message: `unknown check ${w}; known: ${knownChecks.join(', ')}` });
    }
  }
  if ('strays' in obj) {
    const s = obj.strays as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'strays', message: 'must be { allow: [globs] }' });
    else {
      for (const k of Object.keys(s)) if (k !== 'allow') errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `strays.${k}`, message: 'unknown key' });
      if ('allow' in s) {
        if (!Array.isArray(s.allow) || s.allow.some(a => typeof a !== 'string')) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'strays.allow', message: 'must be an array of globs' });
        else (s.allow as string[]).forEach((g, i) => { const why = globError(g); if (why) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `strays.allow[${i}]`, message: `${JSON.stringify(g)} ${why}` }); });
      }
    }
  }
  if ('local' in obj) {
    if (!Array.isArray(obj.local) || obj.local.some(l => typeof l !== 'string')) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: 'local', message: 'must be an array of <workflow file>/<job id>' });
    else (obj.local as string[]).forEach((l, i) => { if (!LANE_ID.test(l)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `local[${i}]`, message: `${JSON.stringify(l)} must be <workflow file>/<job id>` }); });
  }
  return errors;
}

export function parseConfig(text: string, knownChecks: readonly string[] = []): { config: PregateConfig; errors: ConfigError[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e: any) { return { config: DEFAULT_CONFIG, errors: [{ code: 'PREGATE_CONFIG_INVALID', path: PREGATE_CONFIG_PATH, message: `not valid JSON: ${e.message}` }] }; }
  const errors = validateConfig(raw, knownChecks);
  if (errors.length) return { config: DEFAULT_CONFIG, errors };
  const o = raw as Partial<PregateConfig>;
  return { config: { $schema: o.$schema, runner: o.runner ?? null, dependencies: o.dependencies ?? {}, empty_lanes: o.empty_lanes ?? [], selection: o.selection ?? {}, warn: o.warn ?? [], strays: { allow: o.strays?.allow ?? [] }, local: o.local ?? [], guards: o.guards ?? [], serial_patterns: o.serial_patterns ?? DEFAULT_SERIAL_PATTERNS, price_file: o.price_file ?? null, stall_timeout_s: o.stall_timeout_s ?? null, remote_gate: o.remote_gate ?? null }, errors: [] };
}

export type ConfigLoad = { config: PregateConfig; errors: ConfigError[]; present: boolean; label: string; kind: 'base' | 'head' | 'user' | 'none'; /** sha256 of the user file's bytes (kind 'user' only). */ digest?: string } | { unavailable: true; base: string; detail: string };

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  // r.error covers ENOBUFS, where stdout is cut at the buffer limit even with status 0.
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? '').trim() };
}

export function loadConfigFromBase(repoRoot: string, base: string, knownChecks: readonly string[] = []): ConfigLoad {
  const ref = `origin/${base.replace(/^origin\//, '')}`;
  const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!sha.ok || !sha.out) return { unavailable: true, base: base.replace(/^origin\//, ''), detail: `${ref} is not a resolvable commit` };
  const show = git(repoRoot, ['show', `${sha.out}:${PREGATE_CONFIG_PATH}`]);
  if (!show.ok) {
    // Absent only when the tree says so: a timeout, an oversized blob or a missing/corrupt object must refuse, not hand the run to the user file.
    const entry = git(repoRoot, ['ls-tree', '--name-only', sha.out, '--', PREGATE_CONFIG_PATH]);
    if (!entry.ok || entry.out) return { unavailable: true, base: base.replace(/^origin\//, ''), detail: `${ref}:${PREGATE_CONFIG_PATH} could not be read and git cannot confirm it is absent` };
    return { config: DEFAULT_CONFIG, errors: [], present: false, label: `${ref}@${sha.out.slice(0, 12)} (no ${PREGATE_CONFIG_PATH})`, kind: 'none' };
  }
  return { ...parseConfig(show.out, knownChecks), present: true, label: `${ref}@${sha.out.slice(0, 12)}:${PREGATE_CONFIG_PATH}`, kind: 'base' };
}

export function loadConfigFromHead(repoRoot: string, knownChecks: readonly string[] = []): ConfigLoad {
  const file = path.join(repoRoot, PREGATE_CONFIG_PATH);
  if (!fs.existsSync(file)) return { config: DEFAULT_CONFIG, errors: [], present: false, label: `head (no ${PREGATE_CONFIG_PATH})`, kind: 'none' };
  return { ...parseConfig(fs.readFileSync(file, 'utf8'), knownChecks), present: true, label: `head (unreviewed) ${PREGATE_CONFIG_PATH}`, kind: 'head' };
}

/** A symlink to nothing on the way to `file` (a dotfiles link not yet cloned): a policy the user meant to have, not an absent one. */
function danglingLink(file: string): boolean {
  for (let p = file; path.dirname(p) !== p; p = path.dirname(p)) {
    try { if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() && !fs.existsSync(p)) return true; } catch { return true; }
  }
  return false;
}

/** The user-owned copy for a repo that keeps `.gstack/` out of git; the caller consults it only when the base has none. */
export function loadConfigFromUser(file: string, knownChecks: readonly string[] = []): ConfigLoad | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !danglingLink(file)) return null;
    // An unreadable policy must refuse, never fall back to defaults (its guards would silently vanish).
    return { ...parseConfig('{}', knownChecks), errors: [{ code: 'PREGATE_CONFIG_INVALID', path: file, message: `cannot read the user-owned policy: ${(e as Error).message}` }], present: true, label: `user ${file}`, kind: 'user' };
  }
  const load = parseConfig(text, knownChecks);
  // `sealed` (the pre-push guard) and `price_file` (gstack-eval-plan) read only the git copies, so a non-null value in the user file would look active and do nothing.
  let raw: unknown = null;
  try { raw = JSON.parse(text); } catch { /* parseConfig reported it */ }
  const ignored = raw && typeof raw === 'object' && !Array.isArray(raw) ? ['sealed', 'price_file'].filter(k => (raw as Record<string, unknown>)[k] != null) : [];
  // parseConfig names the repo copy for a JSON error; this file is not it.
  const errors = [...load.errors.map(e => e.path === PREGATE_CONFIG_PATH ? { ...e, path: file } : e), ...ignored.map(k => ({ code: 'PREGATE_CONFIG_INVALID' as const, path: k, message: `the user-owned policy covers gstack-pregate run only; ${k} is read from ${PREGATE_CONFIG_PATH} on the base branch` }))];
  return { ...load, errors, present: true, label: `user ${file}`, kind: 'user', digest: createHash('sha256').update(text).digest('hex') };
}

export function isConfigUnavailable(load: ConfigLoad): load is { unavailable: true; base: string; detail: string } {
  return (load as any).unavailable === true;
}

export function explainConfig(): string {
  return [
    'runner: the test command with a {files} placeholder; null detects bun test / vitest / jest / pytest from the repo',
    'dependencies: glob → test files the import graph cannot see (subprocess targets, runtime reads, generated inputs); [] declares no lane needed',
    'empty_lanes: extra globs treated as docs/no-tests when nothing else maps them. Built-in, with or without this file: any Markdown file the import graph maps to no test (a quoted path, a join() of path segments, an import, or a dependencies entry), plus README/CHANGELOG/CONTRIBUTING/LICENSE/AGENTS/CLAUDE and licence text under any name; assets (images, fonts, media) and allowlisted tool config take their own empty lane. Source code and files under a test directory never qualify. A test that reads the file still selects that test',
    'selection: <workflow.yml>/<job> → the runner-owned command that lists that lane’s test files when its matrix is planner-computed',
    `warn: check ids downgraded to warn; never ${NON_DOWNGRADABLE.join(', ')}; lanes keeps its required-lane and requires-remote verdicts`,
    'strays.allow: root files or new top-level directories that are intentional',
    'local: <workflow.yml>/<job> lanes a local run satisfies (platform-agnostic toolchain, or CI off); their tests run here, not requires-remote',
    'guards: [{ id, when: [globs], command, fix?, timeout_s? }]: each guard whose globs match a touched file runs in its own process (--allow-repo-commands); a failure fails pregate with the guard id and fix; never downgradable',
    `serial_patterns: test-file globs the lanes check runs one process per file, apart from the unit files (default ${DEFAULT_SERIAL_PATTERNS.join(', ')})`,
    'sealed: { paths, transcripts, answer_markers, seed_patterns, local_paths, visibility }: sealed or eval output the pre-push hook and `gstack-pregate sealed` refuse to publish to a public destination (docs/pregate.md#sealed)',
    'price_file: repo-relative path of the GSTACK_EVAL_CALLS v1 call-plan file `gstack-eval-plan price-gate` prices a paid gate from; never executed (docs/eval-calls.md)',
    'stall_timeout_s: seconds without test output before the lanes check kills the runner\'s process group and records it incomplete (default 300; 0 disables; --stall-timeout overrides)',
    'remote_gate: the repo\'s remote test gate command; under 8 cores the test tier becomes a requires-remote obligation naming it, and gstack-pregate --remote runs it (it must print PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n>) (docs/pregate.md#remote-gate)',
    'no .gstack/pregate.json on the base: <state root>/projects/<slug>/pregate.json is read instead (state root: GSTACK_STATE_ROOT, else GSTACK_HOME, else GSTACK_STATE_DIR, else a gstack plugin data dir, else ~/.gstack, per docs/state-root.md; run --explain prints the resolved path; outside the repo, so a PR cannot reach it; a path inside the checkout is ignored)',
  ].join('\n') + '\n';
}
