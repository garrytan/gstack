import { test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, describeIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-build');

describeIfSelected('Build skill E2E', ['build-skill-cli-handoff'], () => {
  let workDir: string;
  let planFile: string;
  let shimPath: string;
  let handoffLog: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-build-'));
    planFile = path.join(workDir, 'implementation-plan.md');
    shimPath = path.join(workDir, 'fake-gstack-build');
    handoffLog = path.join(workDir, 'handoff.log');

    spawnSync('git', ['init', '-b', 'main'], { cwd: workDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, stdio: 'pipe' });

    fs.writeFileSync(
      path.join(workDir, 'README.md'),
      '# Build handoff fixture\n',
    );
    fs.writeFileSync(
      planFile,
      `# Build Handoff Plan

## Feature 1: Handoff

### Phase 1.1: Tiny change
- [ ] **Test Specification (Gemini Sub-agent)**: Write a failing test.
- [ ] **Implementation (Gemini Sub-agent)**: Make the test pass.
- [ ] **Review & QA (Codex Sub-agent)**: Review the change.
`,
    );
    fs.writeFileSync(
      shimPath,
      `#!/usr/bin/env bash
set -euo pipefail
{
  echo "PWD=$PWD"
  i=0
  for arg in "$@"; do
    echo "ARG[$i]=$arg"
    i=$((i + 1))
  done
} > "$GSTACK_BUILD_HANDOFF_LOG"
exit 0
`,
      { mode: 0o755 },
    );

    spawnSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: workDir, stdio: 'pipe' });
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  test('build-skill-cli-handoff', async () => {
    const result = await runSkillTest({
      prompt: `Read ${path.join(ROOT, 'build', 'SKILL.md')} for the /build workflow.

This is an E2E handoff test, not a real build. The implementation plan has already been located at:
${planFile}

Follow only the CLI launch portion of the /build skill:
- Do not synthesize a living plan.
- Do not invoke any model subagents.
- Do not use AskUserQuestion.
- Do not edit source files or the plan.
- Use GSTACK_BUILD_CLI from the environment.
- Invoke it with the plan file and --project-root set to the current git repo root.
- Stop after the CLI command exits and report that the handoff happened.`,
      workingDirectory: workDir,
      maxTurns: 8,
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'build-skill-cli-handoff',
      runId,
      env: {
        GSTACK_BUILD_CLI: shimPath,
        GSTACK_BUILD_HANDOFF_LOG: handoffLog,
        GSTACK_HOME: path.join(workDir, '.gstack'),
      },
    });

    logCost('/build cli handoff', result);

    const log = fs.existsSync(handoffLog)
      ? fs.readFileSync(handoffLog, 'utf-8')
      : '';
    const handoffOk = log.includes(`ARG[0]=${planFile}`)
      && log.includes('ARG[1]=--project-root')
      && log.includes(`ARG[2]=${workDir}`)
      && !fs.existsSync(path.join(workDir, 'src'));

    recordE2E(evalCollector, '/build cli handoff', 'Build skill E2E', result, {
      passed: handoffOk && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(log).toContain(`ARG[0]=${planFile}`);
    expect(log).toContain('ARG[1]=--project-root');
    expect(log).toContain(`ARG[2]=${workDir}`);
    expect(fs.existsSync(path.join(workDir, 'src'))).toBe(false);
  }, 150_000);
});

afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
