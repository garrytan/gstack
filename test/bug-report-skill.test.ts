import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('/bug-report skill', () => {
  test('is report-only and requires explicit approval before publication', () => {
    const template = read('bug-report/SKILL.md.tmpl');

    expect(template).toContain('REPORT, DO NOT FIX');
    expect(template).toContain('NO SURPRISE PUBLICATION');
    expect(template).toContain('does not fix code or publish the report without explicit approval');
    expect(template).not.toMatch(/allowed-tools:[\s\S]*?\n  - Edit\n/);
  });

  test('requires reproducible evidence and distinguishes fact from hypothesis', () => {
    const template = read('bug-report/SKILL.md.tmpl');

    expect(template).toContain('## Steps to reproduce');
    expect(template).toContain('## Evidence');
    expect(template).toContain('### Confirmed facts');
    expect(template).toContain('### Root-cause hypothesis');
    expect(template).toContain('Not reproduced');
  });

  test('protects sensitive histories and scans the report at the sink', () => {
    const template = read('bug-report/SKILL.md.tmpl');

    expect(template).toMatch(/shell history as\s+sensitive activity records/);
    expect(template).toContain('{{REDACT_INVOCATION_BLOCK:pre-issue:retain}}');
    expect(template).toContain('{{REDACT_INVOCATION_BLOCK:pre-pr-body:brief:retain}}');
    expect(template).toContain('Never run bare `env`, `printenv`, `set`');
    expect(template).toContain('Never copy an entire tool home');
    expect(template).toContain('SQLite state');
    expect(template).toContain('Treat every evidence file as its own persistence sink');
    expect(template).toContain('separate sinks');
    expect(template).toContain('finally-style cleanup step');
    expect(template).toContain('Rerun the PR-body scan');
    expect(template).toContain('Screenshots and other binary evidence require a separate visual privacy gate');
    expect(template).toContain('Never upload raw captures');
  });

  test('generated workflow retains scanned bytes until persistence succeeds', () => {
    const generated = read('bug-report/SKILL.md');
    expect(generated).toContain('Retain `$REDACT_FILE` for the immediate destination write');
    expect(generated).toContain('Never delete or reconstruct it before the write');
    expect(generated).toContain('Retain `$REDACT_FILE` until the destination write succeeds');

    const reportScan = generated.slice(
      generated.indexOf('#### Redaction scan — pre-issue'),
      generated.indexOf('Before writing or returning the companion PR body'),
    );
    const writeIndex = reportScan.indexOf('Write or send');
    const cleanupIndex = reportScan.indexOf('rm -f "$REDACT_FILE"');
    expect(writeIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(writeIndex);
  });

  test('drafts honest maintainer guidance without pretending a fix exists', () => {
    const template = read('bug-report/SKILL.md.tmpl');

    expect(template).toContain('{YYYY-MM-DD}-{slug}-pr-body.md');
    expect(template).toContain('Not implemented in this report-only run');
    expect(template).toContain('Verify generator idempotency by snapshotting');
  });

  test('is included in the router and documentation inventories', () => {
    const router = read('SKILL.md.tmpl');
    expect(router).toContain('"this doesn\'t work"');
    expect(router).toMatch(/"this doesn't work"[^\n]+invoke `\/investigate`/);
    expect(router).toMatch(/Explicit precedence exception:[^\n]+invoke `\/bug-report`/);
    expect(read('AGENTS.md')).toContain('`/bug-report`');
    expect(read('docs/skills.md')).toContain('## `/bug-report`');
  });

  test('produces PR guidance without manufacturing an empty PR', () => {
    const template = read('bug-report/SKILL.md.tmpl');
    expect(template).toContain('-pr-body.md');
    expect(template).toContain('How maintainers can verify');
    expect(template).toContain('Do not manufacture an');
    expect(template).toContain('Open a remote draft PR only when');
  });

  test('generated catalogs include the skill', () => {
    expect(read('gstack/llms.txt')).toContain('[/bug-report](bug-report/SKILL.md)');
    expect(read('scripts/proactive-suggestions.json')).toContain('"bug-report"');
  });
});
