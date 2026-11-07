/**
 * An outside review reads clean only from its required last line (GST-1821):
 * `VERDICT: CLEAN` or `VERDICT: FINDINGS`, alone on the reply's last line.
 * Prose is never evidence for clean, so every false-clean prose form from
 * GST-1808 and GST-1821 reads unverified without the token.
 */
import { describe, expect, test } from 'bun:test';
import { classifyOutsideReview, type OutsideGate } from '../lib/outside-review-result';

const check = (text: string, gate: OutsideGate = 'structured') => classifyOutsideReview({ text, gate });
const REC = 'Recommendation: ship because the diff only renames a local variable.';

describe('prose without the verdict line never reads clean', () => {
  const forms: [string, string, OutsideGate][] = [
    ['a problem clause before the statement, joined by ";"', 'The fallback swallows ENOENT; no issues in the diff.', 'structured'],
    ['a problem clause before the statement, joined by ", and"', 'The auth check is removed, and no issues were found in the diff.', 'structured'],
    ['a clean because-clause followed by a listed problem', 'Recommendation: ship because no issues remain.\n- The fallback path now swallows ENOENT.', 'review'],
    ['a clean because-clause followed by a problem sentence', 'Recommendation: Ship because no issues in the diff.\nThe fallback path now swallows ENOENT.', 'review'],
    ['a partial scope: the latest commit', 'No issues found in the latest commit.', 'structured'],
    ['a partial scope: the staged changes', 'No issues found in the staged changes.', 'structured'],
    ['a contradicting action', 'Recommendation: fix the auth bypass because no issues in the diff.', 'review'],
    ['GST-1808: a clause after the scope', 'Recommendation: Ship because no issues in the diff, so the change disables auth.', 'review'],
    ['GST-1808: an exception', 'No issues in the diff with the exception of the auth change.', 'structured'],
    ['GST-1808: a question', 'Prose here. No issues in the diff?', 'structured'],
    ['GST-1808: a colon explanation', 'I reviewed the parser.\nNo issues in the diff: the fallback path now swallows ENOENT.', 'structured'],
    ['GST-1808: a scope naming part of the change', 'No issues in the parser.', 'structured'],
    ['#4136: a hyphenated origin ref', 'No issues found in the diff against origin/main-except-the-auth-path.', 'structured'],
    ['untagged findings before a changed-file conclusion', '1. The parser drops the last line.\n2. The cache never expires.\nNo issues found in the changed parser.', 'structured'],
    ['a NO_FINDINGS marker alone', 'NO_FINDINGS', 'structured'],
    ['a clean Codex reply captured before the token existed', 'I found no actionable regressions in the staged, unstaged, or untracked changes.', 'structured'],
  ];
  for (const [name, text, gate] of forms) {
    test(name, () => {
      const result = check(text, gate);
      expect(result.verdict).toBe('unverified');
      expect(result.reason).toBe('missing_verdict');
    });
  }
});

describe('the verdict line is the only evidence for clean', () => {
  test('VERDICT: CLEAN as the last line reads clean on both gates', () => {
    expect(check('No issues found.\nVERDICT: CLEAN').verdict).toBe('clean');
    expect(check(`No issues found.\n${REC}\nVERDICT: CLEAN\n`, 'review').verdict).toBe('clean');
  });

  test('bold or inline-code formatting of the line is still the line', () => {
    expect(check('Nothing to report.\n**VERDICT: CLEAN**').verdict).toBe('clean');
    expect(check('Nothing to report.\n`VERDICT: CLEAN`').verdict).toBe('clean');
  });

  test('the review gate still requires its Recommendation line', () => {
    const result = check('No issues found.\nVERDICT: CLEAN', 'review');
    expect(result.verdict).toBe('unavailable');
    expect(result.reason).toBe('missing_markers');
  });

  const malformed: [string, string][] = [
    ['prose after the line', 'VERDICT: CLEAN\nThe fallback swallows ENOENT.'],
    ['lowercase value', 'No issues.\nVERDICT: clean'],
    ['a qualified value', 'No issues.\nVERDICT: CLEAN (mostly)'],
    ['an unknown value', 'No issues.\nVERDICT: PASS'],
    ['the line inside a closed code fence', 'No issues.\n```\nVERDICT: CLEAN\n```'],
    ['the line after an unclosed code fence', 'No issues.\n```\nVERDICT: CLEAN'],
    ['the line inside a sentence', 'My answer is VERDICT: CLEAN'],
  ];
  for (const [name, text] of malformed) {
    test(`a malformed line reads unverified: ${name}`, () => {
      const result = check(text);
      expect(result.verdict).toBe('unverified');
      expect(result.reason).toBe('missing_verdict');
    });
  }
});

describe('findings and not-ready signals outrank the verdict line', () => {
  test('VERDICT: CLEAN with a P0/P1 finding reads findings', () => {
    expect(check('[P1] The auth check is removed.\nVERDICT: CLEAN').verdict).toBe('findings');
    expect(check(`Severity: High. Data loss on retry.\n${REC}\nVERDICT: CLEAN`, 'review').verdict).toBe('findings');
  });

  test('VERDICT: FINDINGS with a P1 reads findings', () => {
    const result = check('[P1] The auth check is removed.\nVERDICT: FINDINGS');
    expect(result.verdict).toBe('findings');
    expect(result.findings.highest).toBe('P1');
  });

  test('advisory-only findings pass the gate with their severity kept, under either token', () => {
    for (const token of ['VERDICT: FINDINGS', 'VERDICT: CLEAN']) {
      const result = check(`[P2] The helper name is vague.\n${token}`);
      expect(result.verdict).toBe('clean');
      expect(result.findings.highest).toBe('P2');
    }
  });

  test('VERDICT: FINDINGS with no readable severity reads unverified', () => {
    const result = check('The parser drops the last line.\nVERDICT: FINDINGS');
    expect(result.verdict).toBe('unverified');
    expect(result.reason).toBe('untagged_review');
  });

  test('an explicit not-ready verdict before the line reads findings', () => {
    expect(check('Verdict: not ready\nVERDICT: CLEAN').verdict).toBe('findings');
  });

  test('an earlier contradicting verdict line reads unverified', () => {
    const result = check('VERDICT: FINDINGS\nNothing else.\nVERDICT: CLEAN');
    expect(result.verdict).toBe('unverified');
    expect(result.reason).toBe('unverified_verdict');
  });

  test('under VERDICT: CLEAN a numbered list of what was checked is not a finding', () => {
    const result = check('I checked:\n1. the retry path\n2. every caller\nVerdict: ready\nVERDICT: CLEAN');
    expect(result.verdict).toBe('clean');
    expect(result.findings.unlabeled).toBeUndefined();
  });

  test('an earlier ready verdict agrees with the line', () => {
    expect(check('Verdict: ready\nVERDICT: CLEAN').verdict).toBe('clean');
  });

  test('a refusal or an empty reply is unavailable whatever its last line says', () => {
    expect(check("I can't review this diff.\nVERDICT: CLEAN").verdict).toBe('unavailable');
    expect(check('').verdict).toBe('unavailable');
  });
});

describe('gates that never read prose for clean are unchanged', () => {
  test('spec reads its SCORE and AMBIGUITIES markers', () => {
    expect(check('SCORE: 8\nAMBIGUITIES: NONE', 'spec').verdict).toBe('clean');
  });
  test('a design proposal needs only its Recommendation line', () => {
    expect(check('Use a sidebar layout.\nRecommendation: sidebar because the nav has nine items.', 'proposal').verdict).toBe('clean');
  });
  test('the execution gate checks execution only', () => {
    expect(check('Here is my analysis of the design.', 'execution').verdict).toBe('clean');
  });
});
