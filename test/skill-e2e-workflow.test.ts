import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-workflow');

// --- Document-Release skill E2E ---

describeIfSelected('Document-Release skill E2E', ['document-release'], () => {
  let docReleaseDir: string;

  beforeAll(() => {
    docReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-doc-release-'));

    // Copy document-release skill files
    copyDirSync(path.join(ROOT, 'document-release'), path.join(docReleaseDir, 'document-release'));

    // Init git repo with initial docs
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: docReleaseDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create initial README with a features list
    fs.writeFileSync(path.join(docReleaseDir, 'README.md'),
      '# Test Project\n\n## Features\n\n- Feature A\n- Feature B\n\n## Install\n\n```bash\nnpm install\n```\n');

    // Create initial CHANGELOG that must NOT be clobbered
    fs.writeFileSync(path.join(docReleaseDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 1.0.0 — 2026-03-01\n\n- Initial release with Feature A and Feature B\n- Setup CI pipeline\n');

    // Create VERSION file (already bumped)
    fs.writeFileSync(path.join(docReleaseDir, 'VERSION'), '1.1.0\n');

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Create feature branch with a code change
    run('git', ['checkout', '-b', 'feat/add-feature-c']);
    fs.writeFileSync(path.join(docReleaseDir, 'feature-c.ts'), 'export function featureC() { return "C"; }\n');
    fs.writeFileSync(path.join(docReleaseDir, 'VERSION'), '1.1.1\n');
    fs.writeFileSync(path.join(docReleaseDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 1.1.1 — 2026-03-16\n\n- Added Feature C\n\n## 1.0.0 — 2026-03-01\n\n- Initial release with Feature A and Feature B\n- Setup CI pipeline\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: add feature C']);
  });

  afterAll(() => {
    try { fs.rmSync(docReleaseDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('document-release', async () => {
    const result = await runSkillTest({
      prompt: `Read the file document-release/SKILL.md for the document-release workflow instructions.

Run the /document-release workflow on this repo. The base branch is "main".

IMPORTANT:
- Do NOT use AskUserQuestion — auto-approve everything or skip if unsure.
- Do NOT push or create PRs (there is no remote).
- Do NOT run gh commands (no remote).
- Focus on updating README.md to reflect the new Feature C.
- Do NOT overwrite or regenerate CHANGELOG entries.
- Skip VERSION bump (it's already bumped).
- After editing, just commit the changes locally.`,
      workingDirectory: docReleaseDir,
      maxTurns: 30,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 180_000,
      testName: 'document-release',
      runId,
    });

    logCost('/document-release', result);

    // Read CHANGELOG to verify it was NOT clobbered
    const changelog = fs.readFileSync(path.join(docReleaseDir, 'CHANGELOG.md'), 'utf-8');
    const hasOriginalEntries = changelog.includes('Initial release with Feature A and Feature B')
      && changelog.includes('Setup CI pipeline')
      && changelog.includes('1.0.0');
    if (!hasOriginalEntries) {
      console.warn('CHANGELOG CLOBBERED — original entries missing!');
    }

    // Check if README was updated
    const readme = fs.readFileSync(path.join(docReleaseDir, 'README.md'), 'utf-8');
    const readmeUpdated = readme.includes('Feature C') || readme.includes('feature-c') || readme.includes('feature C');

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);
    recordE2E(evalCollector, '/document-release', 'Document-Release skill E2E', result, {
      passed: exitOk && hasOriginalEntries,
    });

    // Critical guardrail: CHANGELOG must not be clobbered
    expect(hasOriginalEntries).toBe(true);

    // Accept error_max_turns — thorough doc review is not a failure
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    // Informational: did it update README?
    if (readmeUpdated) {
      console.log('README updated to include Feature C');
    } else {
      console.warn('README was NOT updated — agent may not have found the feature');
    }
  }, 240_000);
});

// --- Ship workflow with local bare remote ---

describeIfSelected('Ship workflow E2E', ['ship-local-workflow'], () => {
  let shipWorkDir: string;
  let shipRemoteDir: string;

  beforeAll(() => {
    shipRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-remote-'));
    shipWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-work-'));

    // Create bare remote
    spawnSync('git', ['init', '--bare'], { cwd: shipRemoteDir, stdio: 'pipe' });

    // Clone it as working repo
    spawnSync('git', ['clone', shipRemoteDir, shipWorkDir], { stdio: 'pipe' });

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: shipWorkDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Initial commit on main
    fs.writeFileSync(path.join(shipWorkDir, 'app.ts'), 'console.log("v1");\n');
    fs.writeFileSync(path.join(shipWorkDir, 'VERSION'), '0.1.0.0\n');
    fs.writeFileSync(path.join(shipWorkDir, 'CHANGELOG.md'), '# Changelog\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
    run('git', ['push', '-u', 'origin', 'main']);

    // Feature branch
    run('git', ['checkout', '-b', 'feature/ship-test']);
    fs.writeFileSync(path.join(shipWorkDir, 'app.ts'), 'console.log("v2");\n');
    run('git', ['add', 'app.ts']);
    run('git', ['commit', '-m', 'feat: update to v2']);

  });

  afterAll(() => {
    try { fs.rmSync(shipWorkDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(shipRemoteDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('ship-local-workflow', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/ship-test. Do these steps in order:
1. Read VERSION file and bump the last digit by 1 (e.g. 0.1.0.0 → 0.1.0.1). Write the new version back.
2. Add a CHANGELOG.md entry: "## [NEW_VERSION] - TODAY" with a bullet "- Ship test feature".
3. Stage all changes, commit with message "ship: vNEW_VERSION".
4. Push to origin: git push origin feature/ship-test`,
      workingDirectory: shipWorkDir,
      maxTurns: 8,
      timeout: 120_000,
      testName: 'ship-local-workflow',
      runId,
    });

    logCost('/ship local workflow', result);

    // Check push succeeded
    const remoteLog = spawnSync('git', ['log', '--oneline'], { cwd: shipRemoteDir, stdio: 'pipe' });
    const remoteCommits = remoteLog.stdout.toString().trim().split('\n').length;

    // Check VERSION was bumped
    const versionContent = fs.existsSync(path.join(shipWorkDir, 'VERSION'))
      ? fs.readFileSync(path.join(shipWorkDir, 'VERSION'), 'utf-8').trim() : '';
    const versionBumped = versionContent !== '0.1.0.0';

    recordE2E(evalCollector, '/ship local workflow', 'Ship workflow E2E', result, {
      passed: remoteCommits > 1 && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(remoteCommits).toBeGreaterThan(1);
    console.log(`Remote commits: ${remoteCommits}, VERSION: ${versionContent}, bumped: ${versionBumped}`);
  }, 150_000);
});

// --- Browser cookie detection smoke test ---

describeIfSelected('Setup Browser Cookies E2E', ['setup-cookies-detect'], () => {
  let cookieDir: string;

  beforeAll(() => {
    cookieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-cookies-'));
    // Copy skill files
    fs.mkdirSync(path.join(cookieDir, 'setup-browser-cookies'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'setup-browser-cookies', 'SKILL.md'),
      path.join(cookieDir, 'setup-browser-cookies', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(cookieDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('setup-cookies-detect', async () => {
    const result = await runSkillTest({
      prompt: `Read setup-browser-cookies/SKILL.md for the cookie import workflow.

This is a test environment. List which browsers you can detect on this system by checking for their cookie database files.
Write the detected browsers to ${cookieDir}/detected-browsers.md.
Do NOT launch the cookie picker UI — just detect and report.`,
      workingDirectory: cookieDir,
      maxTurns: 5,
      timeout: 45_000,
      testName: 'setup-cookies-detect',
      runId,
    });

    logCost('/setup-browser-cookies detect', result);

    const detectPath = path.join(cookieDir, 'detected-browsers.md');
    const detectExists = fs.existsSync(detectPath);
    const detectContent = detectExists ? fs.readFileSync(detectPath, 'utf-8') : '';
    const hasBrowserName = /chrome|arc|brave|edge|comet|safari|firefox/i.test(detectContent);

    recordE2E(evalCollector, '/setup-browser-cookies detect', 'Setup Browser Cookies E2E', result, {
      passed: detectExists && hasBrowserName && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(detectExists).toBe(true);
    if (detectExists) {
      expect(hasBrowserName).toBe(true);
    }
  }, 60_000);
});

// --- gstack-upgrade E2E ---

describeIfSelected('gstack-upgrade E2E', ['gstack-upgrade-happy-path'], () => {
  let upgradeDir: string;
  let remoteDir: string;

  beforeAll(() => {
    upgradeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-upgrade-'));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-remote-'));

    const run = (cmd: string, args: string[], cwd: string) =>
      spawnSync(cmd, args, { cwd, stdio: 'pipe', timeout: 5000 });

    // Init the "project" repo
    run('git', ['init'], upgradeDir);
    run('git', ['config', 'user.email', 'test@test.com'], upgradeDir);
    run('git', ['config', 'user.name', 'Test'], upgradeDir);

    // Create mock gstack install directory (local-git type)
    const mockGstack = path.join(upgradeDir, '.claude', 'skills', 'gstack');
    fs.mkdirSync(mockGstack, { recursive: true });

    // Init as a git repo
    run('git', ['init'], mockGstack);
    run('git', ['config', 'user.email', 'test@test.com'], mockGstack);
    run('git', ['config', 'user.name', 'Test'], mockGstack);

    // Create bare remote
    run('git', ['init', '--bare'], remoteDir);
    run('git', ['remote', 'add', 'origin', remoteDir], mockGstack);

    // Write old version files
    fs.writeFileSync(path.join(mockGstack, 'VERSION'), '0.5.0\n');
    fs.writeFileSync(path.join(mockGstack, 'CHANGELOG.md'),
      '# Changelog\n\n## 0.5.0 — 2026-03-01\n\n- Initial release\n');
    fs.writeFileSync(path.join(mockGstack, 'setup'),
      '#!/bin/bash\necho "Setup completed"\n', { mode: 0o755 });

    // Initial commit + push
    run('git', ['add', '.'], mockGstack);
    run('git', ['commit', '-m', 'initial'], mockGstack);
    run('git', ['push', '-u', 'origin', 'HEAD:main'], mockGstack);

    // Create new version (simulate upstream release)
    fs.writeFileSync(path.join(mockGstack, 'VERSION'), '0.6.0\n');
    fs.writeFileSync(path.join(mockGstack, 'CHANGELOG.md'),
      '# Changelog\n\n## 0.6.0 — 2026-03-15\n\n- New feature: interactive design review\n- Fix: snapshot flag validation\n\n## 0.5.0 — 2026-03-01\n\n- Initial release\n');
    run('git', ['add', '.'], mockGstack);
    run('git', ['commit', '-m', 'release 0.6.0'], mockGstack);
    run('git', ['push', 'origin', 'HEAD:main'], mockGstack);

    // Reset working copy back to old version
    run('git', ['reset', '--hard', 'HEAD~1'], mockGstack);

    // Copy gstack-upgrade skill
    fs.mkdirSync(path.join(upgradeDir, 'gstack-upgrade'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'gstack-upgrade', 'SKILL.md'),
      path.join(upgradeDir, 'gstack-upgrade', 'SKILL.md'),
    );

    // Commit so git repo is clean
    run('git', ['add', '.'], upgradeDir);
    run('git', ['commit', '-m', 'initial project'], upgradeDir);
  });

  afterAll(() => {
    try { fs.rmSync(upgradeDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(remoteDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('gstack-upgrade-happy-path', async () => {
    const mockGstack = path.join(upgradeDir, '.claude', 'skills', 'gstack');
    const result = await runSkillTest({
      prompt: `Read gstack-upgrade/SKILL.md for the upgrade workflow.

You are running /gstack-upgrade standalone. The gstack installation is at ./.claude/skills/gstack (local-git type — it has a .git directory with an origin remote).

Current version: 0.5.0. A new version 0.6.0 is available on origin/main.

Follow the standalone upgrade flow:
1. Detect install type (local-git)
2. Run git fetch origin && git reset --hard origin/main in the install directory
3. Run the setup script
4. Show what's new from CHANGELOG

Skip any AskUserQuestion calls — auto-approve the upgrade. Write a summary of what you did to stdout.

IMPORTANT: The install directory is at ./.claude/skills/gstack — use that exact path.`,
      workingDirectory: upgradeDir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'gstack-upgrade-happy-path',
      runId,
    });

    logCost('/gstack-upgrade happy path', result);

    // Check that the version was updated
    const versionAfter = fs.readFileSync(path.join(mockGstack, 'VERSION'), 'utf-8').trim();
    const output = result.output || '';
    const mentionsUpgrade = output.toLowerCase().includes('0.6.0') ||
      output.toLowerCase().includes('upgrade') ||
      output.toLowerCase().includes('updated');

    recordE2E(evalCollector, '/gstack-upgrade happy path', 'gstack-upgrade E2E', result, {
      passed: versionAfter === '0.6.0' && ['success', 'error_max_turns'].includes(result.exitReason),
    });

    expect(['success', 'error_max_turns']).toContain(result.exitReason);
    expect(versionAfter).toBe('0.6.0');
  }, 240_000);
});

// --- Test Coverage Audit E2E ---

describeIfSelected('Test Coverage Audit E2E', ['ship-coverage-audit'], () => {
  let coverageDir: string;

  beforeAll(() => {
    coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-coverage-'));

    // Copy ship skill files
    copyDirSync(path.join(ROOT, 'ship'), path.join(coverageDir, 'ship'));
    copyDirSync(path.join(ROOT, 'review'), path.join(coverageDir, 'review'));

    // Create a Node.js project WITH test framework but coverage gaps
    fs.writeFileSync(path.join(coverageDir, 'package.json'), JSON.stringify({
      name: 'test-coverage-app',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'echo "no tests yet"' },
      devDependencies: { vitest: '^1.0.0' },
    }, null, 2));

    // Create vitest config
    fs.writeFileSync(path.join(coverageDir, 'vitest.config.ts'),
      `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n`);

    fs.writeFileSync(path.join(coverageDir, 'VERSION'), '0.1.0.0\n');
    fs.writeFileSync(path.join(coverageDir, 'CHANGELOG.md'), '# Changelog\n');

    // Create source file with multiple code paths
    fs.mkdirSync(path.join(coverageDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(coverageDir, 'src', 'billing.ts'), `
export function processPayment(amount: number, currency: string) {
  if (amount <= 0) throw new Error('Invalid amount');
  if (currency !== 'USD' && currency !== 'EUR') throw new Error('Unsupported currency');
  return { status: 'success', amount, currency };
}

export function refundPayment(paymentId: string, reason: string) {
  if (!paymentId) throw new Error('Payment ID required');
  if (!reason) throw new Error('Reason required');
  return { status: 'refunded', paymentId, reason };
}
`);

    // Create a test directory with ONE test (partial coverage)
    fs.mkdirSync(path.join(coverageDir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(coverageDir, 'test', 'billing.test.ts'), `
import { describe, test, expect } from 'vitest';
import { processPayment } from '../src/billing';

describe('processPayment', () => {
  test('processes valid payment', () => {
    const result = processPayment(100, 'USD');
    expect(result.status).toBe('success');
  });
  // GAP: no test for invalid amount
  // GAP: no test for unsupported currency
  // GAP: refundPayment not tested at all
});
`);

    // Init git repo with main branch
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: coverageDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial commit']);

    // Create feature branch
    run('git', ['checkout', '-b', 'feature/billing']);
  });

  afterAll(() => {
    try { fs.rmSync(coverageDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('ship-coverage-audit', async () => {
    const result = await runSkillTest({
      prompt: `Read the file ship/SKILL.md for the ship workflow instructions.

You are on the feature/billing branch. The base branch is main.
This is a test project — there is no remote, no PR to create.

ONLY run Step 3.4 (Test Coverage Audit) from the ship workflow.
Skip all other steps (tests, evals, review, version, changelog, commit, push, PR).

The source code is in ${coverageDir}/src/billing.ts.
Existing tests are in ${coverageDir}/test/billing.test.ts.
The test command is: echo "tests pass" (mocked — just pretend tests pass).

Produce the ASCII coverage diagram showing which code paths are tested and which have gaps.
Do NOT generate new tests — just produce the diagram and coverage summary.
Output the diagram directly.`,
      workingDirectory: coverageDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      timeout: 120_000,
      testName: 'ship-coverage-audit',
      runId,
    });

    logCost('/ship coverage audit', result);
    recordE2E(evalCollector, '/ship Step 3.4 coverage audit', 'Test Coverage Audit E2E', result, {
      passed: result.exitReason === 'success',
    });

    expect(result.exitReason).toBe('success');

    // Check output contains coverage diagram elements
    const output = result.output || '';
    const hasGap = output.includes('GAP') || output.includes('gap') || output.includes('NO TEST');
    const hasTested = output.includes('TESTED') || output.includes('tested') || output.includes('✓');
    const hasCoverage = output.includes('COVERAGE') || output.includes('coverage') || output.includes('paths tested');

    console.log(`Output has GAP markers: ${hasGap}`);
    console.log(`Output has TESTED markers: ${hasTested}`);
    console.log(`Output has coverage summary: ${hasCoverage}`);

    // At minimum, the agent should have read the source and test files
    const readCalls = result.toolCalls.filter(tc => tc.tool === 'Read');
    expect(readCalls.length).toBeGreaterThan(0);
  }, 180_000);
});

// --- Codex skill E2E ---

describeIfSelected('Codex skill E2E', ['codex-review'], () => {
  let codexDir: string;

  beforeAll(() => {
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-codex-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: codexDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Commit a clean base on main
    fs.writeFileSync(path.join(codexDir, 'app.rb'), '# clean base\nclass App\nend\n');
    run('git', ['add', 'app.rb']);
    run('git', ['commit', '-m', 'initial commit']);

    // Create feature branch with vulnerable code (reuse review fixture)
    run('git', ['checkout', '-b', 'feature/add-vuln']);
    const vulnContent = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-vuln.rb'), 'utf-8');
    fs.writeFileSync(path.join(codexDir, 'user_controller.rb'), vulnContent);
    run('git', ['add', 'user_controller.rb']);
    run('git', ['commit', '-m', 'add vulnerable controller']);

    // Copy the codex skill file
    fs.copyFileSync(path.join(ROOT, 'codex', 'SKILL.md'), path.join(codexDir, 'codex-SKILL.md'));
  });

  afterAll(() => {
    try { fs.rmSync(codexDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('codex-review', async () => {
    // Check codex is available — skip if not installed
    const codexCheck = spawnSync('which', ['codex'], { stdio: 'pipe', timeout: 3000 });
    if (codexCheck.status !== 0) {
      console.warn('codex CLI not installed — skipping E2E test');
      return;
    }

    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/add-vuln with changes against main.
Read codex-SKILL.md for the /codex skill instructions.
Run /codex review to review the current diff against main.
Write the full output (including the GATE verdict) to ${codexDir}/codex-output.md`,
      workingDirectory: codexDir,
      maxTurns: 15,
      timeout: 300_000,
      testName: 'codex-review',
      runId,
      model: 'claude-opus-4-6',
    });

    logCost('/codex review', result);
    recordE2E(evalCollector, '/codex review', 'Codex skill E2E', result);
    expect(result.exitReason).toBe('success');

    // Check that output file was created with review content
    const outputPath = path.join(codexDir, 'codex-output.md');
    if (fs.existsSync(outputPath)) {
      const output = fs.readFileSync(outputPath, 'utf-8');
      // Should contain the CODEX SAYS header or GATE verdict
      const hasCodexOutput = output.includes('CODEX') || output.includes('GATE') || output.includes('codex');
      expect(hasCodexOutput).toBe(true);
    }
  }, 360_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
