/**
 * The reviewer-packet path from #3621 and #3636 was reverted after no-loss round 3
 * (GSTA-167): packet reviewers found 10 of the 19 blockers the pre-#3621 reviewers find.
 * This keeps the removed commands and modules gone and unreferenced, so a branch cut
 * before the revert cannot bring back a dangling call to them through a merge.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const REMOVED = [
  'bin/gstack-review-packet',
  'lib/review-packet.ts',
  'lib/review-packet-collect.ts',
  'lib/review-plan-live.ts',
  'lib/review-prompts.ts',
];
const NAMES = /gstack-review-packet|review-packet-collect|review-plan-live|lib\/review-prompts|review-packet\.ts|READ_BUDGET|reviewer-packets|review-packets-fc|REVIEW_COVERAGE_INCOMPLETE|review-coverage-incomplete/;
const SELF = path.relative(ROOT, import.meta.path);

describe('reviewer packets stay reverted (GSTA-167)', () => {
  test('the removed packet files do not exist', () => {
    expect(REMOVED.filter(f => fs.existsSync(path.join(ROOT, f)))).toEqual([]);
  });

  test('no tracked file outside CHANGELOG.md names a removed packet file, the packet read rule or a packet-only anchor or code', () => {
    const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    expect(ls.status).toBe(0);
    const files = ls.stdout.split('\0').filter(f => f && f !== 'CHANGELOG.md' && f !== SELF && fs.existsSync(path.join(ROOT, f)));
    expect(files.length).toBeGreaterThan(1000);
    const hits = files.filter(f => {
      const full = path.join(ROOT, f);
      if (!fs.statSync(full).isFile()) return false;
      return NAMES.test(fs.readFileSync(full, 'utf8'));
    });
    expect(hits).toEqual([]);
  });
});

/**
 * The reviewer briefs main restored in #3638 (v1.91.331.0), pinned by content: the rendered
 * specialist, Red Team, adversarial and outside-voice prompts, the checklists they read, the
 * fix-check prompt and the depth rules that pick reviewers. A change to any of them changes what a
 * reviewer sees or how its findings rate, so it merges only after its preregistered no-loss replay
 * passes (GStack Minder crew rule, 2026-10-30). Repin with that replay's id in the commit message.
 */
const REVIEWER_BRIEFS: Record<string, string> = {
    'ship/sections/review-army.md': '3d89708c2776b0d97fb2420c0461d37179b9f25ca0677ba038a6cff53dbf7465',
    'ship/sections/adversarial.md': '3f361c1f42605c8329048c81162216e7bf9902bdbb2327811c39ee4e201bb95d',
    'review/sections/review-army.md': '78329b64640260cd8831ca81a9189f3f8dcade9c406431631d3f2cd798cd3967',
    'review/sections/adversarial.md': 'a402018055670f50b75322ab92a0b03d740c481cc5ef2f2ac72b281dae29ec7b',
    'review/checklist.md': '607788afeb2c83f2dff1dccd58d212616ec72393d28cda2fa18690c1a83df699',
    'review/design-checklist.md': 'b9205f88313cc64902c0b13e9685722ab8138d3dcc58916154f47274abda7d83',
    'review/gate-integrity.md': 'f570db344c9a01df633bcaa281d6017f4f12420fd3e0aa3078c1ce06e0df8332',
    'review/specialists/api-contract.md': '263d23ac119dd601d315c191dbdbd503d47c00264c9c0ca81959559ca11d4e95',
    'review/specialists/data-migration.md': 'b6fd9eb229002ea598f8fe9ff53b1cd8821e3bd37a7aa7b07b5526556c71ebca',
    'review/specialists/maintainability.md': 'f8015d549e70297f782f0aabf6fe3a9fe31ec5ed61c311ab854e4a858282ed9b',
    'review/specialists/performance.md': '545c294ae53638b4c8524e8cde08246a4ce3b5c287ec7c44e27f5556a3b0e8cc',
    'review/specialists/red-team.md': '9ea05149f5b13d6a19ecec26285142d09d259cf80a515af828abdd1f43320427',
    'review/specialists/security.md': '17bfe813eb3de22835af048ec359770720f1d7f371a26460169f7e32b1bcac9f',
    'review/specialists/simplification.md': 'f33846b1dcf2fdeef82d0744ab2ef48fb4a33b34a737dafc33dd0e891756689f',
    'review/specialists/state-machines.md': '597215e4438d85d9cc71b48097c61eef7cba4f4b09dc14c92b4b94893b3d3ea2',
    'review/specialists/testing.md': 'd6cc2bef7be562387d0c0a22fefe646dff9c295f1d34d8453a6cb496584150e4',
    'scripts/resolvers/fix-check.ts': '712bf5b0c439e96bac32f19cbe25394dabb4c94aa66600100bfde9b100e15a08',
    'lib/review-depth.ts': '66f4ff6b03c869d6892f6efdfb237d578c301cf4ea6f6ecb4b366cd286a0bcb5',
};

describe('reviewer briefs stay at their no-loss-tested bytes (GSTA-167)', () => {
  test('every pinned reviewer brief, checklist and depth rule hashes to its pin', () => {
    const drift = Object.entries(REVIEWER_BRIEFS).filter(([file, sha]) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
      return createHash('sha256').update(text).digest('hex') !== sha;
    }).map(([file]) => file);
    expect(drift).toEqual([]);
  });

  test('the pins cover every specialist checklist', () => {
    const specialists = fs.readdirSync(path.join(ROOT, 'review/specialists')).filter(f => f.endsWith('.md')).map(f => `review/specialists/${f}`);
    expect(specialists.filter(f => !(f in REVIEWER_BRIEFS))).toEqual([]);
  });
});
