/**
 * Per-repo docs-only paths (GST-1974; docs/pregate.md#repo-docs-paths). A repository may name extra human-docs paths in
 * the base branch's .gstack/ship-policy.json `docs_only` block. The bypass corpus comes first: a pull request must never
 * allowlist itself, a pattern must never reach agent-loaded Markdown or code, and an unreadable policy fails closed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findCarry } from '../lib/ci-carry';
import { classifyDocsOnly } from '../lib/docs-only';
import { mergedChecksFor } from '../lib/land-docs-only';
import { docsOnlyLane } from '../lib/pregate/docs-only-lane';
import { buildRunCheck } from '../lib/pregate/run-check';
import type { CheckResult, PregateContext } from '../lib/pregate/types';
import type { ApiJob, ApiRun, RunDeps, RunProfile } from '../lib/run-evidence';
import { finish, minimumReader, validatePolicy } from '../lib/ship-policy';
import { docsOnlyPolicyErrors } from '../lib/ship-policy-docs-only';
import { DOCS_ONLY_KEY_VERSION, LAND_DOCS_ONLY_SKIP_KEY_VERSION, LAND_KEY_VERSION } from '../lib/ship-policy-keys';

const ROOT = path.resolve(import.meta.dir, '..');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const POLICY = '.gstack/ship-policy.json';
const TESTS = ['test/wiki.test.ts', 'test/x.test.ts'];
const WIKI = { docs_only: { allow: ['wiki/board/**.md'], tests: TESTS } };
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
/** A base commit on top of `plain` whose policy is `policy` (an object, or raw text), tagged `tag`. */
function base(tag: string, policy: unknown) {
  git('checkout', '-q', '--detach', 'plain');
  put(POLICY, typeof policy === 'string' ? policy : JSON.stringify(policy));
  git('add', '-A');
  git('commit', '-qm', tag);
  git('tag', tag);
}
/** Commit `change` on top of `from` and classify from..HEAD (or from to the working tree); resets afterwards. */
function classify(from: string, change: () => void, worktree = false) {
  git('checkout', '-q', '--detach', from);
  try {
    change();
    if (worktree) return classifyDocsOnly({ root: repo, base: from });
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'change');
    return classifyDocsOnly({ root: repo, base: from, head: 'HEAD' });
  } finally {
    git('reset', '-q', '--hard', from);
    git('clean', '-qfdx');
  }
}
const reasons = (r: ReturnType<typeof classifyDocsOnly>) => r.refusals.map(x => `${x.path}: ${x.reason}`).join('; ');

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-policy-'));
  git('init', '-q', '-b', 'main');
  for (const f of ['README.md', 'docs/guide.md', 'docs/internal/notes-x.md', 'wiki/board/old.md', 'wiki/board/pinned.md', 'wiki/board/tested.md', 'wiki/other.md']) put(f);
  put('lib/code.ts', 'export const x = 1;\n');
  put('scripts/post.ts', "export const post = 'wiki/board/pinned.md';\n");
  put('scripts/wiki.ts', "import { readdirSync } from 'node:fs';\nexport const posts = () => readdirSync('wiki');\n");
  put('test/wiki.test.ts', "import { test } from 'bun:test';\nimport '../scripts/wiki';\nimport '../scripts/post';\ntest('wiki', () => {});\n");
  put('test/x.test.ts', "import { test } from 'bun:test';\nexport const doc = 'wiki/board/tested.md';\ntest('x', () => {});\n");
  put(POLICY, JSON.stringify({ bump: 'patch' }));
  git('add', '-A');
  git('commit', '-q', '-m', 'plain');
  git('tag', 'plain');
  base('allowed', WIKI);
  base('broad', { docs_only: { allow: ['wiki/**.md'] } });
  base('denied', { docs_only: { allow: ['wiki/board/**.md'], deny: ['docs/internal/**', 'README.md'], tests: TESTS } });
  base('unlinked', { docs_only: { allow: ['wiki/board/**.md'] } });
  base('halflinked', { docs_only: { allow: ['wiki/board/**.md'], tests: ['test/x.test.ts'] } });
  base('invalid', { docs_only: { allow: ['**'] } });
  base('broken', '{ "docs_only": { "allow": ["wiki/board/**.md"] ');
  base('future', { docs_only: { allow: ['wiki/board/**.md'], deny: ['README.md'], audience: 'humans' } });
  base('ghost', { docs_only: { allow: ['wiki/board/**.md'], tests: [...TESTS, 'test/missing.test.ts'] } });
});
afterAll(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

describe('bypasses refuse', () => {
  test('a head-side policy edit never allowlists its own change, in commit or working-tree mode', () => {
    const edit = () => { put(POLICY, JSON.stringify(WIKI)); put('wiki/board/post.md'); };
    for (const worktree of [false, true]) {
      const r = classify('plain', edit, worktree);
      expect(r.docsOnly).toBe(false);
      expect(reasons(r)).toContain(`${POLICY}: `);
      expect(reasons(r)).toContain('wiki/board/post.md: not on the docs allowlist');
    }
  });

  test('an edit to the policy under an allowing base is still never docs-only', () => {
    const r = classify('allowed', () => { put(POLICY, JSON.stringify({ docs_only: { allow: ['wiki/**.md'] } })); put('wiki/board/post.md'); });
    expect(r.docsOnly).toBe(false);
    expect(r.refusals.map(x => x.path)).toEqual([POLICY]);
  });

  const parse = (p: unknown) => docsOnlyPolicyErrors({ allow: [p] }).map(e => `${e.path}: ${e.message}`).join('; ');
  test.each([
    'SKILL.md', 'wiki/SKILL.md', 'wiki/**/SKILL.md', 'AGENTS.md', 'wiki/AGENTS.md', 'CLAUDE.md', 'wiki/CLAUDE.md', 'CREW.md', 'wiki/board/CREW.md',
    'wiki/x.tmpl', 'wiki/x.md.tmpl', 'skills/**.md', 'skills/review/notes.md', 'templates/**.md', 'wiki/templates/**.md', 'wiki/**/templates/**.md',
    'wiki/skills/**.md', 'wiki/sections/a.md', 'wiki/prompts/**.md', 'wiki/review-prompt.md', 'wiki/preferences.md', 'wiki/factory.md', 'wiki/captain.md',
    '.github/**.md', '.gstack/x.md', 'lib/**.md', 'scripts/notes.md', 'test/**.md', 'wiki/?kills/x.md', 'wiki/[s]kills/x.md',
  ])('an allow pattern aimed at agent prose or code is refused at parse time: %s', p => {
    expect(parse(p)).toMatch(/^docs_only\.allow\[0\]: /);
  });

  test.each(['**', '*', '**.md', '*.md', '**/*.md', '**/README.md', '*/board/*.md', 'wiki/**', 'wiki/*', 'wiki/*.mdx', 'wiki/*.ts', 'wiki/board/**.MD', 'wiki/board/**.md/', '../wiki/*.md', '/wiki/*.md', ''])(
    'a broad or non-Markdown allow pattern is refused at parse time with an example of a narrow one: %p', p => {
      expect(parse(p)).toContain('docs_only.allow[0]: ');
      if (p !== '') expect(parse(p)).toContain('wiki/board/**.md');
    });

  test('the block shape is checked: allow is required, lists are capped, deny takes any contained glob, unknown keys are not errors', () => {
    const paths = (raw: unknown) => docsOnlyPolicyErrors(raw).map(e => e.path);
    expect(paths({ allow: ['wiki/board/**.md'] })).toEqual([]);
    expect(paths({ allow: ['wiki/board/**.md'], deny: ['**', 'wiki/board/drafts/**'] })).toEqual([]);
    expect(paths({ allow: ['wiki/board/**.md'], audience: 'humans' })).toEqual([]);
    expect(paths({})).toEqual(['docs_only.allow']);
    expect(paths([])).toEqual(['docs_only']);
    expect(paths({ allow: 'wiki/board/**.md' })).toEqual(['docs_only.allow']);
    expect(paths({ allow: Array.from({ length: 17 }, (_, i) => `wiki/b${i}/**.md`) })).toEqual(['docs_only.allow']);
    expect(paths({ allow: ['wiki/board/**.md'], deny: [3, '../x'] })).toEqual(['docs_only.deny[0]', 'docs_only.deny[1]']);
    expect(paths({ allow: ['wiki/board/**.md'], tests: ['tests/*.test.ts', 'scripts/wiki.ts', '.github/x.test.ts', '../x.test.ts', 'tests/wiki.test.ts'] })).toEqual(['docs_only.tests[0]', 'docs_only.tests[1]', 'docs_only.tests[2]', 'docs_only.tests[3]']);
  });

  test.each(['wiki/SKILL.md', 'wiki/AGENTS.md', 'wiki/CLAUDE.md', 'wiki/CREW.md', 'wiki/board/crew.md', 'wiki/templates/a.md', 'wiki/skills/x/a.md', 'wiki/sections/a.md',
    'wiki/prompts/a.md', 'wiki/review-prompt.md', 'wiki/preferences.md', 'wiki/board/factory.md', 'wiki/board/run-prereg.md', 'wiki/board/x-policy.md',
    'wiki/lib/x.md', 'wiki/scripts/x.md', 'wiki/node_modules/x.md', 'wiki/.github/x.md', 'wiki/board/evals/x.md'])(
    'the built-in deny wins over a legal repo pattern: %s', f => {
      const r = classify('broad', () => put(f));
      expect(r.docsOnly).toBe(false);
      expect(reasons(r)).not.toContain('not on the docs allowlist');
    });

  test('a directory holding a SKILL.md stays agent prose under a repo pattern', () => {
    const r = classify('broad', () => { put('wiki/SKILL.md'); put('wiki/board/post.md'); });
    expect(reasons(r)).toContain('wiki/board/post.md: agent-read prose');
  });

  test('a repo-allowed path that a script or a test names is pinned', () => {
    expect(reasons(classify('allowed', () => put('wiki/board/pinned.md', 'edited\n')))).toContain('named by scripts/post.ts');
    expect(reasons(classify('allowed', () => put('wiki/board/tested.md', 'edited\n')))).toContain('named by test/x.test.ts');
  });

  test('a script that lists an allowed directory refuses the change unless a declared docs test is tied to it', () => {
    const unlinked = reasons(classify('unlinked', () => put('wiki/board/post.md')));
    expect(unlinked).toContain('its directory is read by');
    expect(unlinked).toContain('scripts/wiki.ts');
    const half = reasons(classify('halflinked', () => put('wiki/board/post.md')));
    expect(half).toContain('scripts/wiki.ts');
    expect(half).not.toContain('test/x.test.ts');
    expect(classify('allowed', () => put('wiki/board/post.md')).docsOnly).toBe(true);
  });

  test('a script that builds the directory path relatively or by concatenation is a directory reader too', () => {
    const forms = ["'./wiki'", "path.join(__dirname, '../wiki/board')", "root + '/wiki'", '`${root}/wiki`'];
    for (const [i, form] of forms.entries()) {
      git('checkout', '-q', '--detach', 'allowed');
      put('scripts/rel.ts', `export const dir = (root: string) => ${form};\n`);
      git('add', '-A');
      git('commit', '-qm', `relative reader ${i}`);
      git('tag', `rel-${i}`);
      expect([form, reasons(classify(`rel-${i}`, () => put('wiki/board/post.md')))]).toEqual([form, expect.stringContaining('its directory is read by scripts/rel.ts')]);
    }
  });

  test('a declared docs test missing from the tree refuses a repo-allowed change instead of passing without it', () => {
    for (const worktree of [false, true]) {
      const r = classify('ghost', () => put('wiki/board/post.md'), worktree);
      expect(r.docsOnly).toBe(false);
      expect(reasons(r)).toContain('test/missing.test.ts');
    }
    expect(classify('ghost', () => put('docs/guide.md', 'edited\n')).docsOnly).toBe(true);
  });

  test('a rename from code into an allowed path refuses, and so does an executable or a symlink there', () => {
    const r = classify('allowed', () => git('mv', 'lib/code.ts', 'wiki/board/code.md'));
    expect(r.docsOnly).toBe(false);
    expect(reasons(r)).toContain('wiki/board/code.md: not on the docs allowlist');
    expect(classify('allowed', () => { put('wiki/board/run.md'); fs.chmodSync(path.join(repo, 'wiki/board/run.md'), 0o755); }).docsOnly).toBe(false);
    expect(classify('allowed', () => { fs.mkdirSync(path.join(repo, 'wiki/board'), { recursive: true }); fs.symlinkSync('../../lib/code.ts', path.join(repo, 'wiki/board/link.md')); }).docsOnly).toBe(false);
  });

  test('a base policy that fails to parse, or an invalid docs_only block, fails closed for every change', () => {
    for (const tag of ['broken', 'invalid']) {
      for (const f of ['wiki/board/post.md', 'README.md']) {
        const r = classify(tag, () => put(f, 'edited\n'));
        expect(r.docsOnly).toBe(false);
        expect(reasons(r)).toContain(POLICY);
      }
    }
    expect(reasons(classify('invalid', () => put('README.md', 'edited\n')))).toContain('docs_only.allow[0]');
  });

  test('an unknown key in the base block drops the repo allow list but keeps its deny list', () => {
    expect(classify('future', () => put('wiki/board/post.md')).docsOnly).toBe(false);
    expect(reasons(classify('future', () => put('wiki/board/post.md')))).toContain('docs_only.audience');
    expect(classify('future', () => put('README.md', 'edited\n')).docsOnly).toBe(false);
    expect(classify('future', () => put('docs/guide.md', 'edited\n')).docsOnly).toBe(true);
  });

  test('repo deny entries only restrict, built-in paths included', () => {
    expect(reasons(classify('denied', () => put('docs/internal/notes-x.md', 'edited\n')))).toContain('docs_only.deny');
    expect(classify('denied', () => put('README.md', 'edited\n')).docsOnly).toBe(false);
    expect(classify('denied', () => put('docs/guide.md', 'edited\n')).docsOnly).toBe(true);
    expect(classify('denied', () => put('wiki/board/post.md')).docsOnly).toBe(true);
  });

  test('without a docs_only block the fixed allowlist is unchanged', () => {
    expect(classify('plain', () => put('wiki/board/post.md')).docsOnly).toBe(false);
    expect(classify('plain', () => put('docs/guide.md', 'edited\n')).docsOnly).toBe(true);
  });
});

describe('a wiki/board post under a base-side allow is docs-only end to end', () => {
  test('the classifier, in commit and working-tree mode, for a new, edited and renamed post', () => {
    for (const worktree of [false, true]) {
      const r = classify('allowed', () => put('wiki/board/post.md'), worktree);
      expect([r.docsOnly, reasons(r)]).toEqual([true, '']);
      expect(r.tests).toEqual(expect.arrayContaining(TESTS));
    }
    expect(classify('allowed', () => put('docs/guide.md', 'edited\n')).tests).not.toContain('test/wiki.test.ts');
    expect(classify('allowed', () => put('wiki/board/old.md', 'edited\n')).docsOnly).toBe(true);
    expect(classify('allowed', () => { fs.mkdirSync(path.join(repo, 'wiki/board/2026')); git('mv', 'wiki/board/old.md', 'wiki/board/2026/old.md'); }).docsOnly).toBe(true);
    expect(classify('allowed', () => { put('wiki/board/post.md', 'See wiki/board/old.md and docs/guide.md.\n'); put('docs/guide.md', 'edited\n'); }).docsOnly).toBe(true);
    expect(classify('allowed', () => put('wiki/other.md', 'edited\n')).docsOnly).toBe(false);
    const moved = classify('allowed', () => git('mv', 'wiki/board/old.md', 'docs/old.md'));
    expect([moved.docsOnly, moved.tests]).toEqual([true, expect.arrayContaining(TESTS)]);
  });

  test('land keeps the skipped merged checks when the base tip gained a reader of the changed directory', () => {
    const land = { merged_checks: ['typecheck', 'tests'], docs_only_skip: ['tests'] };
    const tip = (tag: string, change: () => void) => { git('checkout', '-q', '--detach', 'allowed'); change(); git('add', '-A'); git('commit', '-qm', tag); git('tag', tag); };
    tip('pin', () => put('wiki/board/post.md'));
    const pin = git('rev-parse', 'pin').trim();
    tip('tip-reader', () => put('test/list.test.ts', "import { readdirSync } from 'node:fs';\nimport { test } from 'bun:test';\ntest('posts', () => { readdirSync('./wiki/board'); });\n"));
    tip('tip-code', () => put('lib/other.ts', 'export const y = 2;\n'));
    tip('tip-index', () => put('wiki/board/index.md', 'See wiki/board/post.md.\n'));
    expect(mergedChecksFor(repo, land, 'tip-code', pin)).toEqual(['typecheck']);
    expect(mergedChecksFor(repo, land, 'tip-index', pin)).toEqual(['typecheck']);
    expect(mergedChecksFor(repo, land, 'tip-reader', pin)).toEqual(['typecheck', 'tests']);
  });

  test('the CI output: docs_only=true on a pull_request run, false on a push to main', () => {
    git('checkout', '-q', '--detach', 'allowed');
    put('wiki/board/post.md');
    git('add', '-A');
    git('commit', '-qm', 'post');
    try {
      for (const [event, code, value] of [['pull_request', 0, 'true'], ['push', 1, 'false']] as const) {
        const out = path.join(repo, '..', `${path.basename(repo)}-${event}.out`);
        const r = spawnSync(path.join(ROOT, 'bin/gstack-docs-only'), ['--repo', repo, '--base', 'HEAD^1', '--head', 'HEAD', '--github-output', out], { encoding: 'utf8', env: { ...ENV, GITHUB_EVENT_NAME: event }, timeout: 30_000 });
        const lines = fs.readFileSync(out, 'utf8').split('\n');
        expect([r.status, lines[0]]).toEqual([code, `docs_only=${value}`]);
        if (value === 'true') expect(lines[1]).toContain('test/wiki.test.ts');
        fs.rmSync(out, { force: true });
      }
    } finally { git('reset', '-q', '--hard', 'allowed'); }
  });

  test('pregate\'s lanes check runs the docs lane and owes no remote gate', () => {
    git('checkout', '-q', '--detach', 'allowed');
    git('update-ref', 'refs/remotes/origin/main', 'allowed');
    const ctx = { repoRoot: repo, base: 'main', explain: [] as string[], allowRepoCommands: true } as unknown as PregateContext;
    const lanes = { id: 'lanes', stage: 'tests', status: 'pass', inputs: {}, lines: [], remote: [{ lane: 'x' }] } as unknown as CheckResult;
    try {
      put('wiki/board/post.md', 'See [the old post](old.md).\n');
      const ok = docsOnlyLane(ctx, lanes)!;
      expect([ok.status, ok.remote]).toEqual(['pass', []]);
      expect(ok.detail).toContain('docs-only: 1 file(s)');
      expect(ok.detail).toContain('2 docs reader test file(s) passed');
      git('update-ref', 'refs/remotes/origin/main', 'plain');
      expect(docsOnlyLane(ctx, lanes)).toBeNull();
    } finally {
      git('reset', '-q', '--hard', 'allowed');
      git('clean', '-qfdx');
      git('update-ref', '-d', 'refs/remotes/origin/main');
    }
  });

  test('gstack-ci-carry counts the skipped-suite run as carried through pregate\'s own docs-only callback', () => {
    git('checkout', '-q', '--detach', 'allowed');
    put('wiki/board/post.md');
    git('add', '-A');
    git('commit', '-qm', 'post');
    const head = git('rev-parse', 'HEAD').trim();
    const tree = git('rev-parse', 'HEAD^{tree}').trim();
    git('remote', 'add', 'origin', 'https://github.com/fixture/docs-policy.git');
    try {
      const suites = ['free-plan', 'typecheck'];
      const profile: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request'], jobs: [...suites, 'free-tests'], artifact: 'tested-tree', os: 'Linux', skippable: { jobs: suites, gate: 'docs-scope', scripts: ['lib/docs-only.ts'] } };
      const run = { id: 9, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: head, path: '.github/workflows/free-tests.yml', created_at: '2026-11-08T11:00:00Z', updated_at: '2026-11-08T11:10:00Z', repository: { full_name: 'fixture/docs-policy' }, head_repository: { full_name: 'fixture/docs-policy' } } as ApiRun;
      const job = (name: string, conclusion: string) => ({ name, conclusion, completed_at: '2026-11-08T11:10:00Z' }) as ApiJob;
      const deps: RunDeps = { run: () => run, runsForHead: (_wf, sha) => (sha === head ? [run] : []), jobs: () => [job('docs-scope', 'success'), ...suites.map(n => job(n, 'skipped')), job('free-tests', 'success')], artifact: () => { throw new Error('no artifact'); }, commitTree: sha => (sha === head ? tree : null) };
      const carry = (tip: string) => {
        git('update-ref', 'refs/remotes/origin/main', tip);
        const rc = buildRunCheck(repo, null, false, 'main');
        if ('error' in rc) throw new Error(rc.error);
        return findCarry({ repo: 'fixture/docs-policy', deps, profiles: { 'ci-reuse/free-tests': profile }, now: new Date('2026-11-08T12:00:00Z'), unchanged: () => null, docsOnly: rc.docsOnly }, { profiles: ['ci-reuse/free-tests'], head, tree, wtree: () => tree });
      };
      const v = carry('allowed');
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.receipt).toContain('not_owed=docs-only');
      expect(carry('plain').ok).toBe(false);
      git('checkout', '-q', '--detach', 'allowed');
      put(POLICY, JSON.stringify({ bump: 'patch' }));
      git('commit', '-qam', 'revoke the allow on the base tip');
      const revoked = git('rev-parse', 'HEAD').trim();
      git('checkout', '-q', '--detach', head);
      expect(carry(revoked).ok).toBe(false);
    } finally {
      git('remote', 'remove', 'origin');
      git('reset', '-q', '--hard', 'allowed');
    }
  });
});

describe('the policy reader', () => {
  const at = { gstackVersion: DOCS_ONLY_KEY_VERSION };
  const codes = (raw: Record<string, unknown>) => validatePolicy(raw, at).map(e => `${e.code}:${e.path}`);

  test('docs_only needs min_gstack_version at its introducing release and validates its patterns', () => {
    expect(codes({ ...WIKI, min_gstack_version: DOCS_ONLY_KEY_VERSION })).toEqual([]);
    expect(codes({ docs_only: null })).toEqual([]);
    expect(codes(WIKI)).toEqual(['POLICY_INVALID:docs_only']);
    expect(codes({ docs_only: { allow: ['**'] }, min_gstack_version: DOCS_ONLY_KEY_VERSION })).toEqual(['POLICY_INVALID:docs_only.allow[0]']);
    expect(minimumReader(WIKI)).toBe(DOCS_ONLY_KEY_VERSION);
  });

  test('land.docs_only_skip names its own floor, by value, as bump: never does', () => {
    const land = { merged_checks: ['typecheck', 'tests'], docs_only_skip: ['tests'] };
    expect(codes({ land, min_gstack_version: LAND_DOCS_ONLY_SKIP_KEY_VERSION })).toEqual([]);
    expect(codes({ land, min_gstack_version: LAND_KEY_VERSION })).toEqual(['POLICY_INVALID:land.docs_only_skip']);
    expect(codes({ land: { merged_checks: ['typecheck'] }, min_gstack_version: LAND_KEY_VERSION })).toEqual([]);
    expect(minimumReader({ land })).toBe(LAND_DOCS_ONLY_SKIP_KEY_VERSION);
  });

  test('unknown keys under land and docs_only are warnings, not errors; elsewhere they stay errors', () => {
    const raw = { land: { merged_checks: ['typecheck'], retries: 2 }, docs_only: { allow: ['wiki/board/**.md'], audience: 'humans' }, min_gstack_version: DOCS_ONLY_KEY_VERSION };
    expect(codes(raw)).toEqual([]);
    const loaded = finish(JSON.stringify(raw), { kind: 'base', ref: 'origin/main', sha: 'a'.repeat(40), label: 'fixture' });
    expect(loaded.errors.map(e => e.path)).not.toContain('land.retries');
    expect(loaded.warnings.map(w => w.path)).toEqual(['land.retries', 'docs_only.audience']);
    expect(loaded.warnings[0]!.message).toContain('ignored');
    expect(codes({ pr_count: { default_pr_count: 1, split_requires_owner: true, extra: 1 } })).toEqual(['POLICY_INVALID:pr_count.extra']);
  });

  test('gstack\'s own policy turns on neither key', () => {
    const own = JSON.parse(fs.readFileSync(path.join(ROOT, POLICY), 'utf8'));
    expect(own.docs_only).toBeUndefined();
    expect(own.land?.docs_only_skip).toBeUndefined();
  });
});
