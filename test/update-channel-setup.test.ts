/**
 * New installs default to the stable channel (docs/releases.md#channels,
 * GST-1642): the real ./setup on a fresh state root records update_channel
 * stable for a user's clone, records nothing for a contributor checkout or an
 * existing install (auto, which follows main), and records an explicit
 * GSTACK_UPDATE_CHANNEL as given. The checkout is a real git clone of a
 * file:// origin built from the install fixture's source.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, runSetup, type Fixture } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const STUB_MTIME = new Date('2040-01-01');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1' };

/** A fixture whose gstack install is a git clone of a file:// origin; fresh drops the fixture's preset config.yaml (a first install). */
function cloned(opts: { fresh: boolean; branch?: string }) {
  const f = makeFixture();
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...f.env, ...GIT_ENV } }).trim();
  const staging = makeSource(f, join(f.dir, 'staging'));
  git(staging, 'init', '-q', '-b', 'main');
  git(staging, 'add', '-A', '-f');
  git(staging, 'commit', '-q', '-m', 'seed');
  const origin = join(f.dir, 'origin.git');
  git(f.dir, 'clone', '-q', '--bare', staging, origin);
  const src = join(f.home, '.claude/skills/gstack');
  git(f.dir, 'clone', '-q', '--single-branch', '--depth', '1', `file://${origin}`, src);
  // A clone stamps every file with the clone time; the fixture's stub binaries must stay newer than their sources, or setup rebuilds them.
  for (const rel of ['browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf', 'browse/dist/.build-complete']) utimesSync(join(src, rel), STUB_MTIME, STUB_MTIME);
  if (opts.branch) git(src, 'checkout', '-q', '-b', opts.branch);
  if (opts.fresh) rmSync(join(f.home, '.gstack/config.yaml'));
  const setup = (env: Record<string, string> = {}) => {
    const r = runSetup(f, join(src, 'setup'), [], { env: { ...GIT_ENV, ...env } });
    return { ...r, out: r.stdout + r.stderr };
  };
  const channel = () => spawnSync('bash', [join(src, 'bin/gstack-update-channel.sh'), src], { env: f.env, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
  const key = () => spawnSync(join(src, 'bin/gstack-config'), ['get', 'update_channel'], { env: f.env, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
  return { f, src, setup, channel, key };
}
const onlyLine = (out: string) => out.split('\n').filter(l => l.startsWith('Update channel:'));

describe.skipIf(process.platform === 'win32')('./setup: the update channel a first install records', () => {
  // Value: protects=a fresh git clone on the default branch, set up on a fresh state root, follows stable and says so once, with the command to switch;
  // fails_when=setup records nothing (new installs keep following main), records too late (after another config write marks the install existing),
  // or prints no switch command; why_new=GST-1642 makes stable the default for new installs; seam=install fixture, file:// origin; no_claim=GitHub's origin
  test('a fresh non-contributor clone records stable, prints the channel and the switch command once, and a rerun keeps it', () => {
    const c = cloned({ fresh: true });
    const r = c.setup();
    expect(r.status, r.out).toBe(0);
    expect(c.key()).toBe('stable');
    expect(c.channel()).toBe('stable');
    expect(onlyLine(r.out)).toEqual([`Update channel: stable (new install). Switch: ${c.src}/bin/gstack-config set update_channel main (docs/releases.md#channels)`]);
    const again = c.setup();
    expect(again.status, again.out).toBe(0);
    expect(onlyLine(again.out)).toEqual([]);
    expect(c.channel()).toBe('stable');
  }, 180_000);

  // Value: protects=a contributor checkout (here: on a branch other than origin's default) keeps auto, so it follows main, and setup says why;
  // fails_when=a contributor's checkout is moved to stable; why_new=new detection (GST-1642); seam=install fixture; no_claim=every signal (unit-tested)
  test('a contributor checkout records nothing and follows main', () => {
    const c = cloned({ fresh: true, branch: 'work' });
    const r = c.setup();
    expect(r.status, r.out).toBe(0);
    expect(c.key()).toBe('auto');
    expect(c.channel()).toBe('main');
    expect(onlyLine(r.out)).toEqual([`Update channel: main (contributor checkout: on branch work). Switch: ${c.src}/bin/gstack-config set update_channel stable (docs/releases.md#channels)`]);
  }, 180_000);

  // Value: protects=an existing install whose config says auto (or nothing) keeps following main with no message; fails_when=setup or an upgrade's
  // setup silently moves an existing install to stable; why_new=GST-1642 must not switch existing installs; seam=the fixture's preset config.yaml;
  // no_claim=installs whose state root was deleted (they read as new)
  test('an existing install (config.yaml present, no update_channel) records nothing, prints nothing and follows main', () => {
    const c = cloned({ fresh: false });
    const r = c.setup();
    expect(r.status, r.out).toBe(0);
    expect(c.key()).toBe('auto');
    expect(c.channel()).toBe('main');
    expect(onlyLine(r.out)).toEqual([]);
  }, 180_000);

  // Value: protects=GSTACK_UPDATE_CHANNEL=main at first install is recorded, so later commands without the variable still follow main (how a Capy
  // session's setup leaves a fresh machine); fails_when=a fresh install made under the main pin records stable; why_new=GST-1642; seam=install fixture;
  // no_claim=the Capy wrapper itself (capy-skill-wrapper.test.ts)
  test('GSTACK_UPDATE_CHANNEL=main at first install records main', () => {
    const c = cloned({ fresh: true });
    const r = c.setup({ GSTACK_UPDATE_CHANNEL: 'main' });
    expect(r.status, r.out).toBe(0);
    expect(c.key()).toBe('main');
    expect(c.channel()).toBe('main');
    expect(existsSync(join(c.f.home, '.gstack/.last-setup-version'))).toBe(true);
    expect(onlyLine(r.out)).toEqual([`Update channel: main (set by GSTACK_UPDATE_CHANNEL at install). Switch: ${c.src}/bin/gstack-config set update_channel stable (docs/releases.md#channels)`]);
  }, 180_000);
});
