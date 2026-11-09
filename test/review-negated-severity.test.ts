import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collect, ledgerBlockers, parseFindings, rank, readJsonl, recordJudgment, summaryCandidate, type JudgedLine } from '../lib/review-ledger';

const DIR = path.resolve(import.meta.dir, 'fixtures/review-ledger/gst-1628');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const roleOf = (f: string) => f.replace(/\.txt$/, '').split('_').at(-1)!;
const labels = (output: string, reader = 'fix-check', raises = true) => parseFindings(reader, output, raises).map(f => f.label);

/** Captured reader outputs (Captain drive handoffs, gstack ship runs) with every label main 1a06afd collected; each CRITICAL is the reader's own blocking rating. */
const REAL: Record<string, string[]> = {
  'gsta-281-s8-gst1354-fc_fix-check.txt': ['CRITICAL', 'INFORMATIONAL', 'INFORMATIONAL'],
  'gsta-203-s6.15-ship-3850-p1_targeted.txt': ['CRITICAL'],
  'gsta-270-s6-shipa-p1_red-team.txt': ['CRITICAL', 'CRITICAL', 'INFORMATIONAL', 'INFORMATIONAL'],
  'gsta-281-s7-gst1354-p2_outside-voice.txt': ['CRITICAL', 'CRITICAL', 'CRITICAL'],
  'gsta-270-s10-shipa-p2_outside-voice.txt': ['CRITICAL'],
  'gsta275-s8-gst1276-p2_outside-voice.txt': ['CRITICAL'],
  'gsta-294-s6-ship-1399-v1_outside-voice.txt': ['CRITICAL', 'CRITICAL', 'CRITICAL'],
  'gsta-202-3852-wave-p2_outside-voice.txt': ['CRITICAL', 'CRITICAL'],
  'gsta275-s10-gst1276-v3_adversarial-native.txt': ['CRITICAL', 'Medium', 'Medium', 'Low'],
  'gsta275-s14-gst1276-v4_adversarial-native.txt': ['CRITICAL', 'Medium', 'Low', 'Low', 'Low'],
};

describe('a sentence that denies a severity never collects at it (GST-1628)', () => {
  // Value: protects=a reader's closing sentence that denies CRITICAL with a rating verb counts no blocker: gstack-evals#247's "None of
  //   these rises to CRITICAL." collects at INFORMATIONAL, and #4055's "Nothing reaches the CRITICAL floor.", whose line names file:line
  //   loci in its other sentences and so keeps its label under the GST-435 locus rule, is a summary candidate that lead judgment lowers
  //   with a reason; fails_when=#247's sentence collects CRITICAL, #4055's line is no candidate (judge refuses the lowering), or the ledger
  //   counts a blocker for either; why_new=#247 (fc2 blocking_found=1) and #4055 (blocking_found=2 for one real blocker) each had to
  //   explain a phantom the judge refused to lower; seam=parseFindings, collect, recordJudgment and ledgerBlockers; no_claim=that every
  //   denial spelling is recognized
  test('neither captured phantom counts as a blocker', () => {
    const evals = 'geva-350-evals247-fc2-closing_fix-check.txt';
    const crew = 'gsta-329-pr4055-fc_fix-check.txt';
    for (const raises of [true, false]) {
      expect([raises, labels(read(evals), 'fix-check', raises)]).toEqual([raises, ['INFORMATIONAL']]);
      expect([raises, labels(read(crew), 'fix-check', raises)]).toEqual([raises, ['INFORMATIONAL', 'INFORMATIONAL', 'CRITICAL']]);
    }
    for (const [name, lower] of [[evals, {}], [crew, { 'fix-check#3': 'the reader wrote "Nothing reaches the CRITICAL floor": a no-defect closing line' }]] as const) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1628-'));
      const ledger = path.join(d, 'l.jsonl');
      const merged = path.join(d, 'm.jsonl');
      const judged = path.join(d, 'j.jsonl');
      fs.writeFileSync(path.join(d, 'out.txt'), read(name));
      const c = collect(ledger, 'fix-check', read(name), merged, path.join(d, 'out.txt'));
      const set: JudgedLine[] = c.lines.map(l => { const reason = (lower as Record<string, string>)[l.id]; return reason ? { id: l.id, severity: 'INFORMATIONAL', reason } : { id: l.id, severity: l.label }; });
      fs.writeFileSync(judged, set.map(j => JSON.stringify(j)).join('\n') + '\n');
      const verdict = recordJudgment(ledger, c.lines, readJsonl(judged), judged, merged);
      expect([name, verdict.ok, verdict.dismissed, ledgerBlockers(ledger)]).toEqual([name, true, Object.keys(lower), []]);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  // Value: protects=no real blocker is lost: every captured reader output here collects exactly the labels main collected, on the gate
  //   and code classes, across JSON, inline and line-field Severity/Blocks, native FIXABLE, path-led and fenced shapes; fails_when=any real
  //   CRITICAL collects lower or any record splits or disappears; why_new=GST-766's negation drop lost real blockers and was reverted, so
  //   the denial grammar must be proven on real outputs; seam=parseFindings; no_claim=coverage of reader outputs outside this corpus
  test('every real CRITICAL in the captured corpus still collects CRITICAL', () => {
    let critical = 0;
    for (const [name, want] of Object.entries(REAL)) for (const raises of [true, false]) {
      const got = labels(read(name), roleOf(name), raises);
      expect([name, raises, got]).toEqual([name, raises, want]);
      if (raises) critical += got.filter(l => rank(l) === 4).length;
    }
    expect(critical).toBe(16);
  });

  // Value: protects=the rating verbs deny like "is" does, and only inside a sentence that is wholly a denial: a named defect, a locus or an
  //   exception in that sentence, an "else" or "the blockers" subject, or a label that names a thing ("the CRITICAL path") keeps its label,
  //   and a line naming a locus in another sentence keeps its label as a summary candidate; fails_when=a denial collects a finding, any
  //   control collects below CRITICAL, or a candidate flag is wrong; why_new=GST-1628; seam=parseFindings and summaryCandidate;
  //   no_claim=that each control is a real finding
  test('rating verbs deny, and the negative controls keep their label', () => {
    for (const line of ['Nothing reaches CRITICAL.', 'None of these rises to CRITICAL.', 'Nothing reaches the CRITICAL floor.', 'None of them would rise to CRITICAL.',
      'Neither finding reaches the CRITICAL bar.', 'Nothing here meets the CRITICAL threshold.', 'None of these qualifies as CRITICAL.', 'No finding rises to CRITICAL.',
      'No issues reach High or CRITICAL.', 'Nothing in this diff rises to the level of CRITICAL.'])
      expect([line, labels(line)]).toEqual([line, []]);
    for (const line of ['The leak in log.ts:3 is fixed. Nothing reaches CRITICAL.', 'I checked crew/docs/captain.md:313-336 and brief.md:36. Nothing reaches the CRITICAL floor.',
      'No auth check guards the admin route, so nothing rises to CRITICAL.'])
      expect([line, labels(line), summaryCandidate(line)]).toEqual([line, ['CRITICAL'], true]);
    for (const line of ['The race in queue.ts:40 rises to CRITICAL.', 'Nothing in auth.ts:9 reaches CRITICAL.', 'Nothing reaches CRITICAL except the token leak.'])
      expect([line, summaryCandidate(line)]).toEqual([line, false]);
    for (const line of ['The race in queue.ts:40 rises to CRITICAL.', 'Nothing else reaches CRITICAL.', 'None of the blockers rises to CRITICAL.', 'Nothing in auth.ts:9 reaches CRITICAL.',
      'Nothing reaches CRITICAL except the token leak.', 'No auth check guards the admin route, so nothing reaches CRITICAL.', 'Nothing reaches the CRITICAL path without a token.',
      'Unauthenticated input reaches the CRITICAL write path.', 'I found nothing CRITICAL. The retry loop rises to CRITICAL.', '- Nothing reaches CRITICAL.', 'Nothing reaches CRITICAL. Blocks: yes'])
      expect([line, labels(line)]).toEqual([line, ['CRITICAL']]);
  });
  // Value: protects=a verb that takes the severity as its object ("Neither fix clears the P0.", a fix-check reader's surviving blocker)
  //   and a label followed by a word that only starts like a floor noun ("no CRITICAL barrier") keep their label and are no summary
  //   candidate; fails_when=either collects nothing or becomes dismissible, or the floor nouns widen the pre-GST-1628 denial ("No CRITICAL
  //   level."); why_new=#4075's Step 11 voices showed both dropping a blocker at 049c0fb; seam=parseFindings and summaryCandidate;
  //   no_claim=that each control is a real finding
  test('an object-taking verb and a look-alike floor noun keep their label', () => {
    for (const [line, want] of [['Neither fix clears the P0.', ['P0']], ['None of the changes clears the CRITICAL.', ['CRITICAL']], ['Neither fix hits the P0.', ['P0']],
      ['Nothing reaches the CRITICAL.', ['CRITICAL']], ['There is no CRITICAL barrier between tenants, so one tenant can overwrite another tenant\u2019s records.', ['CRITICAL']]] as const)
      expect([line, labels(line)]).toEqual([line, [...want]]);
    for (const line of ['Neither fix clears the P0.', 'None of the patches clears the CRITICAL.', 'Nothing hits the CRITICAL.', 'No CRITICAL level.',
      'There is no CRITICAL barrier between tenants, so one tenant can overwrite another tenant\u2019s records.'])
      expect([line, summaryCandidate(line)]).toEqual([line, false]);
  });
});
