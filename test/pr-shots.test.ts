/**
 * gstack-pr-shots (lib/pr-shots.ts): change-centred hunks, the −/+ gutter,
 * escaping, section extraction at a base commit, and the refusals that keep
 * secrets, binaries, option-like refs and outside files off a public PR image.
 * Rendering itself is covered by the no-browser path (SHOT_PNG: unavailable).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPage, cleanText, defaultBase, diffLines, hunks, pathSides, resolveCommit } from '../lib/pr-shots';
import { wtreeFingerprint } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
function repo(files: Record<string, string>): { dir: string; base: string; git: (...args: string[]) => string } {
  const dir = tmp('shots-repo-');
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { dir, base: git('rev-parse', 'HEAD'), git };
}

describe('diff and hunks', () => {
  test('a change at line 240 of 300 stays visible; gaps say how much they hide', () => {
    const a = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    const b = [...a]; b[239] = 'line 240 CHANGED';
    const ops = diffLines(a, b);
    if (!Array.isArray(ops)) throw new Error(ops.message);
    const hs = hunks(ops);
    expect(hs.length).toBe(1);
    expect(hs[0]!.gapBefore).toBe(236);
    expect(hs[0]!.ops.map(o => o.t + o.line)).toContain('+line 240 CHANGED');
    const page = buildPage({ before: { text: a.join('\n'), label: 'Before' }, after: { text: b.join('\n'), label: 'After' }, title: 't', caption: 'c', kind: 'prompt' });
    if ('code' in page) throw new Error(page.message);
    expect(page.html).toContain('⋯ 236 unchanged lines');
    expect(page.html).toContain('⋯ 57 unchanged lines');
    expect(page.html).toContain('<span class="m">+</span><span class="t">line 240 CHANGED</span>');
    expect(page.html).toContain('<span class="m">−</span><span class="t">line 240</span>');
    expect(page.text).toContain('+line 240 CHANGED');
    expect(page.changed).toBe(2);
  });

  test('HTML is escaped, the page has a strict CSP, identical sides are refused', () => {
    const page = buildPage({ before: { text: 'a', label: 'B' }, after: { text: '<script>x</script>', label: 'A' }, title: '<t>', caption: '"c"', kind: 'terminal' });
    if ('code' in page) throw new Error(page.message);
    expect(page.html).not.toContain('<script>x');
    expect(page.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(page.html).toContain("default-src 'none'");
    const same = buildPage({ before: { text: 'x', label: 'B' }, after: { text: 'x', label: 'A' }, title: 't', caption: 'c', kind: 'prompt' });
    expect('code' in same && same.code).toBe('PR_SHOTS_IDENTICAL');
  });

  test('a whole rewrite is marked once per pane instead of highlighting every line', () => {
    const page = buildPage({ before: { text: 'old one\nold two', label: 'B' }, after: { text: 'new one\nnew two\nnew three', label: 'A' }, title: 't', caption: 'c', kind: 'prompt' });
    if ('code' in page) throw new Error(page.message);
    expect(page.html).toContain('rewritten entirely: every line is removed (−)');
    expect(page.html).toContain('rewritten entirely: every line is new (+)');
    expect(page.html).not.toContain('class="row add"');
    expect(page.html).toContain('<span class="m">+</span><span class="t">new three</span>');
  });

  test('the text version uses a fence longer than any tilde run inside', () => {
    const page = buildPage({ before: { text: '~~~\nold', label: 'B' }, after: { text: '~~~\nnew', label: 'A' }, title: 't', caption: 'c', kind: 'prompt' });
    if ('code' in page) throw new Error(page.message);
    expect(page.text).toContain('~~~~diff');
  });

  test('ANSI is stripped; binary and oversize input are refused', () => {
    expect(cleanText('\x1b[31mred\x1b[0m\r\n', 'x')).toBe('red\n');
    expect(cleanText(Buffer.from([65, 0, 66]), 'x')).toMatchObject({ code: 'PR_SHOTS_INPUT_REFUSED' });
    expect(cleanText('x'.repeat(600 * 1024), 'x')).toMatchObject({ code: 'PR_SHOTS_INPUT_REFUSED' });
  });
});

describe('default base', () => {
  const featureRepo = (baseBranch = 'main') => {
    const r = repo({ 'doc.md': 'before\n' });
    if (baseBranch !== 'main') r.git('branch', '-m', baseBranch);
    const origin = tmp('shots-origin-');
    r.git('init', '-q', '--bare', '--initial-branch', baseBranch, origin);
    r.git('remote', 'add', 'origin', origin);
    r.git('push', '-q', '-u', 'origin', baseBranch);
    r.git('remote', 'set-head', 'origin', baseBranch);
    r.git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(r.dir, 'doc.md'), 'after\n');
    r.git('add', 'doc.md'); r.git('commit', '-q', '-m', 'feature text');
    r.git('push', '-q', '-u', 'origin', 'feature');
    return { ...r, baseBranch };
  };

  // Value: protects=default comparisons show committed PR changes and preserve explicit/local fallbacks;
  //   fails_when=the feature head, moved base tip or stale local base is used, or missing bases stop refusing;
  //   why_new=existing path-mode tests supply a base instead of exercising remote default selection; seam=none
  test.each(['main', 'develop'])('a local origin/HEAD naming feature still compares against %s', baseBranch => {
    const r = featureRepo(baseBranch);
    expect(defaultBase(r.dir)).toBe(r.base); // ordinary remote-HEAD control
    r.git('remote', 'set-head', 'origin', 'feature');
    expect(resolveCommit(r.dir, baseBranch)).toBe(r.base); // explicit --base stays usable
    const chosen = defaultBase(r.dir);
    expect(chosen).toBe(r.base);
    if (typeof chosen !== 'string') throw new Error(chosen.message);
    const sides = pathSides(r.dir, 'doc.md', chosen);
    if ('code' in sides) throw new Error(sides.message);
    expect(sides.before.text).toBe('before\n');
    expect(sides.after.text).toBe('after\n');
    const page = buildPage({ ...sides, title: 'doc.md', caption: 'Changed text', kind: 'prompt' });
    expect('code' in page).toBe(false); // not PR_SHOTS_IDENTICAL for a committed change
  });

  // Value: protects=a stale remote HEAD cannot hide a usable origin/main before-image;
  //   fails_when=a dangling or unrelated HEAD target is accepted without trying the real base;
  //   why_new=the feature-HEAD cases have a resolving target that shares history; seam=none
  test.each(['dangling', 'unrelated'])('an unusable origin/HEAD (%s) falls back to main', state => {
    const r = featureRepo();
    const target = 'refs/remotes/origin/retired';
    if (state === 'unrelated') {
      const unrelated = r.git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated root');
      r.git('update-ref', target, unrelated);
    }
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', target);
    expect(r.git('rev-parse', 'refs/remotes/origin/main')).toBe(r.base);
    const chosen = defaultBase(r.dir);
    expect(chosen).toBe(r.base);
    if (typeof chosen !== 'string') throw new Error(chosen.message);
    const sides = pathSides(r.dir, 'doc.md', chosen);
    if ('code' in sides) throw new Error(sides.message);
    expect(sides.before.text).toBe('before\n');
    expect(sides.after.text).toBe('after\n');
  });

  test('a moved remote base still compares from the branch fork point, not its tip', () => {
    const r = featureRepo();
    r.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'base-only.txt'), 'upstream change\n');
    r.git('add', 'base-only.txt'); r.git('commit', '-q', '-m', 'advance base');
    r.git('push', '-q', 'origin', 'main');
    const tip = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', 'feature');
    r.git('remote', 'set-head', 'origin', 'feature');
    expect(tip).not.toBe(r.base);
    expect(defaultBase(r.dir)).toBe(r.base);
  });

  test('an unset remote HEAD uses the tracking base rather than a stale local branch', () => {
    const r = featureRepo();
    r.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'base-only.txt'), 'upstream change\n');
    r.git('add', 'base-only.txt'); r.git('commit', '-q', '-m', 'advance base');
    r.git('push', '-q', 'origin', 'main');
    const tip = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', '-b', 'rebased-feature', 'origin/main');
    fs.writeFileSync(path.join(r.dir, 'doc.md'), 'rebased change\n');
    r.git('add', 'doc.md'); r.git('commit', '-q', '-m', 'rebased feature');
    r.git('update-ref', 'refs/heads/main', r.base);
    r.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    expect(r.git('rev-parse', 'main')).toBe(r.base);
    expect(defaultBase(r.dir)).toBe(tip);
  });

  test('a local-only main keeps its before-image for uncommitted changes', () => {
    const r = repo({ 'doc.md': 'before\n' });
    fs.writeFileSync(path.join(r.dir, 'doc.md'), 'after\n');
    expect(defaultBase(r.dir)).toBe(r.base);
    const sides = pathSides(r.dir, 'doc.md', r.base);
    expect(sides).toMatchObject({ before: { text: 'before\n' }, after: { text: 'after\n' } });
  });

  test('no usable local base still refuses with the explicit-base escape', () => {
    const r = repo({ 'doc.md': 'before\n' });
    r.git('branch', '-m', 'feature');
    const result = defaultBase(r.dir);
    expect(result).toMatchObject({ code: 'PR_SHOTS_INPUT_NOT_FOUND' });
    if (typeof result === 'string') throw new Error('expected a missing-base refusal');
    expect(result.message).toContain('--base');
    expect(resolveCommit(r.dir, r.base)).toBe(r.base);
  });

  test('a self-referential remote HEAD with no resolvable base does not fall back to itself', () => {
    const r = featureRepo();
    r.git('remote', 'set-head', 'origin', 'feature');
    r.git('update-ref', '-d', 'refs/remotes/origin/main');
    r.git('branch', '-D', 'main');
    r.git('remote', 'set-url', 'origin', path.join(tmp('shots-offline-'), 'missing.git'));
    const result = defaultBase(r.dir);
    expect(result).toMatchObject({ code: 'PR_SHOTS_INPUT_NOT_FOUND' });
    if (typeof result === 'string') throw new Error('expected a missing-base refusal');
    expect(result.message).toContain('--base');
    expect(resolveCommit(r.dir, r.base)).toBe(r.base);
  });
});

describe('path mode', () => {
  test('one heading section at the base vs the working tree; a new section has an absent before', () => {
    const { dir, base } = repo({ 'SKILL.md': '# S\n## Step 1\nold text\n## Step 2\nsame\n' });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# S\n## Step 1\nnew text\n## Step 2\nsame\n## Step 3\nadded\n');
    const s = pathSides(dir, 'SKILL.md', base, 'Step 1');
    if ('code' in s) throw new Error(s.message);
    expect(s.before.text).toBe('## Step 1\nold text');
    expect(s.after.text).toBe('## Step 1\nnew text');
    expect(s.before.label).toContain(`at ${base.slice(0, 7)} · source text`);
    const added = pathSides(dir, 'SKILL.md', base, 'Step 3');
    if ('code' in added) throw new Error(added.message);
    expect(added.before.absent).toBe('section not present before');
    expect(pathSides(dir, 'SKILL.md', base, 'Nope')).toMatchObject({ code: 'PR_SHOTS_INPUT_NOT_FOUND' });
    expect(pathSides(dir, '../etc/passwd', base)).toMatchObject({ code: 'PR_SHOTS_INPUT_REFUSED' });
  });

  test('refs are resolved without option parsing', () => {
    const { dir } = repo({ 'a.txt': 'a' });
    expect(resolveCommit(dir, '--output=/tmp/x')).toMatchObject({ code: 'PR_SHOTS_INPUT_REFUSED' });
    expect(resolveCommit(dir, 'no-such-ref')).toMatchObject({ code: 'PR_SHOTS_INPUT_NOT_FOUND' });
  });
});

describe('gstack-pr-shots CLI', () => {
  const cli = (args: string[], cwd: string, env: Record<string, string> = {}) => {
    const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-pr-shots'), ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_PROJECT_SLUG: 'acme', GSTACK_SKIP_ASIDE: '1', GSTACK_BROWSE_BIN: '/nonexistent/browse', ...env } });
    return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  test('captures inside the repo render to HTML and text; no browser is reported, not failed', () => {
    const { dir } = repo({ 'x.txt': 'x' });
    fs.writeFileSync(path.join(dir, 'before.txt'), '$ gstack-approvals render\nNo approvals\n');
    fs.writeFileSync(path.join(dir, 'after.txt'), '$ gstack-approvals render\n| Date | Asked |\n');
    const state = tmp('shots-state-');
    const r = cli(['--before', 'before.txt', '--after', 'after.txt', '--kind', 'terminal', '--caption', 'The record renders as a table'], dir, { GSTACK_STATE_ROOT: state });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^SHOT_HTML: .*\/projects\/acme\/pr-shots\/Before-and-after\/shot\.html$/m);
    expect(r.out).toMatch(/^SHOT_PNG: (unavailable \(|.*pair\.png engine=)/m);
    const text = fs.readFileSync(r.out.match(/^SHOT_TEXT: (.+)$/m)![1]!, 'utf8');
    expect(text).toStartWith('<details><summary>Before/after as text: The record renders as a table</summary>');
  });

  // #3560: pr-shots starts the browse daemon from the worktree; the daemon's state-dir setup
  // appended .gstack/ to the tracked .gitignore in a repository that tracks .gstack/ config, so the
  // tree changed after pregate and the /ship receipt refused with PREGATE_STALE. The stub browse
  // runs the daemon's real state-dir setup (browse/src/config.ts), then fails like a browser-less host.
  test.skipIf(process.platform === 'win32')('the working-tree fingerprint is unchanged after a run that starts browse (#3560)', () => {
    const { dir } = repo({ '.gitignore': 'node_modules/\n.gstack/tmp/\n', '.gstack/pregate.json': '{}\n', 'doc.md': '# Doc\n\nold\n' });
    fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\n\nnew\n');
    const stubDir = tmp('shots-browse-');
    fs.writeFileSync(path.join(stubDir, 'state-dir.ts'), `import { ensureStateDir, resolveConfig } from ${JSON.stringify(path.join(ROOT, 'browse/src/config.ts'))};\nensureStateDir(resolveConfig());\nprocess.exit(1);\n`);
    const browse = path.join(stubDir, 'browse');
    fs.writeFileSync(browse, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} --no-env-file --config=/dev/null ${JSON.stringify(path.join(stubDir, 'state-dir.ts'))}\n`, { mode: 0o755 });
    const before = wtreeFingerprint({ cwd: dir });
    expect('tree' in before).toBe(true);
    const r = cli(['--path', 'doc.md', '--caption', 'c'], dir, { GSTACK_STATE_ROOT: tmp('shots-state-'), GSTACK_BROWSE_BIN: browse, BROWSE_STATE_FILE: '' });
    expect(r.out).toMatch(/^SHOT_PNG: failed /m);
    expect(fs.existsSync(path.join(dir, '.gstack', '.gitignore'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.gstack/tmp/\n');
    expect(wtreeFingerprint({ cwd: dir })).toEqual(before);
  });

  test('a secret in a capture is refused before anything is written, without echoing it', () => {
    const { dir } = repo({ 'x.txt': 'x' });
    const secret = 'ghp_' + 'b'.repeat(36);
    fs.writeFileSync(path.join(dir, 'before.txt'), 'ok\n');
    fs.writeFileSync(path.join(dir, 'after.txt'), `token ${secret}\n`);
    const state = tmp('shots-state-');
    const r = cli(['--before', 'before.txt', '--after', 'after.txt', '--caption', 'c'], dir, { GSTACK_STATE_ROOT: state });
    expect(r.status).toBe(3);
    expect(r.err).toContain('(PR_SHOTS_INPUT_REFUSED)');
    expect(r.err).toMatch(/after matched the secret scanner: line 1 /);
    expect(r.err + r.out).not.toContain(secret);
    expect(fs.existsSync(path.join(state, 'projects'))).toBe(false);
  });

  test('a capture outside the repository and state root is refused; mixed modes are usage errors', () => {
    const { dir } = repo({ 'x.txt': 'x' });
    const outside = path.join(tmp('shots-out-'), 'secret.txt');
    fs.writeFileSync(outside, 'x');
    expect(cli(['--before', outside, '--after', 'x.txt', '--caption', 'c'], dir, { GSTACK_STATE_ROOT: tmp('shots-state-') }).err).toContain('outside the repository');
    expect(cli(['--path', 'x.txt', '--before', 'x.txt', '--after', 'x.txt', '--caption', 'c'], dir).status).toBe(2);
    expect(cli(['--path', 'x.txt'], dir).status).toBe(2);
  });
});
