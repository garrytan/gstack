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
 * passes (GStack Minder crew rule, 2026-10-30); a cost replay alone is not enough (#3621 passed its
 * cost replay, then its no-loss replay found 11 of 30 blockers). Every pin names the replay that
 * admits its bytes: repin with that replay's id here and in the commit message, and merge only on
 * its passing result.
 */
const NO_LOSS_REPLAYS = {
  '#3638': 'no-loss round 3: main restored the pre-#3621 reviewers (v1.91.331.0)',
  'PR-a': "GSTA-167 variant G Arm 4: structural plan identity at the 14 cohort heads and the free exact re-score of saved C, D and A' findings (parts 4a and 4b)",
  'G1': "GSTA-167 variant G Arm G1: live no-loss replay of both prose voices with part 1's prompts, 2 passes, normalizer v2, paired rule against pooled C' (parts 1 and 3; specialists at medium as in C and C2)",
  'GSTA-160': "GSTA-160 severity floor: replay prereg 4c53e80a (GSTA-11's 12 bugs plus decoys) passed P2, G1 and G2 on the pre-#3660 wording; GSTA-167's cohort no-loss arm on these bytes is pending",
  'L': "GSTA-167 variant G Arm L: live no-loss replay of one batched reader (testing and security plus scoped checklists) and the Red Team on its findings, 2 passes, scored L∘G1 against G1 on the paired rule (part 2)",
} as const;
type Replay = keyof typeof NO_LOSS_REPLAYS;
const REVIEWER_BRIEFS: Record<string, { sha: string; replay: Replay }> = {
    'ship/sections/review-army.md': { sha: '82b93325070c47b9f310d7b1125ae3c2eca032f76672efef0b32f1bc3fb77a01', replay: 'GSTA-160' },
    'ship/sections/adversarial.md': { sha: 'c48aa7717c7438941fa23418367e19a62e07edda7445d0d5a55924e172dd5d33', replay: 'G1' },
    'review/sections/review-army.md': { sha: '6269bb14fde178abd544ae966c0850c6b70dd7e822d73d5996dd4a1cb17d4879', replay: 'GSTA-160' },
    'review/sections/adversarial.md': { sha: 'e6962fa25b78f362654f2954f79683e524d2ebd452d1494f8a2b099888e8e255', replay: 'G1' },
    'review/checklist.md': { sha: 'bcc8d926dd7365b00693863e124b11757b430bff219cecc7e477723bcb1875a1', replay: 'GSTA-160' },
    'review/design-checklist.md': { sha: 'b9205f88313cc64902c0b13e9685722ab8138d3dcc58916154f47274abda7d83', replay: '#3638' },
    'review/gate-integrity.md': { sha: 'f570db344c9a01df633bcaa281d6017f4f12420fd3e0aa3078c1ce06e0df8332', replay: '#3638' },
    'review/specialists/api-contract.md': { sha: '263d23ac119dd601d315c191dbdbd503d47c00264c9c0ca81959559ca11d4e95', replay: '#3638' },
    'review/specialists/data-migration.md': { sha: 'b6fd9eb229002ea598f8fe9ff53b1cd8821e3bd37a7aa7b07b5526556c71ebca', replay: '#3638' },
    'review/specialists/maintainability.md': { sha: 'f8015d549e70297f782f0aabf6fe3a9fe31ec5ed61c311ab854e4a858282ed9b', replay: '#3638' },
    'review/specialists/performance.md': { sha: '545c294ae53638b4c8524e8cde08246a4ce3b5c287ec7c44e27f5556a3b0e8cc', replay: '#3638' },
    'review/specialists/red-team.md': { sha: '9ea05149f5b13d6a19ecec26285142d09d259cf80a515af828abdd1f43320427', replay: '#3638' },
    'review/specialists/security.md': { sha: '17bfe813eb3de22835af048ec359770720f1d7f371a26460169f7e32b1bcac9f', replay: '#3638' },
    'review/specialists/simplification.md': { sha: 'f33846b1dcf2fdeef82d0744ab2ef48fb4a33b34a737dafc33dd0e891756689f', replay: '#3638' },
    'review/specialists/state-machines.md': { sha: '597215e4438d85d9cc71b48097c61eef7cba4f4b09dc14c92b4b94893b3d3ea2', replay: '#3638' },
    'review/specialists/testing.md': { sha: 'f028ca6da0940b1b8b8861ae5f9c156606c0fc343a554f6da6637f9dac1d2581', replay: 'GSTA-160' },
    'scripts/resolvers/fix-check.ts': { sha: '44608ce5713f56989b76f2332255418d8aad91f4638546861d70da31b7ae826e', replay: 'GSTA-160' },
    'lib/review-depth.ts': { sha: 'd4715a5f534d1470c63da879a3d66bb090a9b4929065d1f06c30acd97ef77bb0', replay: 'L' },
};

describe('reviewer briefs stay at their no-loss-tested bytes (GSTA-167)', () => {
  test('every pinned reviewer brief, checklist and depth rule hashes to its pin', () => {
    const drift = Object.entries(REVIEWER_BRIEFS).filter(([file, pin]) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
      return createHash('sha256').update(text).digest('hex') !== pin.sha;
    }).map(([file]) => `${file} (a repin needs a passing no-loss replay; the current pin names ${REVIEWER_BRIEFS[file]!.replay})`);
    expect(drift).toEqual([]);
  });

  test('every pin names the preregistered no-loss replay that admits its bytes', () => {
    const unnamed = Object.entries(REVIEWER_BRIEFS).filter(([, pin]) => !(pin.replay in NO_LOSS_REPLAYS)).map(([file]) => file);
    expect(unnamed).toEqual([]);
    for (const what of Object.values(NO_LOSS_REPLAYS)) expect(what).toMatch(/no-loss|re-score/);
  });

  test('the pins cover every specialist checklist', () => {
    const specialists = fs.readdirSync(path.join(ROOT, 'review/specialists')).filter(f => f.endsWith('.md')).map(f => `review/specialists/${f}`);
    expect(specialists.filter(f => !(f in REVIEWER_BRIEFS))).toEqual([]);
  });
});
