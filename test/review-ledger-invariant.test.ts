import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFindings, rank } from '../lib/review-ledger';

const ROOT = path.resolve(import.meta.dir, '..');
const LABELS = 'CRITICAL|INFORMATIONAL|Critical|Informational|High|HIGH|Medium|MEDIUM|Low|LOW|P[0-3]|FIXABLE|INVESTIGATE';
const CHAIN = `(?:${LABELS})(?:\\s*[/→]\\s*\\**\\s*(?:${LABELS}))*`;
/** A finding's own Severity field as GST-976 defines it: at a line's start (colon optional), or after a separator with its colon and a closed clause. */
const FIELD = new RegExp(`(?:(?:^|\\| )(?:[-*+>]\\s+|\\d+[.)]\\s+)?\\**\\s*Severity\\**\\s*:?\\s*\\**\\s*(${CHAIN})(?![A-Za-z0-9])|(?:[.;,|()]\\s*|\\s[—–-]\\s*)\\**\\s*Severity\\**\\s*:\\s*\\**\\s*(${CHAIN})(?![A-Za-z0-9])(?=\\**\\s*(?:$|[.;,|()*—–]|-\\s|Blocks)))`, 'gi');
const LEAD = new RegExp(`(?:^|\\| )[^\\p{L}\\p{N}]*(?:\\d+[.)]\\s*[^\\p{L}\\p{N}]*)?(?:\\w[\\w./-]*:\\d+(?:[-–:,]\\s*\\d+)*\\S*\\s+[^\\p{L}\\p{N}]*)?(?:${LABELS})(?![a-z])`, 'u');
const HEADING = new RegExp(`^(?:#{1,6}\\s*|\\*\\*)(?:${LABELS})\\b`, 'm');
const LABEL = new RegExp(`${LABELS}`, 'gi');
const LEAD_NO_FIXABLE = new RegExp(LEAD.source.replace('|FIXABLE|INVESTIGATE', ''), 'u');

describe('parseFindings is never weaker than main (GST-976 invariant)', () => {
  // Value: protects=no input the suite pins, no reader fixture and no Severity field shape collects below the label main (82e9d7ec)
  //   collected, unless the finding's own Severity field states exactly one label, and such a finding collects at that label unless a
  //   leading label, a label heading, Blocks: yes or the native voice's FIXABLE raises it; fails_when=a field chain (High/Critical) keeps
  //   its weaker label (b3ddd6c) or a field whose clause runs on stops counting and a body P0 raises the finding (f3810d4);
  //   why_new=three GST-976 review rounds each found a shape the row tables missed; seam=parseFindings; no_claim=that main's label was
  //   right (it is the floor), or coverage of stored private reader outputs (checked outside the repo). GST-987: the gate class (and every
  //   risk class) keeps this rule; outside it the native voice's FIXABLE beside Blocks: no no longer counts as a raise, so such a fielded
  //   finding collects at its field unless a lead, a label heading or Blocks: yes raises it. GST-1031 ruling A: the gate and risk classes
  //   drop that raise too, so on every class FIXABLE raises only a finding that does not state Blocks: no
  test.each([['gate', true], ['code', false]] as const)('every pinned input, reader fixture and generated field shape (%s class)', (_cls, raises) => {
    const { entries, shapes } = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/review-ledger/main-labels.json'), 'utf8'));
    const { bodies, fields: tails, joins, readers, generated } = shapes;
    for (const [b, f, j, r, main] of generated) entries.push({ reader: readers[r], output: bodies[b] + joins[j] + tails[f], main });
    const bad: string[] = [];
    let findings = 0;
    for (const e of entries as Array<{ reader: string; output?: string; fixture?: string; main: string[] }>) {
      const output = e.output ?? fs.readFileSync(path.join(ROOT, 'test/fixtures', e.fixture!), 'utf8');
      const got = parseFindings(e.reader, output, raises);
      if (!e.main.length) continue;
      if (got.length !== e.main.length) { bad.push(`count ${got.length}/${e.main.length} ${JSON.stringify(output.slice(0, 80))}`); continue; }
      got.forEach((f, i) => {
        findings++;
        const fields = [...f.raw.matchAll(FIELD)].map(m => (m[1] ?? m[2])!);
        const single = fields.length === 1 && fields[0]!.match(LABEL)!.length === 1 ? fields[0]!.match(LABEL)![0] : undefined;
        const raised = /Blocks:?\**:?\s*\**\s*yes/i.test(f.raw) || (e.reader.startsWith('adversarial-native') && /FIXABLE/.test(f.raw) && !/Blocks:?\**:?\s*\**\s*no\b/i.test(f.raw)) || (raises ? LEAD : LEAD_NO_FIXABLE).test(f.raw) || HEADING.test(output);
        const ok = single === undefined ? (rank(f.label) ?? 0) >= (rank(e.main[i]) ?? 0)
          : (rank(f.label) ?? 0) >= (rank(single) ?? 0) && (raised || (rank(f.label) ?? 0) === (rank(single) ?? 0));
        if (!ok) bad.push(`${e.reader} main=${e.main[i]} got=${f.label} field=${single ?? '-'} ${JSON.stringify(f.raw.slice(0, 100))}`);
      });
    }
    expect(bad).toEqual([]);
    expect(findings).toBeGreaterThan(1000);
  });
});
