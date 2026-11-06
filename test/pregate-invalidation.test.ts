/**
 * C8 invalidation: pregate.json is evidence only while it is current. A tree
 * that moved after the run, a failed or incomplete check, or a requires-remote
 * obligation without its receipt all reject publication — through
 * `gstack-pregate verify` and through `gstack-ship-receipt write --pregate`,
 * which is what /ship Step 18 calls. Pinned on result codes and exit codes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const run = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', ...args]);
const outFile = (repo: FixtureRepo) => path.join(repo.work, '.gstack/tmp/pregate.json');
const receipt = (repo: FixtureRepo, extra: string[] = []) => runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'interactive', '--pregate', outFile(repo), '--json', ...extra]);

describe('pregate invalidation', () => {
  test('a current green run verifies and lands in the ship receipt as pregate + requires_remote; a later edit makes it PREGATE_STALE for both', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    expect(run(repo, []).status).toBe(EXIT.ok);
    const v = runBin(repo, 'gstack-pregate', ['verify']);
    expect(v.status).toBe(EXIT.ok);
    expect(v.out).toMatch(/^PREGATE_VERIFY: ok pregate pass is current for tree [0-9a-f]{12}$/m);
    const ok = receipt(repo);
    expect(ok.status).toBe(EXIT.ok);
    const parsed = JSON.parse(ok.out);
    expect(parsed.pregate).toMatch(/^pass @[0-9a-f]{12} \(8 checks, current for [0-9a-f]{12}\)$/);
    expect(parsed.requires_remote).toBeUndefined();
    expect(Object.keys(parsed).indexOf('pregate')).toBeGreaterThan(Object.keys(parsed).indexOf('history') < 0 ? Object.keys(parsed).indexOf('session_kind') : Object.keys(parsed).indexOf('history'));
    // The stamp (or any edit) after the run moves the tree: the record is no longer evidence.
    write(repo.work, 'README.md', '# fixture 1.0.1\n');
    const stale = runBin(repo, 'gstack-pregate', ['verify']);
    expect(stale.status).toBe(EXIT.fail);
    expect(stale.err).toContain('(PREGATE_STALE)');
    expect(stale.out).toContain('PREGATE_VERIFY: refused PREGATE_STALE');
    const r = receipt(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toMatch(/nothing written.*\(PREGATE_STALE\)/);
    expect(r.out).toBe('');
    // Re-running on the moved tree makes it current again.
    expect(run(repo, []).status).toBe(EXIT.ok);
    expect(receipt(repo).status).toBe(EXIT.ok);
  }, 30_000);

  test('an uncleared requires-remote obligation is PREGATE_REMOTE_UNCLEARED until `clear` records a receipt, which the ship receipt then carries', () => {
    const repo = fixture();
    commit(repo, { 'test/windows-paths.test.js': "const test = require('node:test');\ntest('windows paths', () => { /* touched */ });\n" });
    expect(run(repo, []).status).toBe(EXIT.ok);
    const v = runBin(repo, 'gstack-pregate', ['verify']);
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toContain('(PREGATE_REMOTE_UNCLEARED)');
    expect(v.out).toContain('requires-remote: windows.yml/windows-shard (windows) 1 test(s) uncleared');
    const r = receipt(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_REMOTE_UNCLEARED)');
    expect(runBin(repo, 'gstack-pregate', ['clear', '--remote', 'nope.yml/job', '--run-url', 'https://example.invalid/runs/1']).status).toBe(EXIT.usage);
    const c = runBin(repo, 'gstack-pregate', ['clear', '--remote', 'windows.yml/windows-shard', '--run-url', 'https://github.com/o/r/actions/runs/42']);
    expect(c.status).toBe(EXIT.ok);
    expect(c.out).toContain('PREGATE_CLEARED: windows.yml/windows-shard receipt=https://github.com/o/r/actions/runs/42 verdict=requires-remote cleared');
    const persisted = JSON.parse(fs.readFileSync(outFile(repo), 'utf8'));
    expect(persisted.requires_remote[0]).toMatchObject({ lane: 'windows.yml/windows-shard', receipt: 'https://github.com/o/r/actions/runs/42' });
    expect(persisted.requires_remote[0].cleared_by).toMatch(/^gstack-pregate clear \d{4}-/);
    expect(runBin(repo, 'gstack-pregate', ['verify']).status).toBe(EXIT.ok);
    const ok = receipt(repo);
    expect(ok.status).toBe(EXIT.ok);
    expect(JSON.parse(ok.out)).toMatchObject({ pregate: expect.stringMatching(/^requires-remote cleared @/), requires_remote: ['windows.yml/windows-shard: https://github.com/o/r/actions/runs/42'] });
  }, 30_000);

  test('a failed check and an incomplete check both refuse publication; a missing or invalid pregate.json is not evidence', () => {
    const repo = fixture();
    commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.1.0' };\n" });
    expect(run(repo, ['--stage', 'preflight']).status).toBe(EXIT.fail);
    expect(runBin(repo, 'gstack-pregate', ['verify']).err).toContain('(PREGATE_LANE_FAILED)');
    expect(receipt(repo).err).toContain('(PREGATE_LANE_FAILED)');
    const inc = fixture();
    commit(inc, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    expect(runBin(inc, 'gstack-pregate', ['--base', 'main']).status).toBe(EXIT.fail);
    expect(runBin(inc, 'gstack-pregate', ['verify']).err).toContain('(PREGATE_INCOMPLETE)');
    expect(receipt(inc).err).toContain('(PREGATE_INCOMPLETE)');
    const none = fixture();
    expect(runBin(none, 'gstack-pregate', ['verify']).err).toContain('(PREGATE_STALE)');
    fs.mkdirSync(path.dirname(outFile(none)), { recursive: true });
    fs.writeFileSync(outFile(none), '{"schema_version": 1}\n');
    const bad = receipt(none);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('(ARTIFACT_SCHEMA)');
  }, 30_000);

  // Value: protects=every record gstack-pregate writes (run and clear) is mirrored byte for byte to <state root>/pregate/by-tree/<tree>.json, the path
  // gstack-ship-queue ready reads for a checkout that did not run the pregate, and a state root that cannot be written still leaves the record and
  // the exit code untouched; fails_when=the mirror is missing, lands under another path or name, holds different bytes than the record, is not
  // refreshed by clear, or an unwritable state root fails the run; why_new=the ship-queue test writes the mirror by hand and covers only the reader;
  // seam=none; no_claim=a second checkout reading it (test/gstack-ship-queue.test.ts covers ready)
  test('run and clear mirror the record to <state root>/pregate/by-tree/<tree>.json; an unwritable state root never fails the record', () => {
    const repo = fixture();
    commit(repo, { 'test/windows-paths.test.js': "const test = require('node:test');\ntest('windows paths', () => { /* touched */ });\n" });
    expect(run(repo, []).status).toBe(EXIT.ok);
    const record = fs.readFileSync(outFile(repo), 'utf8');
    const tree = (JSON.parse(record) as { tree: string }).tree;
    expect(tree).toMatch(/^[0-9a-f]{12,128}$/);
    const mirror = path.join(repo.home, 'pregate', 'by-tree', `${tree}.json`);
    expect(fs.readdirSync(path.join(repo.home, 'pregate', 'by-tree'))).toEqual([`${tree}.json`]);
    expect(fs.readFileSync(mirror, 'utf8')).toBe(record);
    expect(runBin(repo, 'gstack-pregate', ['clear', '--remote', 'windows.yml/windows-shard', '--run-url', 'https://github.com/o/r/actions/runs/42']).status).toBe(EXIT.ok);
    const cleared = fs.readFileSync(outFile(repo), 'utf8');
    expect(cleared).not.toBe(record);
    expect(fs.readFileSync(mirror, 'utf8')).toBe(cleared);
    expect(JSON.parse(fs.readFileSync(mirror, 'utf8')).requires_remote[0].receipt).toBe('https://github.com/o/r/actions/runs/42');

    const blocked = path.join(repo.root, 'not-a-dir');
    fs.writeFileSync(blocked, 'a file where the state root should be\n');
    const unwritable = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands'], { GSTACK_STATE_ROOT: path.join(blocked, 'root') });
    expect(unwritable.status, unwritable.out + unwritable.err).toBe(EXIT.ok);
    expect(unwritable.err).not.toMatch(/ENOTDIR|EACCES|by-tree/);
    expect(JSON.parse(fs.readFileSync(outFile(repo), 'utf8')).tree).toBe(tree);
    expect(fs.existsSync(path.join(blocked, 'root'))).toBe(false);
    expect(fs.readFileSync(mirror, 'utf8')).toBe(cleared);
  }, 120_000);
});
