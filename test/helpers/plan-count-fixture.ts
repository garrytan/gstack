import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getHermeticDirs } from './hermetic-env';

/**
 * Count evals review a seeded plan, never the checkout that supplies skills.
 * Put the complete request in Claude's initial project context before the
 * bare slash command starts: a later message can remain queued behind the
 * skill's first AskUserQuestion and leave it reviewing the live branch.
 */
export function createPlanCountFixture(prompt: string, opts: { nativeReviewOnly?: boolean } = {}): {
  cwd: string;
  env: Record<string, string>;
  cleanup(): void;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-count-'));
  let stateRoot: string | undefined;
  const env: Record<string, string> = {};
  const cleanup = () => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } finally {
      if (stateRoot) fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  };
  try {
    if (opts.nativeReviewOnly) {
      // Seeded-N count bands measure the main review's finding cadence.
      // An outside review can legitimately add findings beyond that band;
      // these fixtures do not cover its separate approval-question cadence.
      // Opt in only from runPlanSkillCounting: mode fixtures keep defaults.
      const sharedState = getHermeticDirs().gstackHome;
      stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-count-state-'));
      for (const entry of fs.readdirSync(sharedState, { withFileTypes: true })) {
        // Preserve onboarding seeds, without copying sibling review logs or
        // artifacts from the per-process shared hermetic state directory.
        if (entry.isFile() && (entry.name === '.activated' ||
            /^\..*(?:-seen|-prompted|-shown)$/.test(entry.name) ||
            entry.name.startsWith('.feature-prompted-'))) {
          fs.copyFileSync(path.join(sharedState, entry.name), path.join(stateRoot, entry.name));
        }
      }
      const config = fs.readFileSync(path.join(sharedState, 'config.yaml'), 'utf8')
        .replace(/^codex_reviews:.*(?:\r?\n|$)/gm, '');
      fs.writeFileSync(path.join(stateRoot, 'config.yaml'), config + '\ncodex_reviews: disabled\n');
      // Config readers prefer STATE_ROOT, while onboarding writers use HOME.
      // Both must resolve to owned state, even with explicit caller overrides.
      env.GSTACK_HOME = stateRoot;
      env.GSTACK_STATE_ROOT = stateRoot;
    }
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
    return { cwd, env, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
