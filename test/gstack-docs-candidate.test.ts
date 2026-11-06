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
  git(dir, 'config', 'maintenance.auto', 'false'); git(dir, 'config', 'gc.auto', '0');
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
    const before = fs.readdirSync(gitDir, { recursive: true }) as string[];
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
    const after = fs.readdirSync(gitDir, { recursive: true }) as string[];
    const changed = [...before.filter(entry => !after.includes(entry)).map(entry => `-${entry}`), ...after.filter(entry => !before.includes(entry)).map(entry => `+${entry}`)];
    expect(after.length, `.git entries changed during snapshot: ${changed.join(', ') || '(same names)'}`).toBe(before.length);
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

  // Value: protects=--docs takes a comma-separated list as well as repeated flags, a path that exists is taken whole even with a space or a comma in it, and a space-separated list is refused instead of recorded as one missing path; fails_when=--docs "a, b" records one path "a, b" (gstack-evals#191 /ship), a single path or an existing spaced path stops working, or "a b" is silently recorded;
  //   why_new=each --docs value was one path; seam=gstack-docs-candidate snapshot; no_claim=--select, which still takes one path per flag
  test('--docs splits a comma-separated list; an existing path is taken whole; a space-separated list is refused', () => {
    const { dir, root, record } = repo();
    fs.writeFileSync(path.join(dir, 'my notes.md'), 'n\n');
    fs.writeFileSync(path.join(dir, 'a,b.md'), 'c\n');
    const docs = (...values: string[]) => {
      const r = run(dir, 'snapshot', '--out', record, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', ...values.flatMap(v => ['--docs', v]));
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(fs.readFileSync(record, 'utf8')).docs;
    };
    expect(docs('handbook')).toEqual(['handbook/guide.md']);
    expect(docs('handbook, app.ts')).toEqual(['app.ts', 'handbook/guide.md']);
    expect(docs('handbook,app.ts,', 'my notes.md')).toEqual(['app.ts', 'handbook/guide.md', 'my notes.md']);
    expect(docs('a,b.md')).toEqual(['a,b.md']);
    fs.rmSync(record);
    const spaced = run(dir, 'snapshot', '--out', record, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'handbook app.ts');
    expect([spaced.status, spaced.stderr.trim()]).toEqual([1, 'gstack-docs-candidate: --docs "handbook app.ts" names no file or directory and holds whitespace: repeat --docs for each path, or separate paths with commas']);
    expect(fs.existsSync(record)).toBe(false);
    for (const empty of ['', ' ', ',']) {
      const r = run(dir, 'snapshot', '--out', record, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', empty);
      expect([r.status, r.stderr.trim()]).toEqual([1, `gstack-docs-candidate: --docs ${JSON.stringify(empty)} names no path: give a file or directory, repeat --docs for each path, or separate paths with commas`]);
      expect(fs.existsSync(record)).toBe(false);
    }
    expect(fs.readdirSync(root)).toEqual(['repo']);
  });

  test('--help prints the usage it names in its errors', () => {
    const { dir } = repo();
    const help = run(dir, '--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('gstack-docs-candidate snapshot --out <candidate.json>');
    expect(help.stdout).toContain('gstack-docs-candidate compare <candidate.json>');
    expect(run(dir, 'install').stderr).toContain(help.stdout.trim());
  });

  // PR gate run 38990111230 (ship-docsync-stale-after): an agent needing the post-child snapshot ran
  // `gstack-docs-candidate snapshot --help`, which exited 1 as an unknown argument.
  test('snapshot --help and compare --help print the usage and exit 0 before any side effect', () => {
    const { dir, root } = repo();
    const before = fs.readdirSync(root, { recursive: true }).sort();
    const usage = run(dir, '--help').stdout;
    for (const command of ['snapshot', 'compare']) {
      const help = run(dir, command, '--help');
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toBe(usage);
    }
    for (const args of [['snapshot', '--help', '--out', path.join(root, 'x.json')], ['compare', '--help', path.join(root, 'x.json')],
      ['snapshot', '--out', path.join(root, 'y.json'), '--help'], ['compare', '-h']]) {
      const result = run(dir, ...args);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stdout).toBe('');
    }
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  test('compare names the record path, each missing or wrong field and the snapshot fix, keeping exit 1', () => {
    const { dir, root } = repo();
    // A post-audit snapshot over the candidate would replace the before-audit baseline, so the ownership
    // check would compare current files with themselves; the fix line must never send an agent there.
    const fix = 'Fix: the candidate must be the record the Prepare snapshot wrote. To rebuild it, rerun the Prepare snapshot (gstack-docs-candidate snapshot --out <path> --audit-id <id> --mode edit --base <rev> ...) only before dispatching the child audit. After the audit, never snapshot over it: the post-child snapshot uses a different --out (<audit-id>-post.json).';
    const cases: Array<[string, string, string[]]> = [
      ['legacy.json', JSON.stringify({ audit_id: 'a', base_sha: 'x', content_hashes: {} }),
        ['missing or wrong schema_version (want 1)', 'missing or wrong base (want the base commit SHA string)', 'missing or wrong hashes (want an object of path -> blob id)']],
      ['null-hashes.json', JSON.stringify({ schema_version: 1, base: 'x', hashes: null }), ['missing or wrong hashes (want an object of path -> blob id)']],
      ['version.json', JSON.stringify({ schema_version: 2, base: 'x', hashes: {} }), ['missing or wrong schema_version (want 1)']],
      ['array.json', '[]', ['not a JSON object']],
      ['broken.json', '{', ['not valid JSON']],
    ];
    for (const [name, body, problems] of cases) {
      const file = path.join(root, name);
      fs.writeFileSync(file, body);
      const result = run(dir, 'compare', file);
      expect(result.status, name).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe(`gstack-docs-candidate: ${file} is not a gstack-docs-candidate record: ${problems.join('; ')}. ${fix}`);
    }
  });

  // Value: protects=a post snapshot records the files its audit edited (before and after) and carries only this run's earlier
  //   audits, so receipt write can reset every file one /ship run's audits edited (GST-1616); fails_when=--pre records untouched
  //   files or misses an added one, or --carry accepts a snapshot without --pre/--run or without edited; why_new=GST-1616;
  //   seam=gstack-docs-candidate snapshot; no_claim=the receipt binding (test/review-exclude.test.ts)
  test('--pre records the audit\'s edits; --carry needs --pre, --run and an earlier post snapshot that recorded them', () => {
    const { dir, root } = repo();
    const args = (id: string, out: string, ...extra: string[]) => ['snapshot', '--out', path.join(root, out), '--audit-id', id, '--mode', 'edit', '--base', 'main', '--docs', 'handbook', '--run', 'r1', ...extra];
    expect(run(dir, ...args('a1', 'a1.json')).status).toBe(0);
    fs.writeFileSync(path.join(dir, 'handbook', 'new.md'), '# New\n');
    expect(run(dir, ...args('a1', 'a1-plain.json')).status).toBe(0);
    const post = run(dir, ...args('a1', 'a1-post.json', '--pre', path.join(root, 'a1.json')));
    expect(post.status, post.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'a1-post.json'), 'utf8'))).toMatchObject({ run_id: 'r1', edited: { 'handbook/new.md': { before: null, after: git(dir, 'hash-object', 'handbook/new.md') } } });
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'a1-post.json'), 'utf8')).edited)).toEqual(['handbook/new.md']);
    const refused = (extra: string[], why: string) => {
      const r = run(dir, ...args('a2', 'a2-post.json', ...extra));
      expect({ status: r.status, written: fs.existsSync(path.join(root, 'a2-post.json')) }).toEqual({ status: 1, written: false });
      expect(r.stderr).toContain(why);
    };
    expect(run(dir, ...args('a2', 'a2.json')).status).toBe(0);
    refused(['--carry', path.join(root, 'a1-post.json')], '--carry needs --pre and --run');
    refused(['--pre', path.join(root, 'a2.json'), '--carry', path.join(root, 'a1-plain.json')], 'names no edited files');
    // Value: protects=snapshot refuses a carry of this same audit, a carry whose HEAD is not an ancestor, another audit's --pre and a
    //   repeated or empty --run/--pre/--carry; fails_when=one of those guards in carried(), auditEdits() or optional() is dropped;
    //   why_new=only the missing --pre/--run and missing edited refusals were covered; seam=none; no_claim=the receipt binding
    const orphan = git(dir, 'commit-tree', '-m', 'orphan', git(dir, 'hash-object', '-t', 'tree', '-w', '/dev/null'));
    const forged = path.join(root, 'a1-orphan.json');
    fs.writeFileSync(forged, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, 'a1-post.json'), 'utf8')), head: orphan }));
    refused(['--pre', path.join(root, 'a2.json'), '--carry', forged], 'is not an ancestor of HEAD');
    refused(['--pre', path.join(root, 'a1.json')], 'is not this audit\'s Prepare snapshot');
    refused(['--run', 'r1'], '--run is allowed once');
    refused(['--pre', ' '], '--pre must be a non-empty one-line value');
    refused(['--pre', path.join(root, 'a2.json'), '--carry', path.join(root, 'a1-post.json'), '--carry', path.join(root, 'a1-post.json')], '--carry is allowed once');
    const self = run(dir, ...args('a1', 'a1-self.json', '--pre', path.join(root, 'a1.json'), '--carry', path.join(root, 'a1-post.json')));
    expect({ status: self.status, written: fs.existsSync(path.join(root, 'a1-self.json')) }).toEqual({ status: 1, written: false });
    expect(self.stderr).toContain('is this audit (a1), not an earlier one');
  });

  // Value: protects=a third audit's post snapshot carries the whole chain oldest first (the carried snapshot's earlier[] prepended);
  //   fails_when=carried() keeps only the directly carried audit or reorders the chain; why_new=no test carried more than one audit;
  //   seam=none; no_claim=the receipt reset over three audits (test/review-exclude.test.ts)
  test('--carry of a post snapshot that itself carried an audit records the whole chain, oldest first', () => {
    const { dir, root } = repo();
    const audit = (id: string, file: string, carry?: string) => {
      const args = ['snapshot', '--audit-id', id, '--mode', 'edit', '--base', 'main', '--docs', 'handbook', '--run', 'r1'];
      expect(run(dir, ...args, '--out', path.join(root, `${id}.json`)).status).toBe(0);
      fs.writeFileSync(path.join(dir, 'handbook', file), `# ${id}\n`);
      const post = run(dir, ...args, '--out', path.join(root, `${id}-post.json`), '--pre', path.join(root, `${id}.json`), ...(carry ? ['--carry', path.join(root, carry)] : []));
      expect(post.status, post.stderr).toBe(0);
      return JSON.parse(fs.readFileSync(path.join(root, `${id}-post.json`), 'utf8'));
    };
    audit('a1', 'one.md');
    audit('a2', 'two.md', 'a1-post.json');
    const third = audit('a3', 'three.md', 'a2-post.json');
    expect(third.earlier.map((e: { audit_id: string; run_id: string }) => [e.audit_id, e.run_id])).toEqual([['a1', 'r1'], ['a2', 'r1']]);
    expect(Object.keys(third.earlier[0].edited)).toEqual(['handbook/one.md']);
    expect(Object.keys(third.earlier[1].edited)).toEqual(['handbook/two.md']);
  });

  test('/ship records post-child hashes with the helper, so Step 16 compares instead of retyping', () => {
    // ci-37198445662 gate-census-2: ship-docsync-completion/-store parents spent 45-78 s of model time
    // retyping hash maps, child output and records into several artifacts after the child returned.
    const gate = fs.readFileSync(path.resolve(import.meta.dir, '..', 'ship/sections/documentation.md.tmpl'), 'utf8').replace(/\s+/g, ' ');
    expect(gate).toContain('post-child hashes (rerun the Prepare `snapshot` with only `--out <audit-id>-post.json` changed and `--pre <its Prepare snapshot>` added, plus `--carry <this run\'s earlier audit\'s -post.json>` on a re-audit so receipt write resets both audits\' files; Step 16 `compare`s it; never type hashes)');
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
