/**
 * gstack-ship-receipt carry across a one-time unstamp-to-fragment commit, then gstack-ship-queue land --pin
 * (docs/ship-policy.md#carrying-a-receipt-across-a-base-merge-or-a-test-only-fix, GST-2245): a repo that moves from
 * stamp-at-/ship to merge: direct holds PRs whose /ship receipts cover their own VERSION, package.json version and
 * CHANGELOG entry. land refuses those stamps (QUEUE_LAND_STAMPED), so each PR gets one commit that puts VERSION,
 * package.json and CHANGELOG.md back at the merge base and moves the entry to changelog.d/<slug>.md. That commit
 * changes release metadata only, so the receipt carries to it and the PR lands without a fresh /ship: with no base
 * merge, after a clean base merge, and after a base merge whose stamp conflicts resolve to the base.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { POLICY, cleanupLandFixtures, land, markReady, remote, setupLandFixture, type Fx } from './helpers/land-direct-fixture';
import { runBin } from './helpers/restamp-fixture';

afterEach(cleanupLandFixtures);
const { merge: _merge, changelog_fragments: _fragments, min_gstack_version: _min, ...LEGACY } = POLICY;
const ENTRY = '- Retries a failed fetch four times\n';
const RETRY = 'exports.MAX_RETRIES = 4;\nexports.TIMEOUT_MS = 5000;\n';
type Mode = 'no base merge' | 'clean base merge' | 'conflicted base merge';

const put = (fx: Fx, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(fx.repo.work, rel)), { recursive: true });
    fs.writeFileSync(path.join(fx.repo.work, rel), text);
  }
};
const read = (fx: Fx, rel: string) => fs.readFileSync(path.join(fx.repo.work, rel), 'utf8');
const commitAll = (fx: Fx, message: string) => { fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', message); return fx.repo.git('rev-parse', 'HEAD'); };
const npmVersion = (fx: Fx, version: string) => put(fx, { 'package.json': read(fx, 'package.json').replace(/"version": "[^"]+"/, '"version": "' + version + '"') });
const stamp = (fx: Fx, version: string, note: string) => {
  put(fx, { VERSION: version + '.0\n', 'CHANGELOG.md': read(fx, 'CHANGELOG.md').replace('# Changelog\n', '# Changelog\n\n## [' + version + '.0] - 2026-11-01\n\n' + note) });
  npmVersion(fx, version);
};
const openPr = (fx: Fx, head: string, body: string) => {
  fx.repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/feat');
  fx.write(d => { d.prs['50'] = { state: 'OPEN', baseRefName: 'main', headRefName: 'feat', isCrossRepository: false, title: 'Retry a failed fetch four times', body: fs.readFileSync(body, 'utf8') }; });
  markReady(fx, '50', head);
};

/**
 * main at 1.2.3.0 under the stamp-at-/ship policy <- feat: four retries with its own 1.2.4.0 stamp (VERSION, package.json,
 * CHANGELOG), /ship receipt written there. main then (for a conflicted merge) ships another stamped PR as 1.2.5.0, adopts
 * merge: direct with changelog fragments and lands a fragment-only PR. feat merges main (unless 'no base merge'; a
 * stamp conflict takes main's files) and commits the unstamp: VERSION, CHANGELOG.md and package.json's version back at
 * the merge base, the entry in changelog.d/four-retries.md, plus any `extra` files.
 */
function unstamped(mode: Mode, extra: Record<string, string> = {}) {
  const fx = setupLandFixture(LEGACY);
  const { repo } = fx;
  repo.git('checkout', '-q', 'origin/main', '-B', 'feat');
  put(fx, { 'lib/retry.js': RETRY });
  stamp(fx, '1.2.4', ENTRY);
  const reviewed = commitAll(fx, 'feat: four retries (v1.2.4.0)');
  const body = path.join(repo.root, 'body.md');
  const written = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '50', '--base', 'main', '--version', '1.2.4.0', '--session-kind', 'unattended', '--body', body]);
  expect(written.status).toBe(EXIT.ok);
  repo.git('checkout', '-q', '--detach', 'origin/main');
  if (mode === 'conflicted base merge') {
    put(fx, { 'lib/other.js': 'exports.other = 1;\n' });
    stamp(fx, '1.2.5', '- another stamped PR\n');
    commitAll(fx, 'other (v1.2.5.0)');
  }
  put(fx, { '.gstack/ship-policy.json': JSON.stringify(POLICY, null, 2) + '\n', 'changelog.d/README.md': '# fragments\n', 'changelog.d/landed.md': '- landed under merge: direct\n', 'lib/landed.js': 'exports.landed = 1;\n' });
  commitAll(fx, 'main: merge direct with changelog fragments');
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  repo.git('checkout', '-q', 'feat');
  if (mode !== 'no base merge') {
    repo.git('fetch', '-q', 'origin');
    let conflicted = false;
    try { repo.git('merge', '-q', '--no-edit', 'origin/main'); } catch { conflicted = true; }
    expect(conflicted).toBe(mode === 'conflicted base merge');
    if (conflicted) {
      repo.git('checkout', 'origin/main', '--', 'VERSION', 'CHANGELOG.md', 'package.json');
      repo.git('add', '-A');
      repo.git('commit', '-q', '--no-edit');
    }
  }
  const mergeBase = repo.git('merge-base', 'origin/main', 'HEAD');
  repo.git('checkout', mergeBase, '--', 'VERSION', 'CHANGELOG.md');
  npmVersion(fx, JSON.parse(repo.git('show', mergeBase + ':package.json')).version);
  put(fx, { 'changelog.d/four-retries.md': ENTRY, ...extra });
  const head = commitAll(fx, 'Move the changelog entry to a fragment');
  return { fx, reviewed, head, body, main: remote(fx, 'main') };
}

describe('carry across an unstamp-to-fragment commit, then land --pin (GST-2245)', () => {
  for (const mode of ['no base merge', 'clean base merge', 'conflicted base merge'] as const) {
    // Value: protects=a PR shipped with its own version stamp lands under merge: direct after one unstamp commit and a
    // carry, with no fresh /ship (gbrain's ~50 stamped PRs); fails_when=carry reads the stamp files' return to the merge
    // base or the new fragment as product, or land rejects the carried receipt; seam=gh shim; no_claim=gh pr edit
    // (--body stands in), gstack-ship-queue ready (markReady stands in)
    test(mode + ': the receipt carries and the PR lands with main\'s VERSION and its entry as a fragment', () => {
      const { fx, reviewed, head, body, main } = unstamped(mode);
      openPr(fx, head, body);
      const stale = land(fx, '50', head);
      expect(stale.status).not.toBe(EXIT.ok);
      expect(stale.err).toContain(reviewed.slice(0, 12));
      expect(fx.read().mergeArgs).toBeUndefined();

      const carried = runBin(fx.repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
      expect(carried.err).not.toContain('RECEIPT_CARRY');
      expect(carried.status).toBe(EXIT.ok);
      expect(carried.out).toContain('CARRY: carried from ' + reviewed.slice(0, 12) + ' to ' + head.slice(0, 12));
      const receipt = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
      expect(receipt.head).toBe(head);
      expect(receipt.carry!.from).toBe(reviewed);
      expect(receipt.carry!.reason).toContain('release metadata');
      if (mode !== 'no base merge') expect(receipt.carry!.reason).toContain('base merge');

      openPr(fx, head, body);
      const landed = land(fx, '50', head);
      expect(landed.err).toBe('');
      expect(landed.status).toBe(EXIT.ok);
      expect(fx.read().mergeArgs).toEqual(['50', '--squash', '--match-head-commit', head, '--subject', 'Retry a failed fetch four times (#50)']);
      const merged = remote(fx, 'main');
      expect(landed.out).toContain('MERGED: #50 as ' + merged);
      expect(fx.repo.git('rev-parse', merged + '^1')).toBe(main);
      for (const rel of ['VERSION', 'CHANGELOG.md', 'package.json']) expect(fx.repo.git('show', merged + ':' + rel)).toBe(fx.repo.git('show', main + ':' + rel));
      expect(fx.repo.git('show', merged + ':changelog.d/four-retries.md')).toBe(ENTRY.trim());
      expect(fx.repo.git('show', merged + ':lib/retry.js')).toBe(RETRY.trim());
    }, 120_000);
  }

  // Value: protects=fail closed on a product edit riding the unstamp commit; fails_when=the metadata rule widens to the
  // whole commit, or land accepts a receipt bound to the stamped head; seam=gh shim; no_claim=gh pr edit
  test('a logic edit in the unstamp commit refuses the carry and the PR does not land', () => {
    const { fx, head, body, main } = unstamped('no base merge', { 'lib/retry.js': RETRY.replace('TIMEOUT_MS = 5000', 'TIMEOUT_MS = 50') });
    const carried = runBin(fx.repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(carried.status).toBe(EXIT.refused);
    expect(carried.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(carried.err).toContain('lib/retry.js');
    openPr(fx, head, body);
    expect(land(fx, '50', head).status).not.toBe(EXIT.ok);
    expect(fx.read().mergeArgs).toBeUndefined();
    expect(remote(fx, 'main')).toBe(main);
  }, 120_000);
});
