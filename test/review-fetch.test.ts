/**
 * The reader fetch rule (GST-1322): the brief paragraph, the scanner over a reader's own tool calls, the base-read
 * readers policy and its path exclusion on every reader's diff. The #362 fixture is the incident's command shape with the
 * organization name replaced, commands and URLs only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FETCH_RULES, auditVerdict, fetchParagraph, forbiddenBy, loadReaders, networkTarget, scanEvents, type ToolEvent } from '../lib/review-fetch';
import { workspaceParagraph } from '../lib/review-brief';
import { READERS_KEY_VERSION, validatePolicy } from '../lib/ship-policy';
import { effectiveReaders, READERS_POLICY_DEFAULT } from '../lib/ship-policy-readers';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(import.meta.dir, 'fixtures', 'review-fetch', 'pr362-reader-events.jsonl');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const NONE: { forbid_fetch: string[]; forbid_paths: string[] } = { forbid_fetch: [], forbid_paths: [] };
const bash = (command: string): ToolEvent => ({ tool: 'capy.bash', input: { command } });
const rules = (events: ToolEvent[], r = NONE) => scanEvents(events, r, '/work/repo').map(h => [h.rule, h.severity, h.target]);

describe('fetch paragraph', () => {
  test('names every default rule and says no fetch is asked for', () => {
    const p = fetchParagraph();
    for (const r of FETCH_RULES) expect(p).toContain(r.brief);
    expect(p).toContain('This brief asks for no fetch.');
    expect(p).not.toContain('Repository note');
  });
  test('a declared policy adds its hosts, its paths and its note', () => {
    const p = fetchParagraph({ forbid_fetch: ['github.com/example-org/beam', 'huggingface.co'], forbid_paths: ['sealed/**'], brief_note: 'sealed/ is custody: never read plaintext.' });
    expect(p).toContain('forbids any access to github.com/example-org/beam, huggingface.co, web page reads included');
    expect(p).toContain('files matching `sealed/**`');
    expect(p).toContain('Repository note: sealed/ is custody: never read plaintext.');
  });
  test('every brief closes with it before the workspace paragraph', () => {
    const w = workspaceParagraph('/work/repo');
    expect(w.startsWith(fetchParagraph() + '\n\nWorkspace:')).toBe(true);
    expect(workspaceParagraph('/work/repo', { ...READERS_POLICY_DEFAULT, brief_note: 'note x' })).toContain('Repository note: note x');
  });
});

describe('scanner', () => {
  test('the #362 shape is a violation under the default rule, and a forbid_fetch hit when BEAM is declared', () => {
    const events = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map(l => JSON.parse(l) as ToolEvent);
    expect(auditVerdict(scanEvents(events, NONE, '/workspace/gbrain-evals'))).toBe('violation');
    expect(rules(events)).toEqual([['git-remote', 'violation', 'https://github.com/example-org/BEAM.git']]);
    expect(rules(events, { forbid_fetch: ['github.com/example-org/beam'], forbid_paths: [] }).map(r => r[0])).toEqual(['forbid-fetch', 'git-remote']);
  });
  test('the fixture holds tool names and inputs only, never a result or file content', () => {
    for (const l of fs.readFileSync(FIXTURE, 'utf8').trim().split('\n')) {
      const e = JSON.parse(l) as Record<string, unknown>;
      expect(Object.keys(e).sort()).toEqual(['input', 'tool']);
      expect(Object.keys(e.input as object)).toEqual(['command']);
    }
  });
  test('text that only mentions a fetch is not one', () => {
    expect(rules([
      bash('grep -rn "git clone https://github.com/a/b" lib'), bash("rg 'curl https://x.example/a.tar.gz' docs"),
      bash('cat ' + path.join(ROOT, 'lib/review-fetch.ts')), bash('git diff 1a2b3c4 -- lib && git log --oneline -5 && git show 1a2b3c4:lib/a.ts'),
      bash('git clone /tmp/fixture-repo work && git clone file:///tmp/other x'), { tool: 'web.fetch', input: { url: 'https://docs.github.com/en/rest' } },
      bash('curl -s https://bun.sh/docs/cli/test'),
    ])).toEqual([]);
  });
  test('each default rule fires on its shape, through wrappers, shells and programs', () => {
    expect(rules([
      bash('GIT_TERMINAL_PROMPT=0 timeout 60 git -C /tmp ls-remote git@github.com:o/r.git'),
      bash("bash -c 'cd /tmp && gh repo clone o/r'"), bash('gh api repos/o/r/tarball/main > r.tgz'), bash('gh release download v1 -R o/r'),
      bash('hf download o/data --repo-type dataset'), bash('python3 -c "from datasets import load_dataset; load_dataset(\'o/d\')"'),
      bash('wget https://example.com/files/data.tar.gz'), bash('curl -L https://raw.githubusercontent.com/o/r/main/x.json'),
      bash('pip install git+https://github.com/o/r'), bash('git submodule update --init'),
      { tool: 'execute', input: { code: 'await tools.capy.bash({ command: "git clone --depth 1 https://gitlab.com/o/r" });' } },
    ]).map(r => r[0])).toEqual(['git-remote', 'gh-repo', 'gh-repo', 'gh-repo', 'dataset', 'dataset', 'archive', 'archive', 'git-install', 'git-remote', 'git-remote']);
  });
  test('a fetch of the checkout\'s own remote by name is a note, not a violation', () => {
    const hits = scanEvents([bash('git fetch origin main')], NONE, '/work/repo');
    expect(hits.map(h => [h.rule, h.severity])).toEqual([['own-remote', 'note']]);
    expect(auditVerdict(hits)).toBe('clean');
  });
  test('forbid_paths catches reads by tool, by command and by git object path; the exclusion pathspec itself is not a read', () => {
    const r = { forbid_fetch: [], forbid_paths: ['sealed/**'] };
    expect(rules([
      { tool: 'capy.read', input: { path: '/work/repo/sealed/split.jsonl' } }, bash('cat sealed/split.jsonl'), bash('git show HEAD:sealed/split.jsonl'),
      bash("git diff 1a2b3c4 -- . ':(top,exclude,glob)sealed/**'"), { tool: 'capy.read', input: { path: '/work/repo/src/a.ts' } },
    ], r).map(x => x[0])).toEqual(['forbid-path', 'forbid-path', 'forbid-path']);
  });
  test('forbid_fetch matches hosts, subdomains and owner/repo, with or without .git', () => {
    expect(forbiddenBy(networkTarget('https://huggingface.co/datasets/o/d')!, ['huggingface.co'])).toBe('huggingface.co');
    expect(forbiddenBy(networkTarget('https://cdn-lfs.huggingface.co/x')!, ['huggingface.co'])).toBe('huggingface.co');
    expect(forbiddenBy(networkTarget('git@github.com:Example-Org/BEAM.git')!, ['github.com/example-org/beam'])).toBe('github.com/example-org/beam');
    expect(forbiddenBy(networkTarget('https://github.com/example-org/beamer')!, ['github.com/example-org/beam'])).toBeNull();
    expect(rules([{ tool: 'web.fetch', input: { url: 'https://github.com/example-org/BEAM/tree/main/chats' } }], { forbid_fetch: ['github.com/example-org/beam'], forbid_paths: [] }).map(x => x[0])).toEqual(['forbid-fetch']);
  });
});

describe('readers policy', () => {
  test('validation: entries, paths and the note are checked; unknown subkeys fail', () => {
    const errs = (readers: unknown) => validatePolicy({ readers, min_gstack_version: READERS_KEY_VERSION }).map(e => e.path);
    expect(errs({ forbid_fetch: ['github.com/o/r', 'huggingface.co'], forbid_paths: ['sealed/**'], brief_note: 'sealed/ is custody.' })).toEqual([]);
    expect(errs({ forbid_fetch: ['https://github.com/o/r'] })).toEqual(['readers.forbid_fetch[0]']);
    expect(errs({ forbid_paths: [':(top)x'] })).toEqual(['readers.forbid_paths[0]']);
    expect(errs({ brief_note: 'two\nlines' })).toEqual(['readers.brief_note']);
    expect(errs({ brief_note: 'token ghp_' + 'a'.repeat(30) })).toEqual(['readers.brief_note']);
    expect(errs({ allow_fetch: [] })).toEqual(['readers.allow_fetch']);
  });
  test('the head may add entries, never remove one, and its note is ignored', () => {
    const base = { forbid_fetch: ['github.com/o/r'], forbid_paths: ['sealed/**'], brief_note: 'base note' };
    expect(effectiveReaders(base, { forbid_fetch: [], forbid_paths: [], brief_note: 'head note' })).toMatchObject({ ...base, head_added: [] });
    expect(effectiveReaders(base, { forbid_fetch: ['huggingface.co'], forbid_paths: [], brief_note: null })).toMatchObject({ forbid_fetch: ['github.com/o/r', 'huggingface.co'], head_added: ['huggingface.co'] });
  });

  function repo(basePolicy: object | string | null, headPolicy?: object): { dir: string; base: string; head: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fetch-'));
    dirs.push(dir);
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    const write = (p: object | string) => { fs.mkdirSync(path.join(dir, '.gstack'), { recursive: true }); fs.writeFileSync(path.join(dir, '.gstack/ship-policy.json'), typeof p === 'string' ? p : JSON.stringify(p)); };
    if (basePolicy !== null) write(basePolicy);
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feat');
    if (headPolicy) write(headPolicy);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'feat');
    return { dir, base, head: git('rev-parse', 'HEAD') };
  }
  const policy = (readers: object) => ({ readers, min_gstack_version: READERS_KEY_VERSION });

  test('read at the base: a head that drops an entry is ignored, one that adds is applied', () => {
    const r = repo(policy({ forbid_fetch: ['github.com/o/r'], forbid_paths: ['sealed/**'] }), policy({ forbid_fetch: ['huggingface.co'] }));
    const load = loadReaders(r.dir, r.base, 'main', r.head);
    expect(load.state).toBe('ok');
    if (load.state === 'ok') expect([load.readers.forbid_fetch, load.readers.forbid_paths]).toEqual([['github.com/o/r', 'huggingface.co'], ['sealed/**']]);
  });
  test('no policy file is the default rule; an invalid base policy refuses', () => {
    const none = repo(null);
    expect(loadReaders(none.dir, none.base, 'main', none.head)).toMatchObject({ state: 'ok', readers: { forbid_fetch: [], forbid_paths: [], brief_note: null } });
    const bad = repo(policy({ forbid_fetch: ['not a host'] }));
    expect(loadReaders(bad.dir, bad.base, 'main', bad.head)).toMatchObject({ state: 'refused', code: 'POLICY_INVALID' });
  });
  test('gstack-review-plan cuts forbid_paths out of every reader\'s diff and prints the READERS line', () => {
    const r = repo(policy({ forbid_paths: ['sealed/**'] }));
    fs.mkdirSync(path.join(r.dir, 'sealed'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'sealed/split.jsonl'), '{"q":"held out"}\n');
    fs.writeFileSync(path.join(r.dir, 'b.ts'), Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
    spawnSync('git', ['add', '.'], { cwd: r.dir }); spawnSync('git', ['commit', '-qm', 'more'], { cwd: r.dir });
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fetch-state-'));
    dirs.push(state);
    const out = spawnSync(path.join(ROOT, 'bin', 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: state } });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('READERS: forbid_fetch=0 forbid_paths=1 note=no head_added=0');
    const cmds = out.stdout.split('\n').filter(l => l.startsWith('DIFF_CMD: '));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) expect(c).toContain("':(top,exclude,glob)sealed/**'");
  });
});
