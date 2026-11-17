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
import { parseAddedLineNumbers, parseAddedLines, secretsCheck } from '../lib/pregate/checks/secrets';
import type { PregateContext } from '../lib/pregate/types';
import { cleanup, commit, makeFixtureRepo, runBin, BASE_PREGATE, type FixtureRepo } from './helpers/pregate-fixture';

const PREGATE = path.resolve(import.meta.dir, '..', 'bin', 'gstack-pregate');
const AWS = 'AKIA' + 'ZQ3XN7P2LM4RT8WV';
const PAT = ['ghp', 'Zq8Lm2Xv7Nc4Rt9Wy1Kp6Hd3Fs5Gb0Jx8Ue2'].join('_');
const utf16 = (text: string, bigEndian = false) => { const le = Buffer.from(`\uFEFF${text}`, 'utf16le'); return bigEndian ? le.swap16() : le; };
/** Every file this checkout stores as binary (PNG, JPEG, GIF, ICNS): real assets, not synthetic noise. */
const BINARY_ASSETS = spawnSync('git', ['ls-files', '--eol'], { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: 30_000 }).stdout.split('\n').filter(l => l.startsWith('i/-text')).map(l => l.split('\t').pop()!);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function repo(files: Record<string, string | Buffer>) {
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
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  git('add', '.');
  git('commit', '-qm', 'feat');
  const secrets = () => {
    const r = spawnSync(PREGATE, ['--base', 'main', '--only', 'secrets', '--json'], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
    const check = JSON.parse(r.stdout).checks.find((c: { id: string }) => c.id === 'secrets');
    return { status: check.status as string, detail: check.detail as string, lines: (check.lines ?? []) as string[] };
  };
  return { root, dir, git, env, secrets };
}

describe('pregate secrets: source context and diff integrity', () => {
  // Value: protects=a large added diff (a binary read with --text) parses in linear time; fails_when=each added line copies the file's earlier lines; why_new=GST-2195 review; seam=pure parser; no_claim=git's own speed
  test('parseAddedLines reads 200,000 added lines in one file quickly (GST-2195)', () => {
    const diff = 'diff --git a/big.bin b/big.bin\n+++ b/big.bin\n@@ -0,0 +1,200000 @@\n' + '+x\n'.repeat(200_000);
    const started = performance.now();
    expect(parseAddedLines(diff).get('big.bin')?.length).toBe(200_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('parseAddedLines groups by file and keeps a "+++" content line inside a hunk', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1,2 @@', '+one', '+++two', 'diff --git a/b.env b/b.env', '--- /dev/null', '+++ b/b.env', '@@ -0,0 +1 @@', '+three'].join('\n');
    expect([...parseAddedLines(diff)]).toEqual([['a.ts', ['one', '++two']], ['b.env', ['three']]]);
  });

  test('a Python call that reads key.json is code; the same key name holding a literal key still fails (GST-1064)', () => {
    expect(repo({ 'attach.py': 'import json\nkey = json.loads(files.get("key.json", ""))\n' }).secrets().status).toBe('pass');
    const fake = 'Zx9Q' + 'w8Er7Ty6Ui5Op4As3Df2';
    const r = repo({ 'attach.py': `key = json.loads(files.get("key.json")) or "${fake}"\n`, '.env': `KEY=${fake}\n` }).secrets();
    expect(r.status).toBe('fail');
    expect(r.lines.join('\n')).toContain('attach.py');
    expect(r.lines.join('\n')).toContain('.env');
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

  // Value: protects=pregate's secrets check reads a four-part version written to a VERSION file, or the file itself, as a version, and lists a
  //   LOW privacy finding as a warning that never fails or warns the check, while a public IP with no version context still warns and a key
  //   still fails (GST-2047); fails_when=gstack-evals' pv-sdk.ts VERSION write warns as pii.ip_public, a home path turns the check warn or fail,
  //   or 8.8.8.8 and AKIA keys stop reporting; why_new=the engine tables test the scanner, not the check's status; seam=fixture repo; no_claim=CI
  test('a version beside a VERSION file passes and a home path only warns; a bare public IP still warns and a key still fails (GST-2047)', () => {
    expect(repo({ 'pv-sdk.ts': 'fs.writeFileSync(path.join(dir, "VERSION"), "1.98.0.0\\n");\n', VERSION: '1.98.0.0\n' }).secrets()).toMatchObject({ status: 'pass', lines: [] });
    const low = repo({ 'notes.md': 'logs are under /home/garry/work/run.log\n' }).secrets();
    expect([low.status, low.detail]).toEqual(['pass', expect.stringContaining('(1 WARN)')]);
    const ip = repo({ 'dns.ts': 'const resolver = "8.8.8.8";\n' }).secrets();
    expect([ip.status, ip.lines.join('\n')]).toEqual(['warn', expect.stringContaining('pii.ip_public')]);
    expect(repo({ 'notes.md': `logs are under /home/garry/work/run.log\nkey ${AWS}\n` }).secrets().status).toBe('fail');
  });

  // Value: protects=a Django test that adds `session = self.client.session` passes the never-downgradable secrets check while the same line in a string or an env file still fails it;
  //   fails_when=the #4209 false positive returns, or the exemption reaches a """ block or a .env value; why_new=#4209 stopped /ship for Python users; seam=fixture repo; no_claim=Dart files at the pregate level
  test('a Django test client session read passes; the same line in a string or a .env file still fails (#4209)', () => {
    const base = 'from django.test import TestCase\n\n\nclass ViewTests(TestCase):\n    def test_index(self):\n        self.client.get("/")\n';
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'tests/test_views.py': base } });
    try {
      const secrets = () => JSON.parse(runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']).out).checks.find((c: { id: string }) => c.id === 'secrets');
      const added = base + '        session = self.client.session\n        session["cart"] = [1]\n        session.save()\n';
      commit(fx, { 'tests/test_views.py': added });
      expect(secrets().status).toBe('pass');
      commit(fx, { 'tests/test_views.py': added + '\nFIXTURE = """\n        session = self.client.session\n"""\n', '.env': 'SESSION=self.client.session\n' });
      const check = secrets();
      expect({ status: check.status, rows: (check.lines as string[]).filter((l) => l.includes('env.kv')) }).toEqual({ status: 'fail', rows: [expect.stringContaining('.env, added line 1)'), expect.stringContaining('test_views.py, line 12)')] });
    } finally { cleanup(fx); }
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

  test('a Python file whose working copy no longer holds the diff\'s added lines is scanned as git diffed it (#3630, GST-738)', () => {
    const token = 'Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJx';
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'app.py': 'x = 1\n' } });
    try {
      commit(fx, { 'app.py': `x = 1\nAPI_TOKEN = "${token}"\n` });
      fx.git('update-index', '--assume-unchanged', 'app.py');
      fs.writeFileSync(path.join(fx.work, 'app.py'), 'x = 1\ny = 2\n');
      const check = JSON.parse(runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']).out).checks.find((c: { id: string }) => c.id === 'secrets');
      expect({ status: check.status, kv: (check.lines as string[]).some((l) => l.includes('env.kv') && l.includes('app.py, line 2')) }).toEqual({ status: 'fail', kv: true });
    } finally { cleanup(fx); }
  });

  // Value: protects=the Python/Dart exemption reads the text git diffed, never a working copy that differs from it; fails_when=a committed credential inside a """ block passes because the working copy's other lines were edited under assume-unchanged;
  //   why_new=GST-738: the added lines matched, so the edited delimiters around them were trusted; seam=git diff; no_claim=a file edited after the scan
  test('a committed credential in a Python string still fails when the working copy rewrites the lines around it (GST-738)', () => {
    const token = 'Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJx';
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'app.py': 'x = 1\nCONFIG = """\n"""\n' } });
    try {
      commit(fx, { 'app.py': `x = 1\nCONFIG = """\npassword: ${token}\n"""\n` });
      fx.git('update-index', '--assume-unchanged', 'app.py');
      fs.writeFileSync(path.join(fx.work, 'app.py'), `x = 1\nCONFIG = 1  #\npassword: ${token}\n#\n`);
      const check = JSON.parse(runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']).out).checks.find((c: { id: string }) => c.id === 'secrets');
      expect({ status: check.status, kv: ((check.lines ?? []) as string[]).some((l) => l.includes('env.kv') && l.includes('app.py')) }).toEqual({ status: 'fail', kv: true });
    } finally { cleanup(fx); }
  });

  test('diff.suppressBlankEmpty does not shift the diffed Python text (GST-738)', () => {
    const fx: FixtureRepo = makeFixtureRepo({ pregate: BASE_PREGATE, baseFiles: { 'app.py': 'x = 1\n\ny = 2\n' } });
    try {
      commit(fx, { 'app.py': 'x = 1\n\ny = 2\nrows = {\n    "password": session.password,\n}\n' });
      fx.git('config', 'diff.suppressBlankEmpty', 'true');
      const check = JSON.parse(runBin(fx, 'gstack-pregate', ['--base', 'main', '--only', 'secrets', '--json']).out).checks.find((c: { id: string }) => c.id === 'secrets');
      expect(check.status).toBe('pass');
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

  test('a test file reading an env var in code and holding a self-named fixture label passes; a literal beside the read or in a .env file still fails (GST-1894)', () => {
    const token = '8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ';
    const qm = 'let token: string | undefined;\nfunction start(opts?: { env?: Record<string, string> }) {\n    token = opts?.env?.AGENT_API_TOKEN;\n}\nconst brain = {\n      clientSecret: "personal-secret",\n};\n';
    expect(repo({ 'memory-registry-pg.test.ts': qm }).secrets().status).toBe('pass');
    const r = repo({ 'memory-registry-pg.test.ts': qm.replace('AGENT_API_TOKEN;', `AGENT_API_TOKEN ?? "${token}";`), 'agent.env': `AGENT_API_TOKEN=${token}\n` }).secrets();
    expect(r.status).toBe('fail');
    const kv = r.lines.filter((l) => l.includes('env.kv'));
    expect(kv).toHaveLength(2);
    expect(kv).toEqual(expect.arrayContaining([expect.stringContaining('agent.env, added line 1'), expect.stringContaining('memory-registry-pg.test.ts, added line 3')]));
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

  // Value: protects=a token in a file git calls binary fails the never-downgradable secrets check like the same token in plain text;
  //   fails_when=a NUL byte, a -diff line the branch itself adds to .gitattributes, or UTF-16 text passes the check unscanned; why_new=GSTA-461 item 5 reached GitHub with both guards green; seam=fixture repo; no_claim=UTF-16 outside the ASCII range
  test('a token in a file git calls binary fails like plain text: a NUL byte, a -diff attribute the branch adds, UTF-16LE and UTF-16BE (GST-2195)', () => {
    const r = repo({ 'plain.txt': `token ${PAT}\n`, 'nul.txt': `\0token ${PAT}\n`, '.gitattributes': '*.jsonl -diff\n', 'out.jsonl': `{"token":"${PAT}"}\n`, 'le.txt': utf16(`token ${PAT}\r\n`), 'be.txt': utf16(`token ${PAT}\n`, true) }).secrets();
    expect(r.status).toBe('fail');
    for (const file of ['plain.txt', 'nul.txt', 'out.jsonl', 'le.txt', 'be.txt']) expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^HIGH github\\.pat .*\\(${file.replace('.', '\\.')}, added line 1\\)$`)));
  });

  // Value: protects=a token in UTF-16 text that is mostly outside the ASCII range is still found; fails_when=Cyrillic or CJK text around the token makes its NUL bytes read as spaces;
  //   why_new=GST-2195 review: localized UTF-16 files (Localizable.strings, .rc) passed the check; seam=fixture repo; no_claim=UTF-32
  test('a token in UTF-16 text that is mostly Cyrillic or CJK fails like plain text (GST-2195)', () => {
    const ru = Array(8).fill('Привет мир, это файл настроек').join('\r\n');
    const zh = Array(8).fill('这是一个本地化的字符串文件内容').join('\r\n');
    const r = repo({ 'ru.strings': utf16(`${ru}\r\ntoken ${PAT}\r\n`), 'zh.strings': utf16(`${zh}\r\ntoken ${PAT}\r\n`), 'zh-be.strings': utf16(`${zh}\ntoken ${PAT}\n`, true) }).secrets();
    expect(r.status).toBe('fail');
    for (const file of ['ru.strings', 'zh.strings', 'zh-be.strings']) expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^HIGH github\\.pat .*\\(${file.replace('.', '\\.')}, added line 9\\)$`)));
  });

  // Value: protects=a keyword and its value on the next line of UTF-16 text fail like the same pair in plain text; fails_when=the readings of a binary file share one line, so the keyword line ends with another reading and the next-line rule loses it;
  //   why_new=GSTA-474: an AWS secret key under its YAML key passed in UTF-16LE (#4243 advisory note 1); seam=fixture repo; no_claim=UTF-32
  test('an AWS secret key on the line under its keyword fails in UTF-16LE and UTF-16BE like plain text (GST-2261)', () => {
    const pair = `aws_secret_access_key:\n  ${['Zq3Xn7P2Lm4Rt8Wv', 'Bc5Df6Gh7Jk8Lm9Np0Qr1St2'].join('')}\n`;
    const r = repo({ 'plain.yml': pair, 'le.yml': utf16(pair), 'be.yml': utf16(pair, true) }).secrets();
    expect(r.status).toBe('fail');
    for (const file of ['plain.yml', 'le.yml', 'be.yml']) expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^HIGH aws\\.secret_key .*\\(${file.replace('.', '\\.')}, added line \\d\\)$`)));
  });

  // Value: protects=a plain token in a binary file that also holds UTF-16 text is listed once; fails_when=each reading of the file reports the same finding again;
  //   why_new=GST-2261 review (testing specialist): a mixed binary listed one token three times; seam=fixture repo; no_claim=a UTF-16 token found at different columns in both byte orders
  test('a plain token in a binary file that also holds UTF-16 text is listed once (GST-2261)', () => {
    const r = repo({ 'mixed.bin': Buffer.concat([Buffer.from(`token ${PAT}\n`), utf16('hello world\n')]) }).secrets();
    expect(r.status).toBe('fail');
    expect(r.lines.filter(l => /github\.pat .*mixed\.bin/.test(l))).toHaveLength(1);
  });

  // Value: protects=a credential whose keyword and value sit in different readings of one binary line still fails, as on main; fails_when=the readings are only scanned apart;
  //   why_new=GST-2261 cross-family audit: a plain-byte key before its UTF-16LE keyword passed once the combined reading was dropped; seam=fixture repo; no_claim=UTF-32
  test('a plain-byte AWS key before its UTF-16LE keyword on one line fails like main (GST-2261)', () => {
    const mixed = Buffer.concat([Buffer.from(`\0x\0${['Zq3Xn7P2Lm4Rt8Wv', 'Bc5Df6Gh7Jk8Lm9Np0Qr1St2'].join('')}\0y\0 `, 'latin1'), Buffer.from('aws_secret_access_key:', 'utf16le'), Buffer.from('\n')]);
    const r = repo({ 'mixed.bin': mixed }).secrets();
    expect(r.status).toBe('fail');
    expect(r.lines).toContainEqual(expect.stringMatching(/^HIGH aws\.secret_key .*\(mixed\.bin, added line 1\)$/));
  });

  // Value: protects=a UTF-16 token right beside a CJK character is found, and so is a plain token beside a run of character-and-NUL pairs; fails_when=the CJK character's bytes glue onto the token, or padding the run cuts the plain token;
  //   why_new=GST-2195 review (outside voice): U+4E2D before a token read as "-N" glued to it; seam=fixture repo; no_claim=UTF-32
  test('a token right beside a CJK character in UTF-16, or beside a NUL run in binary content, fails like plain text (GST-2195)', () => {
    const r = repo({ 'le.strings': utf16(`中${PAT}中文\r\n`), 'be.strings': utf16(`中${PAT}中文\n`, true), 'run.bin': Buffer.from(`\x89\0\0\x01${PAT}\0x\0y\0z\0\n`, 'latin1') }).secrets();
    expect(r.status).toBe('fail');
    for (const file of ['le.strings', 'be.strings', 'run.bin']) expect(r.lines).toContainEqual(expect.stringMatching(new RegExp(`^HIGH github\\.pat .*\\(${file.replace('.', '\\.')}, added line 1\\)$`)));
  });

  // Value: protects=a plain token in binary content stays whole when a NUL-flanked byte sits beside it; fails_when=reading the bytes as UTF-16 glues that byte to the token or cuts its edge character off;
  //   why_new=GST-2195 review: the UTF-16 reading hid tokens the plain reading found; seam=fixture repo; no_claim=tokens split by a NUL inside them
  test.each([
    ['a NUL terminator, then a little-endian integer', PAT + '\0' + '1\0\0\0'],
    ['a one-character string after it', '\0' + PAT + '\0x\0'],
    ['a one-character string before it', '\0x\0' + PAT + '\0'],
    ['a uint16 length before it', '\0\0' + '4\0' + PAT],
    ['UTF-16 runs on both sides', 'A\0B\0' + PAT + '\0C\0D\0'],
  ])('a token in binary content beside %s fails like plain text (GST-2195)', (_, body) => {
    const r = repo({ 'blob.bin': Buffer.concat([Buffer.from([0x89, 0, 0, 1]), Buffer.from(body, 'latin1')]) }).secrets();
    expect(r.status).toBe('fail');
    expect(r.lines).toContainEqual(expect.stringMatching(/^HIGH github\.pat .*\(blob\.bin, added line 1\)$/));
  });

  // Value: protects=reading binary files does not turn real images into findings; fails_when=a PNG, JPEG, GIF or ICNS from this repo warns or fails the check;
  //   why_new=GST-2195 scans binary content that was skipped before; seam=fixture repo; no_claim=compiled executables (the repo stores none)
  test('the real binary assets this repo stores add no finding, and the pass names how many files it read (GST-2195)', () => {
    expect(BINARY_ASSETS.length).toBeGreaterThanOrEqual(10);
    const root = path.resolve(import.meta.dir, '..');
    const r = repo(Object.fromEntries(BINARY_ASSETS.map(rel => [rel, fs.readFileSync(path.join(root, rel))]))).secrets();
    expect({ status: r.status, lines: r.lines }).toEqual({ status: 'pass', lines: [] });
    expect(r.detail).toContain(`in ${BINARY_ASSETS.length} files (${BINARY_ASSETS.length} binary)`);
  });

  // Value: protects=a diff git could not produce in full never reads as a clean scan; fails_when=a failed, killed or truncated merge-base diff passes as "no added lines";
  //   why_new=the pre-push hook fails closed here (#1946) and pregate did not; seam=check run on a real repo with an unreadable merge base; no_claim=the 60 s timeout itself
  test('a merge-base diff git could not finish is PREGATE_ENVIRONMENT, never a clean scan (GST-2195)', async () => {
    const f = repo({ 'a.txt': `token ${PAT}\n` });
    const scratch = path.join(f.root, 'scratch');
    fs.mkdirSync(scratch);
    const ctx = { repoRoot: f.dir, mergeBase: '0'.repeat(40), wtree: 'w', head: 'h', baseRef: 'origin/main', baseSha: '0'.repeat(40), touched: [], config: { allowlist: [] }, scratch, timeoutMs: 60_000, env: f.env } as unknown as PregateContext;
    const check = await secretsCheck.run(ctx);
    expect({ status: check.status, code: check.code }).toEqual({ status: 'incomplete', code: 'PREGATE_ENVIRONMENT' });
    expect(check.detail).toContain('git diff');
  });
});
