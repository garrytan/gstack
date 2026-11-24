/**
 * The `land` block of .gstack/ship-policy.json and its merged-tree run (docs/ship-policy.md#land-direct, GST-1316).
 * When the base moved past a pin's merge base, `gstack-ship-queue land --pin` builds the pin merged onto the base
 * tip in a fresh clone outside the checkout (its own .git and a copy of the checkout's node_modules, GST-1766) and runs
 * `land.merged_checks` there; it lands only when every command passes. A
 * conflict or a failing command refuses; with no key, land warns and merges as before. The commands are repo commands
 * (the merged tree's package.json decides what `bun run` does), so they run only under --allow-repo-commands, never
 * under --dry-run, with an environment that keeps PATH and locale only and a throwaway HOME. Validated here so
 * lib/ship-policy.ts stays one schema file.
 *
 * A scrubbed environment does not stop a check reading land's own: /proc/<land pid>/environ is the exec-time
 * snapshot (deleting from process.env does not change it), and any process of the same uid can read it, through
 * $PPID or a /proc scan (GST-1421). So on Linux land makes itself non-dumpable before the first check, which closes
 * its /proc environ, mem and ptrace to its own uid; execve resets the flag, so the checks stay ordinary processes, and
 * land never restores it. The git and gh processes land starts after the checks carry its environment and are
 * dumpable, so land also becomes the subreaper of everything the checks start: a process that left the check's group
 * with setsid or a double fork is reparented to land, which kills every child it has after each check. When either
 * fails the checks do not run. macOS has no /proc but `ps -E` (KERN_PROCARGS2) shows a same-uid process's exec-time
 * environment and has no per-process opt-out, so there the land process's environment stays readable to the checks.
 * The checks also run as land's user. In the clone, what a check writes to .git, its hooks or node_modules stays in the
 * clone, which land deletes. A check can still write outside it by absolute path, to files land's later git and gh
 * calls (the lock push, the merge, the merge check) read with land's environment. Land records, before the checks: the
 * config and hooks of the checkout's git directories, the commondir and gitdir files and the checkout's `.git` that say
 * where git finds them, every config file git loads in the checkout (includes and the global file among them), gh's
 * config and hosts files, the git and gh binaries lib/tool-path.ts pinned before the first repo command, and every hop
 * of a symlink among them. When any changed it refuses, makes no further git or gh call and leaves the land lock held
 * for a person to inspect. No git call land makes runs a hook (crew/lib/ship-queue-gate's queueHooksOff), which also skips the
 * managed pre-push guard: land pushes only the lock and notes it writes and the merged commit of already-pushed commits,
 * and a hook run after the checks is the opening this closes. Land's own git calls in the clone run with the checks'
 * environment.
 */
import { dlopen, FFIType } from 'bun:ffi';
import { spawnSync } from './spawn-sync';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PolicyError } from './ship-policy';
import { pinnedFirst, toolPath } from './tool-path';

/** A local git (crew/lib/ship-queue-gate's shape) so this module, which lib/ship-policy imports, pulls in no queue code. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string; status: number | null } {
  const use = env ?? process.env;
  const r = spawnSync(toolPath('git', use.PATH), args, { cwd, encoding: 'utf8', timeout: 120_000, env: use, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim(), status: r.status };
}

export interface LandPolicy {
  /** Shell commands run in the pin merged onto the base tip, in order; each must exit 0. */
  merged_checks?: string[];
  /** Git glob pathspecs: a PR that changes one lands as a merge commit, not a squash, so commits a receipt points to stay on the base (lib/squash-message.ts). */
  merge_commit_paths?: string[];
  /** A workflow land dispatches on the merged commit and the run profile its run must pass (lib/land-merged-ci.ts). */
  merged_ci?: { workflow: string; profile: string };
}

const MAX_CHECKS = 16, MAX_COMMAND = 512, CHECK_TIMEOUT_MS = 900_000;
const KEPT_ENV = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];
/** No hook or fsmonitor from the repository's config or the merged tree runs in the git calls around the checks. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** The paths in a git directory that decide what programs git runs or where it reads them: config, hooks, commondir, gitdir. */
const GIT_GUARDED = ['config', 'config.worktree', 'hooks', 'commondir', 'gitdir'];
type GitEntry = { mode: number; link?: string; data?: Buffer };

/** The guarded paths: the checkout's `.git`, each git directory's GIT_GUARDED entries, the files in `extra`, and every hop of a guarded symlink. */
function gitTops(root: string, dirs: string[], extra: string[]): string[] {
  const tops = [...dirs.flatMap(d => GIT_GUARDED.map(n => path.join(d, n))), ...extra];
  for (let p of [...tops]) {
    for (let hop = 0; hop < 40; hop++) {
      try { p = path.resolve(fs.realpathSync(path.dirname(p)), fs.readlinkSync(p)); } catch { break; }
      tops.push(p);
    }
  }
  return [path.join(root, '.git'), ...new Set(tops)];
}

/** Every path under `tops` with its mode (type bits included) and bytes or symlink target; the checkout's `.git` directory is recorded without its contents, and a FIFO, socket or device is never read. */
function gitState(root: string, tops: string[]): Map<string, GitEntry> {
  const state = new Map<string, GitEntry>();
  const walk = (p: string, deep: boolean) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    const entry: GitEntry = { mode: st.mode };
    state.set(p, entry);
    try {
      if (st.isSymbolicLink()) entry.link = fs.readlinkSync(p);
      else if (st.isFile()) entry.data = fs.readFileSync(p);
      else if (st.isDirectory() && deep) for (const name of fs.readdirSync(p)) walk(path.join(p, name), true);
    } catch {}
  };
  for (const top of tops) walk(top, top !== path.join(root, '.git'));
  return state;
}

/** Files outside the git directories that land's later git and gh calls read: every config file git loads in the checkout, the global and XDG git config files (so creating one counts), gh's config and hosts files, and the pinned git and gh. */
function landReadFiles(root: string): string[] {
  const home = process.env.HOME || os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const gh = process.env.GH_CONFIG_DIR || path.join(xdg, 'gh');
  const origins = git(root, ['config', '--list', '--show-origin', '--name-only']).out.split('\n').map(l => l.split('\t')[0] ?? '').filter(o => o.startsWith('file:')).map(o => path.resolve(root, o.slice(5)));
  const tools = (['git', 'gh'] as const).map(t => toolPath(t)).filter(t => path.isAbsolute(t));
  return [...origins, ...(process.env.GIT_CONFIG_GLOBAL ? [path.resolve(process.env.GIT_CONFIG_GLOBAL)] : []), path.join(home, '.gitconfig'), path.join(xdg, 'git', 'config'), path.join(gh, 'config.yml'), path.join(gh, 'hosts.yml'), ...tools];
}

/** The guarded paths whose entry `after` differs from `before` (added, removed, retyped, rewritten, repointed or re-moded). */
function changedGitPaths(before: Map<string, GitEntry>, after: Map<string, GitEntry>): string[] {
  const same = (a?: GitEntry, b?: GitEntry) => !!a && !!b && a.mode === b.mode && a.link === b.link && (a.data && b.data ? a.data.equals(b.data) : a.data === b.data);
  return [...new Set([...before.keys(), ...after.keys()])].filter(p => !same(before.get(p), after.get(p))).sort();
}

export const LAND_EXPLANATION = '{ merged_checks, docs_only_skip? } or null, read from the base revision only: under merge: direct, when the base moved past a pin\'s merge base, `land --pin` builds the pin merged onto the base tip in a fresh clone outside the checkout (its own .git, a copy of the checkout\'s node_modules) and runs each merged_checks command there (at most 16, 512 characters each, 15 minutes each); it lands only when every one exits 0, and refuses on a conflict (QUEUE_LAND_NOT_CLEAN) or a failure (QUEUE_LAND_MERGED_CHECKS). They are repo commands: land runs them only with --allow-repo-commands (else REPO_COMMANDS_NOT_ALLOWED), never under --dry-run, with PATH and locale as the only environment and a throwaway HOME. null lands a stale base unchecked with a STALE_BASE: warn line. docs_only_skip names merged_checks commands land skips for a pin lib/docs-only.ts calls human docs only (docs/pregate.md#docs-only) and needs min_gstack_version at its own introducing release. merge_commit_paths lists git glob pathspecs (at most 64, 256 characters each, no `..`): a PR that changes one lands as a merge commit instead of a squash, so an eval results PR keeps the commits its run receipts point to (docs/writing-prs.md#the-commit-on-main); it needs min_gstack_version at its own introducing release, and with it merged_checks may be left out. merged_ci { workflow, profile } runs CI on the tree that would land, after any merged_checks pass: land pushes the merged commit to the scratch branch gstack-land/<pr>, dispatches the workflow there, waits up to 45 minutes, and lands only when lib/run-evidence.ts accepts that run (an earlier land\'s workflow_dispatch run on gstack-land/<pr> whose head commit has the same merged tree is reused instead of a new dispatch: waited on while it runs, refused when red) under the named run profile of the base\'s .gstack/pregate.json with the merged tree as its tested tree (a red run refuses with QUEUE_LAND_MERGED_CHECKS; a run that cannot start, finish or be proved refuses with QUEUE_NOT_READY); it runs on CI, so it needs no --allow-repo-commands, never runs under --dry-run, and the branch is deleted whatever the outcome; with it merged_checks may be left out, and an older gstack ignores it with a warning. An unknown key under land is a warning, ignored.';

/** The keys this gstack reads under land; any other is a warning (lib/ship-policy.ts policyWarnings), never an error. */
export const LAND_KEYS: readonly string[] = ['merged_checks', 'docs_only_skip', 'merge_commit_paths', 'merged_ci'];

export function landPolicyErrors(raw: unknown): PolicyError[] {
  const l = raw as Record<string, unknown> | null;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return [{ code: 'POLICY_INVALID', path: 'land', message: 'must be { merged_checks } or null' }];
  const out: PolicyError[] = [];
  const paths = l.merge_commit_paths;
  if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > 64 || paths.some(p => typeof p !== 'string' || !p.trim() || p.length > 256 || /[\0\r\n]/.test(p) || p.startsWith('/') || p.split(/[\\/]+/).includes('..')))) out.push({ code: 'POLICY_INVALID', path: 'land.merge_commit_paths', message: 'must list 1 to 64 relative git glob pathspecs of at most 256 characters, with no `..`' });
  const ci = l.merged_ci as Record<string, unknown> | undefined;
  if (ci !== undefined && (!ci || typeof ci !== 'object' || Array.isArray(ci) || Object.keys(ci).some(k => k !== 'workflow' && k !== 'profile') || typeof ci.workflow !== 'string' || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(ci.workflow) || typeof ci.profile !== 'string' || !/^[A-Za-z0-9_.\/-]{1,128}$/.test(ci.profile))) out.push({ code: 'POLICY_INVALID', path: 'land.merged_ci', message: 'must be { workflow, profile }: a workflow file name under .github/workflows and a run_profiles name in .gstack/pregate.json' });
  const c = l.merged_checks;
  if (c === undefined && (paths !== undefined || ci !== undefined) && l.docs_only_skip === undefined) return out;
  if (!Array.isArray(c) || !c.length || c.length > MAX_CHECKS) return [...out, { code: 'POLICY_INVALID', path: 'land.merged_checks', message: `must list 1 to ${MAX_CHECKS} commands` }];
  const skip = l.docs_only_skip;
  if (skip !== undefined && (!Array.isArray(skip) || skip.some(s => !c.includes(s)) || skip.length >= c.length)) out.push({ code: 'POLICY_INVALID', path: 'land.docs_only_skip', message: 'must list merged_checks commands, leaving at least one to run' });
  c.forEach((cmd, i) => {
    if (typeof cmd !== 'string' || !cmd.trim()) out.push({ code: 'POLICY_INVALID', path: `land.merged_checks[${i}]`, message: 'must be a non-empty command' });
    else if (cmd.length > MAX_COMMAND || /[\0\r\n]/.test(cmd)) out.push({ code: 'POLICY_CONTAINMENT', path: `land.merged_checks[${i}]`, message: `must be one line of at most ${MAX_COMMAND} characters` });
  });
  return out;
}

/** `setup`: land could not run the checks at all (git failed, or the merged tree's dependencies differ from the checkout's node_modules): the lane's code is not at fault. `tampered`: the checks changed a file land's later git or gh calls read, so land holds for a person to inspect. */
export type MergedRun = { ok: true; tree: string; commit: string } | { ok: false; conflict: boolean; setup?: boolean; tampered?: boolean; tree?: string; detail: string };
type MergedFailure = Extract<MergedRun, { ok: false }>;
/** Checkouts where land.merged_checks changed a guarded path: land makes no further git call there, so ship-queue-land-direct skips the lock release. */
export const changedCheckouts = new Set<string>();
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces', 'overrides'];
const read = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const openLibc = () => dlopen('libc.so.6', {
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
}).symbols;
let libc: ReturnType<typeof openLibc> | undefined;
/** PR_SET_DUMPABLE 0 (confirmed with PR_GET_DUMPABLE) and PR_SET_CHILD_SUBREAPER 1; null when both hold, else why not. */
function closeLandProc(): string | null {
  try {
    libc ??= openLibc();
    const set = libc.prctl(4, 0, 0, 0, 0), now = libc.prctl(3, 0, 0, 0, 0), reaper = libc.prctl(36, 1, 0, 0, 0);
    return set === 0 && now === 0 && reaper === 0 ? null : `prctl(PR_SET_DUMPABLE, 0) returned ${set}, dumpable is ${now}, prctl(PR_SET_CHILD_SUBREAPER, 1) returned ${reaper}`;
  } catch (e) { return (e as Error).message; }
}
/** After a check, land (a subreaper) has no children of its own, so every child is something the check left behind: SIGKILL the live ones and reap the dead until none is live; false when some survive a second of passes. */
function killStrays(): boolean {
  for (let pass = 0; pass < 100; pass++) {
    const kids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(d => {
      const stat = read(`/proc/${d}/stat`) ?? '';
      const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid: Number(d), ppid: Number(ppid), dead: state === 'Z' };
    }).filter(k => k.ppid === process.pid);
    for (const k of kids) {
      if (k.dead) libc!.waitpid(k.pid, null, 1);
      else try { process.kill(k.pid, 'SIGKILL'); } catch {}
    }
    if (kids.every(k => k.dead)) return true;
    Bun.sleepSync(10);
  }
  return false;
}
const deps = (file: string): string => { try { const p = JSON.parse(read(file) ?? 'null') ?? {}; return JSON.stringify(DEP_KEYS.map(k => p[k] ?? null)); } catch { return 'unreadable'; } };

/** The pin merged onto `base` as a throwaway commit in `root`: its tree and commit, or the conflict or git failure that stopped it. */
export function mergedCommit(root: string, base: string, pin: string): { ok: true; tree: string; commit: string } | MergedFailure {
  const mt = git(root, ['merge-tree', '--write-tree', '--name-only', base, pin]);
  const [tree = '', ...rest] = mt.out.split('\n');
  if (!mt.ok) return { ok: false, conflict: mt.status === 1, setup: mt.status !== 1, detail: mt.status === 1 ? `the pin conflicts with ${base.slice(0, 12)} in ${rest.slice(0, rest.indexOf('') < 0 ? undefined : rest.indexOf('')).join(', ') || 'files git did not name'}` : `git merge-tree failed: ${mt.err.split('\n')[0]}` };
  const who = { GIT_AUTHOR_NAME: 'gstack land', GIT_AUTHOR_EMAIL: 'land@gstack.invalid', GIT_COMMITTER_NAME: 'gstack land', GIT_COMMITTER_EMAIL: 'land@gstack.invalid' };
  const commit = git(root, ['commit-tree', tree, '-p', base, '-p', pin, '-m', 'gstack land: merged-tree check'], { ...process.env, ...who });
  return commit.ok ? { ok: true, tree, commit: commit.out } : { ok: false, conflict: false, setup: true, tree, detail: `cannot build the merged tree ${tree.slice(0, 12)}: ${commit.err.split('\n')[0]}` };
}

/** Run `checks` on a throwaway commit of `pin` merged onto `base` (HEAD is that commit), in a fresh clone of `root` with a copy of its node_modules, deleted afterwards, with a scrubbed environment; a check that does not finish (its whole process group is killed), moves HEAD or changes a tracked file fails, one that changes a file land's later git or gh calls read fails as tampered, and a merged tree whose dependencies differ from the checkout's is refused before any check runs. */
export function runMergedChecks(root: string, base: string, pin: string, checks: string[], timeoutMs = CHECK_TIMEOUT_MS): MergedRun {
  const merged = mergedCommit(root, base, pin);
  if (!merged.ok) return merged;
  const { tree } = merged;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-merged-'));
  const dir = path.join(scratch, 'tree'), home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = { HOME: home, ...Object.fromEntries(KEPT_ENV.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) };
  try {
    const clone = git(root, [...NO_HOOKS, 'clone', '-q', '--no-checkout', '--no-hardlinks', '--', root, dir]);
    const unlinked = clone.ok ? git(dir, [...NO_HOOKS, 'remote', 'remove', 'origin']) : clone;
    const add = unlinked.ok ? git(dir, [...NO_HOOKS, 'checkout', '-q', '--detach', merged.commit]) : unlinked;
    if (!add.ok) return { ok: false, conflict: false, setup: true, tree, detail: `cannot build the merged tree ${tree.slice(0, 12)}: ${add.err.split('\n')[0]}` };
    const drift = [...LOCKFILES.filter(l => read(path.join(root, l)) !== read(path.join(dir, l))), ...(deps(path.join(root, 'package.json')) !== deps(path.join(dir, 'package.json')) ? ['package.json dependencies'] : [])];
    if (drift.length) return { ok: false, conflict: false, setup: true, tree, detail: `the merged tree's ${drift.join(', ')} differ from this checkout's, so its node_modules cannot vouch for the merged tree` };
    const modules = path.join(root, 'node_modules');
    if (fs.existsSync(modules) && !fs.existsSync(path.join(dir, 'node_modules'))) {
      try { fs.cpSync(fs.realpathSync(modules), path.join(dir, 'node_modules'), { recursive: true, verbatimSymlinks: true }); }
      catch (e) { return { ok: false, conflict: false, setup: true, tree, detail: `cannot copy the checkout's node_modules into the merged tree ${tree.slice(0, 12)}: ${(e as Error).message}` }; }
    }
    const linux = process.platform === 'linux';
    const open = linux ? closeLandProc() : null;
    if (open) return { ok: false, conflict: false, setup: true, tree, detail: `cannot close land's /proc environment to the checks (${open}), so they did not run` };
    const gitDirs = [...new Set(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir']).out.split('\n').filter(Boolean))];
    if (!gitDirs.length) return { ok: false, conflict: false, setup: true, tree, detail: 'cannot find the checkout\'s git directory, so the checks did not run' };
    const tops = gitTops(root, gitDirs, landReadFiles(root));
    const saved = gitState(root, tops);
    process.env.PATH = pinnedFirst();
    let failed = '', setup = false;
    let touched: string[] = [];
    try {
      for (const cmd of checks) {
        const group = process.platform !== 'win32';
        const log = path.join(scratch, 'check.log');
        const fd = fs.openSync(log, 'w');
        const opts = { cwd: dir, env, stdio: ['ignore', fd, fd] as ['ignore', number, number], timeout: timeoutMs, killSignal: 'SIGKILL' as const, detached: group };
        const r = spawnSync('sh', ['-c', cmd], opts);
        fs.closeSync(fd);
        if (group && r.pid) try { process.kill(-r.pid, 'SIGKILL'); } catch {}
        if (linux && !killStrays()) { failed = `\`${cmd}\` left processes running that land could not stop on the merged tree ${tree.slice(0, 12)}`; break; }
        if (r.status === 0 && !r.error) continue;
        const tail = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-6).join('\n');
        failed = `\`${cmd}\` ${r.error ? `did not finish (${r.error.message})` : `exited ${r.status ?? r.signal}`} on the merged tree ${tree.slice(0, 12)}${tail ? `:\n${tail}` : ''}`;
        break;
      }
      if (!failed && git(dir, [...NO_HOOKS, 'rev-parse', 'HEAD'], env).out !== merged.commit) failed = `the checks moved HEAD off the merged commit ${merged.commit.slice(0, 12)}, so it was not the tree they passed`;
      const status = failed ? null : git(dir, [...NO_HOOKS, 'status', '--porcelain', '--untracked-files=no'], env);
      if (status && !status.ok) { setup = true; failed = `git status failed on the merged tree ${tree.slice(0, 12)}: ${status.err.split('\n')[0]}`; }
      else if (status?.out) failed = `the checks changed tracked files on the merged tree ${tree.slice(0, 12)}, so it was not the tree they passed: ${status.out.split('\n').slice(0, 6).join(', ')}`;
      if (linux && !killStrays()) failed ||= `git on the merged tree ${tree.slice(0, 12)} left processes running that land could not stop`;
    } finally {
      touched = changedGitPaths(saved, gitState(root, tops));
      if (touched.length) changedCheckouts.add(root);
    }
    if (touched.length) {
      const named = touched.slice(0, 20).map(p => p.startsWith(root + path.sep) ? path.relative(root, p) : p).join(', ') + (touched.length > 20 ? ` and ${touched.length - 20} more` : '');
      return { ok: false, conflict: false, tampered: true, tree, detail: `the checks changed ${named}, which land's later git and gh calls read, on the merged tree ${tree.slice(0, 12)}, so land made no further git or gh call and left the land lock held; inspect each path and restore it from a trusted copy (delete a hook the checks added) before any git command in this checkout, then release the lock as the LOCK line says` };
    }
    if (failed) return { ok: false, conflict: false, setup, tree, detail: failed };
    return { ok: true, tree, commit: merged.commit };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
