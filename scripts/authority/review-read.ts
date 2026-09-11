import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readCurrentReview, readReviewUnion } from '../../lib/review-reader';

function fail(error: unknown): never {
  process.stderr.write(JSON.stringify({ result: null, error: { code: error instanceof Error ? error.message : 'review_read_failed' } }) + '\n');
  process.exit(2);
}

try {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let json = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === '--json') { if (json) throw new Error('review_read_arguments_invalid'); json = true; continue; }
    const value = args.shift();
    if (!value || value.startsWith('--') || values.has(flag) || !['--require-current', '--assert-target-ref', '--assert-target-sha'].includes(flag)) throw new Error('review_read_arguments_invalid');
    values.set(flag, value);
  }
  if (!json || (values.has('--assert-target-ref') && values.has('--assert-target-sha')) || (!values.get('--require-current') && values.size > 0)) throw new Error('review_read_arguments_invalid');
  const stateHome = process.env.GSTACK_HOME || (process.env.HOME ? path.join(process.env.HOME, '.gstack') : '');
  if (!stateHome) throw new Error('review_state_root_missing');
  if (values.get('--require-current')) {
    const result = readCurrentReview({ cwd: process.cwd(), stateHome, capability: values.get('--require-current')!, assertTargetRef: values.get('--assert-target-ref'), assertTargetSha: values.get('--assert-target-sha') });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.current) process.exit(1);
  } else {
    const union = readReviewUnion({ cwd: process.cwd(), stateHome });
    const runtimeRoot = path.resolve(import.meta.dir, '..', '..');
    const run = (argv: string[]) => { const result = spawnSync(argv[0], argv.slice(1), { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: process.env.HOME ?? '' } }); return result.status === 0 ? result.stdout.trim() : null; };
    process.stdout.write(JSON.stringify({ schema: 'ecpe.review-union.v1', repo_id: union.identity.repo_id, branch_ref: union.identity.raw_branch, reviews: union.reviews, head: run(['/usr/bin/git', 'rev-parse', 'HEAD^{commit}']), tree: run(['/usr/bin/git', 'rev-parse', 'HEAD^{tree}']), wtree: run([path.join(runtimeRoot, 'bin/gstack-wtree')]), dirty: (run(['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all']) ?? '') !== '' }) + '\n');
  }
} catch (error) { fail(error); }
