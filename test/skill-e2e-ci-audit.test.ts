/** /ci-audit behavior on a planted repo (test/helpers/ci-audit-planted.ts):
 *   ci-audit-planted             the skill names the three planted problems with
 *                                numbers, flags neither decoy and edits nothing
 *   ci-audit-planted-no-gstack   the same task, data and tools with no skill text
 *                                (the no-gstack arm, scored by the same rules)
 * The GitHub API is offline: the week of Actions responses sits in ./.ci-data and
 * GSTACK_CI_AUDIT_FIXTURE points gstack-ci-audit at it for both arms.
 */
import { afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { ROOT, runId, describeIfSelected, testIfSelected, logCost, createEvalCollector, finalizeEvalCollector } from './helpers/e2e-helpers';
import { extractSkillBody } from './helpers/skill-fixture';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { PLANTED, scoreReply, writePlantedRepo } from './helpers/ci-audit-planted';
import { resolveEvalModel } from '../lib/eval-model';
import type { SkillTestResult } from './helpers/session-runner';

const evalCollector = createEvalCollector('e2e');
const RUNNER_MS = CAPTURE_MS - 3 * OFFICE_HOURS_BUN_GRACE_MS;

export const CI_AUDIT_TASK = `Audit this repository's GitHub Actions CI for speed and cost. GitHub's API is
offline on this machine; the last week of Actions API responses for acme/widgets is
saved under ./.ci-data (one JSON file per API path, job logs as .txt). Tell me the
fixes worth making, ranked, each with the numbers behind it (minutes, how often).
Do not change any files.`;

function trackedChanges(cwd: string): string {
  return spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
}

async function runCase(entry: { id: string; suite: string; skill: boolean }): Promise<void> {
    const testName = entry.id;
    let base: string | undefined;
    try {
      await runRecordedOfficeHoursAttempt({
        collector: evalCollector, name: entry.id, suite: entry.suite,
        model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
        budgetMs: CAPTURE_MS - OFFICE_HOURS_BUN_GRACE_MS,
        run: async signal => {
          base = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-'));
          const cwd = path.join(base, 'widgets');
          await writePlantedRepo(cwd, path.join(cwd, '.ci-data'));
          fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '.ci-data/\nci-audit/\n');
          let prompt = CI_AUDIT_TASK;
          if (entry.skill) {
            fs.mkdirSync(path.join(cwd, 'ci-audit'), { recursive: true });
            fs.writeFileSync(path.join(cwd, 'ci-audit', 'SKILL.md'), extractSkillBody(path.join(ROOT, 'ci-audit')).replaceAll('~/.claude/skills/gstack/', `${ROOT}/`));
            prompt = `Read ci-audit/SKILL.md and follow it (report-only: answer no to every fix question).\n\n${CI_AUDIT_TASK}`;
          }
          return runSkillTest({
            prompt, workingDirectory: cwd, maxTurns: 25,
            allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
            env: { GSTACK_CI_AUDIT_FIXTURE: path.join(cwd, '.ci-data') },
            timeout: RUNNER_MS, testName, runId, signal,
          });
        },
        validate: (result: SkillTestResult) => {
          logCost(entry.id, result);
          if (result.exitReason !== 'success') throw new Error(`${entry.id}: ${result.exitReason}`);
          const { found, decoys } = scoreReply(result.output || '');
          const missing = PLANTED.map(p => p.id).filter(id => !found.includes(id));
          if (missing.length) throw new Error(`${entry.id}: missed ${missing.join(', ')}`);
          if (decoys.length) throw new Error(`${entry.id}: flagged decoy ${decoys.join(', ')}`);
          if (trackedChanges(path.join(base!, 'widgets'))) throw new Error(`${entry.id}: tracked files changed`);
        },
      });
    } finally {
      if (base) try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    }
}

describeIfSelected('CI Audit E2E', ['ci-audit-planted'], () => {
  testIfSelected('ci-audit-planted', () => runCase({ id: 'ci-audit-planted', suite: 'CI Audit E2E', skill: true }), CAPTURE_MS);
});

describeIfSelected('CI Audit no-gstack E2E', ['ci-audit-planted-no-gstack'], () => {
  testIfSelected('ci-audit-planted-no-gstack', () => runCase({ id: 'ci-audit-planted-no-gstack', suite: 'CI Audit no-gstack E2E', skill: false }), CAPTURE_MS);
});

afterAll(async () => { await finalizeEvalCollector(evalCollector); });
