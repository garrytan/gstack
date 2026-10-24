/**
 * #3105: every gate that summarises a review fails closed. Codex consult and
 * challenge replies label findings `1. **P1 — x**`, `1. P2 — x` or `P2 —` and
 * end `Verdict: not ready (...)`; the `execution` gate printed `VERDICT: clean /
 * FINDINGS: none` for all of them. The fixtures in
 * test/fixtures/outside-review-severity/codex-3105/ are synthesized from the
 * forms the issue documents (it describes 13 replies but does not include them).
 * #3329: that same gate then printed `clean` for a parsed advisory finding
 * whose last `Verdict:` line says `not ready`. `bare-dash-p2.txt` is unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyOutsideReview, validateOutsideReview, type OutsideGate } from '../lib/outside-review-result';
import { GATE_OUTCOMES } from '../lib/gate-outcomes';

const ROOT = path.resolve(import.meta.dir, '..');
const LIB = path.join(ROOT, 'lib', 'outside-review-result.ts');
const FIX = path.join(ROOT, 'test', 'fixtures', 'outside-review-severity', 'codex-3105');
const fixture = (name: string) => path.join(FIX, name);
const read = (name: string) => fs.readFileSync(fixture(name), 'utf8');
const REC = 'Recommendation: fix it because the change loses data.';
const cli = (gate: OutsideGate, name: string) =>
  spawnSync(process.execPath, [LIB, '--verdict', '--label', 'Codex consult', gate, fixture(name)], { encoding: 'utf8', timeout: 10000 });

describe('#3105 Codex reply shapes under the execution gate', () => {
  for (const [name, status, stdout] of [
    ['plan-bold-dash.txt', 3, 'VERDICT: findings\nFINDINGS: P1\n'],
    ['diff-numbered-dash.txt', 3, 'VERDICT: findings\nFINDINGS: P1\n'],
    ['bare-dash-p2.txt', 3, 'VERDICT: findings\nFINDINGS: P2\n'],
    ['ready-one-p3.txt', 0, 'VERDICT: clean\nFINDINGS: P3\n'],
    ['table-p1.txt', 3, 'VERDICT: findings\nFINDINGS: P1\n'],
    ['not-ready-unlabeled.txt', 3, 'VERDICT: findings\nFINDINGS: unspecified\n'],
    ['grouped-unparsed.txt', 4, 'VERDICT: unverified\nFINDINGS: none\nUNPARSED: line 3: "## P1/P2 findings"\nREASON: unparsed_severity\n'],
    ['blocking-plus-unparsed.txt', 3, 'VERDICT: findings\nFINDINGS: P1\nUNPARSED: line 4: "- P2/P3 nits: naming and a stale comment."\n'],
    ['no-findings.txt', 0, 'VERDICT: clean\nFINDINGS: none\n'],
    ['p1-in-code.txt', 0, 'VERDICT: clean\nFINDINGS: none\n'],
  ] as const) {
    test(`${name}: exit ${status}`, () => {
      const r = cli('execution', name);
      expect([r.status, r.stdout]).toEqual([status, stdout]);
    });
  }

  test('an unparsed label is unverified with its own reason, anchor and the quoted line', () => {
    const r = cli('execution', 'grouped-unparsed.txt');
    expect(r.stderr).toContain('Codex consult: ran, verdict unverified (');
    expect(r.stderr).toContain('(line 3: "## P1/P2 findings")');
    expect(r.stderr).toContain('bun lib/outside-review-result.ts --verdict <gate> <reply-file>');
    expect(r.stderr).toContain('docs/troubleshooting.md#outside-review-unparsed-severity');
    expect(GATE_OUTCOMES.unparsed_severity).toMatchObject({ state: 'ran', anchor: 'outside-review-unparsed-severity' });
  });

  test('parsed blocking findings win and still print the unparsed detail', () => {
    const r = cli('execution', 'blocking-plus-unparsed.txt');
    expect(r.stderr).toContain('Codex consult: findings block this review; separately,');
    expect(r.stderr).toContain('line 4: "- P2/P3 nits: naming and a stale comment."');
    expect(r.stderr).toContain('#outside-review-unparsed-severity');
  });

  test('a not-ready verdict with an unparsed label still blocks, never clean', () => {
    const r = classifyOutsideReview({ text: '## P1 findings\nThe cap is ignored.\nVerdict: not ready', gate: 'execution' });
    expect([r.verdict, r.findings.highest, r.unparsed]).toEqual(['findings', null, 'line 1: "## P1 findings"']);
  });
});

describe('#3105 severity forms are read by every gate that summarises a review', () => {
  const forms: Array<[string, string]> = [
    ['**P1 — The cap is ignored.**', 'P1'],
    ['1. **P1 — The cap is ignored.** `lib/retry.ts:12`', 'P1'],
    ['**P1** — The cap is ignored.', 'P1'],
    ['**P1:** The cap is ignored.', 'P1'],
    ['1. P2 — The docs lag.', 'P2'],
    ['P2 —', 'P2'],
    ['P2 – The docs lag.', 'P2'],
    ['- P0 - Secrets reach the log.', 'P0'],
    ['### P1', 'P1'],
    ['> 2) P3: rename the helper.', 'P3'],
    ['| P1 | cap ignored |', 'P1'],
    ['- `P1`: race in cleanup.', 'P1'],
    ['High: the retry loop never stops.', 'P1'],
    ['| 1 | high | cap ignored |', 'P1'],
  ];
  for (const gate of ['execution', 'structured', 'review'] as const) {
    test(`${gate}: label forms`, () => {
      for (const [text, highest] of forms) {
        const r = classifyOutsideReview({ text: `${text}\n${REC}`, gate });
        const verdict = highest === 'P0' || highest === 'P1' ? 'findings' : 'clean';
        expect({ text, highest: r.findings.highest as string | null, verdict: r.verdict as string }).toEqual({ text, highest, verdict });
      }
    });
    test(`${gate}: unparsed label positions fail closed with unparsed_severity`, () => {
      for (const text of ['## P1 findings', '- **P1/P2** gaps remain.', '1. P1-ish: maybe a race.', 'P2, P3 and nits below.', '**[P1/P2]** cap ignored']) {
        const r = classifyOutsideReview({ text: `${text}\n${REC}`, gate });
        expect({ text, verdict: r.verdict as string, reason: r.reason as string | undefined }).toEqual({ text, verdict: 'unverified', reason: 'unparsed_severity' });
      }
    });
    test(`${gate}: negative controls stay clean`, () => {
      expect(classifyOutsideReview({ text: read('no-findings.txt'), gate }).verdict).toBe('clean');
      expect(classifyOutsideReview({ text: read('p1-in-code.txt'), gate }).verdict).toBe('clean');
      for (const text of ['The P1 queue drains first.', 'Ship it; we discussed P1 and P2 priorities yesterday.', 'See issue #P12.', 'Use a P10 bucket.'])
        expect({ text, verdict: classifyOutsideReview({ text: `${text}\nNo issues found.\n${REC}`, gate }).verdict as string }).toEqual({ text, verdict: 'clean' });
    });
  }

  test('an unlabeled consult reply with no severity markers stays clean', () => {
    for (const text of ['Use a queue here; the writer pool blocks.', 'A high-level answer: use a queue.', 'Verdict: ready'])
      expect({ text, verdict: classifyOutsideReview({ text, gate: 'execution' }).verdict as string }).toEqual({ text, verdict: 'clean' });
  });

  test('the proposal gate is not a review summary: no severity-word or unparsed checks', () => {
    const proposal = '## P1 layout\nHigh: a dense table.\nRecommendation: table because operators compare many rows.';
    expect(classifyOutsideReview({ text: proposal, gate: 'proposal' }).verdict).toBe('clean');
  });
});

describe('#3329 a last not-ready Verdict blocks even with advisory findings', () => {
  const ISSUE = '1. **P2 — The docs lag the new flag.**\n2. **P3 — Rename the helper.**\nVerdict: not ready (1 P1/P2)';
  const P2 = '1. **P2 — The docs lag the new flag.**';
  const textFor = (gate: OutsideGate, text: string) => gate === 'review' ? `${text}\n${REC}` : text;
  const see = (text: string, gate: OutsideGate) => {
    const r = classifyOutsideReview({ text: textFor(gate, text), gate });
    return { verdict: r.verdict as string, highest: r.findings.highest as string | null, reason: (r.reason ?? null) as string | null, unparsed: r.unparsed ?? null };
  };

  test('numbered bold P2 plus P3 with not ready is findings/P2 on execution, structured and review', () => {
    for (const gate of ['execution', 'structured', 'review'] as const)
      expect({ gate, ...see(ISSUE, gate) }).toEqual({ gate, verdict: 'findings', highest: 'P2', reason: null, unparsed: null });
    expect(validateOutsideReview(ISSUE, 'structured')).toEqual({ completed: true, gate: 'fail' });
  });

  test('P3-only and unlabeled not-ready replies block; P0/P1 block even when the last Verdict says ready', () => {
    for (const gate of ['execution', 'structured', 'review'] as const) {
      expect({ gate, ...see('1. **P3 — Rename the helper.**\nVerdict: not ready', gate) }).toEqual({ gate, verdict: 'findings', highest: 'P3', reason: null, unparsed: null });
      expect({ gate, ...see('The retry path can double-send.\nVerdict: not ready', gate) }).toEqual({ gate, verdict: 'findings', highest: null, reason: null, unparsed: null });
    }
    expect(see('1. **P1 — The cap is ignored.**\nVerdict: ready', 'review')).toMatchObject({ verdict: 'findings', highest: 'P1' });
    expect(see('**P0 — Secrets reach the log.**\nVerdict: ready', 'execution')).toMatchObject({ verdict: 'findings', highest: 'P0' });
  });

  test('advisory P2/P3 with ready or no Verdict stay clean', () => {
    for (const text of [
      `${P2}\n2. **P3 — Rename the helper.**\nVerdict: ready`,
      `${P2}\n2. **P3 — Rename the helper.**`,
      '1. **P3 — Rename the helper.**\nVerdict: ready (1 P3)',
    ]) {
      const r = see(text, 'execution');
      expect({ text, verdict: r.verdict, highest: r.highest }).toEqual({ text, verdict: 'clean', highest: text.includes('P2') ? 'P2' : 'P3' });
    }
    expect(see(`${P2}\nVerdict: ready`, 'review').verdict).toBe('clean');
    expect(validateOutsideReview(`${P2}\nVerdict: ready`, 'structured')).toEqual({ completed: true, gate: 'pass' });
  });

  test('the last recognized Verdict wins, including supported formatting; quotes do not', () => {
    expect(see(`${P2}\nVerdict: ready\nVerdict: not ready (1 P1/P2)`, 'execution')).toMatchObject({ verdict: 'findings', highest: 'P2' });
    expect(see(`${P2}\nVerdict: not ready (1 P1/P2)\nVerdict: ready`, 'execution').verdict).toBe('clean');
    for (const verdictLine of ['**Verdict:** not ready', '- Verdict: not ready', '### Verdict: not ready'])
      expect({ verdictLine, ...see(`${P2}\n${verdictLine}`, 'execution') }).toMatchObject({ verdict: 'findings', highest: 'P2' });
    expect(see(`${P2}\nVerdict: not ready\n### Verdict: ready`, 'execution').verdict).toBe('clean');
    const fence = ['```', 'Verdict: not ready (2 P2)', '```'].join('\n');
    expect(see(`${P2}\nVerdict: ready\n${fence}`, 'execution').verdict).toBe('clean');
    expect(see(`${fence}\n${P2}\nVerdict: not ready`, 'execution')).toMatchObject({ verdict: 'findings', highest: 'P2' });
    expect(see(`${P2}\nVerdict: ready\nThe rubric says \`Verdict: not ready\`.`, 'execution').verdict).toBe('clean');
    expect(see(`${P2}\nThe rubric says \`Verdict: not ready\`.`, 'execution').verdict).toBe('clean');
    expect(see(`No issues found.\n${fence}`, 'review').verdict).toBe('clean');
  });

  test('parsed P2 plus an unparsed label and not-ready still blocks and keeps the diagnostic', () => {
    const text = `${P2}\n## P1/P2 findings\nVerdict: not ready`;
    expect(see(text, 'execution')).toEqual({ verdict: 'findings', highest: 'P2', reason: null, unparsed: 'line 2: "## P1/P2 findings"' });
    expect(see(`${P2}\n## P1/P2 findings`, 'structured')).toMatchObject({ verdict: 'unverified', reason: 'unparsed_severity', unparsed: 'line 2: "## P1/P2 findings"' });
  });

  test('missing markers and failed execution stay unavailable; proposal and spec ignore the verdict', () => {
    expect(classifyOutsideReview({ text: `${P2}\nVerdict: not ready`, gate: 'review' }).reason).toBe('missing_markers');
    const failed = classifyOutsideReview({ text: textFor('review', `${P2}\nVerdict: not ready`), gate: 'review', exit: 1, stderr: 'fatal: provider exploded' });
    expect(failed.verdict).toBe('unavailable');
    expect(failed.reason).toBe('execution_failed');
    expect(classifyOutsideReview({ text: `${P2}\nVerdict: not ready\n${REC}`, gate: 'proposal' }).verdict).toBe('clean');
    const passing = classifyOutsideReview({ text: `SCORE: 8\nAMBIGUITIES: NONE\n${P2}\nVerdict: not ready`, gate: 'spec' });
    expect([passing.verdict, passing.score]).toEqual(['clean', 8]);
    const failing = classifyOutsideReview({ text: 'SCORE: 6\nAMBIGUITIES: NONE\nVerdict: ready', gate: 'spec' });
    expect([failing.verdict, failing.score]).toEqual(['findings', 6]);
  });
});
