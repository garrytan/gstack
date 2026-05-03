import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SHIP_SKILL = path.join(__dirname, '..', 'ship', 'SKILL.md');

describe('ship/SKILL.md — Plan Completion gate invariants (VAS-449 remediation)', () => {
  const skill = fs.readFileSync(SHIP_SKILL, 'utf8');

  test('Path concreteness rule: filesystem-pathed items must be test -f checked', () => {
    expect(skill).toContain('**Path concreteness rule.**');
    expect(skill).toMatch(/concrete filesystem path/);
    expect(skill).toMatch(/MUST be classified DONE or NOT DONE based on `\[ -f/);
  });

  test('Validator detection: project package.json validate-* scripts are auto-run', () => {
    expect(skill).toContain('**Validator detection.**');
    expect(skill).toMatch(/package\.json/);
    expect(skill).toMatch(/validate-\*/);
  });

  test('Per-item UNVERIFIABLE confirmation: blanket-confirm is forbidden', () => {
    expect(skill).toContain('**Per-item confirmation is mandatory.**');
    expect(skill).toMatch(/Do NOT use a single AskUserQuestion to blanket-confirm/);
    expect(skill).toMatch(/VAS-449/);
  });

  test('Subagent failure: fail-closed, not silent fail-open', () => {
    expect(skill).not.toMatch(/Never block \/ship on subagent failure\.\s*$/m);
    expect(skill).toMatch(/Silent fail-open is the failure shape that VAS-449 surfaced/);
    expect(skill).toMatch(/Stop and fix the audit/);
  });

  test('CONTENT-SHAPE dispatch invokes validator before falling back to UNVERIFIABLE', () => {
    expect(skill).toMatch(/CONTENT-SHAPE in another repo.*validator/s);
    expect(skill).toMatch(/passing validator promotes the item from UNVERIFIABLE to DONE/);
  });
});
