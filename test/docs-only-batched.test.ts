/**
 * GST-4003: classifyDocsOnly asks git which files name each changed doc with one batched `git grep -f -` instead of one
 * `git grep` per path (harness-evals' 16,000-file results PRs), and gets the same answer referencesTo gives path by path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyDocsOnly, referencesTo, referencesToAll } from '../lib/docs-only';

const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.test' };
let repo = '';
const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const put = (rel: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const DOCS = [...Array.from({ length: 40 }, (_, i) => `docs/results/run-${i}.md`), 'README.md', 'docs/README.md', 'docs/guide.md'];

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-batch-')));
  git('init', '-q', '-b', 'main');
  for (const d of DOCS) put(d, `# ${d}\n`);
  put('lib/a.ts', "export const doc = 'see docs/README.md and docs/results/run-1.md';\n");
  put('lib/é.ts', "// é docs/results/run-2.md\n");
  put('scripts/run.sh', 'cat docs/results/run-3.md docs/results/run-30.md\n');
  put('assets/blob.bin', Buffer.concat([Buffer.from('docs/results/run-4.md'), Buffer.from([0, 1, 2, 0])]));
  put('CHANGELOG.md', '- docs/guide.md\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  git('tag', 'seed');
  for (const d of DOCS) put(d, `# ${d}\n\nedited\n`);
  git('commit', '-qam', 'edit');
});
afterAll(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

describe('batched reference scan', () => {
  test('referencesToAll gives every path what referencesTo gives it, at a commit and on the working tree', () => {
    for (const tree of ['HEAD', undefined]) {
      const all = referencesToAll(repo, DOCS, tree);
      expect(Object.fromEntries(all)).toEqual(Object.fromEntries(DOCS.map(p => [p, referencesTo(repo, p, tree)])));
    }
    const head = referencesToAll(repo, DOCS, 'HEAD');
    expect(head.get('README.md')).toEqual(['lib/a.ts']);
    expect(head.get('docs/results/run-3.md')).toEqual(['scripts/run.sh']);
    expect(head.get('docs/results/run-2.md')).toEqual(['lib/é.ts']);
    expect(head.get('docs/results/run-4.md')).toEqual([]);
    expect(head.get('docs/guide.md')).toEqual([]);
  });

  test('classifyDocsOnly runs a bounded number of git grep calls however many docs change', () => {
    const trace = path.join(repo, '..', `${path.basename(repo)}.trace`);
    const before = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try {
      const r = classifyDocsOnly({ root: repo, base: 'seed', head: 'HEAD' });
      expect(r.docsOnly).toBe(false);
      expect(r.refusals.map(x => x.path).sort()).toEqual(['README.md', 'docs/README.md', 'docs/results/run-1.md', 'docs/results/run-2.md', 'docs/results/run-3.md', 'docs/results/run-30.md']);
    } finally {
      if (before === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = before;
    }
    const greps = fs.readFileSync(trace, 'utf8').split('\n').filter(l => /trace: built-in: git grep /.test(l)).length;
    fs.rmSync(trace, { force: true });
    expect(greps).toBeGreaterThan(0);
    expect(greps).toBeLessThanOrEqual(2);
  });
});
