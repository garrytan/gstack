/**
 * Secret-line excerpts (GST-1447, docs/ship-policy.md#review-exclude-paths): a file review_exclude_paths matches and keeps
 * only because a changed line reads a credential goes to pass readers as every matched line with context, and only that
 * excerpt counts toward REVIEW_DIFF_MAX_BYTES. Any other keep reason, and any excerpt that cannot be built, inlines the file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { REVIEW_DIFF_MAX_BYTES, readSelection, reviewExclude } from '../lib/review-exclude';
import { collectCommit } from '../lib/review-collect';
import { secretExcerpt } from '../lib/review-secret-excerpt';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const policyText = JSON.stringify({ review_exclude_paths: ['docs/benchmarks/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
const TURNS = 'docs/benchmarks/qm-s1-probe/results/turns';
/** A credential-shaped base64 value (no known key prefix) for the lines that must keep their file: a name alone keeps nothing (GST-1967). */
const VALUE = Buffer.from('a private signing key that must never reach a results tree 0x5f3759df').toString('base64');
/** A credential-shaped value built at run time, so the source holds no scanner match. */
const plantedKey = (seed: number) => 'gh' + 'p_' + `Zx9Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz2Xc${seed}`.slice(0, 36);

/**
 * One captured model request in the harness-evals #269 shape: about 4,000 pretty-printed JSON lines (~350 KB) whose system
 * prompt lines run past 20 KB and name \`\${…_API_KEY}\`, \`$…_TOKEN\` and keychain commands. Every match carries a marker
 * unique to its file and line, so a test can ask for each one.
 */
function capture(k: number, plant: Record<number, string> = {}): { text: string; markers: string[] } {
  const lines = ['{', ' "requests": ['];
  const markers: string[] = [];
  for (let n = 0; n < 4000; n++) {
    if (plant[n]) lines.push(plant[n]!);
    else if (n % 800 === 30) {
      const env = `\${OPENAI_API_KEY_F${k}_L${n}}`, svc = `svc-f${k}-l${n}`;
      markers.push(env, svc);
      lines.push(`   "system": "${'You are a coding agent. '.repeat(450)}Read ${env} (value ${VALUE}) from the environment and never print it. ${'Follow the repo rules. '.repeat(450)}On macOS run security find-generic-password -s ${svc} for the keychain entry.",`);
    } else if (n % 800 === 380) {
      const env = `$GH_TOKEN_F${k}_L${n}`;
      markers.push(env);
      lines.push(`   "note": "${'context '.repeat(150)}export ${env} (value ${VALUE}) before the push",`);
    } else lines.push(`   "line${n}": "${'x'.repeat(40)} ${n}",`);
  }
  lines.push(' ]', '}');
  return { text: lines.join('\n') + '\n', markers };
}

/** A results branch over the ceiling: ten captures and ten plain session files under docs/benchmarks/** (about 3.5 MB), plus \`extra\`. */
function results(extra: Record<string, string> = {}, plant: Record<number, string> = {}) {
  const repo = makeFixtureRepo({ prefix: 'gstack-excerpt-', baseFiles: { '.gstack/ship-policy.json': policyText } });
  repos.push(repo);
  const files: Record<string, string> = { 'lib/run.js': "exports.run = () => 'ok';\n", ...extra };
  const markers: Record<string, string[]> = {};
  for (let k = 0; k < 10; k++) {
    const c = capture(k, k === 3 ? plant : {});
    files[`${TURNS}/t${k}/llm-turn0.json`] = c.text;
    files[`${TURNS}/t${k}/session.json`] = `{"turn": ${k}, "ok": true}\n`;
    markers[`${TURNS}/t${k}/llm-turn0.json`] = c.markers;
  }
  commit(repo, files);
  return { repo, markers };
}
const pass = (repo: FixtureRepo) => {
  const out = path.join(repo.root, 'pass');
  const r = runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p1', '--', '--gate-tagged', '0']);
  const file = path.join(out, 'pass-manifest.json');
  return { r, out, m: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
};
const exclusion = (repo: FixtureRepo, gateTagged: ReadonlySet<string> | null = new Set()) => {
  const head = repo.git('rev-parse', 'HEAD');
  const baseSha = repo.git('rev-parse', 'origin/main');
  const c = collectCommit(repo.work, baseSha, head);
  const x = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged, context: 'test' });
  if (x.state !== 'active') throw new Error(`expected an active exclusion, got ${x.state}`);
  return { x, mergeBase: c.mergeBase! };
};
const lit = (p: string) => `:(top,literal)${p}`;
/** The kept files a reader still reads whole: DIFF_KEEP's list less the excerpt. */
const wholeKeep = (x: { keep: string[]; excerpt: string[] }) => x.keep.filter(k => !x.excerpt.includes(k));

describe('files kept only for a secret line go to readers as excerpts', () => {
  // Value: protects=a results PR whose captured prompts name credentials reaches review instead of stopping at the ceiling,
  //   and the secret review still sees every matched line; fails_when=a secret-only kept file is inlined whole (the pass
  //   refuses REVIEW_DIFF_TOO_LARGE, harness-evals #269: 75 files, 12.9 MB) or a matched line is missing from the excerpt;
  //   why_new=GST-1447; seam=gstack-review-dispatch pass on a real repository; no_claim=what a model does with the excerpt
  test('the #269 shape fits under the ceiling and every match is in the excerpt each brief names', () => {
    const { repo, markers } = results();
    const { r, m } = pass(repo);
    expect(r.err).not.toContain('REVIEW_DIFF_TOO_LARGE');
    expect(r.status).toBe(EXIT.ok);
    const readers = m.readers.filter((x: any) => !x.prompt_file);
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      expect(reader.excerpt).toEqual(Object.keys(markers).sort().map(lit));
      expect(reader.keep ?? []).toEqual([]);
      expect(reader.excerpt_file.files).toBe(10);
      expect(reader.excerpt_file.bytes).toBeLessThan(REVIEW_DIFF_MAX_BYTES / 4);
    }
    const excerpt = fs.readFileSync(readers[0].excerpt_file.file, 'utf8');
    expect(Buffer.byteLength(excerpt)).toBe(readers[0].excerpt_file.bytes);
    for (const [file, ms] of Object.entries(markers)) {
      expect(excerpt).toContain(`### ${file}`);
      expect(excerpt).toContain('10 changed lines matched (10 by the secret-line rule, 0 with a secret-shaped value)');
      for (const mark of ms) expect({ file, mark, found: excerpt.includes(mark) }).toEqual({ file, mark, found: true });
    }
    const rendered = readers.filter((x: any) => x.file && x.role !== 'outside-voice');
    expect(rendered.length).toBeGreaterThan(0);
    for (const x of rendered) expect(fs.readFileSync(x.file, 'utf8')).toContain(`in the file ${x.excerpt_file.file} (${x.excerpt_file.bytes} bytes, sha256 ${x.excerpt_file.sha256})`);
    const { x, mergeBase } = exclusion(repo);
    const d = readSelection(repo.work, mergeBase, ['--', '.', ...x.specs], wholeKeep(x), x.excerpt);
    expect(d.ok && d.bytes).toBeLessThan(REVIEW_DIFF_MAX_BYTES);
    expect(d.ok && d.text).toContain('## Secret-line excerpts (10 files)');
  }, 240_000);

  // Value: protects=a real credential in a secret-only kept file still reaches the reviewer, wherever it sits in the file;
  //   fails_when=the excerpt keeps only SECRET_LINE matches, so a token far from any matched line (or inside a 20 KB line) is
  //   left out; why_new=GST-1447 (the excerpt replaced the whole file); seam=readSelection on a real repository;
  //   no_claim=pregate's gitleaks scan, which reads every added line on its own
  test('a planted key far from any secret line, short or inside a long line, is in the excerpt', () => {
    const short = plantedKey(1), long = plantedKey(2);
    const plant = { 1500: `   "auth": "${short}",`, 2000: `   "blob": "${'y'.repeat(9000)} ${long} ${'y'.repeat(9000)}",` };
    const { repo } = results({}, plant);
    const { x, mergeBase } = exclusion(repo);
    const d = readSelection(repo.work, mergeBase, ['--', '.', ...x.specs], wholeKeep(x), x.excerpt);
    if (!d.ok) throw new Error('unreadable');
    expect(d.whole).toEqual([]);
    expect(d.excerpt).toContain(short);
    expect(d.excerpt).toContain(long);
    expect(d.excerpt).toContain(`### ${TURNS}/t3/llm-turn0.json`);
    expect(d.excerpt).toContain('12 changed lines matched (10 by the secret-line rule, 2 with a secret-shaped value)');
  }, 240_000);

  // Value: protects=only the secret-line reason earns an excerpt: a file a program names, a file outside the applied patterns,
  //   and every file under an unknown gate scan stay whole; fails_when=named-by-code is never checked for a secret-line file
  //   (it is excerpted), a file outside the patterns is excerpted, or an unknown gate scan still excerpts; why_new=GST-1447;
  //   seam=reviewExclude and gstack-review-dispatch pass on a real repository
  test('a secret-line file a program names, one outside the patterns and an unknown gate scan are inlined whole', () => {
    const named = `${TURNS}/named/llm-turn0.json`, outside = 'data/llm-turn0.json';
    const secret = (k: number) => capture(k).text;
    const { repo, markers } = results({ [named]: secret(20), [outside]: secret(21), 'lib/reader.js': `exports.p = '${named}';\n` });
    const { x } = exclusion(repo);
    expect(x.kept.find(k => k.path === named)).toEqual({ path: named, reason: 'secret-line' });
    expect(wholeKeep(x)).toEqual([lit(named)]);
    expect(x.keep).toContain(lit(named));
    expect(x.excerpt).toEqual(Object.keys(markers).sort().map(lit));
    expect(exclusion(repo, null).x.excerpt).toEqual([]);
    const { r, m } = pass(repo);
    expect(r.status).toBe(EXIT.ok);
    const reader = m.readers.find((y: any) => !y.prompt_file);
    expect(reader.keep).toEqual([lit(named)]);
    expect(reader.excerpt).not.toContain(lit(named));
    expect(reader.excerpt).not.toContain(lit(outside));
    const { mergeBase } = exclusion(repo);
    const d = readSelection(repo.work, mergeBase, ['--', '.', ...x.specs], wholeKeep(x), x.excerpt);
    if (!d.ok) throw new Error('unreadable');
    expect(d.text).toContain(`diff --git a/${named} b/${named}`);
    expect(d.text).toContain(`diff --git a/${outside} b/${outside}`);
    expect(d.excerpt).not.toContain(`### ${named}`);
  }, 240_000);

  // Value: protects=excerpt building fails closed per file: a file whose excerpt cannot be built goes to the reader whole and
  //   joins the reader's keep command while the others stay excerpted; fails_when=such a file drops out of review, is shown
  //   cut, or takes the other files' excerpts down with it; why_new=GST-1447; seam=readSelection and gstack-review-dispatch
  //   pass on a real repository (a minified capture whose one line passes the credential scanner's 1 MiB cap)
  test('a file whose excerpt cannot be built falls back to the whole file', () => {
    const big = `${TURNS}/big/llm-turn0.json`;
    const line = `{"system": "${'You are a coding agent. '.repeat(48000)}Read \${OPENAI_API_KEY_BIG} and use the keychain.", "end": "tail-of-big"}\n`;
    const { repo } = results({ [big]: line });
    const { x, mergeBase } = exclusion(repo);
    expect(x.excerpt).toContain(lit(big));
    const d = readSelection(repo.work, mergeBase, ['--', '.', ...x.specs], wholeKeep(x), x.excerpt);
    if (!d.ok) throw new Error('unreadable');
    expect(d.whole).toEqual([lit(big)]);
    expect(d.text).toContain('"end": "tail-of-big"');
    expect(d.excerpt).not.toContain(`### ${big}`);
    expect(d.excerpt).toContain('## Secret-line excerpts (10 files)');
    const { r, m } = pass(repo);
    expect(r.status).toBe(EXIT.ok);
    const reader = m.readers.find((y: any) => !y.prompt_file);
    expect(reader.keep).toEqual([lit(big)]);
    expect(reader.excerpt).not.toContain(lit(big));
    expect(reader.excerpt_file.files).toBe(10);
  }, 240_000);

  // Value: protects=every matched line of an excerpted file reaches readers; fails_when=a CR, U+2028 or U+2029 followed by
  //   `diff --git ` inside a changed line splits the file's section, so the lines after it leave the excerpt while the file
  //   stays excluded from the reader's own diff; why_new=GST-1447 /ship red-team finding; seam=none
  test('a line separator inside a changed line does not cut the file section short', () => {
    for (const sep of ['\r', '\u2028', '\u2029']) {
      const pad = Array.from({ length: 20 }, (_, i) => `+filler ${i}`);
      const diff = ['diff --git a/r/x.json b/r/x.json', '--- a/r/x.json', '+++ b/r/x.json', '@@ -0,0 +1,23 @@', '+uses ${OPENAI_API_KEY}', ...pad, `+note${sep}diff --git a/zz b/zz`, '+run security find-generic-password -s after-split', ''].join('\n');
      const x = secretExcerpt(diff, ['r/x.json']);
      expect(x.whole.includes('r/x.json') || x.text.includes('after-split')).toBe(true);
    }
  });

  // Value: protects=a secret the scanner finds only with its nearby label (an AWS secret key) reaches readers; fails_when=the
  //   scanner reads changed lines alone or in chunks without overlap, so a label on a context line or across a chunk
  //   boundary hides the value; why_new=GST-1447 /ship outside-voice finding; seam=none
  test('a secret whose label sits on a context line or across a scan chunk is in the excerpt', () => {
    const value = 'wJ' + 'alrXUtnFEMI/K7MDENG/bPxRfiCYzQ9wQ3eR5t';
    const head = ['diff --git a/r/x.yml b/r/x.yml', '--- a/r/x.yml', '+++ b/r/x.yml'];
    const pad = Array.from({ length: 20 }, (_, i) => `+filler ${i}`);
    const context = [...head, '@@ -1,1 +1,23 @@', '+uses ${OPENAI_API_KEY}', ...pad, ' aws_secret_access_key:', `+  ${value}`, ''].join('\n');
    expect(secretExcerpt(context, ['r/x.yml']).text).toContain(value);
    const fill = Array.from({ length: 511 }, () => `+${'f'.repeat(1023)}`);
    const boundary = [...head, '@@ -0,0 +1,515 @@', '+uses ${OPENAI_API_KEY}', ...fill, `+${'x'.repeat(980)} aws_secret_access_key:`, `+${value}`, ''].join('\n');
    expect(secretExcerpt(boundary, ['r/x.yml']).text).toContain(value);
  });
});
