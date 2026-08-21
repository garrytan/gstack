import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function template(skill: 'noshit' | 'fcukit'): string {
  return readFileSync(join(ROOT, skill, 'SKILL.md.tmpl'), 'utf8');
}

describe('/noshit contract', () => {
  const body = template('noshit');

  test('has no mutation-capable file tools', () => {
    const frontmatter = body.slice(0, body.indexOf('\n---', 4));
    expect(frontmatter).not.toMatch(/^\s+- (Write|Edit|NotebookEdit)$/m);
    expect(frontmatter).toContain('  - Read');
  });

  test('states an unconditional zero-write gate', () => {
    expect(body).toContain('**NO FIXES. NO WRITES.**');
    expect(body).toContain('Do not execute project tests, linters, builds');
    expect(body).toContain('Read-only audit: no files or settings changed.');
    expect(body).not.toContain('{{PREAMBLE}}');
    expect(body).not.toContain('preamble-tier:');
  });

  test('uses required statuses and never promotes unknown', () => {
    for (const status of ['PASS', 'WARN', 'FAIL', 'UNKNOWN']) {
      expect(body).toContain(`\`${status}\``);
    }
    expect(body).toContain('Never turn `UNKNOWN` into `PASS`');
  });

  test('does not duplicate health', () => {
    expect(body).toContain('Do not score code quality');
    expect(body).toContain('Route code-quality questions to `/health`');
  });

  test('unsupported host checks become unknown', () => {
    expect(body).toContain('host-specific checks as `UNKNOWN`');
  });
});

describe('/fcukit contract', () => {
  const body = template('fcukit');

  test('discovery precedes approval and writes', () => {
    expect(body.indexOf('## Phase 0: Establish identity')).toBeLessThan(body.indexOf('## Phase 5: One consolidated approval gate'));
    expect(body.indexOf('## Phase 5: One consolidated approval gate')).toBeLessThan(body.indexOf('## Phase 6: Apply only approved changes'));
  });

  test('headless mode blocks before mutation', () => {
    expect(body).toContain('`GSTACK_HEADLESS`, `CI`, or');
    expect(body).toContain('`GITHUB_ACTIONS`');
    expect(body).toContain('BLOCKED: approval required');
    expect(body).toContain('No files or settings changed.');
    expect(body).not.toContain('{{PREAMBLE}}');
  });

  test('fails closed when interactive approval tooling is unavailable', () => {
    expect(body).toContain('In Conductor, render the same consolidated decision as prose');
    expect(body).toContain('If AskUserQuestion is unavailable, fails, or returns no usable answer');
    expect(body).toContain('stale or generic consent never counts');
  });

  test('protects identity and unrelated work', () => {
    expect(body).toContain('Do not run `git init` while identity is ambiguous');
    expect(body).toContain('Record the exact pre-existing changed paths');
    expect(body).toContain('verify every pre-existing unrelated path is unchanged');
    expect(body).toContain('Do not stage or commit');
  });

  test('keeps gbrain optional and routes workflows', () => {
    expect(body).toContain('create memory or bindings in this skill');
    expect(body).toContain('code quality to `/health`');
    expect(body).toContain('`/setup-gbrain`, and shipping');
  });
});
