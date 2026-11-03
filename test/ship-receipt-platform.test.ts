import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { platformReceiptDepth, receiptDepthVerdict, receiptReviewAtHead } from '../lib/ship-receipt-depth';
import { REVIEW_POLICY_KEY_VERSION } from '../lib/ship-policy';
import { platformReviewAt } from '../lib/review-platform';
import type { ShipReceipt } from '../lib/headless-artifacts';

const BIN = path.join(import.meta.dir, '..', 'bin');
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 30_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

function repo(policy: object, files: Record<string, string>): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, '.gstack'));
  fs.writeFileSync(path.join(dir, '.gstack/ship-policy.json'), JSON.stringify({ min_gstack_version: REVIEW_POLICY_KEY_VERSION, ...policy }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-qb', 'feat');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'change');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

let fakeBin = '';
const withGh = <T,>(head: string, fn: () => T, state = 'COMMENTED'): T => {
  const prev = process.env.PATH, prevHead = process.env.FAKE_REVIEW_HEAD, prevState = process.env.FAKE_REVIEW_STATE;
  process.env.PATH = fakeBin + path.delimiter + prev; process.env.FAKE_REVIEW_HEAD = head; process.env.FAKE_REVIEW_STATE = state;
  try { return fn(); } finally {
    process.env.PATH = prev;
    if (prevHead === undefined) delete process.env.FAKE_REVIEW_HEAD; else process.env.FAKE_REVIEW_HEAD = prevHead;
    if (prevState === undefined) delete process.env.FAKE_REVIEW_STATE; else process.env.FAKE_REVIEW_STATE = prevState;
  }
};
let priorState: string | undefined;
beforeAll(() => {
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegh-'));
  priorState = process.env.GSTACK_STATE_ROOT;
  process.env.GSTACK_STATE_ROOT = path.join(fakeBin, 'state');
  fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\ncase "$1" in\n  pr) echo \'{"number":7}\' ;;\n  api) echo "[[{\\"id\\":98,\\"user\\":{\\"login\\":\\"capy-ai[bot]\\"},\\"commit_id\\":\\"$FAKE_REVIEW_HEAD\\",\\"state\\":\\"COMMENTED\\"},{\\"id\\":99,\\"user\\":{\\"login\\":\\"capy-ai[bot]\\"},\\"commit_id\\":\\"$FAKE_REVIEW_HEAD\\",\\"state\\":\\"$FAKE_REVIEW_STATE\\"}]]" ;;\nesac\n', { mode: 0o755 });
});
afterAll(() => { if (priorState === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = priorState; });

describe('C6 receipt: review_depth platform, honest and bound to the exact head (FOUN-63)', () => {
  test('a docs diff under review.platform on with capy-ai[bot]\'s review at HEAD records platform, and the queue accepts it at that head only', () => {
    const { dir, head } = repo({ review: { platform: 'on' } }, { 'docs/howto.md': 'Run the installer.\n' });
    const d = receiptReviewAtHead(dir, 'main', BIN, head).depth;
    expect([d.depth, d.mode]).toEqual(['light', 'panel']);
    const p = withGh(head, () => platformReceiptDepth(dir, 'main', d, head, '99'));
    expect(p.ok && [p.depth.depth, p.depth.mode, p.depth.platform_review]).toEqual(['platform', 'platform', { id: '99', head, reviewer: 'capy-ai[bot]' }]);
    const r = { gstack_version: REVIEW_POLICY_KEY_VERSION, review_depth: (p as any).depth } as ShipReceipt;
    expect(receiptDepthVerdict(dir, 'origin/main', r, head)).toMatchObject({ ok: true, line: expect.stringContaining('platform_review=99@') });
    const moved = { ...r, review_depth: { ...r.review_depth!, platform_review: { id: '99', head: 'b'.repeat(40), reviewer: 'capy-ai[bot]' } } } as ShipReceipt;
    expect(receiptDepthVerdict(dir, 'origin/main', moved, head).ok).toBe(false);
  });
  test('refused: platform review off, runtime code, a results path, a review at another head', () => {
    const off = repo({}, { 'docs/howto.md': 'x\n' });
    const dOff = receiptReviewAtHead(off.dir, 'main', BIN, off.head).depth;
    expect(withGh(off.head, () => platformReceiptDepth(off.dir, 'main', dOff, off.head, '99'))).toMatchObject({ ok: false, message: expect.stringContaining('review.platform on') });
    for (const files of [{ 'src/b.ts': 'export const b = 2;\n' }, { 'docs/results/summary.md': 'Ran it.\n' }] as Record<string, string>[]) {
      const { dir, head } = repo({ review: { platform: 'on' } }, files);
      const d = receiptReviewAtHead(dir, 'main', BIN, head).depth;
      expect(withGh(head, () => platformReceiptDepth(dir, 'main', d, head, '99')).ok).toBe(false);
    }
    const { dir, head } = repo({ review: { platform: 'on' } }, { 'docs/howto.md': 'x\n' });
    const d = receiptReviewAtHead(dir, 'main', BIN, head).depth;
    expect(withGh('c'.repeat(40), () => platformReceiptDepth(dir, 'main', d, head, '99'))).toMatchObject({ ok: false, message: expect.stringContaining('capy-ai[bot]') });
    for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) expect(withGh(head, () => platformReceiptDepth(dir, 'main', d, head, '99'), state).ok).toBe(false);
    expect(withGh(head, () => platformReceiptDepth(dir, 'main', d, head, '99'), 'APPROVED').ok).toBe(true);
    expect(withGh(head, () => platformReviewAt(dir, head), 'CHANGES_REQUESTED').ok).toBe(false);
    expect(withGh(head, () => platformReviewAt(dir, head))).toMatchObject({ ok: true, review: { id: '99' } });
    expect(withGh(head, () => platformReviewAt(dir, head, { id: '98' })).ok).toBe(false);
  });
  test('the receipt records the risk_paths class and the panel mode the base policy gives', () => {
    const { dir, head } = repo({ review: { risk_paths: ['src/balance/**'] } }, { 'src/balance/x.ts': 'export const x = 1;\n' });
    const d = receiptReviewAtHead(dir, 'main', BIN, head).depth;
    expect([d.depth, d.risk, d.mode]).toEqual(['full', ['policy'], 'panel']);
  });
});
