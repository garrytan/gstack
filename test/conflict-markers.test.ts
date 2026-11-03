import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(import.meta.dir, '..', 'scripts', 'check-conflict-markers.ts');
const OPEN = '<'.repeat(7), MID = '='.repeat(7), CLOSE = '>'.repeat(7);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function repo(base: Record<string, string> = { 'README.md': 'base\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-markers-'));
  dirs.push(root);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const write = (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); } };
  write(base);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat');
  const change = (files: Record<string, string>) => { write(files); git('add', '-A'); git('commit', '-q', '-m', 'change'); };
  const run = () => spawnSync('bun', ['--no-env-file', '--config=/dev/null', SCRIPT, '--base', 'main'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { root, change, write, run };
}

describe('check-conflict-markers (GST-1190: #3927 kept markers inside a template literal and its tests passed)', () => {
  // Value: protects=a merge that leaves conflict markers in a changed file is refused before the push, even where the
  //   markers sit inside a string the parser accepts; fails_when=a marker line in a template literal passes, or a markdown
  //   code block that shows a marker is refused; why_new=GSTA-234 #3927; seam=a real git repository and the script
  test('a marker inside a template literal is refused', () => {
    const r = repo();
    r.change({ 'lib/prompt.ts': `export const PROMPT = \`\n${OPEN} HEAD\nkeep this\n${MID}\nor this\n${CLOSE} origin/main\n\`;\n` });
    const out = r.run();
    expect(out.status).toBe(1);
    expect(out.stdout).toContain(`CONFLICT_MARKER: lib/prompt.ts:2 ${OPEN}`);
    expect(out.stdout).toContain(`CONFLICT_MARKER: lib/prompt.ts:4 ${MID}`);
    expect(out.stdout).toContain(`CONFLICT_MARKER: lib/prompt.ts:6 ${CLOSE}`);
  });

  test('a markdown code block that shows a marker is not refused; the same lines outside a fence are', () => {
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
  });

  test('only changed lines count, and a fixture that declares its markers is skipped', () => {
    const r = repo({ 'old.txt': `${OPEN} kept on main\n` });
    r.change({ 'old.txt': `${OPEN} kept on main\nnew line\n`, 'test/fixtures/merge.txt': `gstack-conflict-markers: fixture\n${OPEN} HEAD\n${CLOSE} main\n` });
    expect(r.run()).toMatchObject({ status: 0 });
    r.write({ 'src/wip.js': `${CLOSE} uncommitted\n` });
    const dirty = r.run();
    expect([dirty.status, dirty.stdout]).toEqual([1, expect.stringContaining(`CONFLICT_MARKER: src/wip.js:1 ${CLOSE}`)]);
  });
});
