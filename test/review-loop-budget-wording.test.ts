/**
 * Harness lane E: the review-loop budget's words (absorbed from tstack's sol-loop
 * and pstack's interrogate, written in gstack's own words). The glossary and the
 * two stop rules live where the loop decides (ship Step 9.4 and its repeat
 * decisions, the checklist's Fix-First heuristic); the lead-judgment filters sit
 * in the finding merge both /review and /ship render from one resolver.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\s+/g, ' ');

describe('review-loop budget wording', () => {
  test('ship Step 9.4 budgets by blocker / should / nit and the repeat decisions carry the two stop rules', () => {
    const authored = read('ship/sections/review-army.md.tmpl');
    expect(authored).toContain('a **blocker** is the intended case gone wrong');
    const army = read('ship/sections/review-army.md');
    expect(army).toContain('a **blocker** is the intended case gone wrong');
    expect(army).toContain('a **should** is a real bug a caller will hit, in the intended case');
    expect(army).toContain('a **nit** is the rest');
    expect(army).toContain('The cap is a stop, not an approval');
    expect(army).toContain('cut that growth before anything else');
    expect(army).toContain('(`git diff $RANGE_BASE` from pass 2 on)');
    expect(army).toContain('The gate scan (2.5) and the QA probes keep the whole candidate');
    expect(army).toContain('and the command still exits 0: the PR body carries the reason');
  });

  test('the checklist glossary maps the three words onto the blocking floor and repeats the stop rules', () => {
    const checklist = read('review/checklist.md');
    expect(checklist).toContain('**Severity glossary**');
    for (const word of ['**blocker**', '**should**', '**nit**']) expect(checklist).toContain(word);
    expect(checklist).toContain('cut that growth first');
    expect(checklist).toContain('reaching the cap approves nothing');
  });

  test('both review armies apply lead judgment before a merged finding counts, and every specialist prompt offers the cause anchor', () => {
    const rendered = (['ship', 'review'] as const).map(skillName =>
      generateReviewArmy({ skillName, tmplPath: '', host: 'claude', paths: HOST_PATHS.claude }).replace(/\s+/g, ' '));
    for (const text of [...rendered, read('ship/sections/review-army.md'), read('review/sections/review-army.md')]) {
      const judgment = text.slice(text.indexOf('#### 4. Lead judgment'), text.indexOf('#### 5. Apply specialist confidence gates'));
      expect(judgment.length).toBeGreaterThan(200);
      for (const filter of ['Nit gravity', 'Hypothetical, not actual', 'Structure for a case that does not exist', 'A different design is not a defect', 'Missing context']) expect(judgment).toContain(filter);
      expect(judgment).toContain('returned `NO FINDINGS` was right');
      expect(text).toContain('names the changed line in `cause`');
      expect(text).toContain('Optional: line, fix, fingerprint, evidence, test_stub, advisory, evidence_paths, helper_target, cause.');
    }
  });

  test('docs/review-policy.md states the glossary, the stop rules and lead judgment once', () => {
    const policy = read('docs/review-policy.md');
    expect(policy).toContain('a **blocker** is the intended case gone wrong');
    expect(policy).toContain('the cap approves nothing');
    expect(policy).toContain('the parent applies lead judgment');
    expect(policy).not.toMatch(/\b1\.91\.\d+\.\d+\b/);
  });
});
