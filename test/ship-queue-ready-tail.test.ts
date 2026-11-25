/**
 * The READY tail's last two template gaps (#4529, #4575, #4578): the Attention section printed
 * "<flags against decision-trail row numbers, or No flags>" for the lane to fill, and TRIAL_MERGES listed outside fork PRs such as
 * #4499 as conflicts a lane must resolve. The Attention section now opens with the receipt's risk class (the cross-family trail
 * read left with the decision trail in GST-3562 part 4), and a fork PR is labelled and never fetched or merged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trialMergeLines } from '../lib/ship-queue';
import type { ShipReceipt } from '../lib/headless-artifacts';
import { readyTailLines } from '../lib/ship-receipt';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ready-tail-')); dirs.push(d); return d; };
const GATE = { review_depth: { class: 'gate', risk: [] } } as unknown as ShipReceipt;
const MONEY = { review_depth: { class: 'code', risk: ['money'] } } as unknown as ShipReceipt;
const CODE = { review_depth: { class: 'code', risk: [] } } as unknown as ShipReceipt;
const attention = (r: ShipReceipt | undefined) => { const l = readyTailLines(r, { trialMerges: ['TRIAL_MERGES: none share a file (0 open PRs checked)'] }); return l.slice(l.indexOf('Attention:') + 1); };

describe('the Attention section opens with the risk class and no template line (#4529, GST-3562 part 4)', () => {
  // Value: protects=READY never prints the flags placeholder or a trail-read requirement: the Attention section is one line naming
  //   the receipt's risk class, and the lane lists what needs a decision under it; fails_when=the placeholder line or the MISSING
  //   trail read comes back; why_new=lanes pasted the placeholder on #4529, #4575 and #4578; seam=readyTailLines as ready calls it
  test('one risk-class line, never a placeholder or a trail-read requirement', () => {
    expect(attention(GATE)).toEqual(['risk class: gate']);
    expect(attention(MONEY)).toEqual(['risk class: money']);
    expect(attention(CODE)).toEqual(['not a risk class']);
    expect(attention({} as ShipReceipt)).toEqual(['risk class unknown: the receipt records no review_depth']);
    for (const r of [GATE, CODE]) expect(readyTailLines(r).join('\n')).not.toMatch(/<flags against|trail read|trail-read/);
  });
});

describe('TRIAL_MERGES labels an outside fork PR instead of merging it (#4499)', () => {
  // Value: protects=an outside PR from a fork that shares a file is named as outside and never fetched or merged, while a sibling lane
  //   is still trial-merged; fails_when=a fork PR is listed as a CONFLICT the lane must resolve, or its head is fetched; why_new=#4529,
  //   #4575 and #4578 listed #4499 as a real conflict; seam=trialMergeLines with a gh stub
  test('a fork PR sharing a file is labelled; a sibling sharing the same file is still merged', () => {
    const root = tmp();
    const git = (...a: string[]) => { const r = spawnSync('git', ['-c', 'user.name=Fx', '-c', 'user.email=fx@example.com', ...a], { cwd: root, encoding: 'utf8', timeout: 30_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    const branch = (name: string, text: string) => { git('checkout', '-q', '-b', name, 'main'); fs.writeFileSync(path.join(root, 'a.txt'), text); git('commit', '-q', '-am', name); return git('rev-parse', 'HEAD'); };
    const sibling = branch('sib', 'sibling\n');
    const head = branch('mine', 'mine\n');
    const calls: string[][] = [];
    const list = [{ number: 1, headRefOid: head, files: [{ path: 'a.txt' }] }, { number: 2, headRefOid: sibling, files: [{ path: 'a.txt' }] }, { number: 4499, headRefOid: 'f'.repeat(40), files: [{ path: 'a.txt' }], isCrossRepository: true }];
    const lines = trialMergeLines({ repoRoot: root, base: 'main', gh: a => { calls.push(a); return { ok: true, out: JSON.stringify(list) }; } }, '1', head, ['a.txt']);
    expect(lines).toEqual([
      `TRIAL_MERGES: #2 ${sibling.slice(0, 12)} shares a.txt: CONFLICT in a.txt; the lane states the resolution`,
      `TRIAL_MERGES: #4499 ${'f'.repeat(12)} shares a.txt: outside PR from a fork, not a sibling lane; not trial-merged (rule 19)`,
    ]);
    expect(calls[0]).toContain('number,headRefOid,files,isCrossRepository');
  });
});
