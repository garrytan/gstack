/**
 * default-base — the base branch a command uses when none is given (GST-511).
 * A remote's HEAD counts only when it names a branch other than the
 * checked-out one: a clone made by a PR flow can point origin/HEAD at the PR
 * branch, and that base diffs the branch against itself, an empty diff every
 * gate passes. Past it: the PR's base from gh (a short timeout, any failure
 * ignored; none for a PR from another repository), then `<remote>/main`, then `<remote>/master`. A detached HEAD keeps
 * the remote's HEAD. bin/gstack-diff-scope carries the same chain in bash.
 */
import { spawnSync } from 'node:child_process';

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

export function defaultBaseBranch(cwd: string, remotes: readonly string[] = ['origin']): DefaultBase {
  const current = read('git', ['symbolic-ref', '--quiet', 'HEAD'], cwd, 30_000).replace(/^refs\/heads\//, '');
  let skipped: DefaultBase['skipped'];
  for (const remote of remotes) {
    const prefix = `refs/remotes/${remote}/`;
    const target = read('git', ['symbolic-ref', '--quiet', `${prefix}HEAD`], cwd, 30_000);
    if (!target.startsWith(prefix)) continue;
    const branch = target.slice(prefix.length);
    if (branch !== current) return { branch, remote };
    skipped ??= { remote, branch };
  }
  const pr = current ? read('gh', ['pr', 'view', '--json', 'baseRefName,isCrossRepository', '-q', PR_BASE], cwd, 5_000).split('\n')[0] : '';
  if (pr) return { branch: pr, skipped };
  for (const name of ['main', 'master']) {
    if (remotes.some((remote) => read('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}^{commit}`], cwd, 30_000))) return { branch: name, skipped };
  }
  return { branch: null, skipped };
}

/** Why there is no default base: a remote HEAD named the checked-out branch and nothing past it resolved. */
export function noDefaultBaseLine({ remote, branch }: { remote: string; branch: string }): string {
  return `${remote}/HEAD names the checked-out branch ${branch}, and no PR base, ${remote}/main or ${remote}/master resolves; pass the base explicitly or run git remote set-head ${remote} <base>`;
}
