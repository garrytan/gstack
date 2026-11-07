/**
 * An outside review reads clean only from its required last line (GST-1821):
 * `VERDICT: CLEAN` or `VERDICT: FINDINGS`, alone on the reply's last line.
 * Prose is never evidence for clean, so every false-clean prose form from
 * GST-1808 and GST-1821 reads unverified without the token.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    ['inline code after the value', 'No issues.\nVERDICT: CLEAN `except auth.ts`'],
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

  test('VERDICT: CLEAN beside numbered items with no severity reads unverified', () => {
    for (const text of ['1. Auth bypass in the admin check.\nVERDICT: CLEAN', 'I checked:\n1. the retry path\n2. every caller\nVerdict: ready\nVERDICT: CLEAN']) {
      const result = check(text);
      expect(result.verdict).toBe('unverified');
      expect(result.reason).toBe('untagged_review');
    }
    expect(check('1. [P2] The helper name is vague.\nVERDICT: CLEAN').verdict).toBe('clean');
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

describe('/codex review never sends Codex a prompt without its diff', () => {
  // Value: protects=a failed git diff stops /codex review before Codex runs; fails_when=the prompt build ignores git's exit status and
  //   Codex reviews an empty DIFF block it can call clean; why_new=GST-1821 fix-check (outside-voice#1); seam=the rendered prompt-build
  //   lines in codex/sections/review-mode.md; no_claim=Codex's own reading of the diff
  const section = fs.readFileSync(path.join(import.meta.dir, '..', 'codex/sections/review-mode.md'), 'utf8');
  const build = section.slice(section.indexOf('_DIFF_FAILED=\n'), section.indexOf('\n', section.indexOf('[ -z "$_DIFF_FAILED" ]')));
  const run = (gitDiff: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-diff-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'git'), `#!/bin/sh\n${gitDiff}\n`, { mode: 0o755 });
      const prompt = path.join(dir, 'prompt');
      const r = spawnSync('bash', ['-c', `FOCUS_NAME=none DIFF_BASE=abc _PROMPT_FILE=${prompt}\n${build}\necho BUILT`], {
        env: { PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: 5_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, prompt: fs.existsSync(prompt) ? fs.readFileSync(prompt, 'utf8') : null };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  test('a failing git diff stops before Codex and removes the prompt', () => {
    expect(build).toContain('git diff "$DIFF_BASE" || _DIFF_FAILED=1');
    const r = run('exit 1');
    expect([r.status, r.stdout, r.prompt]).toEqual([1, '', null]);
    expect(r.stderr).toContain('not running codex on a missing diff');
  });

  test('a working git diff lands between the markers', () => {
    const r = run("printf '%s\\n' '+changed line'");
    expect([r.status, r.stdout]).toEqual([0, 'BUILT\n']);
    expect(r.prompt).toContain('DIFF_START\n+changed line\n\nDIFF_END');
  });
});
