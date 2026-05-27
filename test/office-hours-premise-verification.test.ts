import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const skill = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');

function section(heading: string): string {
  const start = skill.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = skill.slice(start + heading.length).match(/\n## /);
  const end = next ? start + heading.length + next.index : skill.length;
  return skill.slice(start, end);
}

describe('/office-hours premise verification', () => {
  test('Phase 1 requires a conditional Codebase Surface Map', () => {
    const phase1 = section('## Phase 1: Context Gathering');

    expect(phase1).toContain('Codebase Surface Map');
    expect(phase1).toContain('schema-touching');
    expect(phase1).toContain('visibility/auth-touching');
    expect(phase1).toContain('server-action-touching');
    expect(phase1).toContain('recent migrations touching affected tables');
    expect(phase1).toContain('RLS policies');
    expect(phase1).toContain('existing server actions');
  });

  test('Phase 3 verifies codebase-fact premises before AskUserQuestion', () => {
    const phase3 = section('## Phase 3: Premise Challenge');
    const verifyIndex = phase3.indexOf('Verify against code first');
    const askIndex = phase3.indexOf('Use AskUserQuestion to confirm');

    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(askIndex).toBeGreaterThan(verifyIndex);
    expect(phase3).toContain('premise that asserts a codebase fact');
    expect(phase3).toContain('relevant migrations, policies, actions, handlers, jobs, or files');
    expect(phase3).toContain('evidence path(s)');
    expect(phase3).toContain('UNVERIFIED');
  });

  test('Phase 5 reviewer must read referenced sources and report doc-vs-code mismatches', () => {
    const specReview = section('## Spec Review Loop');

    expect(specReview).toContain('READ the referenced sources');
    expect(specReview).toContain('report doc-vs-code mismatches');
    expect(specReview).toContain('Do not limit review to internal doc consistency');
    expect(specReview).not.toContain('do NOT read them yourself');
  });
});
