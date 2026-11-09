/**
 * Which secret-like lines keep a file under review_exclude_paths (GST-1967, harness-evals#333), and the argument-byte bound
 * counting only the kept files a reader's diff command carries. A line that only names a credential (an environment
 * variable, a keychain) holds no value and keeps nothing; a line that names one and carries a value still keeps its file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectCommit } from '../lib/review-collect';
import { KEEP_ARG_MAX_BYTES, readSelection, reviewExclude, secretValueLine } from '../lib/review-exclude';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const policyText = JSON.stringify({ review_exclude_paths: ['receipts/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';

/** Credential-shaped values built at run time, so this source holds no scanner match. */
const OPENAI = ['sk', 'proj', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3iJk6lMn9o'].join('-');
const GITHUB = 'gh' + 'p_' + 'Zx9Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz2Xc4';
const BLOB = Buffer.from('a private signing key that must never reach a results tree 0x5f3759df').toString('base64');

/** Each keeps its file: it names a credential and carries a value. */
const VALUE_LINES: Record<string, string> = {
  'real-value': `{"OPENAI_API_KEY": "${OPENAI}"}`,
  assignment: `OPENAI_API_KEY=${OPENAI}`,
  'json-string': `{"cmd": "curl -H $OPENAI_API_KEY", "value": "${OPENAI}"}`,
  'after-name': `{"cmd": "echo \${OPENAI_API_KEY} ${GITHUB} | gh auth login --with-token"}`,
  'far-after-name': `{"cmd": "export GH_TOKEN=$GH_TOKEN; ${'step '.repeat(200)}then push with ${GITHUB}"}`,
  base64: `{"cmd": "curl -H $OPENAI_API_KEY", "auth": "${BLOB}"}`,
};
/** None keeps its file: each only names a credential. The last two are harness-evals#333's captured prompt lines. */
const NAME_LINES: Record<string, string> = {
  brace: '{"cmd": "curl -H \\"Authorization: Bearer ${OPENAI_API_KEY}\\""}',
  bare: '{"cmd": "curl -H $OPENAI_API_KEY"}',
  'process-env': '{"code": "const key = process.env.OPENAI_API_KEY;"}',
  'os-environ': '{"code": "key = os.environ[\\"OPENAI_API_KEY\\"]"}',
  'harn-333-curl': '{"system": "Here you go.\\n\\n`curl -H \\"x-agent-capability: $AGENT_API_TOKEN\\" \\"$AGENT_API_URL/v1/apis\\"` lists what you can call."}',
  'harn-333-keychain': '{"system": "Requires managed model access and a keychain grant for the browser provider key; follow the repo rules."}',
};

describe('secret-like lines under review_exclude_paths', () => {
  // Value: protects=narrowing the keep rule opens no bypass: a key value, a key-name assignment, a key inside a JSON string, a
  //   key after the name (near or far on the line) and a base64 blob after the name all still keep their file; fails_when=the
  //   rule drops every line that names a variable, or reads only the name's own span; why_new=GST-1967; seam=secretValueLine
  //   and gstack-review-plan; no_claim=a bare key with no credential name on its line (pregate's credential scan owns it)
  test('a line that names a credential and carries a value keeps its file', () => {
    for (const [name, line] of Object.entries(VALUE_LINES)) expect({ name, kept: secretValueLine(`receipts/${name}.json`, line) }).toEqual({ name, kept: true });
  });

  // Value: protects=a results tree whose captured prompts only name an environment variable or a keychain is excluded like
  //   any data (harness-evals#333: 2,610 such files kept, 9.5 MB to readers against the 2 MB ceiling); fails_when=a name with no
  //   value counts as secret-like; why_new=GST-1967; seam=secretValueLine; no_claim=code files, which are never excludable
  test('a line that only names an environment variable or a credential store keeps nothing', () => {
    for (const [name, line] of Object.entries(NAME_LINES)) expect({ name, kept: secretValueLine(`receipts/${name}.json`, line) }).toEqual({ name, kept: false });
  });

  test('the plan keeps the value files and excludes the name-only files', () => {
    const repo = makeFixtureRepo({ prefix: 'gstack-secret-value-', baseFiles: { '.gstack/ship-policy.json': policyText } }); repos.push(repo);
    const files: Record<string, string> = { 'receipts/plain.json': '{"ok": true}\n' };
    for (const [name, line] of Object.entries(VALUE_LINES)) files[`receipts/value/${name}.json`] = line + '\n';
    for (const [name, line] of Object.entries(NAME_LINES)) files[`receipts/name/${name}.json`] = line + '\n';
    commit(repo, files);
    const p = JSON.parse(runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--json']).out);
    expect(p.review_exclude.kept_files).toEqual(Object.keys(VALUE_LINES).sort().map(n => ({ path: `receipts/value/${n}.json`, reason: 'secret-line' })));
    expect(p.review_exclude.excluded).toBe(1 + Object.keys(NAME_LINES).length);
    expect(p.review_exclude.skipped).toEqual([]);
  }, 120_000);
});

describe('the argument-byte bound', () => {
  const DIR = `receipts/${'captured-model-requests-'.repeat(4)}`;
  const COUNT = 260;
  function excerptOnly(namedByCode: boolean) {
    const repo = makeFixtureRepo({ prefix: 'gstack-secret-value-', baseFiles: { '.gstack/ship-policy.json': policyText } }); repos.push(repo);
    const files: Record<string, string> = { 'receipts/plain.json': '{"ok": true}\n' };
    const paths = Array.from({ length: COUNT }, (_, k) => `${DIR}t${String(k).padStart(3, '0')}/llm-turn0.json`);
    for (const p of paths) files[p] = `{"n": "${p}"}\n${VALUE_LINES.base64}\n`;
    if (namedByCode) files['lib/reader.js'] = paths.map(p => `require('../${p}');`).join('\n') + '\n';
    commit(repo, files);
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const c = collectCommit(repo.work, baseSha, head);
    const x = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged: new Set(), context: 'test' });
    if (x.state !== 'active') throw new Error(`exclusion is ${x.state}`);
    return { repo, x, paths, mergeBase: c.mergeBase! };
  }

  // Value: protects=kept files that reach readers as a secret-line excerpt file never count toward the bound, so a pattern
  //   over thousands of them still applies, and every git call that reads them stays under the bound (Windows' command line);
  //   fails_when=the bound counts the excerpt files (harness-evals#333: main/trials/** needed 251,063 bytes and was dropped
  //   whole) or readSelection passes them to one git diff; why_new=GST-1967; seam=reviewExclude and readSelection under
  //   GIT_TRACE; no_claim=what an agent's shell does with a brief's keep command (those files still count)
  test('excerpt-only kept files past the bound still apply the pattern, and their read is chunked under it', () => {
    const { repo, x, paths, mergeBase } = excerptOnly(false);
    expect(x.record.skipped).toEqual([]);
    expect(x.record.applied).toEqual(['receipts/**']);
    expect(x.excerpt.length).toBe(COUNT);
    expect(paths.reduce((n, p) => n + Buffer.byteLength(`':(top,literal)${p}' `), 0)).toBeGreaterThan(KEEP_ARG_MAX_BYTES);
    const trace = path.join(repo.root, 'git-trace.log');
    const prior = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    let d: ReturnType<typeof readSelection>;
    try { d = readSelection(repo.work, mergeBase, ['.', ...x.specs], x.keep.filter(k => !x.excerpt.includes(k)), x.excerpt); }
    finally { if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior; }
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.whole ?? []).toEqual([]);
    for (const p of paths) expect(d.excerpt).toContain(p);
    const diffs = fs.readFileSync(trace, 'utf8').split('\n').filter(l => /built-in: git( -c \S+)* diff /.test(l));
    expect(diffs.length).toBeGreaterThan(2);
    for (const l of diffs) expect(Buffer.byteLength(l)).toBeLessThan(KEEP_ARG_MAX_BYTES + 1_000);
  }, 120_000);

  // Value: protects=kept files a reader's diff command names in full still count, so no brief carries a command line past the
  //   bound; fails_when=the bound stops counting kept files that are not excerpted; why_new=GST-1967; seam=reviewExclude
  test('kept files a reader runs as a command still count toward the bound', () => {
    const { x } = excerptOnly(true);
    expect(x.record.applied).toEqual([]);
    expect(x.record.skipped).toMatchObject([{ pattern: 'receipts/**', kept: COUNT }]);
  }, 120_000);
});
