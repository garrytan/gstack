/**
 * scratch-repo — shared test fixture for throwaway git repos.
 *
 * One copy of the hermetic git incantation: identity pinned AND signing
 * disabled (`commit.gpgsign=false tag.gpgsign=false`). Fixture commits must
 * never invoke the operator's gpg — gpg-agent fails with "Cannot allocate
 * memory" under parallel shard load and breaks test SETUP, not the code under
 * test. Three suites duplicated this incantation before extraction (and one
 * copy had already drifted).
 */

import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const GIT_HERMETIC_ARGS = [
  '-c', 'user.email=t@test',
  '-c', 'user.name=t',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
] as const;

const GIT_HERMETIC_FLAGS = GIT_HERMETIC_ARGS.join(' ');

/** Run a git command string in a scratch repo (hermetic identity, no gpg). */
export function gitIn(repoDir: string, args: string): string {
  return execSync(`git ${GIT_HERMETIC_FLAGS} ${args}`, { cwd: repoDir, encoding: 'utf-8', timeout: 10000 });
}

/** Argv-array variant for callers that avoid shell quoting. */
export function gitArgvIn(repoDir: string, args: string[], timeout = 5000) {
  return spawnSync('git', [...GIT_HERMETIC_ARGS, ...args], { cwd: repoDir, timeout });
}

/** Create a scratch repo (mkdtemp) with an initial commit; caller cleans up. */
export function makeScratchRepo(prefix: string, files: Record<string, string> = { 'src.txt': 'v1\n' }): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  gitIn(repoDir, 'init -q -b main');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(repoDir, name), content);
  }
  gitIn(repoDir, `add ${Object.keys(files).join(' ')}`);
  gitIn(repoDir, 'commit -q -m init');
  return repoDir;
}

/** Recursively find files with a given suffix under a directory. */
export function findFilesBySuffix(root: string, suffix: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(suffix)) found.push(p);
    }
  };
  walk(root);
  return found;
}

/**
 * Create a fake `gh` on PATH that behaves per `mode`, keeping bun/git/etc
 * resolvable. Returns the PATH value to pass into env. Used to exercise the
 * post-spawn gh branches (success, failure, garbage JSON) without network.
 */
export function makeGhShimPath(mode: 'fail' | 'json' | 'garbage', jsonPayload = '{}'): { pathEnv: string; shimDir: string } {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gh-shim-'));
  const body =
    mode === 'fail'
      ? '#!/bin/sh\necho "shim: gh failed" >&2\nexit 1\n'
      : mode === 'garbage'
        ? '#!/bin/sh\necho "this is not json"\nexit 0\n'
        : `#!/bin/sh\ncat <<'SHIM_JSON'\n${jsonPayload}\nSHIM_JSON\nexit 0\n`;
  fs.writeFileSync(path.join(shimDir, 'gh'), body, { mode: 0o755 });
  return { pathEnv: `${shimDir}:${process.env.PATH ?? ''}`, shimDir };
}
