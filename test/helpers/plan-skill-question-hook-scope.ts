/** Finite admission guard for the two hermetic early-question consumers.
 * It preserves hooks/settings and refuses unsupported competing sources. It is
 * not an inventory of remotely supplied or arbitrary in-process CLI modules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { frontmatterName, skillCensus } from './skill-census';

declare const scopeBrand: unique symbol;
export type QuestionHookScope = Readonly<{ [scopeBrand]: true }>;
type Options = { configDir: string; cwd: string };
const scopes = new WeakMap<QuestionHookScope, { opts: Options; inventory: string }>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (detail: string): never => { throw new Error(`Unsupported question hook scope: ${detail}`); };
const managedRoot = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
  : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
const skillSourceRoot = fs.realpathSync(path.resolve(import.meta.dir, '..', '..'));

function inventory(opts: Options): string {
  const rows: [string, string | null][] = [];
  let totalBytes = 0;
  let liveSkills: Map<string, string> | undefined;
  function liveSkill(name: string): string | undefined {
    if (!liveSkills) {
      liveSkills = new Map();
      // Mirror the seeder's finite registry, including frontmatter names and
      // the root router alias. A census symlink cannot admit an outside file.
      for (const rel of skillCensus(skillSourceRoot).physicalSkillFiles) {
        const source = path.join(skillSourceRoot, rel);
        const target = fs.realpathSync(source);
        const relative = path.relative(skillSourceRoot, target);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
        const registryName = rel === 'SKILL.md' ? '_gstack-command' : frontmatterName(source) || path.dirname(rel);
        liveSkills.set(registryName, target);
        // The seeder also exposes the same router in its canonical lazy-path
        // view. This alias admits only that exact root document.
        if (rel === 'SKILL.md') liveSkills.set('gstack', target);
      }
    }
    return liveSkills.get(name);
  }
  const stat = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });
  function directory(dir: string, listing = false): string[] | null {
    const info = stat(dir);
    if (!info) { rows.push([dir, null]); return null; }
    if (!info.isDirectory() || fs.realpathSync(dir) !== dir) fail('noncanonical directory');
    const names = listing ? fs.readdirSync(dir).sort() : [];
    if (names.length > 256) fail('directory inventory exceeds bound');
    rows.push([dir, JSON.stringify(names)]);
    return names;
  }
  function read(file: string): string | null {
    const info = stat(file);
    if (!info) { rows.push([file, null]); return null; }
    if (!info.isFile() || info.size > 1024 * 1024) fail('nonregular or oversized source');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile() || info.size > 1024 * 1024) fail('nonregular or oversized source');
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      totalBytes += length;
      if (length > 1024 * 1024 || totalBytes > 16 * 1024 * 1024) fail('source bytes exceed bound');
      rows.push([file, createHash('sha256').update(bytes.subarray(0, length)).digest('hex')]);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { fs.closeSync(fd); }
  }
  function policy(value: unknown): void {
    if (!object(value)) fail('settings/frontmatter must be an object');
    if (value.hooks !== undefined) {
      if (!object(value.hooks)) fail('unparseable hooks');
      for (const event of ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure']) {
        const entries = value.hooks[event];
        if (entries === undefined) continue;
        if (!Array.isArray(entries)) fail(`unparseable ${event} hooks`);
        for (const entry of entries) {
          // AUQ is observed before permission; file/Bash/Fetch grant input is observed at the
          // permission request, after legitimate PreToolUse safety hooks.
          // Reject matching mutators at or after each observation boundary.
          // Substrings are conservatively refused too, independent of anchoring.
          if (!object(entry) || typeof entry.matcher !== 'string'
            || !/^[A-Za-z][A-Za-z0-9_]*$/.test(entry.matcher)
            || (event === 'PreToolUse' ? ['askuserquestion', 'exitplanmode']
              : event === 'PostToolUse' ? ['write', 'edit', 'askuserquestion', 'bash', 'webfetch']
                : event === 'PostToolUseFailure' ? ['bash', 'webfetch'] : ['askuserquestion', 'exitplanmode', 'write', 'edit', 'bash', 'webfetch'])
              .some(tool => tool.includes(entry.matcher.toLowerCase()))
            || !Array.isArray(entry.hooks)) fail(`competing or unsupported ${event} matcher`);
        }
      }
    }
    if (value.enabledPlugins !== undefined && (!object(value.enabledPlugins)
      || Object.values(value.enabledPlugins).some(enabled => enabled !== false))) fail('enabled plugins');
    for (const key of ['plugins', 'modules', 'pluginConfigs']) {
      if (value[key] !== undefined && (!object(value[key]) || Object.keys(value[key]).length)) fail('plugin/module source');
    }
  }
  function settings(file: string): void {
    const text = read(file);
    if (text !== null) policy(JSON.parse(text));
  }
  function skills(dir: string, privateRegistry: boolean): void {
    const link = stat(dir);
    if (link?.isSymbolicLink()) {
      const expected = path.join(path.dirname(path.dirname(opts.configDir)), 'with-skills', '.claude', 'skills');
      if (!privateRegistry || fs.realpathSync(dir) !== expected) fail('external skill registry');
      rows.push([dir, `link:${fs.readlinkSync(dir)}:${expected}`]);
      dir = expected;
    }
    const names = directory(dir, true);
    if (!names) return;
    for (const name of names) {
      if (directory(path.join(dir, name)) === null) fail('missing skill directory');
      let file = path.join(dir, name, 'SKILL.md');
      if (stat(file)?.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        const owner = path.dirname(path.dirname(dir));
        // The installed project registry links each name to its same-name
        // checkout document. Private registries can also use the seeder's
        // exact live-source entry; neither rule admits a different skill.
        const allowed = privateRegistry ? target.startsWith(path.join(owner, 'runtime') + path.sep)
          || target === liveSkill(name)
          : target === path.join(owner, name, 'SKILL.md');
        if (!allowed) fail('external skill document');
        rows.push([file, `link:${fs.readlinkSync(file)}:${target}`]);
        file = target;
      }
      const text = read(file);
      if (text === null) fail('missing skill document');
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!match) fail('unparseable skill frontmatter');
      policy(Bun.YAML.parse(match[1]));
    }
  }
  function config(dir: string, privateRegistry = false): void {
    if (directory(dir) === null) return;
    settings(path.join(dir, 'settings.json'));
    settings(path.join(dir, 'settings.local.json'));
    const plugins = path.join(dir, 'plugins');
    // CLI startup creates this empty container. Its existence is not policy;
    // the registry's absence/bytes are always inventoried, even before mkdir.
    const pluginDir = stat(plugins);
    if (pluginDir && (!pluginDir.isDirectory() || fs.realpathSync(plugins) !== plugins)) fail('noncanonical plugin directory');
    settings(path.join(plugins, 'installed_plugins.json'));
    skills(path.join(dir, 'skills'), privateRegistry);
  }

  for (const dir of [opts.configDir, opts.cwd]) {
    if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || directory(dir) === null) fail('owned absolute directories required');
  }
  config(opts.configDir, true);
  // CLI project settings may come from the working directory or a repo ancestor.
  // Inspect the finite ancestor chain; no HOME/config/auth discovery is performed.
  let current = opts.cwd;
  for (let depth = 0; ; depth++) {
    if (depth > 64) fail('project ancestry exceeds bound');
    config(path.join(current, '.claude'));
    const git = stat(path.join(current, '.git'));
    rows.push([path.join(current, '.git'), git ? 'present' : null]);
    if (git || path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  if (directory(managedRoot) !== null) {
    settings(path.join(managedRoot, 'managed-settings.json'));
    const dropins = path.join(managedRoot, 'managed-settings.d');
    for (const name of directory(dropins, true) ?? []) {
      if (name.endsWith('.json')) settings(path.join(dropins, name));
    }
  }
  return JSON.stringify(rows);
}

export function setupQuestionHookScope(opts: Options): QuestionHookScope {
  const saved = { configDir: opts.configDir, cwd: opts.cwd };
  const scope = Object.freeze({}) as QuestionHookScope;
  scopes.set(scope, { opts: saved, inventory: inventory(saved) });
  return scope;
}

export function assertQuestionHookScope(scope: QuestionHookScope): void {
  const saved = scopes.get(scope);
  if (!saved) fail('descriptor was not created by setup');
  if (inventory(saved.opts) !== saved.inventory) fail('settings or skill inventory changed');
}
