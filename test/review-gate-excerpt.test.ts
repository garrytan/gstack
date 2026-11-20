/**
 * Gate-tagged data excerpts (GST-3273, harness-evals#494): a data file review_exclude_paths matches and keeps only because the
 * gate scan tagged a changed line by its content (a suppression pragma or an env check quoted inside a captured agent
 * transcript) goes to pass readers as every tagged line with context, the way secret-line files do (GST-1447). Code files,
 * files the gate scan tagged by their path (a snapshot) and files whose tags no single line carries stay whole, and a diff
 * still over the ceiling names its largest files.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { REVIEW_DIFF_MAX_BYTES, gateScanPaths } from '../lib/review-exclude';
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
  //   data file is sent whole (REVIEW_DIFF_TOO_LARGE, harness-evals#494: 25 files, 12.3 MB), a tagged line is missing, or
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
    files[code] = '// eslint-disable-next-line no-console\nexport const score = (n: number) => n * 2;\n';
    files[snapshot] = '{"score": 2}\n';
    files[spanning] = 'step 1\ntry { run() } catch (e) {\n}\nstep 2\n';
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
      expect([...(reader.keep ?? [])].sort()).toEqual([code, snapshot, spanning].sort().map(lit));
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

  // Value: protects=a diff still over the ceiling after the cut tells the lane which files to move, not only "split";
  //   fails_when=REVIEW_DIFF_TOO_LARGE names folders alone; why_new=GST-3273 (#494's only printed fix was "split the PR");
  //   seam=gstack-review-dispatch pass on a real repository
  test('a diff still over the ceiling after the cut names its largest files', () => {
    const line = (k: number, n: number) => JSON.stringify({ role: 'tool', content: `// eslint-disable-next-line f${k} n${n} ${'x'.repeat(200)}` });
    const files: Record<string, string> = {};
    for (let k = 0; k < 3; k++) {
      files[`${TRIALS}/big${k}/session.jsonl`] = Array.from({ length: 3600 + k * 100 }, (_, n) => line(k, n)).join('\n') + '\n';
      files[`${TRIALS}/big${k}/summary.json`] = `{"trial": ${k}}\n`;
    }
    const repo = branch(files);
    const { r } = pass(repo);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('REVIEW_DIFF_TOO_LARGE');
    const m = /files=(\S+)/.exec(r.err);
    expect(m?.[1]?.split(',').slice(0, 3).map(f => f.replace(/:\d+$/, ''))).toEqual([2, 1, 0].map(k => `${TRIALS}/big${k}/session.jsonl`));
    expect(r.err).toContain(`largest files: ${TRIALS}/big2/session.jsonl`);
  }, 300_000);
});

describe('gateScanPaths', () => {
  // Value: protects=only a file whose every tag sits on one added line, outside the floor, counts as tagged by content;
  //   fails_when=a path tag (RH-3), a renamed file or a hunk-level tag (RH-16 across lines) is treated as content;
  //   why_new=GST-3273; seam=none
  test('splits tagged paths from paths tagged by content alone', () => {
    const rec = (p: Record<string, unknown>) => JSON.stringify({ id: 'x', level: 'listed', old: [], citation: null, ...p });
    const out = ['GATE_SUMMARY: tagged={RH-3:1}',
      rec({ path: 'r/a.jsonl', tags: ['RH-13'], new: ['plain', '// eslint-disable-line'] }),
      rec({ path: 'r/a.jsonl', tags: [], new: ['plain'] }),
      rec({ path: 'r/__snapshots__/s.json', tags: ['RH-3'], new: ['{}'] }),
      rec({ path: 'r/moved.jsonl', old_path: 'src/moved.ts', tags: ['RH-13'], new: ['// eslint-disable-line'] }),
      rec({ path: 'r/span.log', tags: ['RH-16'], new: ['try { x() } catch (e) {', '}'] }),
      rec({ path: 'r/both.jsonl', tags: ['RH-13'], new: ['// eslint-disable-line'] }),
      rec({ path: 'r/both.jsonl', tags: ['RH-16'], new: ['catch (e) {', '}'] }),
      ''].join('\n');
    const g = gateScanPaths(out);
    expect([...g.tagged].sort()).toEqual(['r/__snapshots__/s.json', 'r/a.jsonl', 'r/both.jsonl', 'r/moved.jsonl', 'r/span.log']);
    expect([...g.content]).toEqual(['r/a.jsonl']);
  });
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

