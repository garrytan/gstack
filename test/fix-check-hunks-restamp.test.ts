/**
 * GST-3523 (GBRA-741, gbrain#10057 run ship4): the pass program renders a fix-check brief, which records its hunks, and only
 * then takes the review-fix-check start. readFixCheckHunks attaches records written at or after the start, so the clean granted
 * fix-check's row carried no hunks and finish did not count it. Recording the start token now re-dates that render's record
 * while its digest still matches the hunks the brief carried.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fixListNames, hunksDigest, readFixCheckHunks, recordFixCheckHunks } from '../lib/review-evidence';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-review-dispatch');
const HUNKS = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function pass() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-restamp-'));
  dirs.push(root);
  expect(spawnSync('git', ['init', '-q', root], { encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
  const hunks = path.join(root, 'hunks.txt'), fixList = path.join(root, 'fixes.txt'), manifest = path.join(root, 'pass-manifest.json');
  fs.writeFileSync(hunks, HUNKS);
  fs.writeFileSync(fixList, 'fix p2/outside-voice#1\n');
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, readers: [], ledger: path.join(root, 'merged.jsonl'), fix_check: { fix_list: fixList, hunks, tests: hunks } }));
  recordFixCheckHunks(root, HUNKS, path.join(root, 'merged.jsonl'), 'fix p2/outside-voice#1\n');
  const mark = (key: string, token: string) => spawnSync(BIN, ['mark', '--manifest', manifest, '--log-start', key, '--token', token], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { root, hunks, mark };
}
const later = () => { const t = Date.now(); while (Date.now() <= t + 5) { /* the start follows the render */ } return new Date().toISOString(); };

// Value: protects=a clean granted fix-check rendered before its start still carries its hunks; fails_when=recording the start leaves the render's record dated before it
test('recording the review-fix-check start re-dates the record its render wrote', () => {
  const p = pass();
  const since = later();
  expect(readFixCheckHunks(p.root, since)).toBeUndefined();
  const r = p.mark('pass:review-fix-check', 't-1');
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('FIX_CHECK_HUNKS: restamped');
  expect(readFixCheckHunks(p.root, since)).toMatchObject({ ...hunksDigest(HUNKS), fix_list: ['p2/outside-voice#1'] });
});

// Value: protects=the record still names only the hunks the reader got; fails_when=a hunks file edited after the render is restamped as read
test('hunks edited after the render, a repeated start or another skill restamp nothing', () => {
  const edited = pass();
  fs.writeFileSync(edited.hunks, HUNKS + '+c\n');
  const since = later();
  expect(edited.mark('pass:review-fix-check', 't-1').stdout).toContain('FIX_CHECK_HUNKS: not restamped');
  expect(readFixCheckHunks(edited.root, since)).toBeUndefined();

  const other = pass();
  const s2 = later();
  expect(other.mark('pass:review', 't-1').stdout).not.toContain('FIX_CHECK_HUNKS');
  expect(readFixCheckHunks(other.root, s2)).toBeUndefined();
  expect(other.mark('pass:review-fix-check', 't-2').status).toBe(0);
  const s3 = later();
  expect(other.mark('pass:review-fix-check', 't-3').stdout).not.toContain('FIX_CHECK_HUNKS');
  expect(readFixCheckHunks(other.root, s3)).toBeUndefined();
});

// Value: protects=recording the start never fails over the hunks file; fails_when=a missing hunks file makes mark exit non-zero after
//   it saved the token, so a retry skips the restamp; seam=gstack-review-dispatch mark --log-start
test('a missing hunks file still records the start and says why nothing was restamped', () => {
  const p = pass();
  fs.rmSync(p.hunks);
  const r = p.mark('pass:review-fix-check', 't-1');
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('LOG_START: pass:review-fix-check token=t-1');
  expect(r.stdout).toContain('FIX_CHECK_HUNKS: not restamped (hunks file unreadable)');
});

// Value: protects=a grant whose findings are approval ids (ruled notes) keeps them in the recorded fix list (GST-3523, gbrain#10063,
//   grant a-b306fda9cc20); fails_when=fixListNames drops a-… ids, so the fix list is empty and clearByGrant closes nothing; seam=recordFixCheckHunks
test('the fix list keeps approval ids beside ledger ids and fingerprints, and nothing else', () => {
  expect(fixListNames('fix a-b306fda9cc20, p2/outside-voice#1 and src/x.ts:3:testing (see a-short, the a-b306fda9cc20 note).')).toEqual(['a-b306fda9cc20', 'p2/outside-voice#1', 'src/x.ts:3:testing']);
});
