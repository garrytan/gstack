import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';

const SCRIPT = path.resolve(import.meta.dir, '..', 'scripts/check-conflict-markers.ts');
const OPEN = '<'.repeat(7), MID = '='.repeat(7), CLOSE = '>'.repeat(7);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function repo(base: Record<string, string> = { 'README.md': 'base\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-markers-'));
  dirs.push(root);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  const write = (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); } };
  write(base);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat');
  const change = (files: Record<string, string>) => { write(files); git('add', '-A'); git('commit', '-q', '-m', 'change'); };
  const run = (env: Record<string, string> = {}) => spawnSync('bun', [...bunIsolationArgs(), SCRIPT, '--base', 'main'], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  return { root, git, change, write, run };
}

describe('check-conflict-markers (GST-1190: #3927 kept markers inside a template literal and its tests passed)', () => {
  // Value: protects=a merge that leaves conflict markers in a changed file is refused before the push, even where the
  //   markers sit inside a string the parser accepts; fails_when=a marker line in a template literal passes, a markdown
  //   code block that shows a marker is refused, or a git display setting hides a file; why_new=GSTA-234 #3927;
  //   seam=a real git repository and the script
  test('a marker inside a template literal is refused', () => {
    const r = repo();
    r.change({ 'lib/prompt.ts': `export const PROMPT = \`\n${OPEN} HEAD\nkeep this\n${MID}\nor this\n${CLOSE} origin/main\n\`;\n` });
    const out = r.run();
    expect(out.status).toBe(1);
    expect(out.stdout).toContain(`CONFLICT_MARKER: lib/prompt.ts:2 ${OPEN}\n`);
    expect(out.stdout).toContain(`CONFLICT_MARKER: lib/prompt.ts:4 ${MID}\n`);
    expect(out.stdout).toContain(`CONFLICT_MARKER: lib/prompt.ts:6 ${CLOSE}\n`);
  });

  test('a markdown code block that shows a marker is not refused; the same lines outside a fence, or in a bash fence, are', () => {
    const r = repo();
    const block = `${OPEN} HEAD\nours\n${MID}\ntheirs\n${CLOSE} main\n`;
    r.change({ 'docs/merging.md': `# Merging\n\nGit writes this:\n\n\`\`\`\n${block}\`\`\`\n\nA heading\n${MID}\n` });
    const fenced = r.run();
    expect([fenced.status, fenced.stdout]).toEqual([0, expect.stringContaining('CONFLICT_MARKERS: none')]);
    r.change({ 'docs/merging.md': `# Merging\n\n${block}` });
    const bare = r.run();
    expect(bare.status).toBe(1);
    expect(bare.stdout).toContain(`CONFLICT_MARKER: docs/merging.md:3 ${OPEN}`);
    expect(bare.stdout).toContain(`CONFLICT_MARKER: docs/merging.md:5 ${MID}`);
    r.change({ 'skill/sections/x.md': `# X\n\n\`\`\`bash\n${OPEN} HEAD\necho a\n${MID}\necho b\n${CLOSE} feat\n\`\`\`\n` });
    expect(r.run().stdout).toContain(`CONFLICT_MARKER: skill/sections/x.md:4 ${OPEN}`);
  });

  test('only changed lines count; a fixture declares itself on a line of its own, a mention elsewhere does not exempt a file', () => {
    const r = repo({ 'old.txt': `${OPEN} kept on main\n` });
    r.change({ 'old.txt': `${OPEN} kept on main\nnew line\n`, 'test/fixtures/merge.txt': `# gstack-conflict-markers: fixture\n${OPEN} HEAD\n${CLOSE} main\n` });
    expect(r.run()).toMatchObject({ status: 0 });
    r.change({ 'cfg.json': `{"fix": "declare gstack-conflict-markers: fixture"}\n${OPEN} HEAD\n` });
    expect(r.run().stdout).toContain(`CONFLICT_MARKER: cfg.json:2 ${OPEN}`);
  });

  test('the pushed commit is read, not only the working tree; untracked files are not; git display settings change nothing', () => {
    const r = repo();
    r.change({ 'src/a b/ünï.ts': `const s = \`\n${CLOSE} theirs\n\`;\n` });
    for (const env of <Record<string, string>[]>[{}, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.noprefix', GIT_CONFIG_VALUE_0: 'true' }, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.mnemonicPrefix', GIT_CONFIG_VALUE_0: 'true' }]) {
      expect(r.run(env).stdout, JSON.stringify(env)).toContain(`CONFLICT_MARKER: src/a b/ünï.ts:2 ${CLOSE}`);
    }
    r.write({ 'src/a b/ünï.ts': 'const s = 1;\n', 'merge.ts.orig': `${OPEN} HEAD\n` });
    const repaired = r.run();
    expect([repaired.status, repaired.stdout]).toEqual([1, expect.stringContaining(`CONFLICT_MARKER: src/a b/ünï.ts:2 ${CLOSE}`)]);
    expect(repaired.stdout).not.toContain('merge.ts.orig');
    r.write({ 'README.md': `base\n${MID}\n` });
    r.git('add', '-A'); r.git('commit', '-q', '-m', 'repair');
    r.write({ 'lib/wip.ts': `${CLOSE} uncommitted\n` }); r.git('add', 'lib/wip.ts'); r.git('commit', '-q', '-m', 'wip'); r.write({ 'lib/wip.ts': `ok\n${OPEN} x\n` });
    expect(r.run().stdout).toContain(`CONFLICT_MARKER: lib/wip.ts:2 ${OPEN} (working tree)`);
  });
});
