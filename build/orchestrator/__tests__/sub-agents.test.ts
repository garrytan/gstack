import { describe, it, expect, afterEach } from 'bun:test';
import {
  parseVerdict,
  stripAnsi,
  detectTestCmd,
  parseFailureCount,
  parseJudgeVerdict,
  buildCodexImplArgv,
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
});
