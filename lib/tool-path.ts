/**
 * The absolute git and gh a gstack process runs, resolved once per PATH value, at its first git or gh call (GST-1766).
 * `gstack-ship-queue land` runs repo commands (land.merged_checks) as its own user between its own git and gh calls, and
 * a check can drop a `git` or `gh` into a writable directory early on PATH; a name looked up again after the checks
 * would run that file with land's environment. lib/land-merged-checks.ts records the resolved files before the checks
 * and refuses when one changed, and before the checks it puts the pinned files' directories first on its own PATH, so
 * every later `git` or `gh` any module starts by name runs them. gh runs `git` by name, so its PATH starts with
 * the pinned git's directory.
 */
import * as path from 'node:path';

const pinned = new Map<string, string>();

/** The file `name` resolves to on PATH the first time this process asks; the bare name when PATH has none, so the spawn fails as before. */
export function toolPath(name: 'git' | 'gh', PATH = process.env.PATH ?? ''): string {
  const key = `${name}\0${PATH}`;
  let found = pinned.get(key);
  if (found === undefined) {
    found = Bun.which(name, { PATH }) ?? name;
    pinned.set(key, found);
  }
  return found;
}

/** PATH with the pinned git's directory first, for a child such as gh that runs `git` by name. */
export function pathWithGit(PATH = process.env.PATH ?? ''): string {
  const git = toolPath('git', PATH);
  return path.isAbsolute(git) ? `${path.dirname(git)}${path.delimiter}${PATH}` : PATH;
}

/** PATH with the pinned git's and gh's directories first, with those files pinned for it too: land sets it on its own process before the checks, so a module that starts `git` or `gh` by name after them runs the files pinned before them. */
export function pinnedFirst(PATH = process.env.PATH ?? ''): string {
  const files = (['git', 'gh'] as const).map(t => [t, toolPath(t, PATH)] as const);
  const next = [...new Set(files.filter(([, f]) => path.isAbsolute(f)).map(([, f]) => path.dirname(f))), PATH].join(path.delimiter);
  for (const [t, f] of files) pinned.set(`${t}\0${next}`, f);
  return next;
}
