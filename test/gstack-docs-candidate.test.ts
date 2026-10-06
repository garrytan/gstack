import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-docs-candidate');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-candidate-')));
  roots.push(root);
  const dir = path.join(root, 'repo');
  fs.mkdirSync(path.join(dir, 'handbook'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', dir);
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'handbook', 'guide.md'), '# Guide\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 2;\n');
  git(dir, 'commit', '-qam', 'change');
  fs.writeFileSync(path.join(dir, 'odd name\nline.ts'), 'x\n');
  fs.appendFileSync(path.join(dir, 'handbook', 'guide.md'), 'dirty\n');
  return { root, dir, record: path.join(root, 'candidate.json') };
}

const run = (cwd: string, ...args: string[]) => spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: 20_000 });

describe('gstack-docs-candidate', () => {
  test('snapshot records base, HEAD, index, NUL-safe path lists and content hashes without touching the repository', () => {
    const { dir, record } = repo();
    const gitDir = path.join(dir, '.git');
    const before = fs.readdirSync(gitDir, { recursive: true }).length;
    const indexBefore = fs.readFileSync(path.join(gitDir, 'index'));
    const result = run(dir, 'snapshot', '--out', record, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'handbook');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`CANDIDATE: ${record}`);
    const saved = JSON.parse(fs.readFileSync(record, 'utf8'));
    expect(saved).toMatchObject({ schema_version: 1, audit_id: 'a1', mode: 'edit', base: git(dir, 'rev-parse', 'main'),
      head: git(dir, 'rev-parse', 'HEAD'), branch: 'feature', committed: ['app.ts'], unstaged: ['handbook/guide.md'],
      untracked: ['odd name\nline.ts'], docs: ['handbook/guide.md'] });
    expect(saved.selected).toEqual(['app.ts', 'handbook/guide.md', 'odd name\nline.ts']);
    expect(saved.hashes['app.ts']).toBe(git(dir, 'hash-object', 'app.ts'));
    expect(saved.index).toHaveLength(2);
    expect(fs.statSync(record).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(gitDir, { recursive: true }).length).toBe(before);
    expect(fs.readFileSync(path.join(gitDir, 'index')).equals(indexBefore)).toBe(true);
  });

  test('compare reports exactly what changed since the snapshot', () => {
    const { dir, record } = repo();
    expect(run(dir, 'snapshot', '--out', record, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'handbook').status).toBe(0);
    const unchanged = run(dir, 'compare', record);
    expect(JSON.parse(unchanged.stdout)).toEqual({ audit_id: 'a1', head_changed: false, index_changed: false, content_changed: [], newly_dirty: [] });
    fs.appendFileSync(path.join(dir, 'handbook', 'guide.md'), 'edited\n');
    fs.writeFileSync(path.join(dir, 'new.md'), 'new\n');
    fs.rmSync(path.join(dir, 'odd name\nline.ts'));
    expect(JSON.parse(run(dir, 'compare', record).stdout)).toEqual({ audit_id: 'a1', head_changed: false, index_changed: false,
      content_changed: ['handbook/guide.md', 'odd name\nline.ts'], newly_dirty: ['new.md'] });
    git(dir, 'add', 'new.md');
    expect(JSON.parse(run(dir, 'compare', record).stdout).index_changed).toBe(true);
    git(dir, 'commit', '-qm', 'more');
    expect(JSON.parse(run(dir, 'compare', record).stdout).head_changed).toBe(true);
  });

  test('--select narrows release paths and invalid invocations fail without a record', () => {
    const { dir, root, record } = repo();
    expect(run(dir, 'snapshot', '--out', record, '--audit-id', 'a', '--mode', 'read-only', '--base', 'main', '--select', 'app.ts').status).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).selected).toEqual(['app.ts']);
    for (const args of [
      ['snapshot', '--out', path.join(dir, 'inside.json'), '--audit-id', 'a', '--mode', 'edit', '--base', 'main'],
      ['snapshot', '--out', path.join(root, 'x.json'), '--audit-id', 'a', '--mode', 'write', '--base', 'main'],
      ['snapshot', '--out', path.join(root, 'y.json'), '--audit-id', 'a', '--mode', 'edit', '--base', 'no-such-rev'],
      ['snapshot', '--out', path.join(root, 'z.json'), '--audit-id', 'a', '--mode', 'edit', '--base', 'main', '--force', 'x'],
      ['compare'], ['compare', path.join(root, 'missing.json')], ['install'], ['--help', 'snapshot'],
    ]) {
      const result = run(dir, ...args);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('gstack-docs-candidate:');
    }
    expect(fs.existsSync(path.join(dir, 'inside.json'))).toBe(false);
  });

  test('--help prints the usage it names in its errors', () => {
    const { dir } = repo();
    const help = run(dir, '--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('gstack-docs-candidate snapshot --out <candidate.json>');
    expect(help.stdout).toContain('gstack-docs-candidate compare <candidate.json>');
    expect(run(dir, 'install').stderr).toContain(help.stdout.trim());
  });

  test('/ship records post-child hashes with the helper, so Step 16 compares instead of retyping', () => {
    // ci-37198445662 gate-census-2: ship-docsync-completion/-store parents spent 45-78 s of model time
    // retyping hash maps, child output and records into several artifacts after the child returned.
    const gate = fs.readFileSync(path.resolve(import.meta.dir, '..', 'ship/sections/documentation.md.tmpl'), 'utf8').replace(/\s+/g, ' ');
    expect(gate).toContain('post-child hashes (rerun the Prepare `snapshot` with only `--out <audit-id>-post.json` changed; Step 16 `compare`s it; never type hashes)');
    expect(gate).toContain('Save records once; cite files by path, never copying their content.');
    const { dir, root, record } = repo();
    const args = ['--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'handbook'];
    expect(run(dir, 'snapshot', '--out', record, ...args).status).toBe(0);
    fs.appendFileSync(path.join(dir, 'handbook', 'guide.md'), 'child edit\n');
    expect(JSON.parse(run(dir, 'compare', record).stdout).content_changed).toEqual(['handbook/guide.md']);
    const post = path.join(root, 'a1-post.json');
    expect(run(dir, 'snapshot', '--out', post, ...args).status).toBe(0);
    expect(JSON.parse(run(dir, 'compare', post).stdout)).toEqual({ audit_id: 'a1', head_changed: false, index_changed: false, content_changed: [], newly_dirty: [] });
    fs.appendFileSync(path.join(dir, 'app.ts'), '// later edit\n');
    fs.writeFileSync(path.join(dir, 'late.md'), 'late\n');
    expect(JSON.parse(run(dir, 'compare', post).stdout)).toMatchObject({ content_changed: ['app.ts'], newly_dirty: ['late.md'] });
  });
});
