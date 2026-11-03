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
  'GST-508': "GST-508 (#3744, GSTA-202) preregistered no-loss replay of review_exclude_paths at ef2760f: Arm V found 33 of 41 blockers vs R 33 of 41, exact sign flip with delta 4, p_NI 0.0279 (pass); Arm P identical depth, dispatch and reader sets on 26 of 26 units (GStack Minder drive handoffs/GSTA-202/noloss-results.md)",
  'GST-257': "GST-257 PR 1 dispatch-superset no-loss check (test/review-targeted.test.ts): on every fixture diff the branch dispatches main's reviewers at 8be7f21 unchanged plus only the targeted reader, and over the last 100 non-release commits on main it lost none; adds the targeted role and brief to the G1 and L bytes, whose existing reviewer text is unchanged",
  'GST-464': "GST-464 brief-identity no-loss check (the brief-body test below): every reviewer brief lib/review-brief.ts cuts from ship/sections/review-army.md and adversarial.md is byte-identical to the bodies at the L and GST-257 pins; only lead instructions outside the cut spans changed",
  'GST-850': "GST-850 dispatch-superset no-loss check: on the 26 GSTA-167 no-loss units the branch plan (wider security and money classes, write-up text in the batched diff) drops no reviewer role main dispatches, so no saved blocker can be lost, and over the last 100 main commits no commit with a gate or risk class drops depth (test/review-risk-routing.test.ts, test/review-risk-linear.test.ts); reviewer text is unchanged",
  'GSTA-224 H1': 'GSTA-224 H1 preregistered no-loss run: the PR-type checklist against main\'s checklist and a no-gstack arm (Opus 5.5, 81 calls), 5 behavior cases, 10 Round 7 application blockers and 2 clean controls; every bar passed (handoffs/GSTA-224/h1-noloss-results.md)',
  'R51': "R51 risk-tier routing no-loss re-score (GSTA-167): the saved panel findings (349 records over 24 of the 26 no-loss units) re-scored against the branch's plan lose no blocker whose only finders are roles it drops, and every gate, security, user-data and money fixture keeps main's reviewers plus the full panel (test/review-targeted.test.ts, test/review-risk-routing.test.ts); reviewer text is unchanged",
  'GST-508+R51': "wave review-53cfb5bfe011 merge of #3744 into main: lib/review-depth.ts keeps both admitted changes, the GST-508 no-loss replay of review_exclude_paths (Arm V 33 of 41 blockers vs R 33 of 41, p_NI 0.0279; GStack Minder drive handoffs/GSTA-202/noloss-results.md) and the R51 risk-tier re-score with GST-850's dispatch-superset no-loss check: excluded paths sit beside the added and removed line maps, and the exclusion filter keeps the publishes-docs rule",
  'GST-508+GST-464': "wave review-53cfb5bfe011 merge of #3744 into main: ship/sections/review-army.md and adversarial.md carry the GST-508 no-loss-replayed exclude pathspec placeholders inside the brief bodies (handoffs/GSTA-202/noloss-results.md) and the GST-464 lead-instruction edits outside the cut spans, which its brief-identity no-loss check admitted",
  'GST-986': "GST-986 brief-identity no-loss check (the brief-body test below): every reviewer brief lib/review-brief.ts cuts from ship/sections/adversarial.md is byte-identical to the bodies at the GST-257 pin; only the lead's Step 11 instruction naming the targeted record's path changed, outside the cut spans",
  'GST-942': "GST-942 dispatch-superset no-loss check: the rmSync rule no longer stops at the first ), a matching rm( rule is added, and both read a file's changed lines joined for a delete split across lines, so a recursive delete raises security on more diffs and never on fewer; over the last 100 first-parent main commits to 3d99c2249 (62,531 changed lines) the line rules match all 170 lines the old rule matched plus 19 more, and no commit changes depth, class or risk class; reviewer text is unchanged",
  'GST-911-redos': "GST-911 ReDoS fix verdict-identity no-loss check (wave review-e7b551ebd865): SVG_REFUSED's url() entry, rewritten to run in linear time, refuses exactly the strings #3838's pattern refused (test/review-risk-redos.test.ts: 60,000 seeded strings and the hand-picked edges, and every SVG blob in the repository's history, with zero differences); SVG_MARKUP now refuses a DOCTYPE naming any document but W3C's SVG DTD (test/review-planner-misreads.test.ts), which only keeps more SVGs code and so drops no reviewer; GST-911's no-loss replay holds unchanged; reviewer text is unchanged",
  'GST-911': "GST-911 no-loss replay (GSTA-249/13): the planner over the last 100 first-parent main commits to f5cb6ec1e, origin/main's code against this branch, gate scan fixed at 0, changes no commit's depth, class, risk classes, targeted classes or SCOPE_AUTH; the three misreads (a drawing-only SVG, a session-named data file, a bare base) are proven on fixtures (test/review-planner-misreads.test.ts), where every SVG that can run script stays code with the security class; reviewer text is unchanged",
  'GST-508+R51+GST-911': "wave review-53cfb5bfe011 merge of main 3d99c2249 (#3848) into #3852: lib/review-depth.ts keeps GST-508's review_exclude_paths (no-loss replay, GStack Minder drive handoffs/GSTA-202/noloss-results.md), R51 with GST-850's dispatch-superset no-loss check, and GST-911's SVG drawings with GST-911-redos (no-loss replay: 0 of 100 main commits changed, reports/GSTA-249-911-decisions.tsv; test/review-planner-misreads.test.ts, test/review-risk-redos.test.ts); lib/review-risk.ts is main's GST-911 bytes. Merged-head checks (handoffs/GSTA-202/merge-3d99c22-checks.md): Arm P on unit 3593 differs only in the exclude pathspec and the disclosure line, the same brief diff as before the merge, and GST-911 panel unit f5cb6ec1e plans, dispatches and renders byte-identical briefs under 3d99c2249 and the merged head",
  'GST-898': "GST-898 verdict-identity no-loss check: the linear rm rule, and the rmSync rule (which also raises security on any call with more than 500 characters before its closing parenthesis), give the same verdict as R51's on every changed line of the last 100 main commits (69,023 lines, a563f47 back 100 first-parent commits) and on 60,000 seeded lines per rule (test/review-risk-redos.test.ts), and no commit changes depth, class or risk class, so every diff dispatches main's reviewers unchanged; reviewer text is unchanged",
  'GST-967': "GST-967 dispatch-superset no-loss check (test/review-depth.test.ts, 'GST-967 dispatch-superset no-loss check'): over 1,440 planReview cases the branch plans exactly what main planned at 1022f4f except the 71 gate-class stops before Step 11, which add only Step 11's adversarial, outside and targeted voices, so no reviewer main dispatches is dropped or re-efforted; the brief bodies lib/review-brief.ts cuts from the ship sections hash to main's; only the lead's repeat-decision and Step 11 instructions changed; reviewer text is unchanged",
  'GST-508+GST-464+GST-967': "wave review-53cfb5bfe011 merge of main 68410828f into #3852: ship/sections/review-army.md and adversarial.md are main's GST-967 bytes plus exactly the GST-508+GST-464 lines (the merged file minus main equals the wave minus fc292e22f, line for line), so GST-967's dispatch-superset no-loss check and GST-508's no-loss replay both hold; merged-head checks in GStack Minder drive handoffs/GSTA-202/merge-6841-checks.md",
  'GST-508+R51+GST-911+GST-967': "wave review-53cfb5bfe011 merge of main 68410828f into #3852: lib/review-depth.ts is main's GST-967 bytes plus exactly the GST-508+R51+GST-911 lines (the merged file minus main equals the wave minus fc292e22f, line for line); GST-967's dispatch-superset no-loss check (test/review-depth.test.ts) passes on the merged file, and the GST-508+R51+GST-911 checks are rerun at the merged head (GStack Minder drive handoffs/GSTA-202/merge-6841-checks.md)",
} as const;
type Replay = keyof typeof NO_LOSS_REPLAYS;
const REVIEWER_BRIEFS: Record<string, { sha: string; replay: Replay }> = {
    'ship/sections/review-army.md': { sha: 'de3e0d35f2af56492c42fd287b6868fbe19bce96b86321e74a4947ba909b74eb', replay: 'GST-508+GST-464+GST-967' },
    'ship/sections/adversarial.md': { sha: '0142d6bc3f2a5bceb9f8b2adef1d3a206e5836c99a0667fe995568da2e80a5a6', replay: 'GST-508+GST-464+GST-967' },
    'review/sections/review-army.md': { sha: '78329b64640260cd8831ca81a9189f3f8dcade9c406431631d3f2cd798cd3967', replay: '#3638' },
    'review/sections/adversarial.md': { sha: 'e6962fa25b78f362654f2954f79683e524d2ebd452d1494f8a2b099888e8e255', replay: 'G1' },
    'review/checklist.md': { sha: 'a32963ef38d9d3613c58c805e8517cd2e593c63769b30dd7d40e2592fa48fc78', replay: 'GSTA-224 H1' },
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
    'lib/review-depth.ts': { sha: 'd76a9afcfadfe0a95b15428c04e6f7a88c6b0fa75591201c45f023fec2bb90db', replay: 'GST-508+R51+GST-911+GST-967' },
    'lib/review-risk.ts': { sha: '08464b78a723ee463ca3a28d0abbc4eb8f4f512192061c703743707b66b5a311', replay: 'GST-942' },
};

/**
 * The reviewer brief bodies lib/review-brief.ts cuts out of the ship sections, at the bytes replays L and GST-257
 * admitted, except fixtures, redTeam and native, which carry the exclude pathspec placeholders the GST-508 replay
 * admitted (byte-identical to #3744 at 995e442). A section repin under GST-464 or GST-986 is valid only while every
 * body still hashes here: the section may change outside the cut spans, never inside them.
 */
const BRIEF_BODIES: Record<string, string> = {
  specialist: '1ebe47ddb3291a9e4fe90b5a260eb57e328144959549bc95c119b68d23652cb5',
  framing: 'aad667b5ea4c6d23d930dafffa38178c04be388cd4364fb73759fc92af17bb63',
  fixtures: 'fbe52f3a9e0f4442eb755f1747a95944b373b439bd05c61f3eb68345d1061a5b',
  redTeam: '6dd670ea040535ca6cceab81c29a395bb67ce5a2ab8fa2b81e51bc4711e4aada',
  native: 'a7cc08fb31b6ca65932a316d589f0b09677426d193d63f88ec74fee6d93ce053',
  outside: 'bd96406da28b03742384560425a333b6d6d7ed2be95bd2026c90e0039632cee2',
};

describe('reviewer briefs stay at their no-loss-tested bytes (GSTA-167)', () => {
  // Value: protects=the GST-986 repin of ship/sections/adversarial.md admits only a lead-instruction edit: every brief a reviewer
  //   reads renders byte-identical to the no-loss-tested bodies; fails_when=an edit inside a cut span changes a brief while the
  //   section pin moves; seam=sectionTexts, the function every render uses; no_claim=the checklists (pinned by file hash below)
  test('every reviewer brief cut from the ship sections is byte-identical to its pinned body', () => {
    const hashes = (root: string) => Object.fromEntries(Object.entries(sectionTexts(root)).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]));
    expect(hashes(ROOT)).toEqual(BRIEF_BODIES);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-bodies-'));
    try {
      fs.cpSync(path.join(ROOT, 'ship', 'sections'), path.join(copy, 'ship', 'sections'), { recursive: true });
      const adversarial = path.join(copy, 'ship', 'sections', 'adversarial.md');
      fs.writeFileSync(adversarial, fs.readFileSync(adversarial, 'utf8').replace('Recommendation:', 'Recommendation (short):'));
      expect(hashes(copy)).not.toEqual(BRIEF_BODIES);
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
