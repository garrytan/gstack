import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Count evals review a seeded plan, never the checkout that supplies skills.
 * Put the complete request in Claude's initial project context before the
 * bare slash command starts: a later message can remain queued behind the
 * skill's first AskUserQuestion and leave it reviewing the live branch.
 */
export function createPlanCountFixture(prompt: string): {
  cwd: string;
  cleanup(): void;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-count-'));
  const cleanup = () => fs.rmSync(cwd, { recursive: true, force: true });
  try {
    fs.writeFileSync(path.join(cwd, 'PLAN.md'), prompt);
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), [
      '# Plan review fixture',
      '',
      'This repository contains the plan under review. Use PLAN.md as the',
      'current plan for the requested plan-review skill. The skill installation',
      'supplies the workflow; its source checkout is not the review target.',
      '',
      'The complete user request is available from the start of this session:',
      '',
      prompt,
      '',
    ].join('\n'));

    const git = (args: string[]) => {
      const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (result.error || result.status !== 0) {
        throw new Error(`Could not initialize plan-count fixture: ${result.error?.message ?? result.stderr}`);
      }
    };
    git(['init', '-b', 'main']);
    git(['add', 'PLAN.md', 'CLAUDE.md']);
    git(['-c', 'user.name=Plan Count Fixture', '-c', 'user.email=plan-count@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Seed review plan']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    return { cwd, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
