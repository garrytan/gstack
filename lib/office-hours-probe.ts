/**
 * The office-hours spec reviewer's one execution right (G1, #973): `--help`
 * for a named command, so a design that cites a flag can be checked. The bin
 * enforces the limits; the prompt only names the command.
 *
 *   allowed   gstack's own bins that handle --help (resolved inside the bin
 *             directory running this probe) and a fixed list of common CLIs,
 *             each found on PATH at a real path outside the repository
 *             checkout; up to two subcommand words, each from that CLI's own
 *             list of built-in names (`git log`, `gh pr create`), never one
 *             that runs a program, script, image or extension named by a word
 *             (`uv run`, `docker run`, `go test`, `npm exec`)
 *   refused   anything else: unlisted names, paths, shell syntax, a listed
 *             name that resolves into the repository
 *   run       no shell, stdin closed, an empty temporary directory as both the
 *             working directory and HOME, an environment holding only PATH,
 *             locale and pagers set to cat (no keys or tokens), `--help` (then
 *             `-h` for a listed CLI whose output has no usage line, as with a
 *             missing man page; never for a gstack bin), 10 s timeout, output capped
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const PROBE_CLIS = ['git', 'gh', 'bun', 'node', 'npm', 'pnpm', 'yarn', 'jq', 'rg', 'python3', 'uv', 'go', 'cargo', 'make', 'docker', 'claude', 'codex', 'gemini'] as const;
const words = (s: string) => s.split(' ');
export const PROBE_SUBCOMMANDS: Record<string, { first: readonly string[]; second: readonly string[] | 'any' }> = {
  git: { first: words('add am apply bisect blame branch checkout cherry-pick clean clone commit config describe diff fetch format-patch grep init log ls-files ls-remote merge mv notes pull push range-diff rebase reflog remote reset restore revert rev-list rev-parse rm shortlog show sparse-checkout stash status submodule switch tag worktree'), second: [] },
  gh: { first: words('api auth browse cache config gist issue label pr project release repo ruleset run search secret status variable workflow'), second: 'any' },
  docker: { first: words('build buildx compose container image images info inspect logs network ps pull push system tag version volume'), second: words('build config down history inspect logs ls prune ps pull push rm tag up') },
  cargo: { first: words('add bench build check clippy doc fmt init metadata new publish remove search tree update'), second: [] },
  go: { first: words('build clean doc env fmt get install list mod version work'), second: words('download edit graph init sync tidy use vendor verify why') },
  npm: { first: words('audit ci config init install ls outdated pack publish uninstall update version view'), second: [] },
  uv: { first: words('add build cache export init lock pip publish python remove self sync tree venv version'), second: words('clean compile dir find freeze install list pin prune show sync tree uninstall update') },
};
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_OUTPUT_CAP = 16_000;

export type ProbeTarget = { exe: string } | { refused: string };

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const isExecutable = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

export function resolveProbe(command: string, o: { pathEnv: string; gstackBin: string; repoRoot?: string }, subcommands: readonly string[] = []): ProbeTarget {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) return { refused: 'not a bare command name' };
  if (subcommands.length > 2 || subcommands.some(w => !/^[a-z][a-z0-9-]*$/.test(w))) return { refused: 'subcommands are at most two lowercase words' };
  if (subcommands.length) {
    const allowed = PROBE_SUBCOMMANDS[command];
    if (!allowed) return { refused: `${command} takes no subcommand words (only ${Object.keys(PROBE_SUBCOMMANDS).join(', ')})` };
    const [first, second] = subcommands;
    if (!allowed.first.includes(first!) || (second !== undefined && allowed.second !== 'any' && !allowed.second.includes(second))) return { refused: `${command} ${subcommands.join(' ')} is not a listed built-in subcommand of ${command}` };
  }
  if (command.startsWith('gstack-')) {
    const exe = path.join(o.gstackBin, command);
    if (!isExecutable(exe) || !inside(fs.realpathSync(o.gstackBin), fs.realpathSync(exe))) return { refused: `${command} is not a gstack bin in ${o.gstackBin}` };
    if (!fs.readFileSync(exe, 'latin1').includes('--help')) return { refused: `${command} does not handle --help` };
    return { exe };
  }
  if (!(PROBE_CLIS as readonly string[]).includes(command)) return { refused: `not on the probe allowlist (gstack bins and ${PROBE_CLIS.join(', ')})` };
  const exe = o.pathEnv.split(path.delimiter).filter(d => path.isAbsolute(d)).map(d => path.join(d, command)).find(isExecutable);
  if (!exe) return { refused: `${command} is not on PATH` };
  if (o.repoRoot && inside(fs.realpathSync(o.repoRoot), fs.realpathSync(exe))) return { refused: `${command} resolves inside the repository` };
  return { exe };
}

export function runProbe(exe: string, subcommands: readonly string[] = []): { status: number | null; timedOut: boolean; output: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-probe-'));
  const keep = ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'PATHEXT', 'COMSPEC'].filter(k => process.env[k] !== undefined);
  const env = { ...Object.fromEntries(keep.map(k => [k, process.env[k]!])), HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, PAGER: 'cat', MANPAGER: 'cat', GIT_PAGER: 'cat', GH_PAGER: 'cat', NO_COLOR: '1' };
  const run = (flag: string) => {
    const r = spawnSync(exe, [...subcommands, flag], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
    return { status: r.status, timedOut, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, PROBE_OUTPUT_CAP) };
  };
  try {
    const help = run('--help');
    return help.timedOut || /usage/i.test(help.output) || path.basename(exe).startsWith('gstack-') ? help : run('-h');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
