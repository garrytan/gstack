/**
 * Gate-tagged data excerpts (GST-3273, harness-evals#494): a data file review_exclude_paths matches and keeps only because the
 * gate scan tagged a changed line by its content (a suppression pragma or an env check quoted inside a captured agent
 * transcript) goes to pass readers as every tagged line with context, the way secret-line files do (GST-1447). Only a
 * .jsonl, .ndjson, .csv, .tsv or .log file, or a .json under a results tree, off every gate floor, not renamed, kept for no
 * other reason, whose every tag instance is one added line's own tag, is cut; anything else stays whole, and a diff still
 * over the ceiling names its largest files.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { REVIEW_DIFF_MAX_BYTES, reviewExclude, secretValueLine, secretValueSpans, tooLargeLine } from '../lib/review-exclude';
import { taggedPaths } from '../lib/ship-receipt-depth';
import { collectCommit } from '../lib/review-collect';
import { REVIEW_CONTENT_KEY_VERSION } from '../lib/ship-policy-keys';
import { secretExcerpt } from '../lib/review-secret-excerpt';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const policyText = JSON.stringify({ review_exclude_paths: ['docs/benchmarks/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
const TRIALS = 'docs/benchmarks/demo/results/trials';
const lit = (p: string) => `:(top,literal)${p}`;

/**
 * One synthetic agent session in the #494 shape: about 2,000 JSONL turns (~230 KB) of plain chatter, with three turns whose
 * quoted tool output the gate scan tags (an eslint-disable pragma, a process.env.CI check, and a --no-verify push buried in
 * a 6 KB line). Each tagged turn carries a marker unique to its file and line. No real transcript text.
 */
function session(k: number): { text: string; markers: string[] } {
  const lines: string[] = [];
  const markers: string[] = [];
  for (let n = 0; n < 2000; n++) {
    const mark = `mark-f${k}-l${n}`;
    if (n === 200) { markers.push(mark); lines.push(JSON.stringify({ role: 'tool', content: `patched lint: // eslint-disable-next-line no-console (${mark})` })); }
    else if (n === 900) { markers.push(mark); lines.push(JSON.stringify({ role: 'tool', content: `if (process.env.CI) return; (${mark})` })); }
    else if (n === 1600) { markers.push(mark); lines.push(JSON.stringify({ role: 'assistant', content: `${'Working through the task. '.repeat(120)}ran git push --no-verify (${mark}) ${'Still working. '.repeat(200)}` })); }
    else lines.push(JSON.stringify({ role: n % 2 ? 'assistant' : 'user', content: `turn ${n} of trial ${k}: ${'plain words about the benchmark task '.repeat(2)}` }));
  }
  return { text: lines.join('\n') + '\n', markers };
}

/** A results branch: `files` plus lib/run.js; each trial's small summary.json is what review_exclude_paths leaves out. */
function branch(files: Record<string, string>) {
  const repo = makeFixtureRepo({ prefix: 'gstack-gate-excerpt-', baseFiles: { '.gstack/ship-policy.json': policyText } });
  repos.push(repo);
  commit(repo, { 'lib/run.js': "exports.run = () => 'ok';\n", ...files });
  return repo;
}
const pass = (repo: FixtureRepo) => {
  const out = path.join(repo.root, 'pass');
  const r = runBin(repo, 'gstack-review-dispatch', ['pass', '--base', 'main', '--out', out, '--pass', 'p1']);
  const file = path.join(out, 'pass-manifest.json');
  return { r, m: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
};

describe('gate-tagged data files go to readers as their tagged lines', () => {
  // Value: protects=a results PR whose captured agent sessions quote lint pragmas or env checks reaches review instead of
  //   stopping at the ceiling, every tagged line still reaches readers, and the gate still fires; fails_when=a gate-tagged
  //   data file is sent whole (REVIEW_DIFF_TOO_LARGE; on harness-evals#494 main's whole reader diff was 12.26 MB), a tagged line is missing, or
  //   a code file, a path-tagged snapshot or a file whose tag spans lines is cut; why_new=GST-3273;
  //   seam=gstack-review-plan and gstack-review-dispatch pass on a real repository, real gate scan; no_claim=what a model
  //   does with the excerpt
  test('the #494 shape fits under the ceiling; code, path-tagged and multi-line-tagged files stay whole', () => {
    const files: Record<string, string> = {};
    const markers: Record<string, string[]> = {};
    for (let k = 0; k < 12; k++) {
      const s = session(k);
      files[`${TRIALS}/t${k}/session.jsonl`] = s.text;
      files[`${TRIALS}/t${k}/summary.json`] = `{"trial": ${k}, "passed": true}\n`;
      markers[`${TRIALS}/t${k}/session.jsonl`] = s.markers;
    }
    const code = 'docs/benchmarks/demo/harness/score.ts';
    const snapshot = 'docs/benchmarks/demo/results/__snapshots__/expected.json';
    const spanning = `${TRIALS}/t99/run.log`;
    const hidden = `${TRIALS}/t98/run.log`;
    const mixed = `${TRIALS}/t97/run.log`;
    files[code] = '// eslint-disable-next-line no-console\nexport const score = (n: number) => n * 2;\n';
    files[snapshot] = '{"score": 2}\n';
    files[spanning] = 'step 1\ntry { run() } catch (e) {\n}\nstep 2\n';
    files[hidden] = `step 1\nif (process.env.CI) try { realGate() } catch (e) {\n}\nrun(); try { a() } catch (e) {}\nstep 2\n`;
    files[mixed] = `step 1\ntry { b() } catch (e) {\n}\nrun(); try { a() } catch (e) {}\nstep 2\n`;
    const repo = branch(files);
    const total = Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0);
    expect(total).toBeGreaterThan(REVIEW_DIFF_MAX_BYTES);

    const plan = runBin(repo, 'gstack-review-plan', ['--base', 'main']);
    expect(plan.status).toBe(0);
    expect(plan.out).toMatch(/^REVIEW_CLASS: gate/m);
    expect(plan.out).toMatch(/^GATE_SCAN: tagged=([1-9]\d*)/m);

    const { r, m } = pass(repo);
    expect(r.err).not.toContain('REVIEW_DIFF_TOO_LARGE');
    expect(r.status).toBe(EXIT.ok);
    const readers = m.readers.filter((x: any) => !x.prompt_file);
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      expect(reader.excerpt).toEqual(Object.keys(markers).sort().map(lit));
      expect([...(reader.keep ?? [])].sort()).toEqual([code, snapshot, spanning, hidden, mixed].sort().map(lit));
      expect(reader.excerpt_file.files).toBe(12);
      expect(reader.excerpt_file.bytes).toBeLessThan(REVIEW_DIFF_MAX_BYTES / 4);
    }
    const excerpt = fs.readFileSync(readers[0].excerpt_file.file, 'utf8');
    expect(excerpt).toContain('## Gate-tagged data excerpts (12 files)');
    for (const [file, ms] of Object.entries(markers)) {
      expect(excerpt).toContain(`### ${file}`);
      expect(excerpt).toContain('3 changed lines matched (0 by the secret-line rule, 0 with a secret-shaped value, 3 tagged by the gate scan: RH-12, RH-13, RH-14) out of 2000');
      for (const mark of ms) expect({ file, mark, found: excerpt.includes(mark) }).toEqual({ file, mark, found: true });
    }
    expect(excerpt).not.toContain('turn 500 of trial 0');
    const rendered = readers.filter((x: any) => x.file && x.role !== 'outside-voice');
    expect(rendered.length).toBeGreaterThan(0);
    for (const x of rendered) expect(fs.readFileSync(x.file, 'utf8')).toContain('a changed line the gate scan tagged in a data file');
  }, 300_000);

  // Value: protects=a diff still over the ceiling after the cut tells the lane which files to move, not only "split", and a
  //   gate-tagged file whose path holds a space stays in review; fails_when=REVIEW_DIFF_TOO_LARGE names folders alone or cuts
  //   a name at its first space, or the gate scan records the path with git's trailing tab so the file is excluded unread;
  //   why_new=GST-3273 (#494's only printed fix was "split the PR"); seam=gstack-review-dispatch pass on a real repository
  test('a diff still over the ceiling after the cut names its largest files', () => {
    const line = (k: number, n: number) => JSON.stringify({ role: 'tool', content: `// eslint-disable-next-line f${k} n${n} ${'x'.repeat(200)}` });
    const files: Record<string, string> = {};
    for (let k = 0; k < 3; k++) {
      files[`${TRIALS}/big ${k}/session.jsonl`] = Array.from({ length: 3600 + k * 100 }, (_, n) => line(k, n)).join('\n') + '\n';
      files[`${TRIALS}/big${k}/summary.json`] = `{"trial": ${k}}\n`;
    }
    const repo = branch(files);
    const { r } = pass(repo);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('REVIEW_DIFF_TOO_LARGE');
    const m = / files=(.*?) policy=/.exec(r.err);
    expect(m?.[1]?.split(',').slice(0, 3).map(f => JSON.parse(f.replace(/:\d+$/, '')))).toEqual([2, 1, 0].map(k => `${TRIALS}/big ${k}/session.jsonl`));
    expect(r.err).toContain(`largest files: ${TRIALS}/big 2/session.jsonl (`);
  }, 300_000);
});

describe('a credential line in an excerpted file always reaches readers', () => {
  // Value: protects=a kept file whose changed lines carry a credential value (secretValueLine: a key name given a
  //   credential-shaped run, with no SECRET_LINE or scanner match) never reaches readers as an excerpt without that line;
  //   fails_when=the gate-tagged excerpt shows only the tagged lines and drops the credential line, which before GST-3273
  //   sent the file whole; why_new=/ship review of #4556 (security reader, reproduced); seam=gstack-review-dispatch pass on a
  //   real repository; no_claim=credential lines in files kept for another reason
  test('a gate-tagged session with a credential line shows that line or goes whole', () => {
    const blob = Buffer.from('a private signing key that must never reach a results tree 0x5f3759df').toString('base64');
    const file = `${TRIALS}/t0/session.jsonl`;
    const lines = session(0).text.split('\n');
    lines[500] = JSON.stringify({ role: 'tool', content: `GH_TOKEN=${blob} (cred-mark-t0)` });
    const repo = branch({ [file]: lines.join('\n'), [`${TRIALS}/t0/summary.json`]: '{"trial": 0}\n' });
    const { r, m } = pass(repo);
    expect(r.status).toBe(EXIT.ok);
    const readers = m.readers.filter((x: any) => !x.prompt_file);
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      const whole = (reader.keep ?? []).includes(lit(file));
      const shown = reader.excerpt_file ? fs.readFileSync(reader.excerpt_file.file, 'utf8').includes('cred-mark-t0') : false;
      expect({ reader: reader.reader, reaches: whole || shown }).toEqual({ reader: reader.reader, reaches: true });
    }
  }, 300_000);
});

describe('a long credential line keeps its value in the excerpt', () => {
  const blob = Buffer.from('a private signing key that must never reach a results tree 0x5f3759df').toString('base64');
  const diffOf = (file: string, line: string) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,1 +1,2 @@', ' ok', '+' + line, ''].join('\n');
  // Value: protects=a credential value on a line past EXCERPT_LINE_MAX reaches readers (or its file goes whole) when another
  //   match already gave the line a window; fails_when=only the window around a gate tag is shown; why_new=/ship pass 2 on
  //   #4556 (security reader); seam=secretExcerpt with the predicate excerptOf passes
  test('a gate tag far from the credential does not hide it', () => {
    const line = '// eslint-disable-next-line ' + 'x'.repeat(900) + ' GH_TOKEN=' + blob + ' (cred-mark)';
    expect(secretValueLine('r/a.jsonl', line)).toBe(true);
    const x = secretExcerpt(diffOf('r/a.jsonl', line), ['r/a.jsonl'], secretValueSpans);
    expect({ whole: x.whole, shown: x.text.includes(blob) }).toEqual({ whole: [], shown: true });
  });
  // Value: protects=a value starting past the name's own 160-character window but inside secretValueLine's 200-character
  //   lookahead is shown; fails_when=the excerpt shows the name and cuts the value; why_new=/ship pass 2 on #4556 (red team);
  //   seam=secretExcerpt with the predicate excerptOf passes
  test('a value past the name window but inside the lookahead is shown', () => {
    const tok = 'Zq9Lm3Xv7Rt2Bn8Kp4Wd6Hs1Fg5';
    const line = 'x'.repeat(500) + ' k = process.env.DEMO_API_KEY || "' + 'y '.repeat(80) + tok + '"';
    expect(secretValueLine('r/a.jsonl', line)).toBe(true);
    const x = secretExcerpt(diffOf('r/a.jsonl', line), ['r/a.jsonl'], secretValueSpans);
    expect({ whole: x.whole, shown: x.text.includes(tok) }).toEqual({ whole: [], shown: true });
  });
});

describe('only allowlisted data files are cut, the same way in the plan and the receipt', () => {
  /** The plan's selection (gstack-review-plan --json) and the receipt's (reviewExclude on the commit, tags from gstack-gate-diff jsonl). */
  const both = (repo: FixtureRepo) => {
    const head = repo.git('rev-parse', 'HEAD');
    const baseSha = repo.git('rev-parse', 'origin/main');
    const planned = runBin(repo, 'gstack-review-plan', ['--base', 'main', '--json']);
    const scan = runBin(repo, 'gstack-gate-diff', [baseSha, '--format', 'jsonl']);
    const c = collectCommit(repo.work, baseSha, head);
    const receipt = reviewExclude({ root: repo.work, baseSha, ref: 'origin/main', mergeBase: c.mergeBase!, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged: taggedPaths(scan.out), context: 'test' });
    if (receipt.state === 'refused') expect({ status: planned.status, code: planned.err.includes(`(${receipt.code})`) }).toEqual({ status: EXIT.refused, code: true });
    else {
      expect(planned.status).toBe(0);
      const plan = JSON.parse(planned.out).review_exclude;
      expect(receipt.state === 'active' ? { digest: receipt.record.digest, excerpt: receipt.excerpt } : { state: receipt.state }).toEqual(plan?.state === 'active' ? { digest: plan.digest, excerpt: plan.excerpt } : { state: plan?.state ?? 'none' });
    }
    return receipt;
  };
  const tag = 'patched: // eslint-disable-next-line no-console';

  // Value: protects=a review_content_patterns declaration never qualifies a file to be cut, while an allowlisted data file
  //   beside it is cut, and the plan and the receipt agree; fails_when=a declared .out session is excerpted, or the two
  //   selections differ (RECEIPT_INVALID field=review_exclude); why_new=/ship's final review of #4556 (adversarial reader)
  //   and the allowlist rebuild; seam=gstack-review-plan and reviewExclude on a real repository
  test('a declared .out session stays whole; a results .jsonl beside it is cut', () => {
    const policy = JSON.stringify({ review_exclude_paths: ['docs/benchmarks/**'], review_content_patterns: ['docs/benchmarks/**/sessions/**'], min_gstack_version: REVIEW_CONTENT_KEY_VERSION }) + '\n';
    const repo = makeFixtureRepo({ prefix: 'gstack-gate-agree-', baseFiles: { '.gstack/ship-policy.json': policy } });
    repos.push(repo);
    const s0 = 'docs/benchmarks/demo/sessions/s0.out';
    const rows = `${TRIALS}/t0/session.jsonl`;
    const lines = Array.from({ length: 40 }, (_, n) => n === 5 ? tag : n === 9 ? 'read docs/benchmarks/demo/results/summary.json' : `turn ${n}`);
    commit(repo, { 'lib/run.js': "exports.run = () => 'ok';\n", [s0]: lines.join('\n') + '\n', [rows]: lines.map(l => JSON.stringify({ c: l })).join('\n') + '\n', 'docs/benchmarks/demo/results/summary.json': '{"ok": true}\n', 'docs/benchmarks/demo/results/other.json': '{"n": 1}\n' });
    const x = both(repo);
    expect(x.state === 'active' && x.excerpt).toEqual([lit(rows)]);
    expect(x.state === 'active' && x.keep.includes(lit(s0))).toBe(true);
  }, 120_000);

  // Value: protects=a declared .patch under test/, a .jsonl under test/ and a file renamed from code stay whole, so a tag only
  //   the floor or the old path gives (RH-1's focus and skip idioms) is never hidden behind a one-line tag; fails_when=any of
  //   them is excerpted; why_new=/ship's fifth review of #4556 (a floor-only RH-1 skip on a declared .patch under test/ behind
  //   a floor-free RH-1 line) and the allowlist rebuild; seam=gstack-review-plan and reviewExclude on a real repository
  test('a declared .patch under test/, a .jsonl under test/ and a renamed code file stay whole', () => {
    const policy = JSON.stringify({ review_exclude_paths: ['docs/benchmarks/**'], review_content_patterns: ['docs/benchmarks/**/test/**'], min_gstack_version: REVIEW_CONTENT_KEY_VERSION }) + '\n';
    const legacy = Array.from({ length: 30 }, (_, n) => `const step${n} = ${n};`);
    const repo = makeFixtureRepo({ prefix: 'gstack-gate-floor-', baseFiles: { '.gstack/ship-policy.json': policy, 'src/legacy.ts': legacy.join('\n') + '\n' } });
    repos.push(repo);
    const patch = 'docs/benchmarks/demo/test/fixtures/fix.patch';
    const underTest = 'docs/benchmarks/demo/test/rows.jsonl';
    const moved = `${TRIALS}/t1/legacy.jsonl`;
    const rows = `${TRIALS}/t0/session.jsonl`;
    const movedLines = [...legacy];
    movedLines[10] = "it.skip('the real gate', () => {});";
    movedLines[20] = tag;
    commit(repo, {
      'lib/run.js': "exports.run = () => 'ok';\n",
      [patch]: ['--- a/x.test.ts', '+++ b/x.test.ts', '@@ -1 +1 @@', "+test.only('focus', () => {});", "+it.skip('the real gate', () => {});", ''].join('\n'),
      [underTest]: JSON.stringify({ c: tag }) + '\n',
      'src/legacy.ts': null, [moved]: movedLines.join('\n') + '\n',
      [rows]: JSON.stringify({ c: tag }) + '\n',
      [`${TRIALS}/t0/summary.json`]: '{"ok": true}\n',
    });
    const x = both(repo);
    expect(x.state).toBe('active');
    if (x.state !== 'active') return;
    expect(x.excerpt).toEqual([lit(rows)]);
    for (const p of [patch, underTest, moved]) expect({ p, whole: x.keep.includes(lit(p)) }).toEqual({ p, whole: true });
  }, 120_000);

  // Value: protects=many cut files count toward the kept-file argument bound in the plan exactly as in the receipt;
  //   fails_when=the plan leaves cut files out of KEEP_ARG_MAX_BYTES and applies the pattern while the receipt refuses it;
  //   why_new=/ship's final review of #4556 (adversarial reader); seam=gstack-review-plan and reviewExclude on a real repository
  test('three hundred cut files reach the same verdict on the argument bound', () => {
    const repo = branch({});
    const files: Record<string, string> = { [`${TRIALS}/summary.json`]: '{"ok": true}\n' };
    for (let k = 0; k < 300; k++) files[`${TRIALS}/a-rather-long-trial-folder-name-for-the-bound-${k}/session.jsonl`] = JSON.stringify({ c: tag }) + '\n';
    commit(repo, files);
    expect(both(repo).state).toBe('refused');
  }, 120_000);
});

describe('REVIEW_DIFF_TOO_LARGE names files with spaces whole', () => {
  // Value: protects=the largest-files list names a path holding a space, a comma or a colon as one quoted field; fails_when=the
  //   name is cut at its first space or splits the files= field; why_new=GST-3273 rebuild; seam=tooLargeLine
  test('a path with a space is quoted in files= and named whole in the fix', () => {
    const p = 'docs/run 2/session.jsonl';
    const x = tooLargeLine('t', 'r', { bytes: 3_000_000, byDir: [['docs', 3_000_000]], byFile: [[p, 3_000_000], ['docs/b.jsonl', 10]] }, { state: 'none', base: 'main', source: 's' });
    expect(x.line).toContain(`files="${p}":3000000,docs/b.jsonl:10 `);
    expect(x.line).toContain(`largest files: ${p} (3000000 bytes)`);
  });

  // #4574 follow-up: a control character in a file or folder name must not break the one-line REVIEW_DIFF_TOO_LARGE output.
  test('a newline in a file or folder name is quoted everywhere the line names it', () => {
    const p = 'docs/run\n2/session.jsonl';
    const x = tooLargeLine('t', 'r', { bytes: 3_000_000, byDir: [['docs/run\n2', 3_000_000]], byFile: [[p, 3_000_000]] }, { state: 'none', base: 'main', source: 's' });
    expect(x.line).not.toContain('\n');
    expect(x.line).toContain(`top="docs/run\\n2":3000000 `);
    expect(x.line).toContain(`largest files: ${JSON.stringify(p)} (3000000 bytes)`);
  });
});
