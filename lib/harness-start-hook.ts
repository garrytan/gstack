/**
 * The gstack-start hook (GST-718): an opt-in plugin that puts one short note on every user turn in OpenClaw
 * (before_prompt_build) and Hermes (pre_llm_call), telling the agent to run a gstack skill's start command as
 * written. Skill listings were followed on 1 of 29 chances (HARN-18); a per-turn note 97-100% (HARN-15).
 *
 * Off unless the user asks: `--start-hook`, GSTACK_HARNESS_START_HOOK or `gstack-config set harness_start_hook on`.
 * Turning it on writes a fixed plugin into the harness profile (never under a custom --skills-dir) and changes the
 * harness's settings only through its own commands: OpenClaw needs plugins.entries.gstack-start.hooks.
 * allowConversationAccess before a non-bundled plugin's before_prompt_build runs (2026.10.6 hook-policy-decisions:6);
 * Hermes loads a user plugin only once `hermes plugins enable` lists it. Activation runs only when the choice goes
 * from off to on, so a plugin the user disabled in the harness is never turned back on. Turning it off and
 * unregistering run gstack_harness_hook_release in bin/gstack-harness-ledger.sh, the same code gstack-uninstall runs.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigKey } from './state-root';

export const HOOK_ID = 'gstack-start';
export const START_NOTE_MAX = 300;
/** Names the helper every rendered preamble runs (test/harness-start-hook.test.ts checks both). */
export const START_NOTE = 'gstack: if you use a gstack skill this turn, first run the gstack-skill-start command in its Preamble section exactly as written, with no pipe, head, || true or ; echo. Read its output, then follow the skill.';

export type HookTarget = 'openclaw' | 'hermes';
export type HookState = 'active' | 'written' | 'disabled' | 'unknown' | 'unchecked' | 'off';
export interface HookResult { state: HookState; fix?: string; detail?: string; profile?: string; root?: string }
type Env = Record<string, string | undefined>;

const MANAGED = "Managed by gstack-harness: it rewrites this file. Turn the hook off: gstack-harness register %s --no-start-hook";
const SPECS = {
  openclaw: {
    profileVar: 'OPENCLAW_STATE_DIR', home: '.openclaw', sub: 'extensions', skills: ['skills'], name: 'OpenClaw', config: 'openclaw.json', setup: 'openclaw onboard',
    activate: [['config', 'set', 'plugins.entries.' + HOOK_ID + '.hooks.allowConversationAccess', 'true'], ['config', 'set', 'plugins.entries.' + HOOK_ID + '.enabled', 'true']],
    files: (): Record<string, string> => ({
      'index.js': [
        '// ' + MANAGED.replace('%s', 'openclaw'),
        "import { readFileSync } from 'node:fs';",
        "const NOTE = new URL('./note.txt', import.meta.url);",
        'export default {',
        "  id: '" + HOOK_ID + "',",
        "  name: 'gstack start hook',",
        '  description: "Puts gstack\'s start-command note on each user turn (managed by gstack-harness).",',
        '  register(api) {',
        "    api.on('before_prompt_build', () => {",
        "      let note = '';",
        "      try { note = readFileSync(NOTE, 'utf8').trim(); } catch {}",
        '      return note ? { prependContext: note } : undefined;',
        '    });',
        '  },',
        '};',
        '',
      ].join('\n'),
      'openclaw.plugin.json': JSON.stringify({ id: HOOK_ID, name: 'gstack start hook', description: "Puts gstack's start-command note on each user turn (managed by gstack-harness).", configSchema: { type: 'object', additionalProperties: false } }, null, 2) + '\n',
      'package.json': JSON.stringify({ name: HOOK_ID, version: '1.0.0', private: true, type: 'module', openclaw: { extensions: ['./index.js'] } }, null, 2) + '\n',
    }),
  },
  hermes: {
    profileVar: 'HERMES_HOME', home: '.hermes', sub: 'plugins', skills: ['skills', 'gstack'], name: 'Hermes', config: 'config.yaml', setup: 'hermes setup',
    activate: [['plugins', 'enable', HOOK_ID]],
    files: (): Record<string, string> => ({
      'plugin.yaml': ['# ' + MANAGED.replace('%s', 'hermes'), 'name: ' + HOOK_ID, 'version: 1.0.0', "description: Puts gstack's start-command note on each user turn (managed by gstack-harness).", ''].join('\n'),
      '__init__.py': [
        '# ' + MANAGED.replace('%s', 'hermes'),
        'from pathlib import Path',
        '',
        '_NOTE = Path(__file__).with_name("note.txt")',
        '',
        '',
        'def _context(**_kwargs):',
        '    try:',
        '        note = _NOTE.read_text(encoding="utf-8").strip()',
        '    except OSError:',
        '        return None',
        '    return {"context": note} if note else None',
        '',
        '',
        'def register(ctx):',
        '    ctx.register_hook("pre_llm_call", _context)',
        '',
      ].join('\n'),
    }),
  },
} as const;

export const isHookTarget = (t: string): t is HookTarget => t === 'openclaw' || t === 'hermes';
export function hookProfile(t: HookTarget, env: Env, home: string): string {
  const v = env[SPECS[t].profileVar];
  return v && path.isAbsolute(v) ? path.resolve(v) : v || path.join(home, SPECS[t].home);
}
export const hookRoot = (t: HookTarget, profile: string) => path.join(profile, SPECS[t].sub, HOOK_ID);
/** The skills folder a registration must use for the hook to go into that profile. */
export const profileSkills = (t: HookTarget, profile: string) => path.join(profile, ...SPECS[t].skills);
const activateCommands = (t: HookTarget, profile: string) => SPECS[t].activate.map(a => SPECS[t].profileVar + '=' + JSON.stringify(profile) + ' ' + t + ' ' + a.join(' ')).join(' && ');
/** The harness's own config file in a profile: the file activation edits through the harness CLI. */
export const hookConfig = (t: HookTarget, profile: string) => path.join(profile, SPECS[t].config);

function canonical(p: string): string {
  try { return fs.realpathSync(p); } catch {}
  const parent = path.dirname(p);
  return parent === p ? p : path.join(canonical(parent), path.basename(p));
}
/** The config OPENCLAW_CONFIG_PATH names when it is not the profile's own openclaw.json (compared after realpath), else ''. */
export function foreignOpenclawConfig(env: Env, profile: string): string {
  const v = env.OPENCLAW_CONFIG_PATH;
  if (!v) return '';
  const named = path.resolve(v);
  return canonical(named) === canonical(hookConfig('openclaw', profile)) ? '' : named;
}

/** A profile with no harness config yet: turning the plugin on through the harness CLI would create a config holding only that setting, so gstack waits for the harness's own setup. */
function noConfig(t: HookTarget, profile: string): HookResult | null {
  const cfg = hookConfig(t, profile);
  if (fs.existsSync(cfg)) return null;
  const s = SPECS[t];
  return { state: 'written', detail: 'no ' + s.name + ' config at ' + cfg + ' yet, and turning the plugin on would create one holding only that setting', fix: 'run ' + s.name + "'s own setup first (" + s.profileVar + '=' + JSON.stringify(profile) + ' ' + s.setup + '), then gstack-harness refresh' };
}

/** Reads the hook from the harness's config file when its CLI is not on PATH (a harness's own terminal tool often lacks it). */
function inspectConfig(t: HookTarget, profile: string, fix: string): HookResult {
  const why = t + ' is not on PATH';
  const written: HookResult = { state: 'written', detail: why + ', so gstack could not turn the plugin on or check it', fix };
  const cfg = hookConfig(t, profile);
  if (!fs.existsSync(cfg)) return written;
  let plugins: any;
  try { plugins = ((t === 'hermes' ? Bun.YAML.parse(fs.readFileSync(cfg, 'utf8')) : JSON.parse(fs.readFileSync(cfg, 'utf8'))) as any)?.plugins ?? {}; }
  catch { return { state: 'unknown', detail: why + ' and ' + cfg + ' could not be parsed, so gstack could not check the plugin', fix: 'gstack-harness status from a shell where ' + t + ' is on PATH' }; }
  if (t === 'hermes') {
    const listed = (k: string) => Array.isArray(plugins[k]) && plugins[k].includes(HOOK_ID);
    if (listed('disabled')) return { state: 'disabled', detail: 'turned off in Hermes (plugins.disabled in ' + cfg + '); gstack leaves it off', fix };
    if (listed('enabled') && fs.existsSync(path.join(hookRoot(t, profile), 'plugin.yaml'))) return { state: 'active', detail: 'read from plugins.enabled in ' + cfg + ' (' + why + ')' };
    return written;
  }
  const entry = plugins.entries?.[HOOK_ID] ?? {};
  if (entry.enabled === false) return { state: 'disabled', detail: 'turned off in openclaw.json (plugins.entries.' + HOOK_ID + '.enabled false); gstack leaves it off', fix };
  if (entry.enabled === true && entry.hooks?.allowConversationAccess === true) return { state: 'unknown', detail: cfg + ' turns it on, but ' + why + ', so gstack could not check that OpenClaw loads it', fix: 'gstack-harness status from a shell where openclaw is on PATH' };
  return written;
}

/** The plugin's files (absolute path -> bytes): fixed code plus note.txt, which the code reads at each turn. */
export function hookFiles(t: HookTarget, root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [name, text] of Object.entries({ ...SPECS[t].files(), 'note.txt': START_NOTE + '\n' })) out.set(path.join(root, name), Buffer.from(text));
  return out;
}

/** The user's choice and where it came from: --start-hook/--no-start-hook, then the env var, then gstack-config, then the ledger. */
export function hookChoice(flag: boolean | undefined, env: Env, stateRoot: string, recorded: string | undefined): { on: boolean; source: 'flag' | 'env' | 'config' | 'ledger' } | { invalid: string } {
  if (flag !== undefined) return { on: flag, source: 'flag' };
  const parse = (v: string | null | undefined) => v == null || v === '' ? null : /^(1|on|true|yes)$/i.test(v) ? true : /^(0|off|false|no)$/i.test(v) ? false : undefined;
  const fromEnv = parse(env.GSTACK_HARNESS_START_HOOK);
  if (fromEnv === undefined) return { invalid: 'GSTACK_HARNESS_START_HOOK=' + JSON.stringify(env.GSTACK_HARNESS_START_HOOK) };
  if (fromEnv !== null) return { on: fromEnv, source: 'env' };
  const stored = readConfigKey('harness_start_hook', { ...env, GSTACK_STATE_ROOT: stateRoot } as NodeJS.ProcessEnv);
  const fromConfig = parse(stored);
  if (fromConfig === undefined) return { invalid: 'gstack-config harness_start_hook=' + JSON.stringify(stored) };
  if (fromConfig !== null) return { on: fromConfig, source: 'config' };
  return { on: recorded === 'on', source: 'ledger' };
}

/** Runs the harness's own CLI for one profile: argv only, stdin closed, a timeout, and no environment beyond PATH, HOME and the profile. */
export function runHarness(t: HookTarget, profile: string, args: readonly string[], env: Env, home: string, timeout = 120_000) {
  const r = spawnSync(t, args, { env: { PATH: env.PATH ?? '', HOME: home, [SPECS[t].profileVar]: profile }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
  return { ok: r.status === 0, stdout: r.stdout ?? '', why: r.error ? String((r.error as NodeJS.ErrnoException).code ?? r.error.message) : r.status === 0 ? '' : 'exit ' + r.status + (out ? ': ' + out.split('\n').slice(-2).join(' | ').slice(0, 300) : '') };
}
const onPath = (bin: string, env: Env) => (env.PATH ?? '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, bin)));

/** Turns the plugin on in the harness. Returns the first failure, or ''. */
export function activateHook(t: HookTarget, profile: string, env: Env, home: string): string {
  if (!onPath(t, env)) return t + ' is not on PATH';
  const missing = noConfig(t, profile);
  if (missing) return missing.detail!;
  for (const a of SPECS[t].activate) {
    const r = runHarness(t, profile, a, env, home, 60_000);
    if (!r.ok) return t + ' ' + a.join(' ') + ' failed (' + r.why + ')';
  }
  return '';
}

function parseJson(s: string): any {
  for (const m of s.matchAll(/^[ \t]*[[{]/gm)) { try { return JSON.parse(s.slice(m.index)); } catch {} }
  return null;
}

/** Reads the hook back from the harness: active (configured for new sessions), disabled by the user, written (with the fix), or unknown (no CLI and a config that cannot settle it). Runs no harness command while the profile has no harness config. */
const READ_TIMEOUT = 15_000;

export function inspectHook(t: HookTarget, profile: string, env: Env, home: string): HookResult {
  const fix = activateCommands(t, profile);
  if (!onPath(t, env)) return inspectConfig(t, profile, fix);
  const missing = noConfig(t, profile);
  if (missing) return missing;
  if (t === 'hermes') {
    const r = runHarness(t, profile, ['plugins', 'list', '--json'], env, home, READ_TIMEOUT);
    const row = (parseJson(r.stdout) ?? []).find?.((p: any) => p?.name === HOOK_ID);
    if (row?.status === 'enabled') return { state: 'active' };
    if (row?.status === 'disabled') return { state: 'disabled', detail: 'turned off in Hermes (plugins.disabled); gstack leaves it off', fix: activateCommands(t, profile) };
    return { state: 'written', detail: row ? 'Hermes lists it as ' + row.status : 'hermes plugins list does not show ' + HOOK_ID + (r.why ? ' (' + r.why + ')' : ''), fix };
  }
  const cfg = parseJson(runHarness(t, profile, ['config', 'get', 'plugins', '--json'], env, home, READ_TIMEOUT).stdout) ?? {};
  const entry = cfg.entries?.[HOOK_ID] ?? {};
  if (entry.enabled === false) return { state: 'disabled', detail: 'turned off in openclaw.json (plugins.entries.' + HOOK_ID + '.enabled false); gstack leaves it off', fix };
  if (Array.isArray(cfg.deny) && cfg.deny.includes(HOOK_ID)) return { state: 'written', detail: 'plugins.deny lists ' + HOOK_ID, fix: 'remove ' + HOOK_ID + ' from plugins.deny in openclaw.json' };
  if (Array.isArray(cfg.allow) && cfg.allow.length && !cfg.allow.includes(HOOK_ID)) return { state: 'written', detail: 'plugins.allow is set and does not list ' + HOOK_ID, fix: 'OPENCLAW_STATE_DIR=' + JSON.stringify(profile) + " openclaw config set plugins.allow '" + JSON.stringify([...cfg.allow, HOOK_ID]) + "'" };
  if (entry.hooks?.allowPromptInjection === false) return { state: 'written', detail: 'plugins.entries.' + HOOK_ID + '.hooks.allowPromptInjection is false', fix };
  const r = runHarness(t, profile, ['plugins', 'inspect', HOOK_ID, '--runtime', '--json'], env, home, READ_TIMEOUT);
  const d = parseJson(r.stdout);
  if (d?.plugin?.status === 'loaded' && d.plugin.enabled && (d.typedHooks ?? []).some((h: any) => h?.name === 'before_prompt_build')) return { state: 'active' };
  const why = d?.plugin ? 'status ' + d.plugin.status + (d.plugin.enabled ? '' : ', not enabled') + ((d.typedHooks ?? []).length ? '' : ', before_prompt_build not registered') : 'openclaw plugins inspect failed' + (r.why ? ' (' + r.why + ')' : '');
  return { state: 'written', detail: why, fix };
}

/** True when a plugin folder holds nothing but the .edited-<stamp> copies gstack kept when it turned the hook off. */
function onlyKeptEdits(root: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { recursive: true, withFileTypes: true }); } catch { return false; }
  const files = entries.filter(e => !e.isDirectory());
  return files.length > 0 && files.every(e => e.isFile() && /\.edited-[0-9T-]+Z$/.test(e.name));
}

/** Checks the plugin folder before anything is written: under the profile, no symlink from the profile down, and not someone else's. */
export function assertHookRoot(t: HookTarget, profile: string, root: string, recordedRoot: string | undefined, fail: (code: 'HARNESS_UNSAFE_DESTINATION' | 'HARNESS_HOOK_OWNED_ELSEWHERE', msg: string) => never): void {
  if (!path.isAbsolute(profile) || /[\t\n\r]/.test(profile)) fail('HARNESS_UNSAFE_DESTINATION', 'the ' + t + ' profile ' + profile + ' is not a plain absolute path');
  const top = path.resolve(profile);
  for (let d = root; d !== top && d !== path.dirname(d); d = path.dirname(d)) {
    let st: fs.Stats;
    try { st = fs.lstatSync(d); } catch { continue; }
    if (st.isSymbolicLink()) fail('HARNESS_UNSAFE_DESTINATION', d + ' is a symlink');
  }
  if (fs.existsSync(root) && recordedRoot !== root && !onlyKeptEdits(root)) fail('HARNESS_HOOK_OWNED_ELSEWHERE', 'a ' + HOOK_ID + ' plugin already exists at ' + root + ' and this registration did not write it');
}
