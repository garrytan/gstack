import { describe, it, expect, afterEach } from 'bun:test';
import {
  parseVerdict,
  stripAnsi,
  detectTestCmd,
  parseFailureCount,
  parseJudgeVerdict,
  buildCodexImplArgv,
  buildCodexReviewArgv,
} from '../sub-agents';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    const colored = '\x1b[31mGATE FAIL\x1b[0m and then \x1b[32mGATE PASS\x1b[0m';
    expect(stripAnsi(colored)).toBe('GATE FAIL and then GATE PASS');
  });
  it('leaves plain text alone', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
  it('handles complex sequences (cursor movement etc)', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Goutput\x1b[0m')).toBe('output');
  });
});

describe('parseVerdict', () => {
  it('returns pass when GATE PASS is the only verdict', () => {
    expect(parseVerdict('All checks complete. GATE PASS.')).toBe('pass');
  });
  it('returns fail when GATE FAIL is the only verdict', () => {
    expect(parseVerdict('Found 3 issues. GATE FAIL.')).toBe('fail');
  });
  it('returns unclear when neither keyword present', () => {
    expect(parseVerdict('Review complete. No issues found.')).toBe('unclear');
  });
  it('returns the LAST verdict when both keywords appear', () => {
    expect(parseVerdict('GATE FAIL first pass. After fix: GATE PASS')).toBe('pass');
    expect(parseVerdict('GATE PASS initially, then GATE FAIL on closer look')).toBe('fail');
  });
  it('strips ANSI before matching', () => {
    expect(parseVerdict('\x1b[32mGATE PASS\x1b[0m')).toBe('pass');
  });
  it('case-sensitive (lowercase gate pass does NOT match)', () => {
    // Per the convention in real plans — Codex emits the keyword in caps.
    expect(parseVerdict('gate pass')).toBe('unclear');
  });
});

describe('detectTestCmd', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns "bun test" when package.json has "test": "bun test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
    expect(detectTestCmd(tmpDir)).toBe('bun test');
  });

  it('returns "npm test" when package.json has "test": "npm test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'npm test' } }));
    expect(detectTestCmd(tmpDir)).toBe('npm test');
  });

  it('returns "pytest" when pytest.ini exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'pytest.ini'), '[pytest]');
    expect(detectTestCmd(tmpDir)).toBe('pytest');
  });

  it('returns "pytest" when pyproject.toml has [tool.pytest.ini_options]', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    expect(detectTestCmd(tmpDir)).toBe('pytest');
  });

  it('returns "go test ./..." when go.mod exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\n');
    expect(detectTestCmd(tmpDir)).toBe('go test ./...');
  });

  it('returns "cargo test" when Cargo.toml exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\n');
    expect(detectTestCmd(tmpDir)).toBe('cargo test');
  });

  it('returns null when no known files exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
    expect(detectTestCmd(tmpDir)).toBeNull();
  });
});

describe('parseFailureCount (dual-impl test outcome scoring)', () => {
  it('counts ✗ markers (bun-style)', () => {
    const out = '✗ test 1 failed\n✗ test 2 failed\n✗ test 3 failed\n';
    expect(parseFailureCount(out)).toBe(3);
  });

  it('counts FAIL markers (jest/pytest-style) when no ✗ present', () => {
    const out = 'PASS test 1\nFAIL test 2\nFAIL test 3\n';
    expect(parseFailureCount(out)).toBe(2);
  });

  it('returns undefined on output with no failure markers (no signal)', () => {
    expect(parseFailureCount('All tests passed.')).toBeUndefined();
  });

  it('returns undefined on empty output', () => {
    expect(parseFailureCount('')).toBeUndefined();
  });

  it('uses larger of ✗ vs FAIL counts when both appear (no summary line)', () => {
    const out = '✗ a\n✗ b\nFAIL c\n';
    expect(parseFailureCount(out)).toBe(2);
  });

  it('prefers explicit summary line ("3 failed") over marker counts', () => {
    // bun summary line beats a few stray ✗ in stack traces
    const out = '✗ test 1\n✗ test 2\n--- summary ---\n3 failed, 1 passed\n';
    expect(parseFailureCount(out)).toBe(3);
  });

  it('matches pytest summary "===== 2 failed in 0.10s ====="', () => {
    const out = `FAILED test_foo.py::test_bar - AssertionError\nFAILED test_baz.py::test_qux - ValueError\n===== 2 failed in 0.10s =====\n`;
    expect(parseFailureCount(out)).toBe(2);
  });

  it('matches pytest summary with mixed pass/fail "===== 3 failed, 5 passed in 1.2s ====="', () => {
    const out = `===== 3 failed, 5 passed in 1.2s =====\n`;
    expect(parseFailureCount(out)).toBe(3);
  });

  it('counts FAILED markers as fallback when no summary line', () => {
    const out = 'FAILED test_a\nFAILED test_b\nFAILED test_c\n';
    expect(parseFailureCount(out)).toBe(3);
  });
});

describe('parseJudgeVerdict (Opus tournament judge output)', () => {
  it('extracts WINNER: gemini + REASONING from valid output', () => {
    const out = 'Reviewing both implementations...\nWINNER: gemini\nREASONING: cleaner code, fewer abstractions\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
    expect(result.reasoning).toContain('cleaner code');
  });

  it('extracts WINNER: codex + REASONING from valid output', () => {
    const out = 'WINNER: codex\nREASONING: handles edge cases better and is more concise';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('codex');
    expect(result.reasoning).toContain('edge cases');
  });

  it('returns verdict=null when WINNER line is missing (caller must fail-closed)', () => {
    const out = 'The judge output is malformed somehow';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBeNull();
    expect(result.reasoning).toMatch(/no anchored WINNER|fail-closed/i);
  });

  it('returns verdict=null when WINNER appears mid-sentence (must be anchored)', () => {
    const out = 'I think the WINNER: gemini is the better choice here.';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBeNull();
  });

  it('handles missing REASONING (still extracts verdict)', () => {
    const out = 'WINNER: codex\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('codex');
    expect(result.reasoning).toBe('');
  });

  it('case-insensitive WINNER value', () => {
    const out = 'WINNER: GEMINI\nREASONING: ok';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
  });

  it('returns verdict=null for empty string (P2-3: emptyFileIsError stdout=\'\' path)', () => {
    // mergeOutputFile sets stdout='' when the judge output file is empty.
    // parseJudgeVerdict must return null so the caller fails-closed (falls back
    // to gemini) rather than extracting a false WINNER from an error message.
    const result = parseJudgeVerdict('');
    expect(result.verdict).toBeNull();
  });

  it('returns verdict=null for diagnostic text that does not contain WINNER: (safety check)', () => {
    // Verify that the error message format used in the old code (before P2-3)
    // would not accidentally produce a verdict even if it appeared in stdout.
    const diagnosticMsg = 'Judge did not write expected output to /tmp/judge-out.md. Original shell stdout:\nLoading model...';
    const result = parseJudgeVerdict(diagnosticMsg);
    expect(result.verdict).toBeNull();
  });

  it('extracts HARDENING notes when all three sections are present', () => {
    const out =
      'WINNER: gemini\nREASONING: cleaner implementation\nHARDENING:\n- Handle null input in processPayment\n- Guard against empty worktree path\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
    expect(result.reasoning).toContain('cleaner implementation');
    expect(result.hardeningNotes).toContain('Handle null input');
    expect(result.hardeningNotes).toContain('Guard against empty worktree path');
  });

  it('returns empty hardeningNotes when HARDENING section is absent', () => {
    const out = 'WINNER: codex\nREASONING: fewer abstractions\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('codex');
    expect(result.hardeningNotes).toBe('');
  });

  it('REASONING does not bleed into HARDENING section', () => {
    const out = 'WINNER: gemini\nREASONING: good structure\nHARDENING:\n- edge case A\n';
    const result = parseJudgeVerdict(out);
    expect(result.reasoning).not.toContain('edge case A');
    expect(result.hardeningNotes).toContain('edge case A');
  });

  it('extracts HARDENING when it appears before REASONING (order variation)', () => {
    const out = 'WINNER: codex\nHARDENING:\n- null check missing\nREASONING: overall better approach\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('codex');
    expect(result.hardeningNotes).toContain('null check missing');
    expect(result.reasoning).toContain('overall better approach');
  });

  it('parses correctly when input has Windows CRLF line endings', () => {
    const out = 'WINNER: gemini\r\nREASONING: clean impl\r\nHARDENING:\r\n- guard null path\r\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
    expect(result.reasoning).toContain('clean impl');
    expect(result.hardeningNotes).toContain('guard null path');
  });

  it('HARDENING: -> none identified inline sentinel is captured and does not bleed into REASONING', () => {
    const out =
      'WINNER: codex\n' +
      'REASONING: both implementations are clean with no major differences.\n' +
      'HARDENING: -> none identified\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('codex');
    expect(result.reasoning).not.toContain('none identified');
    expect(result.hardeningNotes).toContain('none identified');
  });

  it('REASONING does not truncate when "HARDENING:" appears mid-sentence in prose', () => {
    // Fix #3: tightened regex requires HARDENING: to be standalone or bullet-prefixed.
    // A sentence containing "HARDENING:" as prose should not end the REASONING block.
    const out =
      'WINNER: gemini\n' +
      'REASONING: The key concern is HARDENING: this is prose, not a section. More text here.\n' +
      'HARDENING:\n' +
      '- actual hardening note\n';
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe('gemini');
    expect(result.reasoning).toContain('HARDENING: this is prose');
    expect(result.hardeningNotes).toContain('actual hardening note');
  });
});

describe('buildCodexImplArgv (codex exec invocation shape)', () => {
  it('builds argv with exec + workspace-write default + worktree cwd', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/in.md',
      outputFilePath: '/tmp/out.md',
      cwd: '/tmp/gstack-dual-myslug-p1-1234567890/gemini',
    });
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('-s');
    // Default is workspace-write — danger-full-access was unsafe in linked
    // worktrees (shared .git dir + remotes). Override via opts.sandbox or env.
    expect(argv).toContain('workspace-write');
    expect(argv).toContain('-C');
    expect(argv).toContain('/tmp/gstack-dual-myslug-p1-1234567890/gemini');
  });

  it('uses xhigh reasoning effort (thinking mode) by default', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/in.md',
      outputFilePath: '/tmp/out.md',
      cwd: '/tmp/wt',
    });
    expect(argv).toContain('model_reasoning_effort="xhigh"');
  });

  it('honors opts.sandbox override (e.g. danger-full-access when explicitly opted in)', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/in.md',
      outputFilePath: '/tmp/out.md',
      cwd: '/tmp/wt',
      sandbox: 'danger-full-access',
    });
    expect(argv).toContain('danger-full-access');
    expect(argv).not.toContain('workspace-write');
  });

  it('embeds inputFilePath and outputFilePath into the prompt arg', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/MY_INPUT.md',
      outputFilePath: '/tmp/MY_OUTPUT.md',
      cwd: '/tmp/worktree',
    });
    const prompt = argv[1];
    expect(prompt).toContain('/tmp/MY_INPUT.md');
    expect(prompt).toContain('/tmp/MY_OUTPUT.md');
  });

  it('includes -m <model> when model is specified', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/in.md',
      outputFilePath: '/tmp/out.md',
      cwd: '/tmp/wt',
      model: 'gpt-5.3-codex-spark',
    });
    const mIdx = argv.indexOf('-m');
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe('gpt-5.3-codex-spark');
  });

  it('omits -m when model is not specified', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/in.md',
      outputFilePath: '/tmp/out.md',
      cwd: '/tmp/wt',
    });
    expect(argv).not.toContain('-m');
  });

  it('-m appears before -s so model is set before sandbox flags', () => {
    const argv = buildCodexImplArgv({
      inputFilePath: '/tmp/in.md',
      outputFilePath: '/tmp/out.md',
      cwd: '/tmp/wt',
      model: 'gpt-5.3-codex-spark',
    });
    const mIdx = argv.indexOf('-m');
    const sIdx = argv.indexOf('-s');
    expect(mIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(mIdx);
  });
});

describe('buildCodexReviewArgv (codex review invocation shape)', () => {
  it('uses xhigh reasoning effort (thinking mode) by default', () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: '/tmp/review-in.md',
      outputFilePath: '/tmp/review-out.md',
      cwd: '/tmp/wt',
    });
    expect(argv).toContain('model_reasoning_effort="xhigh"');
  });

  it('includes -m <model> when model is specified', () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: '/tmp/review-in.md',
      outputFilePath: '/tmp/review-out.md',
      cwd: '/tmp/wt',
      model: 'gpt-5.5',
    });
    const mIdx = argv.indexOf('-m');
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe('gpt-5.5');
  });

  it('omits -m when model is not specified', () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: '/tmp/review-in.md',
      outputFilePath: '/tmp/review-out.md',
      cwd: '/tmp/wt',
    });
    expect(argv).not.toContain('-m');
  });

  it('-m appears before -s so model is set before sandbox flags', () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: '/tmp/review-in.md',
      outputFilePath: '/tmp/review-out.md',
      cwd: '/tmp/wt',
      model: 'gpt-5.5',
    });
    const mIdx = argv.indexOf('-m');
    const sIdx = argv.indexOf('-s');
    expect(mIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(mIdx);
  });

  it('embeds custom command in the prompt arg', () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: '/tmp/review-in.md',
      outputFilePath: '/tmp/review-out.md',
      cwd: '/tmp/wt',
      command: '/gstack-qa',
    });
    const prompt = argv[1];
    expect(prompt).toContain('/gstack-qa');
    expect(prompt).not.toContain('/gstack-review');
  });

  it('honors sandbox override (read-only)', () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: '/tmp/review-in.md',
      outputFilePath: '/tmp/review-out.md',
      cwd: '/tmp/wt',
      sandbox: 'read-only',
    });
    expect(argv).toContain('read-only');
    expect(argv).not.toContain('workspace-write');
  });

  it('honors reasoning override (high overrides xhigh default)', () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: '/tmp/review-in.md',
      outputFilePath: '/tmp/review-out.md',
      cwd: '/tmp/wt',
      reasoning: 'high',
    });
    expect(argv).toContain('model_reasoning_effort="high"');
    expect(argv).not.toContain('model_reasoning_effort="xhigh"');
  });
});
