import { describe, it, expect, afterEach } from 'bun:test';
import { parseVerdict, stripAnsi, detectTestCmd } from '../sub-agents';
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
