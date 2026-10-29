/**
 * test/helpers/git-fixture-template.ts: copies made from one template are
 * independent repositories (a push in one never reaches the other or the
 * template), and a copy whose rebind misses a path that names the template
 * root, in any of its spellings, throws instead of reaching a test.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitFixtureTemplate, pathSpellings, rebindFile, rebindGitDir, templateReferences } from './helpers/git-fixture-template';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

function build(root: string): { head: string } {
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  return { head: git(work, 'rev-parse', 'HEAD') };
}

const template = gitFixtureTemplate({ prefix: 'gstack-fixture-template-', build, rebind: (copy, tpl) => rebindGitDir(path.join(copy, 'work', '.git'), tpl, copy) });
const leaky = gitFixtureTemplate({ prefix: 'gstack-fixture-template-leak-', build, rebind: () => {} });
afterAll(() => { template.dispose(); leaky.dispose(); });

function copy() {
  const c = template.copy();
  roots.push(c.root);
  return { ...c, work: path.join(c.root, 'work'), origin: path.join(c.root, 'origin.git') };
}
function pushChange(c: ReturnType<typeof copy>, text: string): string {
  fs.writeFileSync(path.join(c.work, 'a.txt'), text);
  git(c.work, 'commit', '-q', '-am', text);
  git(c.work, 'push', '-q', 'origin', 'main');
  return git(c.work, 'rev-parse', 'HEAD');
}

describe('git fixture template', () => {
  test('two copies from one template mutated independently stay isolated from each other and from the template', () => {
    const a = copy();
    const b = copy();
    expect(git(a.work, 'remote', 'get-url', 'origin')).toBe(a.origin);
    expect(git(b.work, 'remote', 'get-url', 'origin')).toBe(b.origin);
    const fromA = pushChange(a, 'from a\n');
    expect(git(a.origin, 'rev-parse', 'main')).toBe(fromA);
    expect(git(b.origin, 'rev-parse', 'main')).toBe(b.meta.head);
    const fromB = pushChange(b, 'from b\n');
    expect(fromB).not.toBe(fromA);
    expect(git(a.origin, 'rev-parse', 'main')).toBe(fromA);
    expect(git(b.origin, 'rev-parse', 'main')).toBe(fromB);
    expect(fs.readFileSync(path.join(a.work, 'a.txt'), 'utf8')).toBe('from a\n');
    const c = copy();
    expect(git(c.origin, 'rev-parse', 'main')).toBe(c.meta.head);
    expect(fs.readFileSync(path.join(c.work, 'a.txt'), 'utf8')).toBe('base\n');
  });

  test('a copy whose rebind leaves the remote URL on the template throws and names the file', () => {
    expect(() => leaky.copy()).toThrow(/still references its template [^\n]*\n.*config/);
  });

  test('native, forward-slash, backslash-escaped and Git Bash spellings are each rewritten, and each one left behind is found', () => {
    const to = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fixture-spellings-'));
    roots.push(to);
    const from = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gstack-fixture-tpl-AbC123';
    const spellings = pathSpellings(from);
    expect(spellings).toEqual([
      'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\gstack-fixture-tpl-AbC123',
      from,
      'C:/Users/RUNNER~1/AppData/Local/Temp/gstack-fixture-tpl-AbC123',
      '/c/Users/RUNNER~1/AppData/Local/Temp/gstack-fixture-tpl-AbC123',
    ]);
    const file = path.join(to, 'config');
    fs.writeFileSync(file, spellings.map(s => 'url = ' + s + '/origin.git\n').join(''));
    expect(templateReferences(to, from)).toEqual([file]);
    rebindFile(file, from, to);
    expect(fs.readFileSync(file, 'utf8')).toBe(spellings.map((_, i) => 'url = ' + (pathSpellings(to)[i] ?? to) + '/origin.git\n').join(''));
    expect(templateReferences(to, from)).toEqual([]);
    for (const s of spellings) {
      fs.writeFileSync(file, 'url = ' + s + '\n');
      expect(templateReferences(to, from)).toEqual([file]);
    }
    expect(templateReferences(to, from, { origin: from + '\\origin.git' })).toEqual([file, '(template meta)']);
  });
});
