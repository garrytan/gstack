import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getHermeticDirs } from './hermetic-env';

/** Disposable config for evals that explicitly cover native review only. */
export function createNativeReviewState(): {
  env: Record<string, string>;
  cleanup(): void;
} {
  const sharedState = getHermeticDirs().gstackHome;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-native-review-state-'));
  const cleanup = () => fs.rmSync(stateRoot, { recursive: true, force: true });
  try {
    for (const entry of fs.readdirSync(sharedState, { withFileTypes: true })) {
      // Keep onboarding seeds; never copy sibling review logs/artifacts.
      if (entry.isFile() && (entry.name === '.activated' ||
          /^\..*(?:-seen|-prompted|-shown)$/.test(entry.name) ||
          entry.name.startsWith('.feature-prompted-'))) {
        fs.copyFileSync(path.join(sharedState, entry.name), path.join(stateRoot, entry.name));
      }
    }
    const config = fs.readFileSync(path.join(sharedState, 'config.yaml'), 'utf8')
      .replace(/^codex_reviews:.*(?:\r?\n|$)/gm, '');
    fs.writeFileSync(path.join(stateRoot, 'config.yaml'), config + '\ncodex_reviews: disabled\n');
    // Readers and onboarding writers must agree on the owned state.
    return { env: { GSTACK_HOME: stateRoot, GSTACK_STATE_ROOT: stateRoot }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Count evals review a seeded plan, never the checkout that supplies skills.
 * Put the complete request in Claude's initial project context before the
 * bare slash command starts: a later message can remain queued behind the
 * skill's first AskUserQuestion and leave it reviewing the live branch.
 */
export function createPlanCountFixture(prompt: string, opts: { nativeReviewOnly?: boolean; files?: Record<string, string> } = {}): {
  cwd: string;
  env: Record<string, string>;
  cleanup(): void;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-count-'));
  let nativeState: ReturnType<typeof createNativeReviewState> | undefined;
  const env: Record<string, string> = {};
  const cleanup = () => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } finally {
      nativeState?.cleanup();
    }
  };
  try {
    const files = Object.entries(opts.files ?? {});
    for (const [name] of files) {
      const parts = name.split(/[\\/]/);
      // The fixture owns its seed plan, instructions and Git metadata. Extra
      // context must be an ordinary relative file, never an overwrite/escape.
      if (path.isAbsolute(name) || path.win32.isAbsolute(name) || parts.some(part =>
        part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
        /^(?:plan|claude)\.md$/i.test(name)) {
        throw new Error(`Invalid plan-count fixture file: ${name}`);
      }
    }
    if (opts.nativeReviewOnly) {
      // Seeded-N bands cover native finding cadence; mode fixtures keep defaults.
      nativeState = createNativeReviewState();
      Object.assign(env, nativeState.env);
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
    for (const [name, content] of files) {
      const target = path.join(cwd, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }

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
    git(['add', '--', 'PLAN.md', 'CLAUDE.md', ...files.map(([name]) => name)]);
    git(['-c', 'user.name=Plan Count Fixture', '-c', 'user.email=plan-count@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Seed review plan']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    return { cwd, env, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
