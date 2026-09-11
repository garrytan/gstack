import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('generated landing remote-head binding', () => {
  test('uses exact-head guard and direct CAS merge without implicit cleanup', () => {
    const source = fs.readFileSync(path.join(ROOT, 'land-and-deploy/sections/merge-and-deploy.md.tmpl'), 'utf8');
    expect(source).toContain('gstack-pr-head-guard assert');
    expect(source).toContain('--expected "$PR_HEAD_OID"');
    expect(source).toContain('--expected-base "$PR_BASE_OID"');
    expect(source).toContain('--assert-target-ref "$PR_TARGET_REF"');
    expect(source).toContain('gstack-effect-scope provider-merge direct');
    expect(source).toContain('--assert-ship-receipt "$SHIP_RECEIPT_ID"');
    // The workflow may name a forbidden CLI in a warning; executable fences
    // must never invoke it. Keep cleanup tokens absent from the whole workflow.
    const commands = [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]).join('\n');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).not.toMatch(/\bgh\s+pr\s+merge\b/);
    const prohibition = 'never\nsilently substitute squash or bypass the adapter with `gh pr merge`.';
    expect(source).toContain(prohibition);
    expect(source.replace(prohibition, '')).not.toMatch(/\bgh\s+pr\s+merge\b/);
    for (const forbidden of ['--delete-branch', 'git push origin --delete', 'git branch -d', 'git worktree remove']) {
      expect(source).not.toContain(forbidden);
    }
  });

  test('names an exact PR in preflight and never infers merge authority from current branch', () => {
    const source = fs.readFileSync(path.join(ROOT, 'land-and-deploy/SKILL.md.tmpl'), 'utf8');
    const generated = fs.readFileSync(path.join(ROOT, 'land-and-deploy/SKILL.md'), 'utf8');
    expect(source).toContain('gstack-pr-head-guard snapshot --pr "$PR_NUMBER"');
    expect(source).toContain('gstack-pr-checks snapshot --pr "$PR_NUMBER"');
    expect(source.indexOf('provider-merge discover')).toBeLessThan(source.indexOf('gstack-pr-head-guard snapshot'));
    expect(source).toContain('LANDING_RECOVERY == 1');
    expect(source).toContain('skip Steps 1.5, 2, and 3');
    expect(generated).toContain('skip Steps 1.5, 2, and 3');
    expect(source).toContain('SHIP_RECOVERY_LANDING_ID=');
    expect(source).toContain('SHIP_RECOVERY_SUBJECT_TREE=');
  });

  test('binds fresh merge to the resolved lane and recovery to the frozen landing',()=>{const source=fs.readFileSync(path.join(ROOT,'land-and-deploy/sections/merge-and-deploy.md.tmpl'),'utf8');expect(source).toContain('LAND_PLAN_LANE=$(printf');expect(source).toContain('LAND_PLAN_LANE=$SHIP_RECOVERY_LANE');expect(source).toContain('--assert-plan-lane "$LAND_PLAN_LANE"');expect(source).toContain('--assert-milestone-landing "$SHIP_RECOVERY_LANDING_ID"')});
});
