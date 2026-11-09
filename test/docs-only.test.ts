/**
 * R81 docs-only class (lib/docs-only.ts, bin/gstack-docs-only; docs/pregate.md#docs-only). The bypass corpus comes
 * first: every way a pull request could pass code or agent instructions off as docs must classify "no".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyDocsOnly, DOCS_READER_EXEMPT, DOCS_READER_TESTS, DocsOnlyError, referencesTo } from '../lib/docs-only';
import { addedLines, brokenLinks } from '../lib/doc-links';
import { mergedChecksFor } from '../lib/land-docs-only';
import { landPolicyErrors } from '../lib/land-merged-checks';
import { docsOnlyLane } from '../lib/pregate/docs-only-lane';
import type { CheckResult, PregateContext } from '../lib/pregate/types';

const ROOT = path.resolve(import.meta.dir, '..');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
let repo = '';

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: ENV, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function put(rel: string, text = `# ${rel}\n\nprose\n`) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}
/** Commit `change` on top of the seed and classify seed..HEAD; resets afterwards. */
function classify(change: () => void, worktree = false) {
  try {
    change();
    if (worktree) return classifyDocsOnly({ root: repo, base: 'seed' });
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'change');
    return classifyDocsOnly({ root: repo, base: 'seed', head: 'HEAD' });
  } finally {
    git('reset', '-q', '--hard', 'seed');
    git('clean', '-qfdx');
  }
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-only-'));
  git('init', '-q', '-b', 'main');
  for (const f of ['README.md', 'docs/guide.md', 'docs/other.md', 'docs/run-me.md', 'docs/troubleshooting.md', 'docs/captain.md', 'docs/ship-policy.md',
    'docs/evals/result.md', 'docs/generated.md', 'review/SKILL.md', 'review/README.md', 'changelog.d/a.md', 'test/fixtures/x/README.md']) put(f);
  put('docs/other.md', 'See [the guide](guide.md).\n');
  put('CHANGELOG.md', '- edited docs/guide.md\n');
  put('lib/x.ts', "export const doc = 'docs/troubleshooting.md#x';\n");
  put('scripts/run.ts', "Bun.spawn(['sh', 'docs/run-me.md']);\n");
  put('.gstack/generated.json', JSON.stringify({ entries: [{ id: 'g', command: 'gen', outputs: ['docs/generated.md'], inputs: [] }] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  git('tag', 'seed');
});
afterAll(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

const reasons = (r: ReturnType<typeof classifyDocsOnly>) => r.refusals.map(x => `${x.path}: ${x.reason}`).join('; ');

describe('bypass corpus: never docs-only', () => {
  const cases: [string, () => void][] = [
    ['docs plus code', () => { put('docs/guide.md', 'new\n'); put('lib/foo.ts', 'export {};\n'); }],
    ['a doc a script executes', () => put('docs/run-me.md', 'echo pwned\n')],
    ['a doc code names by path', () => put('docs/troubleshooting.md', 'changed\n')],
    ['agent prose under docs/', () => put('docs/captain.md', 'changed\n')],
    ['a policy doc', () => put('docs/ship-policy.md', 'changed\n')],
    ['a case variant of an agent-prose name', () => put('docs/Captain.md')],
    ['a lowercase CLAUDE.md', () => put('docs/claude.md')],
    ['SKILL.md', () => put('review/SKILL.md', 'changed\n')],
    ['prose in a skill directory', () => put('review/README.md', 'changed\n')],
    ['a template', () => put('docs/page.md.tmpl')],
    ['a sections file', () => put('docs/sections/a.md')],
    ['factory.md, CREW.md, AGENTS.md, ETHOS.md', () => { put('docs/factory.md'); put('docs/CREW.md'); put('docs/AGENTS.md'); put('docs/ETHOS.md'); }],
    ['preferences', () => put('docs/preferences.md')],
    ['a generated output', () => put('docs/generated.md', 'changed\n')],
    ['pinned results', () => put('docs/evals/result.md', 'changed\n')],
    ['a preregistration', () => put('docs/runaway-prereg.md')],
    ['root markdown off the allowlist', () => put('NOTES-x.md')],
    ['a wrong-case docs tree', () => put('Docs/x.md')],
    ['a wrong-case README', () => put('readme.MD')],
    ['a look-alike README', () => put('READМE.md')],
    ['code under a .md directory', () => put('docs/x.md/evil.ts', 'export {};\n')],
    ['a fixture README', () => put('test/fixtures/x/README.md', 'changed\n')],
    ['the classifier itself', () => put('lib/docs-only.ts', 'export {};\n')],
    ['a workflow', () => put('.github/workflows/x.yml', 'on: push\n')],
    ['an executable doc', () => { fs.chmodSync(path.join(repo, 'docs/guide.md'), 0o755); }],
    ['a symlinked doc', () => fs.symlinkSync('../lib/x.ts', path.join(repo, 'docs/link.md'))],
    ['code renamed to docs', () => git('mv', 'lib/x.ts', 'docs/x.md')],
    ['a deleted doc that code names', () => fs.rmSync(path.join(repo, 'docs/troubleshooting.md'))],
    ['an empty diff', () => {}],
  ];
  for (const [name, change] of cases) test(name, () => expect(classify(change).docsOnly).toBe(false));

  test('worktree mode sees untracked code', () => {
    expect(classify(() => { put('docs/guide.md', 'x\n'); put('lib/new.ts', 'export {};\n'); }, true).docsOnly).toBe(false);
  });
  test('a path that looks like a git option is searched, never parsed', () => {
    expect(referencesTo(repo, '-Ofoo.md')).toEqual([]);
  });
});

describe('docs-only', () => {
  test('a human doc and a changelog fragment', () => {
    const r = classify(() => { put('docs/guide.md', 'new prose\n'); put('changelog.d/b.md', '- note\n'); });
    expect(reasons(r)).toBe('');
    expect(r.docsOnly).toBe(true);
    expect(r.tests).toContain('test/docs-config-keys.test.ts');
  });
  test('CHANGELOG.md and other docs naming a doc do not pin it', () => {
    expect(classify(() => put('docs/guide.md', 'x\n')).docsOnly).toBe(true);
  });
  test('a new doc and a deleted unreferenced doc', () => {
    expect(classify(() => { put('docs/new.md'); fs.rmSync(path.join(repo, 'docs/other.md')); }).docsOnly).toBe(true);
  });
  test('the reference scan is a substring match, so a path inside a longer one pins conservatively', () => {
    expect(reasons(classify(() => put('README.md', 'x\n')))).toContain('README.md: named by');
  });
  test('worktree mode counts untracked docs', () => {
    expect(classify(() => put('docs/new.md'), true).docsOnly).toBe(true);
  });
  test('a pull request merge commit classifies against its first parent, so a base that moved on does not leak in', () => {
    git('checkout', '-q', '-b', 'pr', 'seed');
    put('docs/guide.md', 'pr prose\n');
    git('commit', '-qam', 'docs');
    git('checkout', '-q', '-b', 'base', 'seed');
    put('lib/moved.ts', 'export {};\n');
    git('add', '-A');
    git('commit', '-qm', 'base moved');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
    try {
      expect(classifyDocsOnly({ root: repo, base: 'HEAD^1', head: 'HEAD' }).docsOnly).toBe(true);
    } finally {
      git('checkout', '-q', 'main');
      git('branch', '-qD', 'pr', 'base');
    }
  });
});

describe('errors fail closed', () => {
  test('an unknown ref throws DOCS_ONLY_ERROR, and the CLI exits 2 and writes docs_only=false', () => {
    expect(() => classifyDocsOnly({ root: repo, base: 'nope', head: 'HEAD' })).toThrow(DocsOnlyError);
    const out = path.join(repo, '..', `${path.basename(repo)}-out`);
    const r = spawnSync(path.join(ROOT, 'bin/gstack-docs-only'), ['--repo', repo, '--base', 'nope', '--head', 'HEAD', '--github-output', out], { encoding: 'utf8', env: { ...ENV, GITHUB_EVENT_NAME: 'pull_request' }, timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('DOCS_ONLY: error (DOCS_ONLY_ERROR:');
    expect(fs.readFileSync(out, 'utf8')).toContain('docs_only=false');
    fs.rmSync(out, { force: true });
  });
  test('only a pull_request event may write docs_only=true', () => {
    put('docs/guide.md', 'x\n');
    git('commit', '-qam', 'docs');
    const out = path.join(repo, '..', `${path.basename(repo)}-ev`);
    try {
      for (const [event, want, code] of [['push', 'false', 1], ['workflow_dispatch', 'false', 1], ['merge_group', 'false', 1], ['pull_request', 'true', 0]] as const) {
        fs.rmSync(out, { force: true });
        const r = spawnSync(path.join(ROOT, 'bin/gstack-docs-only'), ['--repo', repo, '--base', 'HEAD^1', '--head', 'HEAD', '--github-output', out], { encoding: 'utf8', env: { ...ENV, GITHUB_EVENT_NAME: event }, timeout: 30_000 });
        expect([event, r.status]).toEqual([event, code]);
        expect(fs.readFileSync(out, 'utf8')).toContain(`docs_only=${want}`);
      }
    } finally {
      fs.rmSync(out, { force: true });
      git('reset', '-q', '--hard', 'seed');
    }
  });
});

describe('link check', () => {
  test('missing files and anchors fail; headings with code, explicit ids, line suffixes and URLs pass', () => {
    put('docs/a.md', '# Who reads (R65, the `review` key)\n<a id="x-y"></a>\n\n[ok](#who-reads-r65-the-review-key) [id](#x-y) [file](../lib/x.ts:3) [web](https://e.com/z)\n[gone](missing.md) [bad](#nope)\n`[code](skip.md)`\n');
    try {
      expect(brokenLinks(repo, ['docs/a.md']).map(b => b.target)).toEqual(['missing.md', '#nope']);
      expect(brokenLinks(repo, ['docs/a.md'], new Map([['docs/a.md', new Set([4])]]))).toEqual([]);
    } finally { fs.rmSync(path.join(repo, 'docs/a.md')); }
  });

  test('added lines cover quoted and spaced names and untracked files, an undecodable anchor is broken, and an unknown base throws', () => {
    const names = ['docs/café.md', 'docs/with space.md'];
    try {
      for (const n of names) put(n, '# T\n\n[gone](never-there.md) [pct](guide.md#100%)\n');
      const added = addedLines(repo, 'seed', names);
      expect(names.map(n => [...(added.get(n) ?? [])])).toEqual([[1, 2, 3, 4], [1, 2, 3, 4]]);
      expect(brokenLinks(repo, names, added).map(b => `${b.file}:${b.target}:${b.reason}`)).toEqual(names.flatMap(n => [`${n}:never-there.md:no such file`, `${n}:guide.md#100%:undecodable anchor`]));
      fs.appendFileSync(path.join(repo, 'docs/guide.md'), '[late](nope-late.md)\n');
      const lines = fs.readFileSync(path.join(repo, 'docs/guide.md'), 'utf8').split('\n').length - 1;
      expect([...(addedLines(repo, 'seed', ['docs/guide.md']).get('docs/guide.md') ?? [])]).toEqual([lines]);
      expect(() => addedLines(repo, 'no-such-ref', ['docs/guide.md'])).toThrow('unknown revision');
    } finally {
      git('checkout', '-q', '--', 'docs/guide.md');
      for (const n of names) fs.rmSync(path.join(repo, n), { force: true });
    }
  });

  test('scripts/check-doc-links.ts exits 0 on resolving added links, 1 on a broken one and 2 on an unknown base', () => {
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'scripts/check-doc-links.ts'), ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
      return [r.status, (r.stdout ?? '').trim().split('\n').at(-1)];
    };
    try {
      put('docs/cli.md', '[ok](guide.md)\n');
      expect(cli('--base', 'seed', 'docs/cli.md')).toEqual([0, 'DOC_LINKS: ok (1 file(s))']);
      put('docs/cli.md', '[gone](nope.md)\n');
      expect(cli('--base', 'seed', 'docs/cli.md')).toEqual([1, 'DOC_LINKS: broken 1']);
      expect(cli('--base', 'no-such-ref', 'docs/cli.md')[0]).toBe(2);
    } finally { fs.rmSync(path.join(repo, 'docs/cli.md'), { force: true }); }
  });
});

test('every test that reads docs by directory or lists every tracked file is registered', () => {
  const READER = /\['ls-files', '-z'\]|git\(\['ls-files', '-z'\]\)|git\('ls-files', '-z'\)|'ls-files', '-z', '--cached', '--others'|join\(ROOT, '(?:docs|changelog\.d)'\)/;
  const listed = new Set([...DOCS_READER_TESTS.flatMap(t => t.tests), ...Object.keys(DOCS_READER_EXEMPT)]);
  for (const f of listed) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
  const files = (spawnSync('git', ['ls-files', '-z', '--', 'test'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout ?? '').split('\0')
    .filter(f => f.endsWith('.ts') && f !== 'test/docs-only.test.ts' && !f.startsWith('test/fixtures/'));
  const unregistered = files.filter(f => READER.test(fs.readFileSync(path.join(ROOT, f), 'utf8')) && !listed.has(f));
  expect(unregistered.map(f => `${f} reads docs by directory or every tracked file; add it to DOCS_READER_TESTS or DOCS_READER_EXEMPT in lib/docs-only.ts`)).toEqual([]);
});

describe('land and pregate use the same class', () => {
  test('land skips only the declared commands, only for a docs-only pin, and never when the base it lands on gained a reader of a changed doc', () => {
    const land = { merged_checks: ['typecheck', 'tests'], docs_only_skip: ['tests'] };
    put('docs/guide.md', 'land prose\n');
    git('commit', '-qam', 'docs pin');
    const docsPin = git('rev-parse', 'HEAD').trim();
    put('lib/x.ts', 'export const y = 1;\n');
    git('commit', '-qam', 'code pin');
    const codePin = git('rev-parse', 'HEAD').trim();
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('checkout', '-q', '--detach', 'seed');
    put('test/reads-guide.test.ts', "export const doc = 'docs/guide.md';\n");
    git('add', '-A');
    git('commit', '-qm', 'base gains a reader');
    const readerTip = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', branch);
    try {
      expect(mergedChecksFor(repo, land, 'seed', docsPin)).toEqual(['typecheck']);
      expect(mergedChecksFor(repo, land, readerTip, docsPin)).toEqual(['typecheck', 'tests']);
      expect(mergedChecksFor(repo, land, 'seed', codePin)).toEqual(['typecheck', 'tests']);
      expect(mergedChecksFor(repo, land, 'nope', docsPin)).toEqual(['typecheck', 'tests']);
      expect(mergedChecksFor(repo, { merged_checks: ['tests'] }, 'seed', docsPin)).toEqual(['tests']);
    } finally { git('reset', '-q', '--hard', 'seed'); }
    expect(landPolicyErrors({ merged_checks: ['a', 'b'], docs_only_skip: ['b'] })).toEqual([]);
    expect(landPolicyErrors({ merged_checks: ['a'], docs_only_skip: ['a'] }).map(e => e.path)).toEqual(['land.docs_only_skip']);
    expect(landPolicyErrors({ merged_checks: ['a', 'b'], docs_only_skip: ['c'] }).map(e => e.path)).toEqual(['land.docs_only_skip']);
  });

  test('pregate passes a docs-only change with no remote obligation, fails a broken added link, and leaves code to the lanes', () => {
    git('update-ref', 'refs/remotes/origin/main', 'seed');
    const ctx = (allow = true) => ({ repoRoot: repo, base: 'main', explain: [] as string[], allowRepoCommands: allow }) as unknown as PregateContext;
    const base = { id: 'lanes', stage: 'tests', status: 'pass', inputs: {}, lines: [], remote: [{ lane: 'x' }] } as unknown as CheckResult;
    try {
      put('docs/guide.md', 'fine [x](other.md)\n');
      const ok = docsOnlyLane(ctx(), base)!;
      expect([ok.status, ok.remote]).toEqual(['pass', []]);
      expect(ok.detail).toContain('docs-only: 1 file(s)');
      put('docs/guide.md', 'broken [x](nope.md)\n');
      expect(docsOnlyLane(ctx(), base)!.status).toBe('fail');
      put('lib/x.ts', 'export {};\n');
      expect(docsOnlyLane(ctx(), base)).toBeNull();
    } finally {
      git('reset', '-q', '--hard', 'seed');
      git('clean', '-qfdx');
      git('update-ref', '-d', 'refs/remotes/origin/main');
    }
  });
});
