import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BASELINE_FILE, parseFindings, readBaseline, runLint, type OxlintRun } from '../scripts/lint-ratchet';

const PIN = '1.2.3';
const roots: string[] = [];

type Finding = { file: string; rule?: string; message: string; line: number };
const report = (findings: Finding[]) => JSON.stringify({
  diagnostics: findings.map(f => ({ filename: f.file, code: f.rule, message: f.message, severity: 'error', labels: [{ span: { line: f.line, column: 1 } }] })),
});
const oxlint = (findings: Finding[], status = findings.length ? 1 : 0) => (): OxlintRun => ({ status, signal: null, stdout: report(findings), stderr: '' });

const unused = { file: 'src/a.ts', rule: 'eslint(no-unused-vars)', message: "Identifier 'fs' is imported but never used.", line: 3 };
const escape = { file: 'src/b.ts', rule: 'eslint(no-useless-escape)', message: 'Unnecessary escape character \'.\'', line: 9 };

function fixture(options: { pin?: string; installed?: string | null; baseline?: unknown } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lint-ratchet-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { oxlint: options.pin ?? PIN } }));
  if (options.installed !== null) {
    fs.mkdirSync(path.join(root, 'node_modules', 'oxlint'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'oxlint', 'package.json'), JSON.stringify({ version: options.installed ?? PIN }));
  }
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  if (options.baseline !== undefined) {
    const text = typeof options.baseline === 'string' ? options.baseline : JSON.stringify(options.baseline);
    fs.writeFileSync(path.join(root, BASELINE_FILE), text);
  }
  return root;
}
const baselineOf = (findings: Finding[], oxlintVersion = PIN) => ({ version: 1, oxlint: oxlintVersion, findings: parseFindings(report(findings)).counts });
const baselineBytes = (root: string) => fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('oxlint ratchet', () => {
  test('identity is file + rule + message: repeats count, lines do not matter, a missing rule is a syntax error', () => {
    const counts = parseFindings(report([unused, { ...unused, line: 40 }, { file: 'src\\c.ts', message: 'Identifier `os` has already been declared', line: 22 }])).counts;
    expect(counts).toEqual({
      "src/a.ts\teslint(no-unused-vars)\tIdentifier 'fs' is imported but never used.": 2,
      'src/c.ts\tsyntax-error\tIdentifier `os` has already been declared': 1,
    });
    expect(parseFindings(report([{ ...unused, line: 300 }])).counts).toEqual(parseFindings(report([unused])).counts);
  });

  test('a clean tree passes, and a known finding that moved lines still passes', () => {
    const root = fixture({ baseline: baselineOf([unused, escape]) });
    const result = runLint({ root, oxlint: oxlint([{ ...unused, line: 120 }, escape]) });
    expect(result).toEqual({ exitCode: 0, out: [`lint ratchet: 2 known findings, none new (oxlint ${PIN}).`], err: [] });
  });

  test('LINT_RATCHET_NEW names file:line, rule, the fix text and a reproduce command', () => {
    const root = fixture({ baseline: baselineOf([unused]) });
    const result = runLint({ root, oxlint: oxlint([unused, { ...unused, line: 7 }, escape]) });
    expect(result.exitCode).toBe(1);
    expect(result.err).toEqual([
      'LINT_RATCHET_NEW: 2 new or more frequent oxlint finding(s). Fix them; do not add them to the baseline.',
      "  + src/a.ts:3,7 eslint(no-unused-vars): Identifier 'fs' is imported but never used. (1 → 2)",
      "  + src/b.ts:9 eslint(no-useless-escape): Unnecessary escape character '.' (0 → 1)",
      'Reproduce with: bunx oxlint -c .oxlintrc.json src/a.ts src/b.ts',
    ]);
  });

  test('LINT_RATCHET_FIXED asks for --write-baseline, which shrinks the baseline', () => {
    const root = fixture({ baseline: baselineOf([unused, escape]) });
    const fixed = runLint({ root, oxlint: oxlint([escape]) });
    expect(fixed.exitCode).toBe(1);
    expect(fixed.err[0]).toBe('LINT_RATCHET_FIXED: 1 finding(s) fixed. Lock the smaller allowance in with: bun run lint --write-baseline (it only shrinks)');
    expect(fixed.err[1]).toContain('src/a.ts eslint(no-unused-vars)');
    expect(runLint({ root, write: true, oxlint: oxlint([escape]) }).exitCode).toBe(0);
    expect(readBaseline(path.join(root, BASELINE_FILE))).toEqual({ oxlint: PIN, findings: parseFindings(report([escape])).counts });
    expect(runLint({ root, oxlint: oxlint([escape]) }).exitCode).toBe(0);
  });

  test('--write-baseline never grows the baseline: a new finding refuses and leaves the file untouched', () => {
    const root = fixture({ baseline: baselineOf([unused]) });
    const before = baselineBytes(root);
    const result = runLint({ root, write: true, oxlint: oxlint([escape]) });
    expect(result.exitCode).toBe(1);
    expect(result.err[0]).toStartWith('LINT_RATCHET_NEW:');
    expect(result.err.at(-1)).toBe('--write-baseline only shrinks the baseline; it never adds a finding.');
    expect(baselineBytes(root)).toBe(before);
  });

  test('LINT_BASELINE_INVALID for a missing, malformed or other-version baseline, never rewritten', () => {
    const missing = fixture();
    const result = runLint({ root: missing, write: true, oxlint: oxlint([]) });
    expect(result.exitCode).toBe(2);
    expect(result.err[0]).toStartWith('LINT_BASELINE_INVALID: scripts/lint-baseline.json is missing or unreadable');
    expect(result.err[0]).toContain('never rewritten automatically');
    expect(fs.existsSync(path.join(missing, BASELINE_FILE))).toBe(false);
    for (const bad of ['{not json', { version: 2, oxlint: PIN, findings: {} }, { version: 1, findings: {} }, { version: 1, oxlint: PIN, findings: { x: 0 } }]) {
      const root = fixture({ baseline: bad });
      const before = baselineBytes(root);
      const invalid = runLint({ root, write: true, oxlint: oxlint([]) });
      expect(invalid.exitCode).toBe(2);
      expect(invalid.err[0]).toStartWith('LINT_BASELINE_INVALID:');
      expect(baselineBytes(root)).toBe(before);
    }
    const stale = fixture({ baseline: baselineOf([unused], '1.0.0') });
    const old = runLint({ root: stale, oxlint: oxlint([unused]) });
    expect(old.exitCode).toBe(2);
    expect(old.err).toEqual([`LINT_BASELINE_INVALID: scripts/lint-baseline.json was written by oxlint 1.0.0, and package.json pins ${PIN}. Rewrite it for the new pin in the same change: bun run lint --write-baseline --oxlint-upgrade`]);
    const range = runLint({ root: fixture({ pin: '^1.2.3', baseline: baselineOf([]) }), oxlint: oxlint([]) });
    expect(range.err[0]).toStartWith('LINT_BASELINE_INVALID: package.json must pin oxlint to an exact version');
  });

  test('--oxlint-upgrade rewrites only a baseline from another oxlint version', () => {
    const root = fixture({ baseline: baselineOf([unused], '1.0.0') });
    const upgraded = runLint({ root, write: true, upgrade: true, oxlint: oxlint([unused, escape]) });
    expect(upgraded.exitCode).toBe(0);
    expect(readBaseline(path.join(root, BASELINE_FILE))).toEqual({ oxlint: PIN, findings: parseFindings(report([unused, escape])).counts });
    const again = runLint({ root, write: true, upgrade: true, oxlint: oxlint([unused, escape]) });
    expect(again.exitCode).toBe(2);
    expect(again.err[0]).toContain('Use --write-baseline, which only shrinks.');
    expect(runLint({ root, upgrade: true, oxlint: oxlint([]) }).err).toEqual(['lint ratchet: --oxlint-upgrade only goes with --write-baseline.']);
  });

  test('OXLINT_MISSING when oxlint is absent or not at the pin', () => {
    const absent = runLint({ root: fixture({ installed: null, baseline: baselineOf([]) }), oxlint: oxlint([]) });
    expect(absent).toMatchObject({ exitCode: 2, err: ['OXLINT_MISSING: oxlint is not installed (node_modules/oxlint). Run: bun install'] });
    const drift = runLint({ root: fixture({ installed: '1.2.4', baseline: baselineOf([]) }), oxlint: oxlint([]) });
    expect(drift.err).toEqual([`OXLINT_MISSING: installed oxlint 1.2.4 does not match package.json's pin ${PIN}. Run: bun install`]);
  });

  test('OXLINT_CRASH prints the oxlint version, the config path and the output tail', () => {
    const root = fixture({ baseline: baselineOf([]) });
    const crashed = runLint({ root, oxlint: () => ({ status: 2, signal: null, stdout: '', stderr: 'Failed to parse configuration file' }) });
    expect(crashed.exitCode).toBe(2);
    expect(crashed.err).toEqual([`OXLINT_CRASH: oxlint ${PIN} (config .oxlintrc.json) ended without a report (exit 2).`, 'Failed to parse configuration file']);
    const truncated = runLint({ root, oxlint: () => ({ status: 1, signal: null, stdout: report([unused]).slice(0, 40), stderr: '' }) });
    expect(truncated.err[0]).toStartWith('OXLINT_CRASH:');
  });

  test('the committed baseline is readable and written by the oxlint package.json pins', () => {
    const root = path.resolve(import.meta.dir, '..');
    const pin = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.oxlint;
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    const baseline = readBaseline(path.join(root, BASELINE_FILE));
    expect(baseline.oxlint).toBe(pin);
    expect(Object.keys(baseline.findings).length).toBeGreaterThan(0);
  });
});
