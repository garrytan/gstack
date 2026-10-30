/**
 * gstack-harness: register gstack's skills with the agent harness gstack is
 * installed into, the harness's own way, and take them back out (GSTA-135).
 *
 * Targets: openclaw and hermes (hosts with renders: real copies in the
 * harness's own skills folder), dots (a router skill in the Dot's skills
 * folder), generic (a router skill and/or a marked context block for any other
 * harness), qm (an org skill pack through QM's admin API, lib/harness-qm.ts),
 * muse and grok (detection only: both already read ~/.claude/skills).
 *
 * Every write is recorded in a ledger, $GSTACK_STATE_ROOT/harness/<id>.ledger,
 * a TSV that bin/gstack-harness-ledger.sh reads without bun, so
 * bin/gstack-uninstall removes exactly what was written before it removes the
 * checkout. A file edited after registration is moved to a backup, never
 * deleted; an entry gstack did not write is never overwritten.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bunIsolationArgs } from './bun-isolation';
import { runBashSync } from './script-invocation';
import { frontmatterList, routerLine } from './skill-triggers';

export type SkillsMode = 'router' | 'hybrid' | 'all';
export type TargetName = 'openclaw' | 'hermes' | 'dots' | 'generic' | 'qm' | 'muse' | 'grok';
type Env = Record<string, string | undefined>;

/** Every-session budgets (rule 30): the router's description and the context block. */
export const ROUTER_DESCRIPTION_MAX = 300;
export const CONTEXT_BLOCK_MAX = 600;
export const BLOCK_BEGIN = '<!-- gstack:begin harness-routing -->';
export const BLOCK_END = '<!-- gstack:end harness-routing -->';
/** Where a Dot keeps its own skills (feder-cr/dots nanobot/dots/skills.py DOT_SKILLS_DIR). */
export const DOT_SKILLS_DIR = '/home/dot/skills';
export const ROUTER_DESCRIPTION = 'Use to review a diff or PR, debug a bug or failing test, QA test a site, plan or review architecture, ship a PR, audit security or write release docs. Load first for any coding task: lists every gstack skill and where to read it.';
/** OpenClaw hybrid mode: these task skills are listed as skills of their own; the router carries the rest. */
export const HYBRID_SKILLS = ['review', 'investigate', 'qa', 'ship', 'plan-eng-review'];

export interface Target {
  name: TargetName;
  displayName: string;
  mechanism: 'skill-folder' | 'skill-pack-api' | 'verify-only' | 'context-block';
  /** Which skills the payload carries: the host's own render, or the checkout's committed Claude render. */
  render: 'host' | 'claude' | null;
  defaultMode: SkillsMode;
  modes: SkillsMode[];
  /** Destination folder for this target, from its environment, or null when it has no default. */
  dest: (env: Env, home: string) => string | null;
  /** Running inside this harness: a session marker or the harness among this process's ancestors. */
  inside: (env: Env, ancestry: string[]) => boolean;
  /** Installed on this machine (binary on PATH or its home folder). */
  present: (env: Env, home: string) => boolean;
  /** The harness's own command that lists the skills it sees, and how one skill name shows in its output. */
  listCommand?: (dest: string) => { argv: string[]; env: Env; listed: (name: string) => RegExp };
}

const onPath = (bin: string, env: Env) => (env.PATH ?? '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, bin)));
/** An ancestor is the harness when its program, or the script its interpreter runs, is named for it (arguments never count). */
const ancestorIs = (ancestry: string[], name: string) => ancestry.some(id => {
  const [exe, script = ''] = id.split(' ');
  return exe === name || (/^(node|nodejs|bun|python[0-9.]*)$/.test(exe) && script.replace(/.(mjs|js|py)$/, '') === name);
});

export const TARGETS: Record<TargetName, Target> = {
  openclaw: {
    name: 'openclaw', displayName: 'OpenClaw', mechanism: 'skill-folder', render: 'host', defaultMode: 'hybrid', modes: ['router', 'hybrid', 'all'],
    dest: (env, home) => path.join(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw'), 'skills'),
    inside: (env, anc) => env.OPENCLAW_SHELL === 'exec' || ancestorIs(anc, 'openclaw'),
    present: (env, home) => onPath('openclaw', env) || fs.existsSync(env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw')),
    listCommand: dest => ({ argv: ['openclaw', 'skills', 'list', '--json'], env: { OPENCLAW_STATE_DIR: path.dirname(dest) }, listed: name => new RegExp('"name":\\s*"' + name + '"') }),
  },
  hermes: {
    name: 'hermes', displayName: 'Hermes', mechanism: 'skill-folder', render: 'host', defaultMode: 'all', modes: ['all'],
    dest: (env, home) => path.join(env.HERMES_HOME || path.join(home, '.hermes'), 'skills', 'gstack'),
    inside: (env, anc) => env.HERMES_AGENT === 'true' || env.AI_AGENT === 'hermes-agent' || ancestorIs(anc, 'hermes'),
    present: (env, home) => onPath('hermes', env) || fs.existsSync(env.HERMES_HOME || path.join(home, '.hermes')),
    listCommand: dest => ({ argv: ['hermes', 'skills', 'list'], env: { HERMES_HOME: path.dirname(path.dirname(dest)) }, listed: name => new RegExp('\\s' + name + '\\s') }),
  },
  dots: {
    name: 'dots', displayName: 'dots (feder-cr)', mechanism: 'skill-folder', render: 'claude', defaultMode: 'router', modes: ['router', 'all'],
    dest: () => DOT_SKILLS_DIR,
    inside: (env) => fs.existsSync('/opt/invisible-dots') && (env.HOME ?? '') === '/home/dot',
    present: () => fs.existsSync('/opt/invisible-dots'),
  },
  generic: {
    name: 'generic', displayName: 'any other harness', mechanism: 'context-block', render: 'claude', defaultMode: 'router', modes: ['router', 'all'],
    dest: () => null,
    inside: () => false,
    present: () => false,
  },
  qm: {
    name: 'qm', displayName: 'QM', mechanism: 'skill-pack-api', render: null, defaultMode: 'all', modes: ['all'],
    dest: env => env.GSTACK_QM_URL || null,
    inside: () => false,
    present: () => false,
  },
  muse: {
    name: 'muse', displayName: 'Muse Code', mechanism: 'verify-only', render: null, defaultMode: 'all', modes: ['all'],
    dest: () => null, inside: () => false, present: env => onPath('muse', env),
    listCommand: () => ({ argv: ['muse', 'skills', 'list'], env: {}, listed: name => new RegExp('\\b' + name + '\\b') }),
  },
  grok: {
    name: 'grok', displayName: 'Grok Build', mechanism: 'verify-only', render: null, defaultMode: 'all', modes: ['all'],
    dest: () => null, inside: () => false, present: env => onPath('grok', env),
    listCommand: () => ({ argv: ['grok', 'inspect'], env: {}, listed: name => new RegExp('\\b' + name + '\\b') }),
  },
};

/** Reason codes users can see; each has a section in docs/troubleshooting.md (test/harness-register.test.ts). */
export const HARNESS_CODES = {
  HARNESS_UNKNOWN_TARGET: { anchor: 'harness-unknown-target', fix: 'name one of: openclaw, hermes, dots, generic, qm, muse, grok' },
  HARNESS_NO_DESTINATION: { anchor: 'harness-no-destination', fix: 'pass --skills-dir <dir> or --context <file>, or --print to see the block without writing' },
  HARNESS_MODE_UNSUPPORTED: { anchor: 'harness-mode-unsupported', fix: 'drop --skills, or pass a mode the target supports (Hermes takes all: its skills index lists only skills registered as folders, so a router would leave the rest out of the listing)' },
  HARNESS_CONTEXT_REFUSED: { anchor: 'harness-context-refused', fix: 'name a rules file the harness already loads (for Hermes, the existing .hermes.md, HERMES.md or AGENTS.md), never SOUL.md' },
  HARNESS_UNSAFE_DESTINATION: { anchor: 'harness-unsafe-destination', fix: 'pick a destination that is a plain folder outside the gstack checkout, not your home folder, with no tab or newline in its path' },
  HARNESS_UNOWNED_ENTRY: { anchor: 'harness-unowned-entry', fix: 'move or rename the existing entry (gstack did not write it), then register again' },
  HARNESS_RENDER_FAILED: { anchor: 'harness-render-failed', fix: 'run bun install in the gstack checkout, then register again; the render output above names the failing skill' },
  HARNESS_BUDGET_EXCEEDED: { anchor: 'harness-budget-exceeded', fix: 'this is a gstack bug: report it with the byte count printed above' },
  HARNESS_NOT_REGISTERED: { anchor: 'harness-not-registered', fix: 'run gstack-harness status to see the registrations on this machine' },
  HARNESS_QM_CREDENTIALS: { anchor: 'harness-qm-credentials', fix: 'set GSTACK_QM_URL and either GSTACK_QM_ADMIN_TOKEN, or GSTACK_QM_SIGNING_SECRET with GSTACK_QM_ADMIN_ACTOR, then rerun with --yes' },
  HARNESS_QM_API: { anchor: 'harness-qm-api', fix: 'check that the QM core URL is reachable and the credential is an org admin; gstack-harness status shows whether a pack was left half-registered' },
  HARNESS_QM_PACK_TOO_LARGE: { anchor: 'harness-qm-pack-too-large', fix: 'QM registration is not available yet; give a QM agent gstack with gstack-harness register generic --print pasted into its instructions' },
} as const;
export type HarnessCode = keyof typeof HARNESS_CODES;

export class HarnessError extends Error {
  constructor(readonly code: HarnessCode, message: string) { super(message); }
  /** Not named line(): Bun gives every thrown Error an own numeric line property, which would shadow it. */
  report(): string {
    const c = HARNESS_CODES[this.code];
    return 'gstack-harness: ' + this.message + '. Fix: ' + c.fix + ' (' + this.code + '; docs/troubleshooting.md#' + c.anchor + ')';
  }
}

export function getTarget(name: string): Target {
  const t = (TARGETS as Record<string, Target>)[name];
  if (!t) throw new HarnessError('HARNESS_UNKNOWN_TARGET', 'unknown harness ' + JSON.stringify(name));
  return t;
}

/** This process's ancestors as "<program> <first argument>" basenames, nearest first (Linux /proc, else ps). */
export function processAncestry(pid = process.pid, depth = 16): string[] {
  const out: string[] = [];
  let cur = pid;
  for (let i = 0; i < depth && cur > 1; i++) {
    let ppid = 0; let cmd = '';
    try {
      const stat = fs.readFileSync('/proc/' + cur + '/stat', 'utf8');
      ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      cmd = fs.readFileSync('/proc/' + cur + '/cmdline', 'utf8').split('\0').slice(0, 2).map(a => path.basename(a)).join(' ');
    } catch {
      const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(cur)], { encoding: 'utf8', timeout: 5000 });
      const m = (r.stdout ?? '').trim().match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      ppid = Number(m[1]); cmd = m[2].split(/\s+/).slice(0, 2).map(a => path.basename(a)).join(' ');
    }
    if (i > 0) out.push(cmd);
    if (!ppid || ppid === cur) break;
    cur = ppid;
  }
  return out;
}

export interface Detection { inside: TargetName[]; present: TargetName[] }
export function detect(env: Env = process.env, home = os.homedir(), ancestry = processAncestry()): Detection {
  const names = Object.keys(TARGETS) as TargetName[];
  return {
    inside: names.filter(n => TARGETS[n].inside(env, ancestry)),
    present: names.filter(n => TARGETS[n].present(env, home)),
  };
}

// --- payload --------------------------------------------------------------

export interface SkillEntry { name: string; use: string; dir: string }

function frontmatterField(md: string, field: string): string {
  const fm = md.startsWith('---\n') ? md.slice(4, md.indexOf('\n---', 4)) : '';
  const lines = fm.split('\n');
  const i = lines.findIndex(l => l.startsWith(field + ':'));
  if (i < 0) return '';
  const first = lines[i].slice(field.length + 1).trim();
  if (first !== '|' && first !== '>') return first.replace(/^["']|["']$/g, '');
  const body: string[] = [];
  for (const l of lines.slice(i + 1)) { if (!/^\s/.test(l)) break; body.push(l.trim()); }
  return body.join(' ');
}

/** Agent Skills frontmatter in its strictest reading (dots): single-line name equal to the folder, single-line description of at most 1024 characters. */
export function flatFrontmatter(md: string, name: string): string {
  const end = md.startsWith('---\n') ? md.indexOf('\n---', 4) : -1;
  const desc = frontmatterField(md, 'description').replace(/\s+/g, ' ').trim();
  const body = end < 0 ? md : md.slice(md.indexOf('\n', end + 4) + 1);
  return '---\nname: ' + name + '\ndescription: ' + (desc.length > 1024 ? desc.slice(0, 1021).trimEnd() + '...' : desc) + '\n---\n' + body;
}

/** Generated skills under root; a render whose frontmatter dropped `triggers:` takes them from triggersByName (the checkout's skills, by name). */
function skillDirs(root: string, triggersByName = new Map<string, string[]>()): Array<SkillEntry & { triggers: string[] }> {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().flatMap(dir => {
    const md = path.join(root, dir, 'SKILL.md');
    if (!fs.existsSync(md)) return [];
    const text = fs.readFileSync(md, 'utf8');
    if (!text.includes('AUTO-GENERATED')) return [];
    const name = frontmatterField(text, 'name') || dir;
    const own = frontmatterList(text, 'triggers');
    const triggers = own.length ? own : triggersByName.get(name) ?? triggersByName.get(name.replace(/^gstack-/, '')) ?? [];
    return [{ name, use: routerLine(frontmatterField(text, 'description'), triggers), dir: path.join(root, dir), triggers }];
  });
}

/** The skills a target's payload carries: the host render (made for this checkout as the install root) or the checkout's committed Claude render. */
export function sourceSkills(target: Target, checkout: string, scratch: string): SkillEntry[] {
  if (target.render === 'claude') return skillDirs(checkout).filter(s => s.name !== 'gstack');
  const out = path.join(scratch, 'render');
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [...bunIsolationArgs(), 'scripts/gen-skill-docs.ts', '--host', target.name, '--install-root', checkout, '--out-dir', out],
    { cwd: checkout, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new HarnessError('HARNESS_RENDER_FAILED', 'could not render ' + target.name + ' skills: ' + ((r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')));
  const skills = skillDirs(path.join(out, '.' + target.name, 'skills'), new Map(skillDirs(checkout).map(s => [s.name, s.triggers])));
  if (!skills.length) throw new HarnessError('HARNESS_RENDER_FAILED', 'the ' + target.name + ' render produced no skills');
  return skills;
}

/** The router skill; direct names the skills hybrid mode lists as skills of their own. */
export function routerSkill(skills: Array<{ name: string; use: string; path: string }>, target: Target, direct: string[] = []): string {
  const claudeNote = target.render === 'claude'
    ? '\nThese files use Claude Code tool names (Bash, Read, Edit, Agent, AskUserQuestion); use your own equivalents.\n' : '';
  const directNote = direct.length ? ' ' + direct.join(', ') + ' are skills of their own in your list; this router carries the rest.' : '';
  return [
    '---', 'name: gstack', 'description: ' + ROUTER_DESCRIPTION, '---',
    '<!-- AUTO-GENERATED by gstack-harness register: rerun it instead of editing -->',
    '# gstack skills', '',
    'Pick the one skill whose line matches the task, then read that SKILL.md in full and follow it. Read nothing else up front.' + directNote + claudeNote,
    ...skills.map(s => '- **' + s.name + '**: ' + s.use + ' Read `' + s.path + '`'),
    '',
  ].join('\n');
}

/** The marked context block for the registration's mode: router (a router path), hybrid (a router path and direct skills) or all (no router). */
export function contextBlock(routerPath: string | null, direct: string[] = []): string {
  const lead = "gstack's engineering workflows (code review, QA, debugging, security audit, plan review, shipping) are installed here. ";
  const pick = ', pick the one skill whose line matches, then read and follow that skill. Load nothing else up front.';
  const body = !routerPath
    ? 'For a coding, review, test, plan or release task, load the matching gstack skill from your skills list and follow it. Load nothing else up front.'
    : direct.length
      ? 'For a task that ' + direct.join(', ') + ' fits, load that skill from your skills list; for any other coding, review, test, plan or release task, read `' + routerPath + '`' + pick
      : 'For a coding, review, test, plan or release task, read `' + routerPath + '`' + pick;
  return [BLOCK_BEGIN, '## gstack skills', lead + body, BLOCK_END].join('\n');
}

// --- ledger ----------------------------------------------------------------

/** pad: what gstack added before a block it appended, so uninstall restores the file byte for byte: new (it created the file), 0 (the file was empty), 1 (one blank line), 2 (a newline and a blank line); '' in ledgers that predate it. */
export interface LedgerBlock { sha: string; path: string; pad: string }
export interface Ledger { meta: Record<string, string>; files: Array<{ sha: string; path: string }>; dirs: string[]; blocks: LedgerBlock[] }

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const ledgerDir = (stateRoot: string) => path.join(stateRoot, 'harness');
export const registrationId = (target: string, dest: string) => target + '-' + sha256(dest).slice(0, 12);
export const ledgerPath = (stateRoot: string, id: string) => path.join(ledgerDir(stateRoot), id + '.ledger');

export function readLedger(file: string): Ledger | null {
  if (!fs.existsSync(file)) return null;
  const l: Ledger = { meta: {}, files: [], dirs: [], blocks: [] };
  const pads = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [kind, a, ...rest] = line.split('\t');
    const b = rest.join('\t');
    if (kind === 'meta') l.meta[a] = b;
    else if (kind === 'file') l.files.push({ sha: a, path: b });
    else if (kind === 'dir') l.dirs.push(b);
    else if (kind === 'blockpad') pads.set(b, a);
    else if (kind === 'block') l.blocks.push({ sha: a, path: b, pad: pads.get(b) ?? '' });
  }
  return l;
}

export function writeLedger(file: string, l: Ledger): void {
  const rows = ['# gstack-harness ledger v1 (read by bin/gstack-harness-ledger.sh)',
    ...Object.entries(l.meta).map(([k, v]) => 'meta\t' + k + '\t' + v),
    ...l.files.map(f => 'file\t' + f.sha + '\t' + f.path),
    ...l.dirs.map(d => 'dir\t-\t' + d),
    ...l.blocks.flatMap(b => [...(b.pad ? ['blockpad\t' + b.pad + '\t' + b.path] : []), 'block\t' + b.sha + '\t' + b.path])];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', rows.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

export function listLedgers(stateRoot: string): Array<{ file: string; ledger: Ledger }> {
  const dir = ledgerDir(stateRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.ledger')).sort()
    .flatMap(f => { const ledger = readLedger(path.join(dir, f)); return ledger ? [{ file: path.join(dir, f), ledger }] : []; });
}

// --- register ----------------------------------------------------------------

export interface RegisterOptions {
  target: Target;
  mode?: SkillsMode;
  /** Destination override: the harness skills folder (--skills-dir). */
  skillsDir?: string;
  /** Context file for the routing block: written only into the file named here (--context). */
  context?: string;
  /** Refresh: context only identifies a generic registration; blocks already recorded are kept while they are still in their files, never re-added. */
  inherit?: boolean;
  checkout: string;
  stateRoot: string;
  env: Env;
  home: string;
  version: string;
  /** Publish an installs.tsv row for host targets (setup's own arm publishes it instead). */
  registry?: boolean;
}
export interface RegisterResult {
  id: string; target: TargetName; dest: string; mode: SkillsMode;
  status: 'installed' | 'updated' | 'unchanged'; written: number; skills: number; router: string | null; ledger: string; kept: string[];
}

const PLAIN = /^[^\t\n\r]+$/;

function assertSafeDest(dest: string, opts: RegisterOptions): void {
  const bad = (why: string) => { throw new HarnessError('HARNESS_UNSAFE_DESTINATION', 'refusing to write into ' + dest + ': ' + why); };
  if (!path.isAbsolute(dest) || !PLAIN.test(dest)) bad('not a plain absolute path');
  const norm = path.resolve(dest);
  if (norm === '/' || norm === path.resolve(opts.home)) bad('it is the filesystem root or your home folder');
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const co = real(opts.checkout);
  let probe = norm;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const resolved = path.join(real(probe), path.relative(probe, norm));
  if (resolved === co || resolved.startsWith(co + path.sep)) bad('it is inside the gstack checkout');
  if (fs.existsSync(norm) && fs.lstatSync(norm).isSymbolicLink()) bad('it is a symlink');
}

function walkFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    const st = fs.statSync(p);
    return st.isDirectory() ? walkFiles(p) : st.isFile() ? [p] : [];
  });
}

function resolveDest(opts: RegisterOptions, id?: string): string | null {
  if (opts.skillsDir) return path.resolve(opts.skillsDir);
  const d = opts.target.dest(opts.env, opts.home);
  if (d) return d;
  return opts.context && id ? path.join(ledgerDir(opts.stateRoot), id) : null;
}

/** Desired files (absolute path -> bytes), the router path, the skill names the harness lists, the skills listed directly beside a router, and the skill count. */
export function planPayload(opts: RegisterOptions, dest: string, mode: SkillsMode, scratch: string): { files: Map<string, Buffer>; router: string | null; visible: string[]; direct: string[]; skills: number } {
  const t = opts.target;
  const skills = sourceSkills(t, opts.checkout, scratch);
  const files = new Map<string, Buffer>();
  const copyDir = (from: string, to: string) => { for (const f of walkFiles(from)) files.set(path.join(to, path.relative(from, f)), fs.readFileSync(f)); };
  const claudeFiles = (s: SkillEntry, to: string) => {
    files.set(path.join(to, 'SKILL.md'), Buffer.from(flatFrontmatter(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), path.basename(to))));
    if (fs.existsSync(path.join(s.dir, 'sections'))) copyDir(path.join(s.dir, 'sections'), path.join(to, 'sections'));
  };
  const listed = (s: SkillEntry) => {
    const to = path.join(dest, path.basename(s.dir));
    if (t.render === 'host') copyDir(s.dir, to); else claudeFiles(s, to);
    return t.render === 'host' ? s.name : path.basename(s.dir);
  };
  if (mode === 'all') {
    const names = skills.map(listed);
    return { files, router: null, visible: names, direct: [], skills: names.length };
  }
  const isDirect = (s: SkillEntry) => mode === 'hybrid' && HYBRID_SKILLS.includes(path.basename(s.dir).replace(/^gstack-/, ''));
  const direct = skills.filter(isDirect).map(listed);
  const routerDir = path.join(dest, 'gstack');
  const entries = skills.filter(s => !isDirect(s)).map(s => {
    if (t.render !== 'host') return { name: s.name, use: s.use, path: path.join(s.dir, 'SKILL.md') };
    const to = path.join(routerDir, 'skills', path.basename(s.dir));
    copyDir(s.dir, to);
    return { name: s.name, use: s.use, path: path.join(to, 'SKILL.md') };
  });
  const router = path.join(routerDir, 'SKILL.md');
  files.set(router, Buffer.from(routerSkill(entries, t, direct)));
  return { files, router, visible: ['gstack', ...direct], direct, skills: skills.length };
}

/** An edited file stays beside itself under a name no harness loads, so no uninstall step that removes gstack's folders can take it. */
function keepEdit(file: string, stamp: string): string {
  const to = file + '.edited-' + stamp;
  fs.renameSync(file, to);
  return to;
}

/** Refuses a path outside dest, or one reached through a symlink below dest. */
function assertOwnedPath(dest: string, p: string): void {
  if (!p.startsWith(dest + path.sep)) throw new HarnessError('HARNESS_UNSAFE_DESTINATION', p + ' is outside ' + dest);
  for (let d = p; d !== dest; d = path.dirname(d)) {
    let st: fs.Stats;
    try { st = fs.lstatSync(d); } catch { continue; }
    if (st.isSymbolicLink()) throw new HarnessError('HARNESS_UNSAFE_DESTINATION', d + ' is a symlink');
  }
}

function onDiskSha(file: string): string | null {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

/** The ledger's hash of a context block: its lines, each ending in a newline, as the bash reader's awk prints them. */
export const blockSha = (block: string) => sha256(block + '\n');

/** The gstack block in a file: absent (no marker lines, or no file), owned (one marker pair hashing to sha) or other. */
export function blockState(file: string, sha: string): 'absent' | 'owned' | 'other' {
  if (!fs.existsSync(file)) return 'absent';
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = (m: string) => lines.flatMap((l, i) => l === m ? [i] : []);
  const [bs, es] = [at(BLOCK_BEGIN), at(BLOCK_END)];
  if (!bs.length && !es.length) return 'absent';
  return bs.length === 1 && es.length === 1 && es[0] > bs[0] && sha256(lines.slice(bs[0], es[0] + 1).join('\n') + '\n') === sha ? 'owned' : 'other';
}

/**
 * The text of file with the block in it, and the pad gstack added before an appended block: replaces the one gstack
 * block there (whole-line markers) when it is the block gstack wrote (ownedSha) or already current (pad ''), else
 * appends. A lone or repeated marker, or a block someone edited, is refused so nothing outside gstack's own lines is
 * ever rewritten.
 */
export function withBlock(file: string, block: string, ownedSha?: string): { text: string; pad: string } {
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  const at = (m: string) => lines.flatMap((l, i) => l === m ? [i] : []);
  const [bs, es] = [at(BLOCK_BEGIN), at(BLOCK_END)];
  if (!bs.length && !es.length) {
    const pad = !exists ? 'new' : !text ? '0' : text.endsWith('\n') ? '1' : '2';
    return { text: text + (pad === '2' ? '\n\n' : pad === '1' ? '\n' : '') + block + '\n', pad };
  }
  if (bs.length === 1 && es.length === 1 && es[0] > bs[0]) {
    const cur = sha256(lines.slice(bs[0], es[0] + 1).join('\n') + '\n');
    if (cur !== blockSha(block) && cur !== ownedSha) throw new HarnessError('HARNESS_UNOWNED_ENTRY', 'the gstack block in ' + file + ' was edited or gstack did not write it; delete the lines from ' + BLOCK_BEGIN + ' to ' + BLOCK_END);
    lines.splice(bs[0], es[0] - bs[0] + 1, ...block.split('\n'));
    return { text: lines.join('\n'), pad: '' };
  }
  throw new HarnessError('HARNESS_UNOWNED_ENTRY', file + ' has a gstack harness-routing marker line without exactly one partner; fix or delete the marker lines');
}

/** Whether a context file belongs to the harness's own home (profile: every session) or to a project (sessions started there). */
export function contextScope(t: Target, file: string, env: Env, home: string): 'profile' | 'project' {
  const harnessHome = t.name === 'hermes' ? env.HERMES_HOME || path.join(home, '.hermes') : t.name === 'openclaw' ? env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw') : null;
  return harnessHome && path.resolve(file).startsWith(path.resolve(harnessHome) + path.sep) ? 'profile' : 'project';
}

/** Hermes loads one project context type, first match wins, walking to the git root (agent/prompt_builder.py build_context_files_prompt); within a group the first name in a folder wins, and the nearest .hermes.md/HERMES.md wins. */
const HERMES_CONTEXT_ORDER = [['.hermes.md', 'HERMES.md'], ['AGENTS.override.md', 'AGENTS.md', 'agents.md'], ['CLAUDE.md'], ['.cursorrules']];

/** Refuses SOUL.md (the harness's identity file), and for Hermes a new file that would shadow the rules it loads now. */
function assertContextFile(t: Target, file: string): void {
  const refuse = (why: string) => { throw new HarnessError('HARNESS_CONTEXT_REFUSED', 'refusing to write the gstack block into ' + file + ': ' + why); };
  if (path.basename(file).toLowerCase() === 'soul.md') refuse('SOUL.md is the harness\'s identity file');
  if (t.name !== 'hermes' || fs.existsSync(file)) return;
  const rank = HERMES_CONTEXT_ORDER.findIndex(g => g.includes(path.basename(file)));
  if (rank < 0) return;
  const group = HERMES_CONTEXT_ORDER[rank];
  const later = HERMES_CONTEXT_ORDER.slice(rank + 1).flat();
  const dirs = [path.dirname(file)];
  for (let d = dirs[0]; !fs.existsSync(path.join(d, '.git')) && path.dirname(d) !== d; d = path.dirname(d)) dirs.push(path.dirname(d));
  const chain = fs.existsSync(path.join(dirs.at(-1)!, '.git')) ? dirs : dirs.slice(0, 1);
  for (const dir of chain) {
    const own = dir === dirs[0] ? group.slice(group.indexOf(path.basename(file)) + 1) : rank === 0 ? group : [];
    const shadowed = [...own, ...later].find(n => fs.existsSync(path.join(dir, n)));
    if (shadowed) refuse('Hermes loads ' + path.basename(file) + ' instead of ' + path.join(dir, shadowed) + ', so creating it would hide those rules; name that file instead');
  }
}

/** Runs fn from one of the checkout's sourced bash libraries, passing args through the environment. */
function sourcedBash(checkout: string, lib: string, fn: string, args: string[], stateRoot: string, env: Env) {
  const argEnv = Object.fromEntries(args.map((a, i) => ['GSTACK_HARNESS_ARG' + i, a]));
  return runBashSync('. "$GSTACK_HARNESS_LIB" && ' + fn + args.map((_, i) => ' "$GSTACK_HARNESS_ARG' + i + '"').join(''),
    { env: { ...process.env, ...env, ...argEnv, GSTACK_HARNESS_LIB: path.join(checkout, 'bin', lib), GSTACK_STATE_ROOT: stateRoot }, encoding: 'utf8', timeout: 60_000 });
}

function shellRegistry(opts: RegisterOptions, fn: string, args: string[]): boolean {
  return sourcedBash(opts.checkout, 'gstack-install-registry.sh', fn, args, opts.stateRoot, opts.env).status === 0;
}

export function register(opts: RegisterOptions): RegisterResult {
  const t = opts.target;
  if (t.mechanism === 'verify-only' || t.mechanism === 'skill-pack-api') throw new HarnessError('HARNESS_UNKNOWN_TARGET', t.name + ' is not registered through files (use status for ' + t.name + ', or lib/harness-qm.ts for qm)');
  const mode = opts.mode ?? t.defaultMode;
  if (!t.modes.includes(mode)) throw new HarnessError('HARNESS_MODE_UNSUPPORTED', t.displayName + ' does not support --skills ' + mode);
  if (ROUTER_DESCRIPTION.length > ROUTER_DESCRIPTION_MAX) throw new HarnessError('HARNESS_BUDGET_EXCEEDED', 'router description is ' + ROUTER_DESCRIPTION.length + ' bytes');
  const provisional = opts.skillsDir ? path.resolve(opts.skillsDir) : t.dest(opts.env, opts.home) ?? (opts.context ? path.resolve(opts.context) : null);
  if (!provisional) throw new HarnessError('HARNESS_NO_DESTINATION', t.displayName + ' has no default skills folder');
  const id = registrationId(t.name, provisional);
  const dest = resolveDest(opts, id)!;
  assertSafeDest(dest, opts);
  const explicit = opts.context && !opts.inherit ? path.resolve(opts.context) : '';
  if (explicit) { assertSafeDest(explicit, opts); assertContextFile(t, explicit); }
  const lfile = ledgerPath(opts.stateRoot, id);
  const prev = readLedger(lfile);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-harness-'));
  try {
    const { files, router, visible, direct, skills } = planPayload(opts, dest, mode, scratch);
    const prevFiles = new Map((prev?.files ?? []).map(f => [f.path, f.sha]));
    const topOf = (p: string) => path.join(dest, path.relative(dest, p).split(path.sep)[0]);
    const owned = new Set([...prevFiles.keys()].map(topOf));
    for (const top of new Set([...files.keys()].map(topOf))) {
      let st: fs.Stats;
      try { st = fs.lstatSync(top); } catch { continue; }
      if (st.isSymbolicLink()) throw new HarnessError('HARNESS_UNSAFE_DESTINATION', top + ' is a symlink');
      if (!owned.has(top)) throw new HarnessError('HARNESS_UNOWNED_ENTRY', top + ' already exists and gstack did not write it');
    }
    const ours = new Set([...files.keys()].map(topOf));
    if (fs.existsSync(dest)) for (const e of fs.readdirSync(dest)) {
      const md = path.join(dest, e, 'SKILL.md');
      if (ours.has(path.join(dest, e)) || owned.has(path.join(dest, e)) || !fs.existsSync(md)) continue;
      const other = frontmatterField(fs.readFileSync(md, 'utf8'), 'name');
      if (visible.includes(other)) throw new HarnessError('HARNESS_UNOWNED_ENTRY', 'a skill named ' + other + ' already exists at ' + path.join(dest, e) + ' and gstack did not write it');
    }
    for (const p of new Set([...files.keys(), ...prevFiles.keys()])) assertOwnedPath(dest, p);
    const want = [...files].map(([p, b]) => ({ path: p, sha: sha256(b) }));
    const context = opts.context ? path.resolve(opts.context) : prev?.meta.context ?? '';
    const block = contextBlock(router, direct);
    if ((explicit || prev?.blocks.length) && block.length > CONTEXT_BLOCK_MAX) throw new HarnessError('HARNESS_BUDGET_EXCEEDED', 'context block is ' + block.length + ' bytes');
    const blocks: LedgerBlock[] = [];
    const blockWrites = new Map<string, string>();
    for (const b of prev?.blocks ?? []) {
      if (b.path === explicit) continue;
      const state = blockState(b.path, b.sha);
      if (state === 'absent') continue;
      if (state === 'other') { blocks.push(b); continue; }
      blockWrites.set(b.path, withBlock(b.path, block, b.sha).text);
      blocks.push({ sha: blockSha(block), path: b.path, pad: b.pad });
    }
    if (explicit) {
      const before = prev?.blocks.find(b => b.path === explicit);
      const w = withBlock(explicit, block, before?.sha);
      blockWrites.set(explicit, w.text);
      blocks.push({ sha: blockSha(block), path: explicit, pad: w.pad || before?.pad || '' });
    }
    const same = prev && prev.meta.mode === mode && prev.meta.names === visible.join(',') && prev.files.length === want.length
      && (prev.meta.context ?? '') === context && prev.blocks.length === blocks.length
      && blocks.every(b => prev.blocks.some(p => p.path === b.path && p.sha === b.sha && p.pad === b.pad))
      && want.every(w => prevFiles.get(w.path) === w.sha && onDiskSha(w.path) === w.sha);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const kept: string[] = [];
    let written = 0;
    if (!same) {
      const dirs = new Set(prev?.dirs ?? []);
      for (const p of files.keys()) for (let d = path.dirname(p); !fs.existsSync(d) && path.dirname(d) !== d; d = path.dirname(d)) dirs.add(d);
      const record = (recorded: typeof want) => writeLedger(lfile, {
        meta: { id, target: t.name, dest, mode, checkout: opts.checkout, version: opts.version, names: visible.join(','), ...(router ? { router } : {}), ...(context ? { context } : {}) },
        files: recorded, dirs: [...dirs].sort((a, b) => b.length - a.length), blocks,
      });
      record([...want, ...(prev?.files ?? []).filter(f => !files.has(f.path))]);
      for (const [p, sha] of prevFiles) {
        if (files.has(p)) continue;
        const disk = onDiskSha(p);
        if (disk === sha) fs.rmSync(p, { force: true }); else if (disk) kept.push(keepEdit(p, stamp));
      }
      for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
        if ([...files.keys()].some(p => p.startsWith(dir + path.sep))) continue;
        try { fs.rmdirSync(dir); dirs.delete(dir); } catch {}
      }
      for (const [p, b] of files) {
        const disk = onDiskSha(p);
        if (disk === sha256(b)) continue;
        if (disk && prevFiles.get(p) !== disk) kept.push(keepEdit(p, stamp));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p + '.gstack-new', b);
        fs.renameSync(p + '.gstack-new', p);
        written++;
      }
      record(want);
    }
    for (const [file, text] of blockWrites) {
      if (text === (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    if (opts.registry && t.render === 'host') shellRegistry(opts, 'gstack_install_registry_upsert', [t.name, 'global', '-', dest, opts.checkout, opts.checkout, opts.version, '-', '-']);
    return { id, target: t.name, dest, mode, status: !prev ? 'installed' : same ? 'unchanged' : 'updated', written, skills, router, ledger: lfile, kept };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The router and context block for a harness gstack cannot write into (Grok Bot, a chat-only skill library). */
export function printPayload(checkout: string): string {
  const t = TARGETS.generic;
  const skills = sourceSkills(t, checkout, os.tmpdir()).map(s => ({ name: s.name, use: s.use, path: path.join(s.dir, 'SKILL.md') }));
  return [routerSkill(skills, t), contextBlock(path.join(checkout, 'SKILL.md'))].join('\n');
}

/** Remove one registration through the bash ledger reader (the same code gstack-uninstall runs). */
export function unregister(stateRoot: string, checkout: string, idOrTarget: string, env: Env = process.env): string[] {
  const all = listLedgers(stateRoot).filter(l => l.ledger.meta.id === idOrTarget || l.ledger.meta.target === idOrTarget);
  if (!all.length) throw new HarnessError('HARNESS_NOT_REGISTERED', 'no registration named ' + JSON.stringify(idOrTarget));
  for (const { file } of all) {
    const r = sourcedBash(checkout, 'gstack-harness-ledger.sh', 'gstack_harness_unregister_ledger', [file], stateRoot, env);
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) throw new HarnessError('HARNESS_NOT_REGISTERED', 'could not remove ' + file + ': ' + (r.stderr || '').trim());
  }
  return all.map(l => l.ledger.meta.id);
}

/** Re-register every file registration this checkout made (setup runs it on every pass, so upgrades refresh them). */
export function refresh(base: Omit<RegisterOptions, 'target'>, skip: Set<string> = new Set()): RegisterResult[] {
  return listLedgers(base.stateRoot)
    .filter(({ ledger: l }) => l.meta.checkout === base.checkout && l.meta.target !== 'qm' && !skip.has(l.meta.id))
    .map(({ ledger: l }) => register({
      ...base, target: getTarget(l.meta.target), mode: l.meta.mode as SkillsMode,
      skillsDir: l.meta.context && l.meta.dest.startsWith(ledgerDir(base.stateRoot)) ? undefined : l.meta.dest,
      context: l.meta.context || undefined, inherit: true,
    }));
}

export interface StatusRow { id: string; target: string; dest: string; mode: string; files: number; version: string; stale: boolean; visible: 'yes' | 'no' | 'unknown'; checked?: string; missing?: string[] }

/** Runs the harness's own skill list: 'yes' when every name shows (or, with any, at least one). */
export function harnessSees(t: Target, dest: string, env: Env, names: string[], any = false): { visible: 'yes' | 'no' | 'unknown'; checked?: string; missing?: string[] } {
  const lc = t.listCommand?.(dest);
  if (!lc || !names.length || !onPath(lc.argv[0], env)) return { visible: 'unknown' };
  const r = spawnSync(lc.argv[0], lc.argv.slice(1), { env: { ...process.env, ...env, ...lc.env }, encoding: 'utf8', timeout: 120_000 });
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  const missing = names.filter(n => !lc.listed(n).test(text));
  const ok = any ? missing.length < names.length : missing.length === 0;
  return { visible: ok ? 'yes' : 'no', checked: lc.argv.join(' '), ...(ok || any ? {} : { missing }) };
}

export function status(stateRoot: string, version: string, env: Env, check = true): StatusRow[] {
  return listLedgers(stateRoot).map(({ ledger: l }) => {
    const t = (TARGETS as Record<string, Target>)[l.meta.target];
    const seen = check && t ? harnessSees(t, l.meta.dest, env, (l.meta.names ?? '').split(',').filter(Boolean)) : { visible: 'unknown' as const };
    return { id: l.meta.id, target: l.meta.target, dest: l.meta.dest, mode: l.meta.mode, files: l.files.length, version: l.meta.version, stale: l.meta.version !== version, ...seen };
  });
}
