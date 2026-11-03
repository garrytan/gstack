/**
 * Arm-benchmark harness — shared by the paid periodic benchmark
 * (test/skill-e2e-arm-benchmark.test.ts) and the FREE selftest
 * (test/arm-benchmark-selftest.test.ts). Extracted so the fixture-integrity
 * and plumbing pins run in `bun run test` on every PR: the paid file matches
 * the skill-e2e-* paid glob, so a selftest living inside it executed weekly
 * at best — a broken fixture would ship past every gating check and be
 * discovered only when the periodic run burned money on a dead instrument.
 *
 * GST-469: each task runs ARM_TRIALS with/without pairs on the pinned
 * ARM_MODEL, every cell and judge call reserves and settles in a spend ledger
 * under ARM_SPEND_CAP_USD, and the candidate sees a project-named folder and
 * a neutral git identity (docs/TESTING_INTERNALS.md#candidate-side-blinding).
 * The preregistration is PREREG.md in the fixtures directory.
 */
import { ROOT, copyDirSync } from './e2e-helpers';
import { extractSkillSections } from './skill-fixture';
import { JUDGE_MS } from './eval-budgets';
import { reserve, settle, SpendCapExceeded } from '../../lib/spend-ledger';
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
/** Pinned candidate model; PREREG.md's Arms name it, and a cell billed for another model is INFRA. */
export const ARM_MODEL = 'claude-opus-5-5';
/** With/without pairs per task, run one pair at a time. */
export const ARM_TRIALS = 3;
export const ARM_JUDGE_MS = JUDGE_MS;
export const ARM_SETUP_MS = 60_000;
/** One pair: setup, both cells concurrently (each followed by its per-diff judge call), then both paired-judge orders concurrently. */
export const ARM_PAIR_MS = ARM_SETUP_MS + ARM_TIMEOUT_MS + ARM_JUDGE_MS + ARM_JUDGE_MS;
export const ARM_TASK_SLACK_MS = 120_000;
export const TASK_TEST_TIMEOUT_MS = ARM_TRIALS * ARM_PAIR_MS + ARM_TASK_SLACK_MS;
export const ARM_SPEND_CAP_USD = 25;
/** Worst case reserved per cell (the model panel's Opus reservation) and per judge call; each settles to measured cost. */
export const ARM_CELL_RESERVE_USD = 2.0;
export const ARM_JUDGE_RESERVE_USD = 0.25;

export const SKILL_NAME = 'build-discipline';
export const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'arm-benchmark');

export type Arm = 'with-skill' | 'without-skill';
export const ARMS: Arm[] = ['with-skill', 'without-skill'];
/** Arm identities as PREREG.md and results.md name them. */
export const ARM_IDENTITY: Record<Arm, string> = {
  'with-skill': `${ARM_MODEL}#${SKILL_NAME}`,
  'without-skill': `${ARM_MODEL}#no-gstack`,
};

export interface ArmTask {
  /** E2E_TOUCHFILES / E2E_TIERS key. Quoted literals below keep the parent
   *  shard mapper (test-paid-shards) able to attribute this file. */
  key: string;
  /** Candidate-visible folder prefix: a project name, never the instrument or the arm. */
  project: string;
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
    project: 'hike-booking',
    fixture: 'native-overbuild',
    ticket: `Ticket: hikers need to pick their hike date when booking.

You are in a small git repo containing a static site (index.html, app.js, styles.css — no build step).
Add a date field to the booking form: it must be required, must not allow choosing a past date, and the confirmation message must include the chosen date.

Leave your changes uncommitted in the working tree.`,
  },
  {
    key: 'arm-benchmark-crud-endpoint',
    project: 'notes-api',
    fixture: 'crud-endpoint',
    checkCmd: ['node', 'run-tests.js'],
    ticket: `Ticket: users need to delete notes.

You are in a small git repo containing an in-memory notes API (app.js, wired to HTTP in server.js).
Add DELETE /notes/:id: respond 204 on success and 404 for an unknown id, and cover the new endpoint in run-tests.js. Verify with: node run-tests.js

Leave your changes uncommitted in the working tree.`,
  },
  {
    key: 'arm-benchmark-bugfix-decoys',
    project: 'receipts',
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${task.project}-`));
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
  run('git', ['config', 'user.email', 'dev@example.com'], dir);
  run('git', ['config', 'user.name', 'Project Dev'], dir);
  run('git', ['config', 'commit.gpgsign', 'false'], dir);
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-m', 'Initial commit'], dir);
  const seedSha = run('git', ['rev-parse', 'HEAD'], dir).trim();

  // Local bare origin so merge-base-style commands work inside the arm.
  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), `${task.project}-origin-`));
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

// --- GST-469: runner options, model pin, spend ledger, results.md ---

/** What the paid runner receives for one cell; the test name is runner-side only and unique per task, arm and trial. */
export function armRunOptions(task: ArmTask, arm: Arm, dir: string, trial: number) {
  const invocation = arm === 'with-skill'
    ? `First invoke the ${SKILL_NAME} skill (via the Skill tool) and follow it while implementing.\n\n`
    : '';
  return {
    prompt: `${invocation}${task.ticket}`,
    workingDirectory: dir,
    maxTurns: ARM_MAX_TURNS,
    allowedTools: ARM_ALLOWED_TOOLS,
    timeout: ARM_TIMEOUT_MS,
    testName: `${task.key}-${arm}-t${trial}`,
    model: ARM_MODEL,
  };
}

/** Models the session's result event says it billed (empty when the host reported none). */
export function billedModels(transcript: any[]): string[] {
  const result = [...transcript].reverse().find((e) => e && e.type === 'result');
  return result?.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [];
}

/** INFRA reason when the cell did not run on ARM_MODEL: asked for another model, or billed models that leave it out. */
export function armCellInfra(requested: string, billed: string[]): string | null {
  const bare = (id: string) => id.toLowerCase().replace(/^[a-z-]+\//, '');
  if (requested !== ARM_MODEL) return `INFRA: ran ${requested}, preregistered ${ARM_MODEL}`;
  if (billed.length && !billed.some((m) => bare(m) === bare(ARM_MODEL))) return `INFRA: billed ${billed.join(', ')}, not ${ARM_MODEL}`;
  return null;
}

export class ArmBudgetStop extends Error {}

/**
 * Reserve `estimateUsd` for one cell or judge call under ARM_SPEND_CAP_USD,
 * run it, and settle to its measured cost (unknown, kept at the reservation,
 * when the work reported none or threw). A refused reservation throws
 * ArmBudgetStop with `STOP: reason=budget_exhausted` and never runs the work.
 */
export async function metered<T>(
  spend: string, attempt: string, estimateUsd: number, label: string,
  fn: () => Promise<{ value: T; costUsd: number | null }>,
): Promise<T> {
  try {
    reserve(spend, attempt, estimateUsd, { cap: ARM_SPEND_CAP_USD, label });
  } catch (err) {
    if (err instanceof SpendCapExceeded) throw new ArmBudgetStop(`STOP: reason=budget_exhausted attempt=${attempt} ${err.message}`);
    throw err;
  }
  let settled = false;
  try {
    const { value, costUsd } = await fn();
    settle(spend, attempt, costUsd ?? 'unknown');
    settled = true;
    return value;
  } finally {
    if (!settled) settle(spend, attempt, 'unknown');
  }
}

export interface ArmCellRecord {
  task: string;
  trial: number;
  arm: Arm;
  infra: string | null;
  checks: 'pass' | 'fail' | 'none';
  /** Per-diff armJudge score (the no-loss diagnostic); null when unscored. */
  perDiff: number | null;
  judgeError: boolean;
  costUsd: number | null;
}

export interface ArmPairRecord {
  task: string;
  trial: number;
  /** Both-order paired verdict; null when the paired judge errored or the pair was not judged. */
  winner: Arm | 'tie' | null;
  mean: Record<Arm, number> | null;
}

/** results.md: one table, one row per arm identity, each no-gstack row beside its variant (gstack-eval-plan results --check). */
export function renderArmResults(input: { runId: string; decider: string; cells: ArmCellRecord[]; pairs: ArmPairRecord[] }): string {
  const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : 'n/a');
  const judged = input.pairs.filter((p) => p.winner !== null);
  const rows = ARMS.map((arm) => {
    const cells = input.cells.filter((c) => c.arm === arm);
    const valid = cells.filter((c) => !c.infra);
    const checked = valid.filter((c) => c.checks !== 'none');
    const w = judged.filter((p) => p.winner === arm).length;
    const t = judged.filter((p) => p.winner === 'tie').length;
    const cost = cells.reduce((s, c) => s + (c.costUsd ?? 0), 0);
    return `| \`${ARM_IDENTITY[arm]}\` | ${cells.length} | ${cells.length - valid.length} | ${checked.filter((c) => c.checks === 'pass').length}/${checked.length} | `
      + `${w}/${t}/${judged.length - w - t} | ${mean(judged.map((p) => p.mean![arm]))} | ${mean(valid.filter((c) => c.perDiff !== null).map((c) => c.perDiff!))} | `
      + `${cells.filter((c) => c.judgeError).length + (input.pairs.length - judged.length)} | $${cost.toFixed(2)} |`;
  });
  return [
    '# arm-benchmark results',
    '',
    `run: ${input.runId}  model: ${ARM_MODEL}  decider: ${input.decider}`,
    '',
    '| arm | cells | infra | checks pass | paired W/T/L | mean over_engineering (paired) | mean over_engineering (per-diff, diagnostic) | judge errors | cost |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
