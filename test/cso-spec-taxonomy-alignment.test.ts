/** CSO uses versioned domain mappings and the shared fail-closed secret taxonomy. */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const CSO = fs.readFileSync(path.join(ROOT, 'cso/SKILL.md'), 'utf8') + '\n'
  + fs.readFileSync(path.join(ROOT, 'cso/sections/audit-phases.md'), 'utf8');

describe('CSO domain source and redaction contracts', () => {
  test('credential recognition uses the shared taxonomy without raw history commands', () => {
    for (const prefix of ['AKIA', 'ghp_', 'sk-ant-', 'BEGIN']) expect(CSO).toContain(prefix);
    expect(CSO).toContain('lib/redact-patterns.ts');
    expect(CSO).toContain('Secrets Archaeology');
    expect(CSO).toContain('Never print raw `git log -p --all`');
    expect(CSO).toContain('Do not call live provider APIs');
  });

  test('OWASP 2025 mapping does not retain obsolete 2021 category numbers', () => {
    const rows = CSO.split('\n').filter(line => /^\| A\d\d \|/.test(line));
    expect(rows).toHaveLength(10);
    const categories = new Map(rows.map(line => {
      const [, id, name] = line.split('|').map(part => part.trim());
      return [id, name];
    }));
    expect(categories.get('A02')).toBe('Security Misconfiguration');
    expect(categories.get('A03')).toBe('Software Supply Chain Failures');
    expect(categories.get('A10')).toBe('Mishandling of Exceptional Conditions');
    expect(rows.find(line => line.startsWith('| A01 |'))).toContain('SSRF');
  });

  test('domain standards carry inspected versions and no inferred compliance', () => {
    for (const version of ['OWASP Top 10:2025', 'OWASP API Security Top 10:2023', 'ASVS version: 5.0.0', 'v5.0.0-1.2.5', 'LLM Top 10 2026', 'Agentic Applications Top 10 2026', 'MCP security guidance version: 2026-07-28']) expect(CSO).toContain(version);
    expect(CSO).toContain('artifact 56857');
    expect(CSO).toContain('unset publication-date field');
    expect(CSO).toContain('artifact 52117');
    expect(CSO).toContain('Do not invent IDs');
  });

  test('all declared scanners retain execution and evidence boundaries', () => {
    for (const scanner of ['Gitleaks', 'OSV-Scanner', 'Semgrep', 'zizmor', 'Trivy', 'Schemathesis']) expect(CSO).toContain(scanner);
    expect(CSO).toContain('Import existing SARIF');
    expect(CSO).toContain('public wheels');
    expect(CSO).toContain('Gemfile.lock` parsed as inert data');
    expect(CSO).toContain('Python `--no-build` alone');
    expect(CSO).toContain('every database connection');
  });
});
