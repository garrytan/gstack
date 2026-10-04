import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { expectMentions } from './helpers/prompt-structure';

const template = fs.readFileSync(
  path.join(import.meta.dir, '..', '.github', 'PULL_REQUEST_TEMPLATE.md'),
  'utf8',
);

describe('gstack PR liveness policy', () => {
  test('remembers the authenticated repository-owner exemption', () => {
    expect(template).toContain('gh api user --jq .login');
    expectMentions(template, [['not', 'sufficient', 'metadata']], 'template');
  });

  test('retains live GSTACK PR proof for every other contributor', () => {
    expect(template).toContain('required for external contributors');
    expect(template).toContain('All other contributors');
    expect(template).toContain('`GSTACK PR` typed LIVE');
    expectMentions(template, [['not', 'overlaid', 'edited']], 'template');
  });
});
