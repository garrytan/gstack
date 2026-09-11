import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('review effect modes', () => {
  test('plain, fix, reply, and combined modes have closed independent effects', () => {
    const source = fs.readFileSync(path.join(ROOT, 'review/SKILL.md.tmpl'), 'utf8');
    expect(source).toContain('review` — report-only');
    expect(source).toContain('review --fix` — bounded tracked writes');
    expect(source).toContain('review --reply-greptile` — report-only plus explicit replies');
    expect(source).toContain('review --fix --reply-greptile`');
    expect(source).toContain('No mode grants commit, push, PR creation/update, merge, or deploy');
  });

  test('clean receipt requires one final report-only pass on one unchanged tree', () => {
    const source = fs.readFileSync(path.join(ROOT, 'review/SKILL.md.tmpl'), 'utf8');
    expect(source.match(/gstack-review-log begin --skill review/g)?.length).toBe(2);
    expect(source).toContain('"status":"superseded_after_fix"');
    expect(source).toContain('FINAL_REVIEW_START_WTREE');
    expect(source).toContain('test "$FINAL_REVIEW_START_WTREE" = "$FINAL_REVIEW_END_WTREE"');
    expect(source).toContain('gstack-review-log finish --run-id "$REVIEW_RUN_ID"');
    expect(source).toContain('If the final pass proposes another fix');
  });
});
