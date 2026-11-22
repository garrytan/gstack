/**
 * The READY tail's last two template gaps (#4529, #4575, #4578): the Attention section printed
 * "<flags against decision-trail row numbers, or No flags>" for the lane to fill, and TRIAL_MERGES listed outside fork PRs such as
 * #4499 as conflicts a lane must resolve. The flags line now comes from the trail-read row's result, and a fork PR is labelled and
 * never fetched or merged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trailReadRow, trialMergeLines } from '../lib/ship-queue';
import type { ShipReceipt } from '../lib/headless-artifacts';
import { readyTailLines } from '../lib/ship-receipt';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ready-tail-')); dirs.push(d); return d; };
const HEADER = 'ts\tphase\tdecision\twhy\tevidence\tresult\n';
const trail = (rows: string[]) => { const f = path.join(tmp(), 'decisions.tsv'); fs.writeFileSync(f, HEADER + rows.map(r => r + '\n').join('')); return f; };
const READ = (flags: string) => `2026-11-20T00:01:00Z\ttrail-read\topenai/gpt-6.2-sol (Subagent 4)\trule 27\tflags.md\t${flags}`;
const GATE = { review_depth: { class: 'gate', risk: [] } } as unknown as ShipReceipt;
const CODE = { review_depth: { class: 'code', risk: [] } } as unknown as ShipReceipt;
const attention = (r: ShipReceipt, file?: string) => { const l = readyTailLines(r, { trialMerges: ['TRIAL_MERGES: none share a file (0 open PRs checked)'], trailRead: trailReadRow(file) }); return l.slice(l.indexOf('Attention:') + 1); };

describe('the Attention flags line comes from the trail (#4529)', () => {
  // Value: protects=READY never prints the flags placeholder: a risk-class PR prints the trail-read row's flags against its row number
  //   and a self-audited PR prints only its opener; fails_when=the placeholder line comes back or a flag is dropped; why_new=lanes
  //   pasted the placeholder on #4529, #4575 and #4578; seam=trailReadRow and readyTailLines as ready calls them
  test('a trail-read row\'s flags, or No flags, against its row; no line without a row or on a self-audited PR', () => {
    expect(attention(GATE, trail([READ('rows 4 and 7: retry claimed without a log')]))).toEqual([
      'reviewed by openai/gpt-6.2-sol (Subagent 4) (risk class: gate; rule 27 cross-family trail read, trail row 1)',
      'Flags (trail row 1): rows 4 and 7: retry claimed without a log',
    ]);
    for (const none of ['No flags', 'none', '']) expect(attention(GATE, trail([READ(none)]))[1]).toBe('No flags (trail row 1)');
    expect(attention(GATE)).toHaveLength(1);
    expect(attention(GATE)[0]).toStartWith('MISSING: cross-family trail read');
    expect(attention(CODE, trail([READ('row 2')]))).toEqual(['self-audited (not a risk class: no cross-family trail read)']);
    for (const r of [GATE, CODE]) expect(readyTailLines(r).join('\n')).not.toContain('<flags against');
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
