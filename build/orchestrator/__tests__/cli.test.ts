import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildGeminiTestSpecPrompt,
  buildDualImplPromptBody,
  buildCodexReviewBody,
  buildJudgePrompt,
  buildContextSaveBody,
  buildReviewGatePlan,
  isLikelyCodexWorkspaceSandboxFailure,
  shouldRetryCodexGateWithDangerFullAccess,
  parseArgs,
  validateRoleProviders,
  resolveProjectRoot,
  validateProjectRootSelection,
  captureGitSnapshot,
  recoverMutableAgentCommit,
  validatePostAgentHygiene,
  validateParentWorkspaceUnchanged,
  hygieneFailureResult,
  archiveLivingPlan,
  archiveOriginPlan,
  buildOriginVerificationBody,
  ensureFeatureBranch,
  restartFeatureFromOriginIssues,
  HELP_TEXT,
} from '../cli';
import type { BuildState, FeatureState, Phase, DualImplTestResult } from '../types';
import { statePath } from '../state';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_ROLE_CONFIGS } from '../role-config';

let tmpDir: string | null = null;
let tmpStateDir: string | null = null;
let realStateDir: string | undefined;

beforeEach(() => {
  realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cli-state-'));
  process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
});

afterEach(() => {
  if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  if (tmpStateDir && fs.existsSync(tmpStateDir)) {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpStateDir = null;
  tmpDir = null;
});

const basePhase: Phase = {
  index: 0,
  number: '1',
  name: 'Auth middleware',
  featureIndex: 0,
  featureNumber: '1',
  featureName: 'Auth',
  body: 'Write tests for the auth middleware.',
  testSpecDone: false,
  testSpecCheckboxLine: 5,
  implementationCheckboxLine: 6,
  reviewCheckboxLine: 7,
  implementationDone: false,
  reviewDone: false,
  dualImpl: false,
};

describe('buildGeminiTestSpecPrompt', () => {
  it('contains "write failing tests"', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt.toLowerCase()).toContain('write failing tests');
  });

  it('contains "do NOT implement" or "do not implement"', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt.toLowerCase()).toMatch(/do not implement/);
  });

  it('contains the phase name', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt).toContain(basePhase.name);
  });

  it('contains the plan file path', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt).toContain('plan.md');
  });
});

describe('--dual-impl flag wiring', () => {
  it('--help text mentions --dual-impl', () => {
    expect(HELP_TEXT).toContain('--dual-impl');
  });

  it('parseArgs([plan, --dual-impl]) sets dualImpl=true when judge is Claude-compatible', () => {
    const args = parseArgs([
      'plan.md',
      '--dual-impl',
      '--primary-impl-provider',
      'gemini',
      '--judge-provider',
      'claude',
    ]);
    expect(args.dualImpl).toBe(true);
  });

  it('parseArgs default -> dualImpl=false', () => {
    const args = parseArgs(['plan.md']);
    expect(args.dualImpl).toBe(false);
  });
});

describe('--skip-ship flag wiring', () => {
  it('parseArgs default -> skipShip=false', () => {
    const args = parseArgs(['plan.md']);
    expect(args.skipShip).toBe(false);
  });

  it('parseArgs([plan, --skip-ship]) sets skipShip=true', () => {
    const args = parseArgs(['plan.md', '--skip-ship']);
    expect(args.skipShip).toBe(true);
  });
});

describe('merge subcommand wiring', () => {
  it('parseArgs([merge]) selects merge mode without a plan file', () => {
    const args = parseArgs(['merge']);
    expect(args.mode).toBe('merge');
    expect(args.planFile).toBe('');
  });

  it('--help text documents merge mode', () => {
    expect(HELP_TEXT).toContain('gstack-build merge [flags]');
    expect(HELP_TEXT).toContain('Review/fix/ship/land unmerged feat/* branches');
  });
});

describe('review gate planning', () => {
  it('skips reviewSecondary when its command is unset', () => {
    const roles = {
      ...DEFAULT_ROLE_CONFIGS,
      reviewSecondary: {
        ...DEFAULT_ROLE_CONFIGS.reviewSecondary,
        command: undefined,
      },
    };

    const plan = buildReviewGatePlan(roles);

    expect(plan.gates.map((g) => g.name)).toEqual(['review', 'qa']);
    expect(plan.skipped).toEqual([
      {
        name: 'reviewSecondary',
        reason: 'reviewSecondary command unset; skipped optional secondary review',
      },
    ]);
  });

  it('fails required review and QA gates when their commands are unset', () => {
    const roles = {
      ...DEFAULT_ROLE_CONFIGS,
      review: { ...DEFAULT_ROLE_CONFIGS.review, command: undefined },
      reviewSecondary: {
        ...DEFAULT_ROLE_CONFIGS.reviewSecondary,
        command: '/custom second opinion',
      },
      qa: { ...DEFAULT_ROLE_CONFIGS.qa, command: undefined },
    };

    const plan = buildReviewGatePlan(roles);

    expect(plan.gates.map((g) => g.name)).toEqual(['reviewSecondary']);
    expect(plan.missingRequired).toEqual(['review', 'qa']);
  });
});

describe('Codex review gate sandbox retry classification', () => {
  it('detects local browser/process permission failures from workspace-write', () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout:
          'Chromium failed: mach_port_rendezvous_mac.cc Permission denied (1100). GATE FAIL',
        stderr: '',
      }),
    ).toBe(true);
  });

  it('detects localhost bind permission failures', () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout: '',
        stderr: 'grpc server cannot bind localhost:50051: EACCES',
      }),
    ).toBe(true);
  });

  it('does not classify Codex service network disconnects as sandbox failures', () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout: 'GATE FAIL',
        stderr:
          'ERROR: stream disconnected before completion: tls handshake eof while sending request to backend-api/codex/responses',
      }),
    ).toBe(false);
  });

  it('only retries Codex gates when sandbox env is not explicit', () => {
    const result = {
      stdout: 'Playwright browser launch failed: Operation not permitted',
      stderr: '',
    };

    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: 'codex' },
        result,
      }),
    ).toBe(true);
    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: 'codex' },
        result,
        reviewSandboxEnv: 'workspace-write',
      }),
    ).toBe(false);
    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: 'claude' },
        result,
      }),
    ).toBe(false);
  });
});

describe('--parallel-phases flag wiring', () => {
  it('--help text mentions --parallel-phases', () => {
    expect(HELP_TEXT).toContain('--parallel-phases');
  });

  it('parseArgs default -> parallelPhases=1', () => {
    const args = parseArgs(['plan.md']);
    expect(args.parallelPhases).toBe(1);
  });

  it('parseArgs([plan, --parallel-phases, 3]) sets parallelPhases=3', () => {
    const args = parseArgs(['plan.md', '--parallel-phases', '3']);
    expect(args.parallelPhases).toBe(3);
  });

  it('parseArgs rejects --parallel-phases below 1', () => {
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    try {
      expect(() => parseArgs(['plan.md', '--parallel-phases', '0'])).toThrow('exit:2');
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  it('parseArgs rejects combining --parallel-phases with --dual-impl', () => {
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    try {
      expect(() => parseArgs(['plan.md', '--dual-impl', '--parallel-phases', '2'])).toThrow('exit:2');
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });
});

describe('--skip-clean-check / --skip-sweep flags', () => {
  it('parseArgs default -> skipCleanCheck=false, skipSweep=false', () => {
    const args = parseArgs(['plan.md']);
    expect(args.skipCleanCheck).toBe(false);
    expect(args.skipSweep).toBe(false);
  });

  it('parseArgs([plan, --skip-clean-check]) -> skipCleanCheck=true', () => {
    const args = parseArgs(['plan.md', '--skip-clean-check']);
    expect(args.skipCleanCheck).toBe(true);
  });

  it('parseArgs([plan, --skip-sweep]) -> skipSweep=true', () => {
    const args = parseArgs(['plan.md', '--skip-sweep']);
    expect(args.skipSweep).toBe(true);
  });

  it('HELP_TEXT contains --skip-clean-check', () => {
    expect(HELP_TEXT).toContain('--skip-clean-check');
  });

  it('HELP_TEXT contains --skip-sweep', () => {
    expect(HELP_TEXT).toContain('--skip-sweep');
  });
});

describe('--gemini-model / --codex-model flag wiring', () => {
  it('--help text mentions --gemini-model', () => {
    expect(HELP_TEXT).toContain('--gemini-model');
  });

  it('--help text mentions --codex-model', () => {
    expect(HELP_TEXT).toContain('--codex-model');
  });

  it('parseArgs with --gemini-model sets geminiModel', () => {
    const args = parseArgs(['plan.md', '--gemini-model', 'primary-model-under-test']);
    expect(args.geminiModel).toBe('primary-model-under-test');
  });

  it('parseArgs with --codex-model sets codexModel', () => {
    const args = parseArgs(['plan.md', '--codex-model', 'secondary-model-under-test']);
    expect(args.codexModel).toBe('secondary-model-under-test');
  });

  it('parseArgs default -> model defaults come from configure.cm (no flags needed)', () => {
    const args = parseArgs(['plan.md']);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(DEFAULT_ROLE_CONFIGS.reviewSecondary.model);
    expect(args.roles.testWriter).toEqual(DEFAULT_ROLE_CONFIGS.testWriter);
    expect(args.roles.testFixer).toEqual(DEFAULT_ROLE_CONFIGS.testFixer);
    expect(args.roles.ship).toEqual(DEFAULT_ROLE_CONFIGS.ship);
  });

  it('--codex-review-model overrides the review model default', () => {
    const args = parseArgs(['plan.md', '--codex-review-model', 'review-model-under-test']);
    expect(args.codexReviewModel).toBe('review-model-under-test');
  });

  it('--help text mentions --codex-review-model', () => {
    expect(HELP_TEXT).toContain('--codex-review-model');
  });

  it('parseArgs accepts all three model flags together', () => {
    const args = parseArgs([
      'plan.md',
      '--gemini-model', 'primary-model-under-test',
      '--codex-model', 'secondary-model-under-test',
      '--codex-review-model', 'review-model-under-test',
    ]);
    expect(args.geminiModel).toBe('primary-model-under-test');
    expect(args.codexModel).toBe('secondary-model-under-test');
    expect(args.codexReviewModel).toBe('review-model-under-test');
  });

  it('parseArgs model flags combine correctly with --dual-impl', () => {
    const args = parseArgs([
      'plan.md',
      '--dual-impl',
      '--primary-impl-provider',
      'gemini',
      '--judge-provider',
      'claude',
    ]);
    expect(args.dualImpl).toBe(true);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(DEFAULT_ROLE_CONFIGS.reviewSecondary.model);
  });

  it('new role flags override defaults', () => {
    const args = parseArgs([
      'plan.md',
      '--review-secondary-model', 'review-secondary-model-under-test',
      '--review-secondary-command', '/custom second opinion',
      '--ship-model', 'ship-model-under-test',
      '--ship-reasoning', 'medium',
    ]);
    expect(args.roles.reviewSecondary.model).toBe('review-secondary-model-under-test');
    expect(args.roles.reviewSecondary.command).toBe('/custom second opinion');
    expect(args.roles.ship.model).toBe('ship-model-under-test');
    expect(args.roles.ship.reasoning).toBe('medium');
  });

  it('--project-root resolves to an absolute path', () => {
    const args = parseArgs(['plan.md', '--project-root', '.']);
    expect(path.isAbsolute(args.projectRoot!)).toBe(true);
  });

  it('--allow-workspace-root defaults false and can be enabled explicitly', () => {
    expect(parseArgs(['plan.md']).allowWorkspaceRoot).toBe(false);
    expect(parseArgs(['plan.md', '--allow-workspace-root']).allowWorkspaceRoot).toBe(true);
  });

  it('provider validation rejects unsupported slash-command providers but allows model-agnostic dual-impl', () => {
    const args = parseArgs([
      'plan.md',
      '--dual-impl',
      '--primary-impl-provider',
      'gemini',
      '--judge-provider',
      'claude',
    ]);
    args.roles.qa.provider = 'kimi';
    args.roles.ship.provider = 'gemini';
    args.roles.land.provider = 'gemini';
    args.roles.contextSave.provider = 'kimi';
    args.roles.primaryImpl.provider = 'codex';
    args.roles.secondaryImpl.provider = 'claude';
    args.roles.judge.provider = 'codex';

    expect(validateRoleProviders(args)).toEqual([
      '--qa-provider kimi is not supported for slash-command gates',
      '--context-save-provider kimi is not supported for slash-command roles',
    ]);
  });

  it('provider validation accepts non-Gemini/Codex/Claude dual-impl roles', () => {
    const args = parseArgs([
      'plan.md',
      '--dual-impl',
      '--primary-impl-provider',
      'codex',
      '--secondary-impl-provider',
      'claude',
      '--judge-provider',
      'gemini',
    ]);
    expect(validateRoleProviders(args)).toEqual([]);
  });
});

describe('post-agent hygiene helpers', () => {
  function git(args: string[], cwd: string) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    }
    return r.stdout.trim();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hygiene-'));
    git(['init', '--initial-branch=main'], tmpDir);
    git(['config', 'user.email', 'test@test.com'], tmpDir);
    git(['config', 'user.name', 'Test User'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'init\n');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'init'], tmpDir);
  });

  it('rejects a successful implementor run with an empty summary', () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, '.llm-tmp', 'summary.md');
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, '');
    fs.writeFileSync(path.join(tmpDir!, 'change.txt'), 'change\n');
    git(['add', '.'], tmpDir!);
    git(['commit', '-m', 'change'], tmpDir!);

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: 'primary implementor',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/empty output summary/);
  });

  it('rejects a successful implementor run that leaves an untracked file and no commit', () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, '.llm-tmp', 'summary.md');
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, 'done\n');
    fs.writeFileSync(path.join(tmpDir!, 'rewrite.py'), 'print("oops")\n');

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: 'primary implementor',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/did not create a new commit/);
    expect(verdict.errors.join('\n')).toMatch(/\?\? rewrite\.py/);
  });

  it('recovers a sandboxed implementor by host-committing summary-listed files and cleaning cache noise', () => {
    fs.mkdirSync(path.join(tmpDir!, 'pkg', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, 'pkg', '__pycache__', 'mod.pyc'), 'old-cache\n');
    git(['add', 'pkg/__pycache__/mod.pyc'], tmpDir!);
    git(['commit', '-m', 'track cache fixture'], tmpDir!);

    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, '.llm-tmp', 'summary.md');
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.mkdirSync(path.join(tmpDir!, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(tmpDir!, 'src', 'feature.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(tmpDir!, 'pkg', '__pycache__', 'mod.pyc'), 'new-cache\n');
    fs.writeFileSync(
      summary,
      [
        '# Primary implementor summary',
        '',
        '## Files changed',
        '- `README.md` — update docs.',
        '- `src/feature.ts` — add feature code.',
        '',
        '## Commit',
        '- Conventional commit message: `feat: add recovered feature`',
      ].join('\n'),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: 'primary implementor',
    });

    expect(recovery.recovered).toBe(true);
    expect(git(['rev-list', '--count', `${before.head}..HEAD`], tmpDir!)).toBe('1');
    expect(git(['log', '-1', '--pretty=%s'], tmpDir!)).toBe('feat: add recovered feature');
    const committedFiles = git(['show', '--name-only', '--pretty=', 'HEAD'], tmpDir!).split('\n');
    expect(committedFiles).toContain('README.md');
    expect(committedFiles).toContain('src/feature.ts');
    expect(committedFiles).not.toContain('pkg/__pycache__/mod.pyc');

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: 'primary implementor',
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it('accepts a committed clean implementor run with a non-empty summary', () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, '.llm-tmp', 'summary.md');
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, 'changed README and committed\n');
    fs.writeFileSync(path.join(tmpDir!, 'README.md'), 'changed\n');
    git(['add', 'README.md'], tmpDir!);
    git(['commit', '-m', 'change readme'], tmpDir!);

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: 'primary implementor',
    });

    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it('writes hygiene failures to a dedicated sibling log', () => {
    const originalLog = path.join(tmpDir!, '.llm-tmp', 'phase-1-primary-impl-1.log');
    fs.mkdirSync(path.dirname(originalLog), { recursive: true });
    fs.writeFileSync(originalLog, 'original agent output\n');

    const result = hygieneFailureResult(
      'primary implementor did not create a new commit',
      originalLog,
    );
    const expectedLog = path.join(
      tmpDir!,
      '.llm-tmp',
      'phase-1-primary-impl-1-hygiene.log',
    );

    expect(result.exitCode).toBe(1);
    expect(result.logPath).toBe(expectedLog);
    expect(result.stdout).toContain('# Post-agent hygiene failure');
    expect(result.stdout).toContain('primary implementor did not create a new commit');
    expect(result.stdout).toContain(`Original agent log: ${originalLog}`);
    expect(fs.readFileSync(expectedLog, 'utf8')).toBe(result.stdout);
  });

  it('detects parent workspace root HEAD and status changes', () => {
    const workspace = path.join(tmpDir!, 'parent-workspace');
    const child = path.join(workspace, 'app');
    fs.mkdirSync(child, { recursive: true });
    git(['init', '--initial-branch=main'], workspace);
    git(['config', 'user.email', 'test@test.com'], workspace);
    git(['config', 'user.name', 'Test User'], workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), 'root\n');
    git(['add', 'README.md'], workspace);
    git(['commit', '-m', 'root init'], workspace);
    git(['init', '--initial-branch=main'], child);

    const before = captureGitSnapshot(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), 'root changed\n');
    git(['add', 'README.md'], workspace);
    git(['commit', '-m', 'root change'], workspace);
    fs.writeFileSync(path.join(workspace, 'root-scratch.txt'), 'dirty\n');

    const verdict = validateParentWorkspaceUnchanged({
      before,
      workspaceRoot: workspace,
      label: 'primary implementor',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('changed workspace root HEAD');
    expect(verdict.errors.join('\n')).toContain('changed workspace root status');
  });
});

describe('buildContextSaveBody', () => {
  it('asks the configured context-save role to preserve phase boundary state', () => {
    const state: BuildState = {
      planFile: '/repo/plan.md',
      planBasename: 'plan',
      slug: 'build-plan',
      branch: 'main',
      startedAt: '2026-04-30T00:00:00.000Z',
      lastUpdatedAt: '2026-04-30T00:00:00.000Z',
      currentPhaseIndex: 0,
      phases: [],
      completed: false,
    };

    const body = buildContextSaveBody({
      state,
      phase: basePhase,
      cwd: '/repo',
    });

    expect(body).toContain('phase boundary context save');
    expect(body).toContain('Completed phase: 1 — Auth middleware');
    expect(body).toContain('Do not make code changes, commits, branch changes, or plan edits.');
  });
});

describe('plan storage helpers', () => {
  it('uses explicit --project-root when plan lives outside the product repo', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-'));
    const project = path.join(tmpDir, 'app');
    const mirror = path.join(tmpDir, 'app-gstack', 'inbox', 'living-plan');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(mirror, { recursive: true });
    const plan = path.join(mirror, 'app-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    expect(resolveProjectRoot({ planFile: plan, projectRoot: project })).toBe(project);
  });

  it('rejects a workspace root with child repos unless explicitly allowed', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-workspace-'));
    const child = path.join(tmpDir, 'app');
    fs.mkdirSync(child, { recursive: true });
    spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    spawnSync('git', ['init'], { cwd: child, stdio: 'ignore' });

    expect(() => validateProjectRootSelection(tmpDir, false)).toThrow(/workspace root/i);
    expect(validateProjectRootSelection(tmpDir, true)).toBe(tmpDir);
  });

  it('requires --project-root when invoked from an ambiguous *-gstack repo', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-'));
    const mirror = path.join(tmpDir, 'app-gstack');
    const living = path.join(mirror, 'living-plans');
    fs.mkdirSync(living, { recursive: true });
    spawnSync('git', ['init'], { cwd: mirror, stdio: 'ignore' });
    const plan = path.join(living, 'app-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    expect(() => resolveProjectRoot({ planFile: plan, cwd: mirror })).toThrow(/--project-root/);
  });

  it('does not bind a sibling living plan to the current product repo implicitly', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-'));
    const currentProject = path.join(tmpDir, 'app-b');
    const mirror = path.join(tmpDir, 'app-a-gstack');
    const living = path.join(mirror, 'living-plans');
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync('git', ['init'], { cwd: currentProject, stdio: 'ignore' });
    spawnSync('git', ['init'], { cwd: mirror, stdio: 'ignore' });
    const plan = path.join(living, 'app-a-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    expect(() => resolveProjectRoot({ planFile: plan, cwd: currentProject })).toThrow(/--project-root/);
  });

  it('requires --project-root for living plans in an uninitialized *-gstack directory too', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-'));
    const currentProject = path.join(tmpDir, 'app-b');
    const living = path.join(tmpDir, 'app-a-gstack', 'living-plans');
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync('git', ['init'], { cwd: currentProject, stdio: 'ignore' });
    const plan = path.join(living, 'app-a-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    expect(() => resolveProjectRoot({ planFile: plan, cwd: currentProject })).toThrow(/--project-root/);
  });

  it('requires --project-root for inbox plans in a sibling *-gstack repo', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-'));
    const currentProject = path.join(tmpDir, 'app-b');
    const inbox = path.join(tmpDir, 'app-a-gstack', 'inbox');
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(inbox, { recursive: true });
    spawnSync('git', ['init'], { cwd: currentProject, stdio: 'ignore' });
    const plan = path.join(inbox, 'app-a-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    expect(() => resolveProjectRoot({ planFile: plan, cwd: currentProject })).toThrow(/--project-root/);
  });

  it('requires --project-root for inbox living plans in a sibling *-gstack repo', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-'));
    const currentProject = path.join(tmpDir, 'app-b');
    const living = path.join(tmpDir, 'app-a-gstack', 'inbox', 'living-plan');
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync('git', ['init'], { cwd: currentProject, stdio: 'ignore' });
    const plan = path.join(living, 'app-a-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    expect(() => resolveProjectRoot({ planFile: plan, cwd: currentProject })).toThrow(/--project-root/);
  });

  it('prefers the plan repo over the current cwd repo for in-repo plans', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-'));
    const planProject = path.join(tmpDir, 'app-a');
    const currentProject = path.join(tmpDir, 'app-b');
    const plans = path.join(planProject, 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.mkdirSync(currentProject, { recursive: true });
    spawnSync('git', ['init'], { cwd: planProject, stdio: 'ignore' });
    spawnSync('git', ['init'], { cwd: currentProject, stdio: 'ignore' });
    const plan = path.join(plans, 'app-a-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    expect(resolveProjectRoot({ planFile: plan, cwd: currentProject })).toBe(planProject);
  });

  it('archives completed living plans into the sibling archived dir', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-archive-'));
    const living = path.join(tmpDir, 'app-gstack', 'living-plans');
    fs.mkdirSync(living, { recursive: true });
    const plan = path.join(living, 'app-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    const archived = archiveLivingPlan(plan);
    expect(archived).toBe(path.join(tmpDir, 'app-gstack', 'archived', 'app-impl-plan-20260430.md'));
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it('archives completed inbox living plans into the sibling archived dir', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-archive-'));
    const living = path.join(tmpDir, 'app-gstack', 'inbox', 'living-plan');
    fs.mkdirSync(living, { recursive: true });
    const plan = path.join(living, 'app-impl-plan-20260430.md');
    fs.writeFileSync(plan, '# plan\n');

    const archived = archiveLivingPlan(plan);
    expect(archived).toBe(path.join(tmpDir, 'app-gstack', 'archived', 'app-impl-plan-20260430.md'));
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it('archives completed origin plans from the sibling inbox into archived', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-origin-archive-'));
    const inbox = path.join(tmpDir, 'app-gstack', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const plan = path.join(inbox, 'app-plan-20260430.md');
    fs.writeFileSync(plan, '# source plan\n');

    const archived = archiveOriginPlan(plan);
    expect(archived).toBe(path.join(tmpDir, 'app-gstack', 'archived', 'app-plan-20260430.md'));
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it('does not archive origin plans outside a gstack inbox/plans dir', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-origin-archive-'));
    const dir = path.join(tmpDir, 'app', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    const plan = path.join(dir, 'app-plan-20260430.md');
    fs.writeFileSync(plan, '# source plan\n');

    expect(archiveOriginPlan(plan)).toBeNull();
    expect(fs.existsSync(plan)).toBe(true);
  });
});

describe('buildOriginVerificationBody', () => {
  it('asks for a GATE PASS / GATE FAIL origin-plan check', () => {
    const body = buildOriginVerificationBody({
      feature: {
        index: 0,
        number: '1',
        name: 'Auth',
        phaseIndexes: [0, 1],
        status: 'origin_verifying',
      },
      livingPlanFile: 'living.md',
      originPlanFile: 'origin.md',
    });
    expect(body).toContain('Origin plan: origin.md');
    expect(body).toContain('GATE PASS');
    expect(body).toContain('GATE FAIL');
  });
});

describe('buildDualImplPromptBody (dual-impl implementation prompt)', () => {
  it('contains "implement"', () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: 'plan.md',
      candidate: 'primary',
      opponent: 'secondary',
    });
    expect(body.toLowerCase()).toMatch(/implement/);
  });

  it('contains "do NOT change test assertions"', () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: 'plan.md',
      candidate: 'primary',
      opponent: 'secondary',
    });
    expect(body).toMatch(/do NOT change test assertions/i);
  });

  it('contains the phase name, plan file, and candidate labels', () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: 'plan.md',
      candidate: 'primary',
      opponent: 'secondary',
    });
    expect(body).toContain(basePhase.name);
    expect(body).toContain('plan.md');
    expect(body).toContain('primary implementor');
    expect(body).toContain('secondary implementor');
  });
});

describe('buildCodexReviewBody (configured review gate context)', () => {
  it('does not hardcode /gstack-review so configured commands stay authoritative', () => {
    const body = buildCodexReviewBody(basePhase, 'plan.md', 'feat/test', 1, null);
    expect(body).toContain('slash command specified by the runner prompt');
    expect(body).not.toContain('/gstack-review');
  });

  it('includes origin-plan issue reports when restarting a feature loop', () => {
    const body = buildCodexReviewBody(basePhase, 'plan.md', 'feat/test', 1, null, undefined, '/tmp/origin-issues.md');
    expect(body).toContain('Origin-plan verification issues');
    expect(body).toContain('/tmp/origin-issues.md');
    expect(body).toContain('Fix every concrete gap');
  });
});

describe('restartFeatureFromOriginIssues', () => {
  function stateAndFeature(): { state: BuildState; feature: FeatureState } {
    const feature: FeatureState = {
      index: 0,
      number: '1',
      name: 'Auth',
      phaseIndexes: [0, 1],
      status: 'origin_verifying',
      featureReview: {
        iterations: 1,
        outputLogPaths: ['/tmp/feature-review.log'],
        outputFilePaths: ['/tmp/feature-review.md'],
        finalVerdict: 'FEATURE_PASS',
      },
    };
    return {
      feature,
      state: {
        planFile: 'plan.md',
        planBasename: 'plan',
        slug: 'plan',
        branch: 'feat/auth',
        startedAt: '2026-04-30T00:00:00.000Z',
        lastUpdatedAt: '2026-04-30T00:00:00.000Z',
        currentPhaseIndex: 0,
        currentFeatureIndex: 0,
        features: [feature],
        phases: [
          { index: 0, number: '1.1', name: 'Tests', status: 'committed' },
          {
            index: 1,
            number: '1.2',
            name: 'Implementation',
            status: 'committed',
            codexReview: {
              iterations: 2,
              finalVerdict: 'GATE PASS',
              outputLogPaths: ['/tmp/review.md'],
            },
          },
        ],
        completed: false,
        geminiModel: 'gemini',
        codexModel: 'codex',
        codexReviewModel: 'codex-review',
      },
    };
  }

  it('records origin issues and resets the feature to its review loop', () => {
    const { state, feature } = stateAndFeature();
    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: '/tmp/origin-issues.md',
      reason: 'missing acceptance behavior',
    });
    expect(restart).toEqual({ restarted: true, phaseIndex: 1 });
    expect(feature.status).toBe('running');
    expect(feature.originVerificationAttempts).toBe(1);
    expect(feature.originIssueLogPaths).toEqual(['/tmp/origin-issues.md']);
    expect(feature.featureReview).toBeUndefined();
    expect(state.phases[1].status).toBe('tests_green');
    expect(state.phases[1].codexReview).toBeUndefined();
    expect(state.phases[1].originIssueLogPath).toBe('/tmp/origin-issues.md');
  });

  it('pauses after the origin verification retry cap is exhausted', () => {
    const { state, feature } = stateAndFeature();
    feature.originVerificationAttempts = 1;
    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: '/tmp/origin-issues.md',
      reason: 'still missing behavior',
      maxAttempts: 1,
    });
    expect(restart.restarted).toBe(false);
    expect(feature.status).toBe('paused');
    expect(feature.error).toContain('still failing after 1 auto-fix attempts');
  });
});

describe('ensureFeatureBranch', () => {
  function stateForBranchTest(slug: string, feature: FeatureState, branch = 'feat/other'): BuildState {
    return {
      planFile: 'plan.md',
      planBasename: 'plan',
      slug,
      branch,
      startedAt: '2026-04-30T00:00:00.000Z',
      lastUpdatedAt: '2026-04-30T00:00:00.000Z',
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [feature],
      phases: [],
      completed: false,
      geminiModel: 'gemini',
      codexModel: 'codex',
      codexReviewModel: 'codex-review',
    };
  }

  it('checks out a saved feature branch when resuming from another branch', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-feature-branch-'));
    const repo = tmpDir;
    expect(spawnSync('git', ['init', '-b', 'main'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repo }).status).toBe(0);
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    expect(spawnSync('git', ['add', 'README.md'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['commit', '-m', 'init'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['checkout', '-b', 'feat/auth'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['checkout', 'main'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['checkout', '-b', 'feat/other'], { cwd: repo }).status).toBe(0);

    const slug = `test-branch-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: '1',
      name: 'Auth',
      phaseIndexes: [],
      status: 'running',
      branch: 'feat/auth',
    };
    const state = stateForBranchTest(slug, feature);

    expect(ensureFeatureBranch({
      cwd: repo,
      state,
      feature,
      dryRun: false,
      noGbrain: true,
    })).toBe(true);
    const current = spawnSync('git', ['branch', '--show-current'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    expect(current).toBe('feat/auth');
    fs.rmSync(statePath(slug), { force: true });
  });

  it('creates a follow-up branch from base for landed origin-verification retries', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-origin-retry-'));
    const bare = path.join(tmpDir, 'origin.git');
    const repo = path.join(tmpDir, 'repo');
    expect(spawnSync('git', ['init', '--bare', bare]).status).toBe(0);
    expect(spawnSync('git', ['clone', bare, repo]).status).toBe(0);
    expect(spawnSync('git', ['checkout', '-b', 'main'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repo }).status).toBe(0);
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    expect(spawnSync('git', ['add', 'README.md'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['commit', '-m', 'init'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['checkout', '-b', 'feat/auth'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['checkout', 'main'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['branch', '-D', 'feat/auth'], { cwd: repo }).status).toBe(0);

    const slug = `test-origin-retry-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: '1',
      name: 'Auth',
      phaseIndexes: [],
      status: 'running',
      branch: 'feat/auth',
      landedAt: '2026-04-30T00:00:00.000Z',
      originVerificationAttempts: 1,
    };
    const state = stateForBranchTest(slug, feature, 'main');

    expect(ensureFeatureBranch({
      cwd: repo,
      state,
      feature,
      dryRun: false,
      noGbrain: true,
    })).toBe(true);
    const current = spawnSync('git', ['branch', '--show-current'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    expect(current).toBe('feat/auth-followup-1');
    expect(feature.branch).toBe('feat/auth-followup-1');
    expect(state.branch).toBe('feat/auth-followup-1');
    fs.rmSync(statePath(slug), { force: true });
  });
});

describe('buildJudgePrompt (tournament judge prompt)', () => {
  function pass(): DualImplTestResult {
    return {
      worktreePath: '/tmp/wt',
      testExitCode: 0,
      testLogPath: '/tmp/wt/test.log',
      timedOut: false,
      failureCount: 0,
    };
  }

  function promptWith(overrides: Partial<Parameters<typeof buildJudgePrompt>[0]['candidates']> = {}) {
    return buildJudgePrompt({
      phase: basePhase,
      candidates: {
        primary: {
          label: 'Primary',
          provider: 'codex',
          model: 'primary-model-under-test',
          diff: 'PRIMARY_DIFF_MARKER',
          testResult: pass(),
          ...overrides.primary,
        },
        secondary: {
          label: 'Secondary',
          provider: 'claude',
          model: 'secondary-model-under-test',
          diff: 'SECONDARY_DIFF_MARKER',
          testResult: pass(),
          ...overrides.secondary,
        },
      },
    });
  }

  it('contains the WINNER format instructions', () => {
    const prompt = promptWith();
    expect(prompt).toContain('WINNER:');
    expect(prompt).toContain('WINNER: primary');
    expect(prompt).toContain('REASONING:');
  });

  it('contains primary and secondary sections with provider/model metadata and diffs', () => {
    const prompt = promptWith();
    expect(prompt).toMatch(/Primary implementor \(codex:primary-model-under-test\)[\s\S]*PRIMARY_DIFF_MARKER/);
    expect(prompt).toMatch(/Secondary implementor \(claude:secondary-model-under-test\)[\s\S]*SECONDARY_DIFF_MARKER/);
  });

  it('reflects test exit codes for each implementor', () => {
    const prompt = promptWith({
      primary: { testResult: { ...pass(), testExitCode: 0 } },
      secondary: { testResult: { ...pass(), testExitCode: 1, failureCount: 3 } },
    });
    expect(prompt).toMatch(/exit/i);
    expect(prompt.toLowerCase()).toMatch(/0/);
    expect(prompt.toLowerCase()).toMatch(/1/);
  });

  it('truncates diffs longer than 40000 chars with a [truncated] marker', () => {
    const hugeDiff = 'x'.repeat(40001);
    const prompt = promptWith({
      primary: { diff: hugeDiff },
      secondary: { diff: 'short' },
    });
    expect(prompt).toContain('[...truncated');
    expect(prompt).toContain('x'.repeat(40000));
    expect(prompt).not.toContain('x'.repeat(40001));
  });

  it('fmtFixIter: undefined omits fix iteration text from prompt', () => {
    const prompt = promptWith();
    expect(prompt).not.toContain('Fix iterations:');
    expect(prompt).not.toContain('Fix loop:');
  });

  it('fmtFixIter: null emits fix loop not run message', () => {
    const prompt = promptWith({
      primary: { fixIterations: null },
      secondary: { fixIterations: null },
    });
    expect(prompt).toContain('Fix loop: not run');
  });

  it('fmtFixIter: 0 emits passed on first try', () => {
    const prompt = promptWith({
      primary: { fixIterations: 0 },
      secondary: { fixIterations: 0 },
    });
    expect(prompt).toContain('passed on first try');
  });

  it('fmtFixIter: N>0 emits required N fix passes', () => {
    const prompt = promptWith({
      primary: { fixIterations: 3 },
      secondary: { fixIterations: 1 },
    });
    expect(prompt).toContain('required 3 fix passes');
    expect(prompt).toContain('required 1 fix pass');
  });

  it('injects primary fix history section into prompt when provided', () => {
    const history = '--- Fix iteration 1 ---\nTestFailed: expected x got y';
    const prompt = promptWith({
      primary: { fixIterations: 1, fixHistory: history },
    });
    expect(prompt).toContain('Primary fix history');
    expect(prompt).toContain('TestFailed');
  });

  it('injects secondary fix history section into prompt when provided', () => {
    const history = '--- Fix iteration 1 ---\nAssertionError: expected 0 got 1';
    const prompt = promptWith({
      secondary: { fixIterations: 1, fixHistory: history },
    });
    expect(prompt).toContain('Secondary fix history');
    expect(prompt).toContain('AssertionError');
  });

  it('omits fix history section heading when fix history is absent', () => {
    const prompt = promptWith();
    expect(prompt).not.toContain('## Primary fix history');
    expect(prompt).not.toContain('## Secondary fix history');
  });

  it('includes HARDENING format instruction in verdict section', () => {
    const prompt = promptWith();
    expect(prompt).toContain('HARDENING:');
  });
});
