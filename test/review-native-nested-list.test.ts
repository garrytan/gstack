import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collect, ledgerBlockers, parseFindings, statesNoBlocks } from '../lib/review-ledger';

const native = (output: string, raises = true) => parseFindings('adversarial-native', output, raises);
/** A numbered finding with a bold lead, a body line, an indented sub-list, a blank line and a closing paragraph holding its fields. */
const nested = (n: number, tag: string, close: string, indent = '   ') => [
  `${n}. **${tag}. The retry queue drops a job on shutdown** (\`queue.ts\` \`drainJobs\`). The drain loop exits before the last flush:`,
  '   - The in-flight job is never written back.',
  '   - The next boot sees no record of it.',
  '',
  `${indent}${close}`,
].join('\n');
const LOW = 'So a job queued in the last second is lost, which is rare and already retried upstream. Severity: Low. Blocks: no.';
const reply = (findings: string[]) => ['**Findings**', '', ...findings.flatMap(f => [f, '']), 'Recommendation: Ship after one fix round on the drain loop.'].join('\n');
const blockers = (output: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-list-'));
  const [ledger, merged, out] = ['l.jsonl', 'm.jsonl', 'out.txt'].map(f => path.join(d, f)) as [string, string, string];
  fs.writeFileSync(out, output);
  const c = collect(ledger, 'adversarial-native', output, merged, out);
  const result = { labels: c.lines.map(l => l.label), blockers: ledgerBlockers(ledger).length };
  fs.rmSync(d, { recursive: true, force: true });
  return result;
};

describe('a numbered native finding keeps its closing paragraph after a nested list', () => {
  // Value: protects=a native finding written as "N. **FIXABLE. ...**", a body line, an indented sub-list, a blank line, then a paragraph
  //   carrying "Severity: Low. Blocks: no." stays one record, so its Severity binds to it and GST-1031 ruling A collects it at Low;
  //   fails_when=the paragraph splits off as a second record and the heading's FIXABLE collects CRITICAL as a blocker; why_new=ALPH-93
  //   (alphaclaw#387): 6 native findings collected as 9 and a Low FIXABLE blocked /ship until an owner ruling; seam=parseFindings,
  //   collect and ledgerBlockers; no_claim=other list-continuation spellings
  test('the closing paragraph joins its finding, indented or at the margin', () => {
    for (const indent of ['   ', ''])
      for (const raises of [true, false]) {
        const found = native(reply([nested(1, 'FIXABLE', LOW, indent), nested(2, 'INVESTIGATE', 'The fix is a final flush before exit. Severity: Medium. Blocks: no.', indent)]), raises);
        expect([indent, raises, found.map(f => f.label)]).toEqual([indent, raises, ['Low', 'Medium']]);
        expect(found[0]!.raw.startsWith('1. **FIXABLE.')).toBe(true);
        expect(found[0]!.raw.endsWith(`| ${LOW}`)).toBe(true);
        expect(found.map(f => statesNoBlocks(f.raw))).toEqual([true, true]);
      }
    expect(blockers(reply([nested(1, 'FIXABLE', LOW)]))).toEqual({ labels: ['Low'], blockers: 0 });
  });

  // Value: protects=the fail-closed holds around that join: a FIXABLE whose paragraph has no Severity field, or says Blocks: yes, still
  //   collects CRITICAL and counts as a blocker; a later numbered item, a lead-labelled paragraph or a located paragraph stays its own
  //   record; a heading naming CRITICAL is never lowered by the paragraph; fails_when=any of these merges, lowers or stops blocking;
  //   why_new=ALPH-93; seam=parseFindings, collect and ledgerBlockers; no_claim=that each control is a real finding
  test('the join never weakens a blocker or swallows a separate finding', () => {
    expect(native(reply([nested(1, 'FIXABLE', 'So a job queued in the last second is lost. Blocks: no.')])).map(f => f.label)).toEqual(['CRITICAL']);
    expect(native(reply([nested(1, 'FIXABLE', 'So a job queued in the last second is lost.')])).map(f => f.label)).toEqual(['CRITICAL']);
    for (const close of ['So jobs are lost on every deploy. Severity: Low. Blocks: yes.', 'So jobs are lost. Blocks: yes. Severity: Low.'])
      expect(blockers(reply([nested(1, 'FIXABLE', close)]))).toEqual({ labels: ['CRITICAL'], blockers: 1 });
    expect(native(reply([nested(1, 'CRITICAL', LOW)]), false).map(f => f.label)).toEqual(['CRITICAL']);
    expect(native(reply([nested(1, 'FIXABLE', LOW), nested(2, 'FIXABLE', 'So restarts leak a lock file. Severity: Medium. Blocks: yes.')])).map(f => f.label))
      .toEqual(['Low', 'CRITICAL']);
    for (const later of ['**High:** the lock file in lock.ts leaks on restart. Blocks: no.', 'Separately, lock.ts:12 leaks the lock file on restart. Severity: High. Blocks: no.']) {
      const found = native([nested(1, 'FIXABLE', LOW), '', later].join('\n'));
      expect([later, found.map(f => f.label)]).toEqual([later, ['Low', 'High']]);
    }
    const located = native([nested(1, 'FIXABLE', 'Also lock.ts:12 leaks on restart. Severity: Low. Blocks: no.', ''), ''].join('\n'));
    expect(located.map(f => f.label)).toEqual(['CRITICAL', 'Low']);
  });
});
