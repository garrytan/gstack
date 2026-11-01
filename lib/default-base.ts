/**
 * default-base — the base branch a command uses when none is given (GST-511), and the
 * refusal every base-relative step shares when its base is the branch itself (GST-774).
 * A remote's HEAD counts only when it names a branch other than the checked-out one, its
 * upstream, or HEAD's own commit: a clone made by a PR flow can point origin/HEAD at the PR
 * branch, and that base diffs the branch against itself, an empty diff every gate passes.
 * Past it: the PR's base from gh, then the remote's live HEAD (`git ls-remote --symref`,
 * which keeps a default branch such as develop or trunk), then `<remote>/main`, then
 * `<remote>/master`. Both network reads use a 5 s timeout with prompts off and ignore any
 * failure; gh names no base for a PR from another repository. bin/gstack-diff-scope reads
 * both through this file's command line.
 */
import { spawnSync } from 'node:child_process';
import { resultLine } from './result-codes';

export interface DefaultBase {
  /** The base branch name, or null when nothing resolves. */
  branch: string | null;
  /** The remote whose HEAD named `branch`; unset for the PR base, main and master. */
  remote?: string;
  /** The first remote HEAD skipped because it names the checked-out branch. */
  skipped?: { remote: string; branch: string };
}

/** gh's jq for the PR's base branch; a PR from another repository names a branch origin may not hold, so it names none. */
const PR_BASE = 'if .isCrossRepository then "" else .baseRefName end';

function read(cmd: string, args: string[], cwd: string, timeout: number): string {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
  });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

const commit = (cwd: string, ref: string) => read('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd, 30_000);
const ancestor = (cwd: string, a: string, b: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, timeout: 30_000, stdio: 'ignore' }).status === 0;

export function defaultBaseBranch(cwd: string, remotes: readonly string[] = ['origin']): DefaultBase {
  const current = read('git', ['symbolic-ref', '--quiet', 'HEAD'], cwd, 30_000).replace(/^refs\/heads\//, '');
  const upstream = current ? read('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd, 30_000) : '';
  const headSha = commit(cwd, 'HEAD');
  let skipped: DefaultBase['skipped'];
  for (const remote of remotes) {
    const prefix = `refs/remotes/${remote}/`;
    const target = read('git', ['symbolic-ref', '--quiet', `${prefix}HEAD`], cwd, 30_000);
    if (!target.startsWith(prefix)) continue;
    const branch = target.slice(prefix.length);
    if (branch !== current && upstream !== `${remote}/${branch}` && commit(cwd, target) !== headSha) return { branch, remote };
    skipped ??= { remote, branch };
  }
  const pr = current ? read('gh', ['pr', 'view', '--json', 'baseRefName,isCrossRepository', '-q', PR_BASE], cwd, 5_000).split('\n')[0] : '';
  if (pr) return { branch: pr, skipped };
  if (skipped) {
    const live = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(read('git', ['ls-remote', '--symref', skipped.remote, 'HEAD'], cwd, 5_000))?.[1];
    if (live) return { branch: live, remote: skipped.remote, skipped };
  }
  for (const name of ['main', 'master']) {
    if (remotes.some((remote) => commit(cwd, `refs/remotes/${remote}/${name}`))) return { branch: name, skipped };
  }
  return { branch: null, skipped };
}

/** Why there is no default base: a remote HEAD named the checked-out branch and nothing past it resolved. */
export function noDefaultBaseLine({ remote, branch }: { remote: string; branch: string }): string {
  return `${remote}/HEAD names the checked-out branch ${branch}, and no PR base, ${remote}/main or ${remote}/master resolves; pass the base explicitly or run git remote set-head ${remote} <base>`;
}

/**
 * Why `base` cannot be the base of a comparison with `head` (BASE_CONTAINS_HEAD), or null. A
 * base that is the head or already contains it compares the branch with itself, so the step
 * would report no changes. A pull-request head (`head` other than HEAD) is refused whenever the
 * base contains it. The checked-out branch is refused only when its real base (defaultBaseBranch)
 * is another branch that lacks HEAD, so the branch has commits this base hides; on the base branch
 * itself, on a detached HEAD, on a fresh branch with no commits past its base, or with no real base
 * resolvable, it is null and the step keeps today's result.
 */
export function baseContainsHead(cwd: string, base: string, head = 'HEAD'): string | null {
  if (!ancestor(cwd, head, base)) return null;
  const baseSha = commit(cwd, base);
  const headSha = commit(cwd, head);
  if (!baseSha || !headSha) return null;
  const what = `${base} (${baseSha.slice(0, 12)}) ${baseSha === headSha ? 'is' : 'already contains'}`;
  if (head !== 'HEAD') return `${what} the head ${headSha.slice(0, 12)}, which then has no changes of its own`;
  const branch = read('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 30_000);
  if (!branch) return null;
  const real = defaultBaseBranch(cwd);
  if (!real.branch || real.branch === branch) return null;
  const realRef = `${real.remote ?? 'origin'}/${real.branch}`;
  const realSha = commit(cwd, `refs/remotes/${realRef}`);
  if (!realSha || ancestor(cwd, headSha, realSha)) return null;
  return `${what} HEAD ${headSha.slice(0, 12)} on ${branch}, whose commits ${realRef} lacks; the real base is ${real.branch}`;
}

if (import.meta.main) {
  const [verb, ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  if (verb === 'default') {
    const found = defaultBaseBranch(cwd);
    if (found.branch) console.log(found.branch);
    else if (found.skipped) console.log(noDefaultBaseLine(found.skipped));
    process.exitCode = found.branch ? 0 : found.skipped ? 3 : 1;
  } else if (verb === 'check' && args[0] && args.length <= 3) {
    const refused = baseContainsHead(cwd, args[0], args[1] || 'HEAD');
    if (refused) console.log(resultLine(args[2] || 'gstack', 'BASE_CONTAINS_HEAD', refused));
    process.exitCode = refused ? 1 : 0;
  } else {
    console.error('usage: default-base.ts default | check <base> [<head>] [<context>]');
    process.exitCode = 2;
  }
}
