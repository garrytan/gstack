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
 *   selection     `<workflow.yml>/<job>` → the runner-owned command that lists
 *                 the lane's test files when the matrix is planner-computed
 *   warn          check ids downgraded to warn (never `secrets`; `lanes` keeps
 *                 its required-lane and requires-remote verdicts)
 *   strays.allow  root files or new top-level directories that are intentional
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResultCodeName } from '../result-codes';
import { containedRelative, globToRegExp } from '../ship-policy';

export const PREGATE_CONFIG_PATH = '.gstack/pregate.json';
export const PREGATE_CONFIG_SCHEMA = 'https://github.com/garrytan/gstack/docs/pregate.md#pregate-v1';
export const NON_DOWNGRADABLE = ['secrets'] as const;

export interface PregateConfig {
  $schema?: string;
  runner: string | null;
  dependencies: Record<string, string[]>;
  selection: Record<string, string>;
  warn: string[];
  strays: { allow: string[] };
}
export const DEFAULT_CONFIG: PregateConfig = { runner: null, dependencies: {}, selection: {}, warn: [], strays: { allow: [] } };
export interface ConfigError { code: ResultCodeName; path: string; message: string }

const MAX_LIST = 256;
const MAX_COMMAND = 512;
const KEYS = ['runner', 'dependencies', 'selection', 'warn', 'strays'];

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
      if (!/^[A-Za-z0-9_.-]+\.ya?ml\/[A-Za-z0-9_-]+$/.test(lane)) errors.push({ code: 'PREGATE_CONFIG_INVALID', path: `selection[${JSON.stringify(lane)}]`, message: 'key must be <workflow file>/<job id>' });
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
  return errors;
}

export function parseConfig(text: string, knownChecks: readonly string[] = []): { config: PregateConfig; errors: ConfigError[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e: any) { return { config: DEFAULT_CONFIG, errors: [{ code: 'PREGATE_CONFIG_INVALID', path: PREGATE_CONFIG_PATH, message: `not valid JSON: ${e.message}` }] }; }
  const errors = validateConfig(raw, knownChecks);
  if (errors.length) return { config: DEFAULT_CONFIG, errors };
  const o = raw as Partial<PregateConfig>;
  return { config: { $schema: o.$schema, runner: o.runner ?? null, dependencies: o.dependencies ?? {}, selection: o.selection ?? {}, warn: o.warn ?? [], strays: { allow: o.strays?.allow ?? [] } }, errors: [] };
}

export type ConfigLoad = { config: PregateConfig; errors: ConfigError[]; present: boolean; label: string; kind: 'base' | 'head' | 'none' } | { unavailable: true; base: string; detail: string };

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

export function loadConfigFromBase(repoRoot: string, base: string, knownChecks: readonly string[] = []): ConfigLoad {
  const ref = `origin/${base.replace(/^origin\//, '')}`;
  const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!sha.ok || !sha.out) return { unavailable: true, base: base.replace(/^origin\//, ''), detail: `${ref} is not a resolvable commit` };
  const show = git(repoRoot, ['show', `${sha.out}:${PREGATE_CONFIG_PATH}`]);
  if (!show.ok) return { config: DEFAULT_CONFIG, errors: [], present: false, label: `${ref}@${sha.out.slice(0, 12)} (no ${PREGATE_CONFIG_PATH})`, kind: 'none' };
  return { ...parseConfig(show.out, knownChecks), present: true, label: `${ref}@${sha.out.slice(0, 12)}:${PREGATE_CONFIG_PATH}`, kind: 'base' };
}

export function loadConfigFromHead(repoRoot: string, knownChecks: readonly string[] = []): ConfigLoad {
  const file = path.join(repoRoot, PREGATE_CONFIG_PATH);
  if (!fs.existsSync(file)) return { config: DEFAULT_CONFIG, errors: [], present: false, label: `head (no ${PREGATE_CONFIG_PATH})`, kind: 'none' };
  return { ...parseConfig(fs.readFileSync(file, 'utf8'), knownChecks), present: true, label: `head (unreviewed) ${PREGATE_CONFIG_PATH}`, kind: 'head' };
}

export function isConfigUnavailable(load: ConfigLoad): load is { unavailable: true; base: string; detail: string } {
  return (load as any).unavailable === true;
}

export function exampleConfigJson(): string {
  const example = {
    $schema: PREGATE_CONFIG_SCHEMA,
    runner: null,
    dependencies: { 'bin/example-tool': ['test/example-tool.test.ts'], 'docs/**': [] },
    selection: {},
    warn: [],
    strays: { allow: [] },
  };
  return JSON.stringify(example, null, 2) + '\n';
}

export function explainConfig(): string {
  return [
    'runner: the test command with a {files} placeholder; null detects bun test / vitest / jest / pytest from the repo',
    'dependencies: glob → test files the import graph cannot see (subprocess targets, runtime reads, generated inputs); [] declares no lane needed',
    'selection: <workflow.yml>/<job> → the runner-owned command that lists that lane’s test files when its matrix is planner-computed',
    `warn: check ids downgraded to warn; never ${NON_DOWNGRADABLE.join(', ')}; lanes keeps its required-lane and requires-remote verdicts`,
    'strays.allow: root files or new top-level directories that are intentional',
  ].join('\n') + '\n';
}
