/**
 * review_exclude_paths on a results PR whose only reader of the data is a hash or pin manifest (HARN-64, harness-evals#538):
 * the manifest named all 2,140 matched files by full path, so the exclusion's name scan kept every one as named-by-code
 * (and git grep -o over 2,140 strings ran past its 120 s bound first), and the review refused a 13.3 MB diff. A manifest of
 * digest-and-path lines names files without reading them; a real code file, or a manifest with any other line, still keeps
 * what it names. The consumer-scan cap gets an override and a plan line naming both remedies.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CONSUMER_SCAN_CAP, consumerScanCap } from '../lib/review-collect';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const H = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const DATA = ['data/run/a.json', 'data/run/b.json'];
function repoWith(extra: Record<string, string>) {
  const repo = makeFixtureRepo({ prefix: 'gstack-xpin-', baseFiles: { '.gstack/ship-policy.json': JSON.stringify({ review_exclude_paths: ['data/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n' } });
  repos.push(repo);
  commit(repo, { 'data/run/a.json': '{"score": 1}\n', 'data/run/b.json': '{"score": 2}\n', ...extra });
  return repo;
}
const planned = (repo: FixtureRepo, env: Record<string, string> = {}) => {
  const r = runBin(repo, 'gstack-review-plan', ['--base', 'main', '--json'], env);
  expect(r.status, r.err).toBe(0);
  const x = JSON.parse(r.out).review_exclude;
  return { excluded: x.excluded as number, kept: Object.fromEntries((x.kept_files as Array<{ path: string; reason: string }>).map(k => [k.path, k.reason])) };
};
const manifest = (lines: string[] = []) => [...DATA.map((p, i) => `${H(i)}  ${p}`), ...lines].join('\n') + '\n';

describe('a hash or pin manifest does not keep the files it lists (HARN-64)', () => {
  // Value: protects=a results PR whose pins.sha256 lists its matched data still gets review_exclude_paths; fails_when=the
  //   manifest counts as code naming every listed file (harness-evals#538 kept 2,140 files and refused 13.3 MB); why_new=HARN-64;
  //   seam=gstack-review-plan --json on a real repository; no_claim=the scan's speed on large trees (measured on #538 instead)
  test('files a pins.sha256 lists are still excluded', () => {
    expect(planned(repoWith({ 'docs/run/pins.sha256': manifest() }))).toEqual({ excluded: 2, kept: {} });
  }, 120_000);

  // Value: protects=a code file that names a data file still keeps it, beside a manifest (negative control); fails_when=the
  //   manifest rule widens to every consumer; seam=gstack-review-plan --json
  test('a code file naming a listed file still keeps it in review', () => {
    expect(planned(repoWith({ 'docs/run/pins.sha256': manifest(), 'lib/load.ts': "export const f = 'data/run/a.json';\n" }))).toEqual({ excluded: 1, kept: { 'data/run/a.json': 'named-by-code' } });
  }, 120_000);

  // Value: protects=a manifest-shaped file with any other line is read as a consumer (negative control); fails_when=a few digest
  //   lines exempt a file that also carries code or prose; seam=gstack-review-plan --json
  // Value: protects=the scan still reads consumer names when git is set to color grep output; fails_when=git grep -l wraps names
  //   in ANSI escapes, every lookup misses and each file stays as consumer-scan-unavailable; why_new=the -l call lost --no-color;
  //   seam=gstack-review-plan --json with color.grep=always from GIT_CONFIG_*; no_claim=other color.* settings
  test('files a pins.sha256 lists are still excluded when git colors grep output', () => {
    expect(planned(repoWith({ 'docs/run/pins.sha256': manifest() }), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'color.grep', GIT_CONFIG_VALUE_0: 'always' })).toEqual({ excluded: 2, kept: {} });
  }, 120_000);

  test('a manifest with a code line keeps what it names', () => {
    expect(planned(repoWith({ 'docs/run/pins.sha256': manifest(['run(process.argv[2])']) }))).toEqual({ excluded: 0, kept: { 'data/run/a.json': 'named-by-code', 'data/run/b.json': 'named-by-code' } });
  }, 120_000);
});

describe('the consumer-scan cap reads GSTACK_REVIEW_CONSUMER_SCAN_CAP and names both remedies (HARN-64)', () => {
  // Value: protects=the cap keeps its default and bounds and the plan says what a tripped cap did and how to lift it; fails_when=
  //   an invalid value moves the cap, the override is ignored, or a tripped cap is silent; seam=consumerScanCap and the plan text
  test('the override, its bounds and the plan line', () => {
    const saved = process.env.GSTACK_REVIEW_CONSUMER_SCAN_CAP;
    try {
      const at = (v: string | undefined) => { if (v === undefined) delete process.env.GSTACK_REVIEW_CONSUMER_SCAN_CAP; else process.env.GSTACK_REVIEW_CONSUMER_SCAN_CAP = v; return consumerScanCap(); };
      expect(CONSUMER_SCAN_CAP).toBe(2000);
      for (const v of [undefined, '', 'many', '0', '-3']) expect(at(v), String(v)).toBe(2000);
      expect(at('5000')).toBe(5000);
      expect(at('1.9')).toBe(1);
    } finally { if (saved === undefined) delete process.env.GSTACK_REVIEW_CONSUMER_SCAN_CAP; else process.env.GSTACK_REVIEW_CONSUMER_SCAN_CAP = saved; }
    const repo = repoWith({});
    const capped = runBin(repo, 'gstack-review-plan', ['--base', 'main'], { GSTACK_REVIEW_CONSUMER_SCAN_CAP: '1' });
    expect(capped.status, capped.err).toBe(0);
    expect(capped.out).toContain('CONSUMER_SCAN: skipped: more than 1 data files changed');
    expect(capped.out).toContain('set GSTACK_REVIEW_CONSUMER_SCAN_CAP above that count, or move the data into its own PR');
    expect(runBin(repo, 'gstack-review-plan', ['--base', 'main']).out).not.toContain('CONSUMER_SCAN:');
  }, 120_000);
});
