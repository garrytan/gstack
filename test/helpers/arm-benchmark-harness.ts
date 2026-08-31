/**
 * Arm-benchmark harness — shared by the paid periodic benchmark
 * (test/skill-e2e-arm-benchmark.test.ts) and the FREE selftest
 * (test/arm-benchmark-selftest.test.ts). Extracted so the fixture-integrity
 * and plumbing pins run in `bun run test` on every PR: the paid file matches
 * the skill-e2e-* paid glob, so a selftest living inside it executed weekly
 * at best — a broken fixture would ship past every gating check and be
 * discovered only when the periodic run burned money on a dead instrument.
 */
import { ROOT, copyDirSync } from './e2e-helpers';
import { extractSkillSections } from './skill-fixture';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Named per-arm constants (plan: defaults of 15 turns/120s are nowhere
// near enough for a build-shaped ticket: read fixture, implement, run tests).
export const ARM_MAX_TURNS = 40;
export const ARM_TIMEOUT_MS = 8 * 60_000;
/** Max diff bytes sent to the over-engineering judge. Truncation is loud
 *  (logged + suffixed onto judge_reasoning) — a clipped patch can hide the
 *  construct being scored, so a silent cap would corrupt cells invisibly. */
export const ARM_JUDGE_DIFF_CAP = 30_000;
// Skill tool in BOTH arms so the tool surface is symmetric — the without-arm
// simply has nothing installed to invoke. No Agent: build-discipline
// dispatches no subagents.
export const ARM_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'];
// Two concurrent arms + up to two judge calls + fixture setup.
export const TASK_TEST_TIMEOUT_MS = ARM_TIMEOUT_MS + 240_000;

export const SKILL_NAME = 'build-discipline';
export const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'arm-benchmark');

export type Arm = 'with-skill' | 'without-skill';

export interface ArmTask {
  /** E2E_TOUCHFILES / E2E_TIERS key. Quoted literals below keep the parent
   *  shard mapper (test-paid-shards) able to attribute this file. */
  key: string;
  /** Deterministic functional check run against the arm's working tree after
   *  harvest (the plan's metric order is diff-quality FIRST: correctness
   *  before LOC). Absent for fixtures with no runnable oracle. */
  checkCmd?: string[];
  fixture: string;
  ticket: string;
}

// The 3 named tasks (plan: one native-platform over-build trap, one CRUD
// endpoint, one bug-fix with planted decoy over-build invitations).
export const TASKS: ArmTask[] = [
  {
    key: 'arm-benchmark-native-overbuild',
    fixture: 'native-overbuild',
    ticket: `Ticket: hikers need to pick their hike date when booking.

You are in a small git repo containing a static site (index.html, app.js, styles.css — no build step).
Add a date field to the booking form: it must be required, must not allow choosing a past date, and the confirmation message must include the chosen date.

Leave your changes uncommitted in the working tree.`,
  },
  {
    key: 'arm-benchmark-crud-endpoint',
    fixture: 'crud-endpoint',
    checkCmd: ['node', 'run-tests.js'],
    ticket: `Ticket: users need to delete notes.

You are in a small git repo containing an in-memory notes API (app.js, wired to HTTP in server.js).
Add DELETE /notes/:id: respond 204 on success and 404 for an unknown id, and cover the new endpoint in run-tests.js. Verify with: node run-tests.js

Leave your changes uncommitted in the working tree.`,
  },
  {
    key: 'arm-benchmark-bugfix-decoys',
    fixture: 'bugfix-decoys',
    checkCmd: ['node', 'run-tests.js'],
    ticket: `Bug report: receipts print $10.5 for a $10.05 item.

You are in a small git repo. \`node run-tests.js\` currently fails on formatPrice(1005).
Fix the bug so all tests pass. Verify with: node run-tests.js

Leave your changes uncommitted in the working tree.`,
  },
];

// --- Skill under test: extracted behavioral layer ---

/** Drop the Eureka telemetry tail from the extracted Search Before Building
 *  section: it appends to the OPERATOR's real ~/.gstack from inside a
 *  hermetic child, and telemetry is not the behavior under test. */
export function stripEureka(text: string): string {
  const start = text.indexOf('**Eureka:**');
  if (start === -1) return text;
  const next = text.indexOf('\n## ', start);
  return text.slice(0, start) + (next === -1 ? '' : text.slice(next + 1));
}

/**
 * Assemble the behavioral-layer skill: the WS3 reuse ladder (## Search Before
 * Building) + the WS7 bounded closer (## Voice), extracted from the rendered
 * ship/SKILL.md (tier 4 — carries both sections) and wrapped in this
 * benchmark's own frontmatter. Extract, don't copy (CLAUDE.md rule).
 */
export function buildBehavioralSkill(): string {
  const extracted = extractSkillSections(path.join(ROOT, 'ship'), ['Search Before Building', 'Voice']);
  const body = stripEureka(extracted.replace(/^---\n[\s\S]*?\n---\n/, '')).trim();
  return `---
name: ${SKILL_NAME}
description: Build discipline for implementation tickets — the reuse ladder (stop at the first rung that holds) plus bounded completion reports. Invoke before implementing any ticket.
---

# Build discipline

Apply these rules to the implementation work you are about to do.

${body}
`;
}

// --- Arm setup: fixture copy + optional skill install + git init + bare origin ---

export interface ArmDirs {
  dir: string;
  originDir: string;
  /** The seed commit — the immutable diff base for harvest (an agent that
   *  disobeys "leave uncommitted" by committing AND pushing can move
   *  origin/main, but it cannot move a recorded SHA). */
  seedSha: string;
}

export function run(cmd: string, args: string[], cwd: string): string {
  // 64MB maxBuffer: the patch capture pipes the FULL staged diff through
  // here, and the most over-built arm outcome (vendored dependency) is
  // exactly the one the benchmark must not die on.
  const r = spawnSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? '';
}

export function setupArm(task: ArmTask, arm: Arm): ArmDirs {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arm-${task.fixture}-${arm}-`));
  copyDirSync(path.join(FIXTURES, task.fixture), dir);

  const baseClaudeMd = '# Project\n\nSmall fixture repo for an implementation ticket. Run its checks with the command named in the ticket.\n';
  if (arm === 'with-skill') {
    const skillDir = path.join(dir, '.claude', 'skills', SKILL_NAME);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildBehavioralSkill());
    fs.writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      baseClaudeMd
      + `\n## Skill routing\n\nBefore implementing any ticket, invoke the ${SKILL_NAME} skill via the Skill tool and follow it while you work.\n`,
    );
  } else {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), baseClaudeMd);
  }

  // node_modules never enters the harvest: an arm that npm-installs a
  // dependency is a scoreable outcome, not a reason to stage 10k files.
  if (!fs.existsSync(path.join(dir, '.gitignore'))) {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  }

  run('git', ['init', '-b', 'main'], dir);
  run('git', ['config', 'user.email', 'arm-bench@example.com'], dir);
  run('git', ['config', 'user.name', 'Arm Bench'], dir);
  run('git', ['config', 'commit.gpgsign', 'false'], dir);
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-m', 'seed fixture'], dir);
  const seedSha = run('git', ['rev-parse', 'HEAD'], dir).trim();

  // Local bare origin so merge-base-style commands work inside the arm.
  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), `arm-${task.fixture}-${arm}-origin-`));
  run('git', ['init', '--bare', '-b', 'main'], originDir);
  run('git', ['remote', 'add', 'origin', originDir], dir);
  run('git', ['push', '-u', 'origin', 'main'], dir);

  return { dir, originDir, seedSha };
}

// --- Diff capture: git add -A && git diff --cached --stat (plan spec) ---

export interface DiffHarvest {
  filesChanged: number;
  insertions: number;
  deletions: number;
  net: number;
  stat: string;
  patch: string;
}

/** Parse the summary line of `git diff --stat`. Empty stat = zero-diff
 *  (a VALID cell, not an error). */
export function parseDiffStat(stat: string): Pick<DiffHarvest, 'filesChanged' | 'insertions' | 'deletions' | 'net'> {
  const line = stat.trim().split('\n').pop() ?? '';
  const files = line.match(/(\d+) files? changed/);
  const ins = line.match(/(\d+) insertions?\(\+\)/);
  const del = line.match(/(\d+) deletions?\(-\)/);
  const insertions = ins ? Number(ins[1]) : 0;
  const deletions = del ? Number(del[1]) : 0;
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions,
    deletions,
    net: insertions - deletions,
  };
}

/**
 * Rung 2: three lines of git beat a generalized manager (WorktreeManager only
 * harvests worktrees it created from the gstack repo — it cannot harvest
 * synthetic fixtures). Diffing the index against the RECORDED seed SHA (not
 * origin/main, which an agent that commits AND pushes can move; not HEAD,
 * which a plain commit moves) keeps the capture honest under every flavor of
 * "leave uncommitted" disobedience.
 */
export function captureStagedDiff(dir: string, seedSha: string): DiffHarvest {
  run('git', ['add', '-A'], dir);
  const stat = run('git', ['diff', '--cached', seedSha, '--stat'], dir);
  const patch = run('git', ['diff', '--cached', seedSha], dir);
  return { ...parseDiffStat(stat), stat: stat.trim(), patch };
}


/** Run the task's functional check in the arm dir. 'none' when the task has
 *  no oracle; never throws — a crashing check is a 'fail', not a dead cell. */
export function runChecks(task: ArmTask, dir: string): 'pass' | 'fail' | 'none' {
  if (!task.checkCmd || task.checkCmd.length === 0) return 'none';
  const r = spawnSync(task.checkCmd[0], task.checkCmd.slice(1), {
    cwd: dir, stdio: 'pipe', encoding: 'utf-8', timeout: 60_000,
  });
  return r.status === 0 ? 'pass' : 'fail';
}
