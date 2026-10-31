/**
 * The office-hours spec reviewer's one execution right (G1, #973): `--help`
 * for a named command, so a design that cites a flag can be checked. The bin
 * enforces the limits; the prompt only names the command.
 *
 *   allowed   gstack's own bins (resolved inside the bin directory running
 *             this probe) and a fixed list of common read-only CLIs, each
 *             found on PATH at a real path outside the repository checkout;
 *             up to two subcommand words for CLIs whose subcommands are fixed
 *             names (`git log`), never for one that would run a script or
 *             file named by the word
 *   refused   anything else: unlisted names, paths, shell syntax, a listed
 *             name that resolves into the repository
 *   run       no shell, stdin closed, an empty temporary working directory,
 *             pagers set to cat, `--help` (then `-h` when its output has no
 *             usage line, as with a missing man page), 10 s timeout, output capped
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const PROBE_CLIS = ['git', 'gh', 'bun', 'node', 'npm', 'pnpm', 'yarn', 'jq', 'rg', 'python3', 'uv', 'go', 'cargo', 'make', 'docker', 'claude', 'codex', 'gemini'] as const;
export const PROBE_SUBCOMMAND_CLIS = ['git', 'gh', 'docker', 'cargo', 'go', 'npm', 'uv'] as const;
export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_OUTPUT_CAP = 16_000;

export type ProbeTarget = { exe: string } | { refused: string };

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const isExecutable = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

export function resolveProbe(command: string, o: { pathEnv: string; gstackBin: string; repoRoot?: string }, subcommands: readonly string[] = []): ProbeTarget {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) return { refused: 'not a bare command name' };
  if (subcommands.length > 2 || subcommands.some(w => !/^[a-z][a-z0-9-]*$/.test(w))) return { refused: 'subcommands are at most two lowercase words' };
  if (subcommands.length && !(PROBE_SUBCOMMAND_CLIS as readonly string[]).includes(command)) return { refused: `${command} takes no subcommand words (only ${PROBE_SUBCOMMAND_CLIS.join(', ')})` };
  if (command.startsWith('gstack-')) {
    const exe = path.join(o.gstackBin, command);
    if (!isExecutable(exe) || !inside(fs.realpathSync(o.gstackBin), fs.realpathSync(exe))) return { refused: `${command} is not a gstack bin in ${o.gstackBin}` };
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
  const env = { ...process.env, PAGER: 'cat', MANPAGER: 'cat', GIT_PAGER: 'cat' };
  const run = (flag: string) => {
    const r = spawnSync(exe, [...subcommands, flag], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
    return { status: r.status, timedOut, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, PROBE_OUTPUT_CAP) };
  };
  try {
    const help = run('--help');
    return help.timedOut || /usage/i.test(help.output) ? help : run('-h');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
