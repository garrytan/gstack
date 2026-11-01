/**
 * pregate `secrets` scans each file's added lines with that file's type (#3211)
 * and never reads an empty or rewritten diff as clean: a `+++` content line
 * inside a hunk is scanned, and diff.external / textconv drivers are ignored.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseAddedLineNumbers, parseAddedLines } from '../lib/pregate/checks/secrets';
import { cleanup, commit, makeFixtureRepo, runBin, BASE_PREGATE, type FixtureRepo } from './helpers/pregate-fixture';

const PREGATE = path.resolve(import.meta.dir, '..', 'bin', 'gstack-pregate');
const AWS = 'AKIA' + 'ZQ3XN7P2LM4RT8WV';
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function repo(files: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pregate-secrets-')));
  roots.push(root);
  const dir = path.join(root, 'work');
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  fs.mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(dir, 'README'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('init', '-q', '--bare', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('checkout', '-qb', 'feat');
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
  git('add', '.');
  git('commit', '-qm', 'feat');
  const secrets = () => {
    const r = spawnSync(PREGATE, ['--base', 'main', '--only', 'secrets', '--json'], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
    const check = JSON.parse(r.stdout).checks.find((c: { id: string }) => c.id === 'secrets');
    return { status: check.status as string, detail: check.detail as string, lines: (check.lines ?? []) as string[] };
  };
  return { dir, git, secrets };
}

describe('pregate secrets: source context and diff integrity', () => {
  test('parseAddedLines groups by file and keeps a "+++" content line inside a hunk', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1,2 @@', '+one', '+++two', 'diff --git a/b.env b/b.env', '--- /dev/null', '+++ b/b.env', '@@ -0,0 +1 @@', '+three'].join('\n');
    expect([...parseAddedLines(diff)]).toEqual([['a.ts', ['one', '++two']], ['b.env', ['three']]]);
  });

  test('a TS object property that reads a credential at runtime is code, not a secret (#3211)', () => {
    const f = repo({ 'app.ts': 'const cfg = {\n  token: credentials.token,\n  apiKey: settings.apiKey,\n};\n' });
    expect(f.secrets().status).toBe('pass');
  });

  test('a Python parameter annotation is code, not a secret; a quoted value on the same name still fails (#3630)', () => {
    expect(repo({ 'app.py': 'def fetch_days(\n    *,\n    session: HttpSession,\n    start: int,\n) -> None:\n    pass\n' }).secrets().status).toBe('pass');
    const r = repo({ 'app.py': 'SETTINGS = dict(\n    session="8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ",\n)\nCONFIG = {\n    "session": "8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ",\n}\n' }).secrets();
    expect(r.status).toBe('fail');
    expect(r.lines.join('\n')).toContain('app.py, line 5)');
  });

  test('parseAddedLineNumbers numbers each added line from its hunk header', () => {
    const diff = ['diff --git a/a.py b/a.py', '--- a/a.py', '+++ b/a.py', '@@ -3,0 +4,2 @@', '+one', '+two', '@@ -9 +11 @@', '-old', '+new'].join('\n');
    expect([...parseAddedLineNumbers(diff)]).toEqual([['a.py', [4, 5, 11]]]);
  });

  test('a line added inside an existing triple-quoted block in a Python or Dart file still fails; a separate hunk keeps its own context (#3630)', () => {
    const token = 'Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJx';
    for (const [file, open, close] of [['app.py', 'CONFIG = """', '"""'], ['lib/config.dart', "const config = '''", "''';"]] as const) {
      const base = `def fetch(\n    *,\n    start: int,\n) -> None:\n    pass\n\n${open}\nhost: db\n${close}\n`;
      const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { [file]: base } });
      try {
        commit(fx, { [file]: base.replace('    start: int,\n', '    session: HttpSession,\n    start: int,\n').replace('host: db\n', `host: db\npassword: ${token}\n`) });
        const r = runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']);
        const check = JSON.parse(r.out).checks.find((c: { id: string }) => c.id === 'secrets');
        expect({ file, status: check.status }).toEqual({ file, status: 'fail' });
        expect((check.lines as string[]).filter((l) => l.includes('env.kv'))).toEqual([expect.stringContaining(`${file}, line 10)`)]);
      } finally { cleanup(fx); }
    }
  });

  test('an untracked Python file reads annotations as code and still fails a literal, naming its line (#3630)', () => {
    const token = 'Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJx';
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'README.md': 'x\n' } });
    try {
      const secrets = () => JSON.parse(runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']).out).checks.find((c: { id: string }) => c.id === 'secrets');
      fs.writeFileSync(path.join(fx.work, 'app.py'), 'def f(\n    session: HttpSession,\n) -> None:\n    pass\n');
      expect(secrets().status).toBe('pass');
      fs.writeFileSync(path.join(fx.work, 'app.py'), `def f(\n    session: HttpSession,\n) -> None:\n    pass\n\nCONFIG = """\npassword: ${token}\n"""\n`);
      const check = secrets();
      expect({ status: check.status, rows: (check.lines as string[]).filter((l) => l.includes('env.kv')) }).toEqual({ status: 'fail', rows: [expect.stringContaining('app.py, line 7)')] });
    } finally { cleanup(fx); }
  });

  test('a Python file whose working copy no longer holds the diff\'s added lines is scanned by its added lines (#3630)', () => {
    const token = 'Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJx';
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'app.py': 'x = 1\n' } });
    try {
      commit(fx, { 'app.py': `x = 1\nAPI_TOKEN = "${token}"\n` });
      fx.git('update-index', '--assume-unchanged', 'app.py');
      fs.writeFileSync(path.join(fx.work, 'app.py'), 'x = 1\ny = 2\n');
      const check = JSON.parse(runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']).out).checks.find((c: { id: string }) => c.id === 'secrets');
      expect({ status: check.status, kv: (check.lines as string[]).some((l) => l.includes('env.kv') && l.includes('app.py, added line 1')) }).toEqual({ status: 'fail', kv: true });
    } finally { cleanup(fx); }
  });

  test('a one-line change to a Python file counts one added line (#3630)', () => {
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'app.py': 'x = 1\n'.repeat(50) } });
    try {
      commit(fx, { 'app.py': 'x = 1\n'.repeat(50) + 'y = 2\n' });
      const check = JSON.parse(runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']).out).checks.find((c: { id: string }) => c.id === 'secrets');
      expect({ status: check.status, detail: check.detail }).toEqual({ status: 'pass', detail: expect.stringMatching(/^1 added lines clean/) });
    } finally { cleanup(fx); }
  });

  test('a Python file too large to read whole has its added lines scanned without the source exemption (#3630)', () => {
    const token = 'Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJx';
    const base = `CONFIG = """\nhost: db\n"""\n${'# pad\n'.repeat(800_000)}`;
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'app.py': base } });
    try {
      commit(fx, { 'app.py': base.replace('host: db\n', `host: db\npassword: ${token}\n`) });
      const r = runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']);
      const check = JSON.parse(r.out).checks.find((c: { id: string }) => c.id === 'secrets');
      expect({ status: check.status, kv: (check.lines as string[]).some((l) => l.includes('env.kv') && l.includes('app.py')) }).toEqual({ status: 'fail', kv: true });
    } finally { cleanup(fx); }
  });

  test('the same assignment in a .env file still fails, naming the file', () => {
    const f = repo({ 'deploy.env': 'API_TOKEN=8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ\n' });
    const r = f.secrets();
    expect(r.status).toBe('fail');
    expect(r.lines.join('\n')).toContain('deploy.env, added line 1');
  });

  test('an added line whose text starts with "++" is scanned', () => {
    const f = repo({ 'notes.txt': `++aws_access_key_id = ${AWS}\n` });
    expect(f.secrets().status).toBe('fail');
  });

  test('a diff.external driver that prints nothing does not make the branch clean', () => {
    const f = repo({ 'notes.txt': `aws_access_key_id = ${AWS}\n` });
    const driver = path.join(path.dirname(f.dir), 'empty-diff.sh');
    fs.writeFileSync(driver, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    f.git('config', 'diff.external', driver);
    expect(f.secrets().status).toBe('fail');
  });
});
