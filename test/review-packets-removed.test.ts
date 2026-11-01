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
import * as os from 'os';
import * as path from 'path';
import { sectionTexts } from '../lib/review-brief';

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
  'L': "GSTA-167 variant G Arm L: live no-loss replay of one batched reader (testing and security plus scoped checklists) and the Red Team on its findings, 2 passes, scored L∘G1 against G1 on the paired rule (part 2)",
  'GST-257': "GST-257 PR 1 dispatch-superset no-loss check (test/review-targeted.test.ts): on every fixture diff the branch dispatches main's reviewers at 8be7f21 unchanged plus only the targeted reader, and over the last 100 non-release commits on main it lost none; adds the targeted role and brief to the G1 and L bytes, whose existing reviewer text is unchanged",
  'GST-464': "GST-464 brief-identity no-loss check (the brief-body test below): every reviewer brief lib/review-brief.ts cuts from ship/sections/review-army.md and adversarial.md is byte-identical to the bodies at the L and GST-257 pins; only lead instructions outside the cut spans changed",
  'R51': "R51 risk-tier routing no-loss re-score (GSTA-167): the saved panel findings (349 records over 24 of the 26 no-loss units) re-scored against the branch's plan lose no blocker whose only finders are roles it drops, and every gate, security, user-data and money fixture keeps main's reviewers plus the full panel (test/review-targeted.test.ts, test/review-risk-routing.test.ts); reviewer text is unchanged",
} as const;
type Replay = keyof typeof NO_LOSS_REPLAYS;
const REVIEWER_BRIEFS: Record<string, { sha: string; replay: Replay }> = {
    'ship/sections/review-army.md': { sha: 'c7edb2a8c19fc8b2c9aa31f443f6c49ebe28528390a0efc47ecc6ac3e3a057be', replay: 'GST-464' },
    'ship/sections/adversarial.md': { sha: 'b70577b6987869acd76cc3865f16eeeed743558c0ea09e5f9933d0d8aec8b91e', replay: 'GST-464' },
    'review/sections/review-army.md': { sha: '78329b64640260cd8831ca81a9189f3f8dcade9c406431631d3f2cd798cd3967', replay: '#3638' },
    'review/sections/adversarial.md': { sha: 'e6962fa25b78f362654f2954f79683e524d2ebd452d1494f8a2b099888e8e255', replay: 'G1' },
    'review/checklist.md': { sha: '607788afeb2c83f2dff1dccd58d212616ec72393d28cda2fa18690c1a83df699', replay: '#3638' },
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
    'review/specialists/testing.md': { sha: 'd6cc2bef7be562387d0c0a22fefe646dff9c295f1d34d8453a6cb496584150e4', replay: '#3638' },
    'review/specialists/targeted.md': { sha: '7f92a0d0a8319c3c0e076fb3b1a4689c45120b2be2c14dfc7d4cb03aafa9d6a5', replay: 'GST-257' },
    'scripts/resolvers/fix-check.ts': { sha: '712bf5b0c439e96bac32f19cbe25394dabb4c94aa66600100bfde9b100e15a08', replay: '#3638' },
    'lib/review-depth.ts': { sha: 'd649569a163c03476c6e0c5ea295f5d02088f96aab85fbc7d558f2ac2b27006a', replay: 'R51' },
    'lib/review-risk.ts': { sha: 'dbef7475d467e17340b21a2bacb52a16a7ccb1ee66291900ed2d36dfb5cfb7f2', replay: 'R51' },
};

/**
 * The six reviewer brief bodies lib/review-brief.ts cuts out of the two ship sections, pinned at
 * the bytes replays L and GST-257 admitted. A section repin under GST-464 is valid only while every
 * body still hashes here: the section may change outside the cut spans, never inside them.
 */
const BRIEF_BODIES: Record<string, string> = {
  specialist: '1ebe47ddb3291a9e4fe90b5a260eb57e328144959549bc95c119b68d23652cb5',
  framing: 'aad667b5ea4c6d23d930dafffa38178c04be388cd4364fb73759fc92af17bb63',
  fixtures: '9517c86befe773e76acbf30a0642ed828e211b8ecb524325702072b26429ef16',
  redTeam: '1cca7957d13f9da08434870290b92958f37750207047b92c9aa52a802da789e8',
  native: 'ddb1041ec1e4dd373c3e4ab9017e49316e78c230055c1ef3db1bbba518b143a2',
  outside: 'bd96406da28b03742384560425a333b6d6d7ed2be95bd2026c90e0039632cee2',
};
const bodyHashes = (root: string) => Object.fromEntries(Object.entries(sectionTexts(root)).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]));

describe('reviewer briefs stay at their no-loss-tested bytes (GSTA-167)', () => {
  // Value: protects=the GST-464 repin of ship/sections/review-army.md and adversarial.md admits only lead-instruction
  //   edits: every brief a reviewer reads renders byte-identical to the no-loss-tested bodies; fails_when=an edit inside a
  //   cut span changes a brief while its section pin is moved; seam=sectionTexts, the function every render uses;
  //   no_claim=the checklists and the targeted brief, pinned by their own file hashes above
  test('every reviewer brief cut from the ship sections is byte-identical to its pinned body', () => {
    expect(bodyHashes(ROOT)).toEqual(BRIEF_BODIES);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-bodies-'));
    try {
      fs.mkdirSync(path.join(copy, 'ship', 'sections'), { recursive: true });
      for (const f of ['review-army.md', 'adversarial.md']) fs.copyFileSync(path.join(ROOT, 'ship', 'sections', f), path.join(copy, 'ship', 'sections', f));
      const army = path.join(copy, 'ship', 'sections', 'review-army.md');
      fs.writeFileSync(army, fs.readFileSync(army, 'utf8').replace('You are a specialist code reviewer.', 'You are a specialist code reviewer. Skim.'));
      expect(bodyHashes(copy).specialist).not.toBe(BRIEF_BODIES.specialist);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

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
