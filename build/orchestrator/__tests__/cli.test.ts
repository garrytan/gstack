import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildGeminiTestSpecPrompt,
  buildCodexImplPromptBody,
  buildCodexReviewBody,
  buildJudgePrompt,
  buildContextSaveBody,
  parseArgs,
  validateRoleProviders,
  resolveProjectRoot,
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

  it('parseArgs([plan, --dual-impl]) sets dualImpl=true', () => {
    const args = parseArgs(['plan.md', '--dual-impl']);
    expect(args.dualImpl).toBe(true);
  });

  it('parseArgs default -> dualImpl=false', () => {
    const args = parseArgs(['plan.md']);
    expect(args.dualImpl).toBe(false);
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
    const args = parseArgs(['plan.md', '--gemini-model', 'gemini-3.1-pro-preview']);
    expect(args.geminiModel).toBe('gemini-3.1-pro-preview');
  });

  it('parseArgs with --codex-model sets codexModel', () => {
    const args = parseArgs(['plan.md', '--codex-model', 'gpt-5.4']);
    expect(args.codexModel).toBe('gpt-5.4');
  });

  it('parseArgs default -> model defaults are baked in (no flags needed)', () => {
    const args = parseArgs(['plan.md']);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(DEFAULT_ROLE_CONFIGS.reviewSecondary.model);
    expect(args.roles.testWriter).toEqual(DEFAULT_ROLE_CONFIGS.testWriter);
    expect(args.roles.testFixer).toEqual(DEFAULT_ROLE_CONFIGS.testFixer);
    expect(args.roles.ship).toEqual(DEFAULT_ROLE_CONFIGS.ship);
  });

  it('--codex-review-model overrides the review model default', () => {
    const args = parseArgs(['plan.md', '--codex-review-model', 'gpt-5.4']);
    expect(args.codexReviewModel).toBe('gpt-5.4');
  });

  it('--help text mentions --codex-review-model', () => {
    expect(HELP_TEXT).toContain('--codex-review-model');
  });

  it('parseArgs accepts all three model flags together', () => {
    const args = parseArgs([
      'plan.md',
      '--gemini-model', 'gemini-3.2-pro',
      '--codex-model', 'gpt-5.3-codex',
      '--codex-review-model', 'gpt-5.4',
    ]);
    expect(args.geminiModel).toBe('gemini-3.2-pro');
    expect(args.codexModel).toBe('gpt-5.3-codex');
    expect(args.codexReviewModel).toBe('gpt-5.4');
  });

  it('parseArgs model flags combine correctly with --dual-impl', () => {
    const args = parseArgs(['plan.md', '--dual-impl']);
    expect(args.dualImpl).toBe(true);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(DEFAULT_ROLE_CONFIGS.reviewSecondary.model);
  });

  it('new role flags override defaults', () => {
    const args = parseArgs([
      'plan.md',
      '--review-secondary-model', 'claude-custom',
      '--review-secondary-command', '/custom second opinion',
      '--ship-model', 'gpt-5.4',
      '--ship-reasoning', 'medium',
    ]);
    expect(args.roles.reviewSecondary.model).toBe('claude-custom');
    expect(args.roles.reviewSecondary.command).toBe('/custom second opinion');
    expect(args.roles.ship.model).toBe('gpt-5.4');
    expect(args.roles.ship.reasoning).toBe('medium');
  });

  it('--project-root resolves to an absolute path', () => {
    const args = parseArgs(['plan.md', '--project-root', '.']);
    expect(path.isAbsolute(args.projectRoot!)).toBe(true);
  });

  it('provider validation rejects unsupported slash-command and dual-impl providers', () => {
    const args = parseArgs(['plan.md', '--dual-impl']);
    args.roles.qa.provider = 'gemini';
    args.roles.contextSave.provider = 'gemini';
    args.roles.primaryImpl.provider = 'codex';
    args.roles.secondaryImpl.provider = 'claude';
    args.roles.judge.provider = 'codex';

    expect(validateRoleProviders(args)).toEqual([
      '--qa-provider gemini is not supported for slash-command gates',
      '--context-save-provider gemini is not supported for slash-command roles',
      '--primary-impl-provider must be gemini when --dual-impl is enabled',
      '--secondary-impl-provider must be codex when --dual-impl is enabled',
      '--judge-provider must be claude when --dual-impl is enabled',
    ]);
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

describe('buildCodexImplPromptBody (dual-impl Codex implementation prompt)', () => {
  it('contains "implement"', () => {
    const body = buildCodexImplPromptBody(basePhase, 'plan.md');
    expect(body.toLowerCase()).toMatch(/implement/);
  });

  it('contains "do NOT change test assertions"', () => {
    const body = buildCodexImplPromptBody(basePhase, 'plan.md');
    expect(body).toMatch(/do NOT change test assertions/i);
  });

  it('contains the phase name and plan file', () => {
    const body = buildCodexImplPromptBody(basePhase, 'plan.md');
    expect(body).toContain(basePhase.name);
    expect(body).toContain('plan.md');
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

  it('contains the WINNER format instructions', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'diff --git a/foo b/foo\n+gemini code',
      codexDiff: 'diff --git a/foo b/foo\n+codex code',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).toContain('WINNER:');
    expect(prompt).toContain('REASONING:');
  });

  it('contains both Gemini and Codex sections with their diffs', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'GEMINI_DIFF_MARKER',
      codexDiff: 'CODEX_DIFF_MARKER',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).toMatch(/Gemini[\s\S]*GEMINI_DIFF_MARKER/);
    expect(prompt).toMatch(/Codex[\s\S]*CODEX_DIFF_MARKER/);
  });

  it('reflects test exit codes for each implementor', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: { ...pass(), testExitCode: 0 },
      codexTestResult: { ...pass(), testExitCode: 1, failureCount: 3 },
    });
    expect(prompt).toMatch(/exit/i);
    expect(prompt.toLowerCase()).toMatch(/0/);
    expect(prompt.toLowerCase()).toMatch(/1/);
  });

  it('truncates diffs longer than 40000 chars with a [truncated] marker', () => {
    const hugeDiff = 'x'.repeat(40001);
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: hugeDiff,
      codexDiff: 'short',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).toContain('[...truncated');
    expect(prompt).toContain('x'.repeat(40000));
    expect(prompt).not.toContain('x'.repeat(40001));
  });

  it('fmtFixIter: undefined omits fix iteration text from prompt', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).not.toContain('Fix iterations:');
    expect(prompt).not.toContain('Fix loop:');
  });

  it('fmtFixIter: null emits fix loop not run message', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
      geminiFixIterations: null,
      codexFixIterations: null,
    });
    expect(prompt).toContain('Fix loop: not run');
  });

  it('fmtFixIter: 0 emits passed on first try', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
      geminiFixIterations: 0,
      codexFixIterations: 0,
    });
    expect(prompt).toContain('passed on first try');
  });

  it('fmtFixIter: N>0 emits required N fix passes', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
      geminiFixIterations: 3,
      codexFixIterations: 1,
    });
    expect(prompt).toContain('required 3 fix passes');
    expect(prompt).toContain('required 1 fix pass');
  });

  it('injects geminiFixHistory section into prompt when provided', () => {
    const history = '--- Fix iteration 1 ---\nTestFailed: expected x got y';
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
      geminiFixIterations: 1,
      geminiFixHistory: history,
    });
    expect(prompt).toContain('Gemini fix history');
    expect(prompt).toContain('TestFailed');
  });

  it('injects codexFixHistory section into prompt when provided', () => {
    const history = '--- Fix iteration 1 ---\nAssertionError: expected 0 got 1';
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
      codexFixIterations: 1,
      codexFixHistory: history,
    });
    expect(prompt).toContain('Codex fix history');
    expect(prompt).toContain('AssertionError');
  });

  it('omits fix history section heading when geminiFixHistory is absent', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).not.toContain('## Gemini fix history');
    expect(prompt).not.toContain('## Codex fix history');
  });

  it('includes HARDENING format instruction in verdict section', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).toContain('HARDENING:');
  });
});
