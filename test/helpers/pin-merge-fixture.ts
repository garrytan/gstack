/**
 * Two independent edits to a pin store, merged for real (GST-1084). seed(root) writes the base tree, edits a and b
 * each change it on their own branch, and `git merge-tree --write-tree` says whether the two merge without a
 * textual conflict. The repository is fresh under os.tmpdir(), outside any checkout, and git runs under gitEnv() so
 * no global hook or config reaches it; the caller removes root.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitEnv } from './git-env';

export interface PinMerge { root: string; clean: boolean; output: string; read: (rel: string) => string }

export function mergePinEdits(seed: (root: string) => void, a: (root: string) => void, b: (root: string) => void): PinMerge {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-merge-'));
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Pin fixture', '-c', 'user.email=pins@gstack.test', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
  const must = (...args: string[]) => {
    const result = git(...args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
    return result.stdout;
  };
  const commit = (edit: (root: string) => void, message: string) => { edit(root); must('add', '-A'); must('commit', '-q', '--no-verify', '-m', message); };
  let merged: ReturnType<typeof git>;
  try {
    must('init', '-q', '-b', 'base');
    commit(seed, 'seed');
    for (const [branch, edit] of [['a', a], ['b', b]] as const) {
      must('checkout', '-q', '-b', branch, 'base');
      commit(edit, branch);
    }
    merged = git('merge-tree', '--write-tree', 'a', 'b');
    if (merged.status !== 0 && merged.status !== 1) throw new Error(`git merge-tree failed (${merged.status}): ${merged.stderr}`);
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const tree = merged.stdout.split('\n')[0]!;
  return { root, clean: merged.status === 0, output: merged.stdout, read: rel => must('show', `${tree}:${rel}`) };
}
