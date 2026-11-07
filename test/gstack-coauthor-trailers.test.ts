/**
 * Free contracts of gstack-coauthor-trailers: distinct authors of a range in
 * first-appearance order, the checkout's own identity and --exclude left out,
 * one Co-authored-by line each, and an idempotent --message append. Commits are
 * written through fast-import so their authors are the stream's, whatever
 * identity the host forces on `git commit`.
 */
import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from '../lib/headless-artifacts';
import { runScriptSync } from '../lib/script-invocation';

const BIN = path.resolve(import.meta.dir, '../crew/bin/gstack-coauthor-trailers');
const temps: string[] = [];
afterAll(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });
const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_COMMITTER_NAME: 'Porter', GIT_COMMITTER_EMAIL: 'porter@example.invalid', GIT_AUTHOR_NAME: 'Porter', GIT_AUTHOR_EMAIL: 'porter@example.invalid',
};

function git(cwd: string, args: string[], input?: string) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', timeout: 30_000, input });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
/** The committer identity git reports in this checkout (whatever the host forces); the bin must never list it. */
function selfEmail(cwd: string): string { return /<([^>]*)>/.exec(git(cwd, ['var', 'GIT_COMMITTER_IDENT']))![1]!; }

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coauthor-'));
  temps.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  const self = selfEmail(dir);
  let mark = 0;
  const commit = (branch: string, file: string, msg: string, author: string, from?: string) => {
    mark++;
    const at = `${1700000000 + mark} +0000`;
    const parent = from ? git(dir, ['rev-parse', from]) : '';
    const stream = `commit refs/heads/${branch}\nmark :${mark}\nauthor ${author} ${at}\ncommitter Porter <${self}> ${at}\ndata ${Buffer.byteLength(msg)}\n${msg}\n`
      + (parent ? `from ${parent}\n` : '') + `M 100644 inline ${file}\ndata ${Buffer.byteLength(msg) + 1}\n${msg}\n\n`;
    git(dir, ['fast-import', '--quiet', '--date-format=raw', '--force'], stream);
  };
  commit('main', 'a.txt', 'seed', `Porter <${self}>`);
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  commit('port/contrib', 'b.txt', 'contributor fix', 'Ada Contributor <Ada@Example.org>', 'refs/heads/main');
  commit('port/contrib', 'c.txt', 'second contributor', 'Bo Helper <bo@example.org>', 'refs/heads/port/contrib');
  commit('port/contrib', 'd.txt', 'ada again', 'Ada Contributor <ada@example.org>', 'refs/heads/port/contrib');
  commit('port/contrib', 'e.txt', 'porter follow-up', `Porter <${self}>`, 'refs/heads/port/contrib');
  git(dir, ['checkout', '-q', 'port/contrib']);
  return dir;
}
const run = (cwd: string, args: string[]) => runScriptSync(BIN, args, { cwd, env: ENV, encoding: 'utf8', timeout: 60_000 });

test('the default range is origin/HEAD..HEAD; authors print once each in first-appearance order without the porter', () => {
  const dir = repo();
  expect(git(dir, ['log', '--format=%ae', 'origin/main..HEAD']).split('\n')).toHaveLength(4);
  const r = run(dir, []);
  expect(r.status).toBe(EXIT.ok);
  expect(r.stdout).toBe('Co-authored-by: Ada Contributor <Ada@Example.org>\nCo-authored-by: Bo Helper <bo@example.org>\n');
  expect(r.stderr.trim()).toBe('COAUTHORS: 2 in origin/main..HEAD');
  const json = JSON.parse(run(dir, ['--json', '--exclude', 'BO@example.org']).stdout);
  expect(json.trailers).toEqual(['Co-authored-by: Ada Contributor <Ada@Example.org>']);
  expect(run(dir, ['HEAD~1..HEAD']).stdout).toBe('');
});

test('--message appends only the missing trailers and is idempotent; a bad range exits 1 and a bad flag 2', () => {
  const dir = repo();
  const file = path.join(dir, 'MSG');
  fs.writeFileSync(file, 'port: contributor fix\n\nCo-authored-by: ada contributor <ADA@example.org>\n');
  expect(run(dir, ['--message', file]).status).toBe(EXIT.ok);
  const expected = 'port: contributor fix\n\nCo-authored-by: ada contributor <ADA@example.org>\nCo-authored-by: Bo Helper <bo@example.org>\n';
  expect(fs.readFileSync(file, 'utf8')).toBe(expected);
  expect(spawnSync('git', ['interpret-trailers', '--parse'], { cwd: dir, input: expected, encoding: 'utf8', timeout: 30_000 }).stdout.trim().split('\n')).toHaveLength(2);
  const plain = path.join(dir, 'PLAIN');
  fs.writeFileSync(plain, 'port: contributor fix\n');
  expect(run(dir, ['--message', plain]).status).toBe(EXIT.ok);
  expect(fs.readFileSync(plain, 'utf8')).toBe('port: contributor fix\n\nCo-authored-by: Ada Contributor <Ada@Example.org>\nCo-authored-by: Bo Helper <bo@example.org>\n');
  const crlf = path.join(dir, 'CRLF');
  fs.writeFileSync(crlf, 'port: contributor fix\r\n\r\nCo-authored-by: ada contributor <ADA@example.org>\r\n# comment\r\n');
  expect(run(dir, ['--message', crlf]).status).toBe(EXIT.ok);
  const parsed = spawnSync('git', ['interpret-trailers', '--parse', crlf], { cwd: dir, encoding: 'utf8', timeout: 30_000 }).stdout;
  expect(parsed).toContain('ada contributor');
  expect(parsed).toContain('Bo Helper');
  expect(fs.readFileSync(crlf, 'utf8')).toMatch(/Co-authored-by: Bo Helper <bo@example.org>\r?\n# comment/);
  const again = run(dir, ['--message', file, '--json']);
  expect(JSON.parse(again.stdout).appended).toEqual([]);
  expect(fs.readFileSync(file, 'utf8')).toBe(expected);
  expect(run(dir, ['nope..HEAD']).status).toBe(EXIT.fail);
  expect(run(dir, ['--bogus']).status).toBe(EXIT.usage);
});

test('--base takes a bare branch, an origin ref or a sha; a slash-named default branch still resolves through origin/; a leading dash is refused', () => {
  const dir = repo();
  const sha = git(dir, ['rev-parse', 'origin/main']);
  for (const base of ['main', 'origin/main', sha]) {
    const r = run(dir, ['--base', base]);
    expect(r.status, base).toBe(EXIT.ok);
    expect(r.stdout, base).toBe('Co-authored-by: Ada Contributor <Ada@Example.org>\nCo-authored-by: Bo Helper <bo@example.org>\n');
  }
  expect(run(dir, ['--base', 'main']).stderr.trim()).toBe('COAUTHORS: 2 in origin/main..HEAD');
  git(dir, ['update-ref', 'refs/remotes/origin/release/1.2', 'refs/remotes/origin/main']);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/1.2']);
  const slash = run(dir, []);
  expect(slash.status).toBe(EXIT.ok);
  expect(slash.stderr.trim()).toBe('COAUTHORS: 2 in origin/release/1.2..HEAD');
  const dash = run(dir, ['--base', '--output=/dev/null']);
  expect(dash.status).toBe(EXIT.usage);
  expect(dash.stderr).toContain('cannot start with -');
});
