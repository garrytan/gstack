/**
 * Train 24 (2026-10-27, gate.train-6d8c948d5409): in both slots `gstack-restamp
 * --next` listed lib/ship-policy.ts as a fifth stamp file and moved main's own
 * `DOCS_CAPS_KEY_VERSION = '1.91.270.0'` (#3511, released at 1.91.275.0) to the
 * slot's version. The pin (234227fc4) had forked from 1.91.274.0 and the lane had
 * merged base f8d0ab03 into it uncommitted, so HEAD still forked before #3511 and
 * the stamp_paths stage, which counts the branch's own lines from
 * merge-base(base, HEAD), read the base's key line as the branch's tentative
 * mention. The stage now leaves out every line the base added since that fork
 * point. #3514's receipt bound (`stampOnlyLine`: a moved version not older than
 * the gated tree's VERSION) refuses that move after the fact only while the key
 * names a release older than the base at the build; a key at the base version
 * passes it, so the restamp itself must not make the move.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { mergeChangelogs } from '../lib/changelog-check';
import { branchAddedLines } from '../lib/restamp';
import { stampOnlyLine } from '../lib/stamp-only';
import { gitArgvIn } from './helpers/scratch-repo';
import { BASE_POLICY, cleanup, makeFixtureRepo, makePr, readFile, restamp, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const TEMPLATES = ["_KEY_VERSION = '{version}'"];
const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], stamp_paths: ['docs/**/*.md', 'src/**/*.ts'], stamp_patterns: TEMPLATES };
const stageDetail = (out: string, name: string) => new RegExp(`^stage ${name}: (\\w+)(?: \\((.*)\\))?$`, 'm').exec(out);
const key = (name: string, v: string) => `export const ${name}_KEY_VERSION = '${v}';\n`;

function write(repo: FixtureRepo, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo.work, rel), text);
}

/** A release landed on main by hand (what a slot stamp leaves behind): VERSION, the manifest, a CHANGELOG heading, plus any files. */
function releaseOnMain(repo: FixtureRepo, v: string, files: Record<string, string> = {}): string {
  repo.git('checkout', '-q', 'main');
  write(repo, 'VERSION', v + '\n');
  const pkg = JSON.parse(readFile(repo, 'package.json'));
  pkg.version = v.split('.').slice(0, 3).join('.');
  write(repo, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
  write(repo, 'CHANGELOG.md', readFile(repo, 'CHANGELOG.md').replace('# Changelog\n', `# Changelog\n\n## [${v}] - 2026-10-27\n\n- release ${v}\n`));
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  repo.git('add', '-A');
  repo.git('commit', '-qm', `v${v}`);
  repo.git('push', '-q', 'origin', 'main');
  return repo.git('rev-parse', 'HEAD');
}

/** The lane's slot state: origin/main merged into the pin and left uncommitted, the CHANGELOG resolved with mergeChangelogs. */
function mergeMainUncommitted(repo: FixtureRepo): void {
  const r = gitArgvIn(repo.work, ['merge', '--no-ff', '--no-commit', 'origin/main'], 30_000, { ...process.env, ...repo.env });
  const conflicts = repo.git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  expect([r.status === 0 ? [] : conflicts]).toEqual([r.status === 0 ? [] : ['CHANGELOG.md']]);
  if (conflicts.length) {
    const merged = mergeChangelogs(repo.git('show', ':2:CHANGELOG.md') + '\n', repo.git('show', ':3:CHANGELOG.md') + '\n', repo.git('show', ':1:CHANGELOG.md') + '\n');
    expect(merged).not.toBeNull();
    write(repo, 'CHANGELOG.md', merged!);
    repo.git('add', 'CHANGELOG.md');
  }
  expect(fs.existsSync(path.join(repo.work, '.git', 'MERGE_HEAD'))).toBe(true);
}

describe('stamp_paths: a key the base introduced after the fork stays, base merge committed or not (train 24)', () => {
  // fails_when=the stamp_paths stage moves a *_KEY_VERSION line that came in with the uncommitted base merge, or lists its file; why_new=every earlier fixture committed the base merge or never merged it, and both read the branch's own lines correctly; seam=none (real git, real restamp); no_claim=what the receipt says about a stamp that was already committed
  test.each([
    ['a key naming an older release (train 24: 1.91.270.0 under base 1.91.275.0), which #3514\'s receipt bound also refuses after the fact', '1.2.4.0', false],
    ['a key at the base version itself, which the receipt bound alone would accept as a stamp', '1.2.5.0', true],
  ])('%s', (_, keyVersion, receiptAccepts) => {
    const repo = makeFixtureRepo({ prefix: 'restamp-train24-', policy: POLICY }); repos.push(repo);
    // The pin: forked at 1.2.3.0, with its own tentative key (newer than its fork) that the stamp must move.
    makePr(repo, 'pr-mine');
    write(repo, 'src/mine.ts', key('MINE', '1.2.9.0'));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'my key');
    // Main moves on: 1.2.4.0, then 1.2.5.0 carrying the base's own key (#3511's shape).
    releaseOnMain(repo, '1.2.4.0');
    releaseOnMain(repo, '1.2.5.0', { 'src/policy.ts': key('DOCS_CAPS', keyVersion) });
    repo.git('checkout', '-q', 'pr-mine');
    mergeMainUncommitted(repo);
    expect(readFile(repo, 'src/policy.ts')).toBe(key('DOCS_CAPS', keyVersion));

    const dry = restamp(repo, ['--next', '--dry-run']);
    expect([dry.status, dry.err]).toEqual([EXIT.ok, '']);
    expect(dry.out).toContain('RESTAMP: 1.2.5.0 -> 1.2.6.0 (dry-run;');
    expect(dry.out).toMatch(/^FILES: CHANGELOG.md VERSION package-lock.json package.json src\/mine.ts$/m);
    expect(dry.out).not.toMatch(/^[-+].*DOCS_CAPS_KEY_VERSION/m);
    expect(dry.out).toMatch(/^-export const MINE_KEY_VERSION = '1\.2\.9\.0';$/m);
    expect(dry.out).toMatch(/^\+export const MINE_KEY_VERSION = '1\.2\.6\.0';$/m);
    const sp = stageDetail(dry.out, 'stamp_paths')!;
    expect(sp[1]).toBe('done');
    expect(sp[2]).toContain('1 mention(s) in 1 file(s) (1.2.9.0 -> 1.2.6.0)');
    expect(sp[2]).toContain("1 line(s) the base added since the fork point are the base's, not this branch's, and stay (src/policy.ts: 1)");

    // The same merge committed (the documented slot sequence) reads the same way.
    repo.git('commit', '-qm', 'merge main');
    const committed = restamp(repo, ['--next', '--dry-run']);
    expect([committed.status, committed.err]).toEqual([EXIT.ok, '']);
    expect(committed.out).toMatch(/^FILES: CHANGELOG.md VERSION package-lock.json package.json src\/mine.ts$/m);
    expect(committed.out).toMatch(/^\+export const MINE_KEY_VERSION = '1\.2\.6\.0';$/m);
    expect(stageDetail(committed.out, 'stamp_paths')![2]).not.toContain('the base added since the fork point');

    // #3514's claim, checked against this shape: the receipt (gated tree at the base version 1.2.5.0) refuses the
    // moved older key, but a key at the base version passes its bound, so only the restamp fix keeps it in place.
    const moved = stampOnlyLine(key('DOCS_CAPS', keyVersion).trim(), key('DOCS_CAPS', '1.2.6.0').trim(), '1.2.5.0', '1.2.6.0', TEMPLATES);
    expect(moved).toBe(receiptAccepts);
  }, 120_000);

  // Value: protects=the base-added read fails closed; fails_when=a diff git cannot run reads as "nothing added" and the base's key line moves again (red-team review of GSTA-129); why_new=the test above only runs the stage with a readable base; seam=none; no_claim=which git errors occur in practice
  test('a base diff git cannot run is a refusal, never an empty "nothing added" set', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-train24-', policy: POLICY }); repos.push(repo);
    expect(branchAddedLines(repo.work, 'HEAD', ['VERSION'], 'HEAD').size).toBe(0);
    expect(() => branchAddedLines(repo.work, 'HEAD', ['VERSION'], 'f'.repeat(40))).toThrow(/^cannot diff HEAD\.\.ffffffffffff for the stamp_paths stage \(.+\); nothing written$/);
  });
});
