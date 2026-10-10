/**
 * gate-diff-repo — materialise a test/fixtures/gate-diff patch pair into a
 * throwaway git repo. Fixtures are patch text only (never a nested .git):
 * `<name>.base.patch` seeds the base commit on `main`, `<name>.patch` is the
 * candidate change applied on a `feature` branch, committed or left in the
 * working tree. Hermetic git identity and no gpg via scratch-repo.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitArgvIn } from './scratch-repo';

export const GATE_DIFF_FIXTURES = path.resolve(import.meta.dir, '..', 'fixtures', 'gate-diff');

export interface GateDiffRepoOptions {
  /** Fixture stem; omit for an empty seed commit. */
  fixture?: string;
  /** Commit the candidate change (default: leave it staged in the working tree). */
  commit?: boolean;
  commitMessage?: string;
  /** Extra non-ignored untracked files written after the change. */
  untracked?: Record<string, string>;
}

function git(dir: string, args: string[]): string {
  const r = gitArgvIn(dir, args, 10_000);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').toString()}`);
  return (r.stdout ?? '').toString();
}

export function buildGateDiffRepo(opts: GateDiffRepoOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-diff-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  if (opts.fixture) git(dir, ['apply', path.join(GATE_DIFF_FIXTURES, `${opts.fixture}.base.patch`)]);
  else fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  if (opts.fixture) {
    git(dir, ['apply', '--index', path.join(GATE_DIFF_FIXTURES, `${opts.fixture}.patch`)]);
    if (opts.commit) git(dir, ['commit', '-q', '-m', opts.commitMessage ?? `apply ${opts.fixture}`]);
  }
  for (const [rel, content] of Object.entries(opts.untracked ?? {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

export function gitIn(dir: string, args: string[]): string {
  return git(dir, args);
}
