import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { startTestServer } from '../browse/test/test-server';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-browse');

let testServer: ReturnType<typeof startTestServer>;
let tmpDir: string;

describeIfSelected('Skill E2E tests', [
  'browse-basic', 'browse-snapshot', 'skillmd-setup-discovery',
  'skillmd-no-local-binary', 'skillmd-outside-git', 'session-awareness',
], () => {
  beforeAll(() => {
    testServer = startTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-'));
    setupBrowseShims(tmpDir);
  });

  afterAll(() => {
    testServer?.server?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('browse-basic', async () => {
    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable and run these commands in sequence:
1. $B goto ${testServer.url}
2. $B snapshot -i
3. $B text
4. $B screenshot /tmp/skill-e2e-test.png
Report the results of each command.`,
      workingDirectory: tmpDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'browse-basic',
      runId,
    });

    logCost('browse basic', result);
    recordE2E(evalCollector, 'browse basic commands', 'Skill E2E tests', result);
    expect(result.browseErrors).toHaveLength(0);
    expect(result.exitReason).toBe('success');
  }, 90_000);

  testConcurrentIfSelected('browse-snapshot', async () => {
    const result = await runSkillTest({
      prompt: `You have a browse binary at ${browseBin}. Assign it to B variable and run:
1. $B goto ${testServer.url}
2. $B snapshot -i
3. $B snapshot -c
4. $B snapshot -D
5. $B snapshot -i -a -o /tmp/skill-e2e-annotated.png
Report what each command returned.`,
      workingDirectory: tmpDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'browse-snapshot',
      runId,
    });

    logCost('browse snapshot', result);
    recordE2E(evalCollector, 'browse snapshot flags', 'Skill E2E tests', result);
    // browseErrors can include false positives from hallucinated paths (e.g. "baltimore" vs "bangalore")
    if (result.browseErrors.length > 0) {
      console.warn('Browse errors (non-fatal):', result.browseErrors);
    }
    expect(result.exitReason).toBe('success');
  }, 90_000);

  testConcurrentIfSelected('skillmd-setup-discovery', async () => {
    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const setupStart = skillMd.indexOf('## SETUP');
    const setupEnd = skillMd.indexOf('## IMPORTANT');
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    // Guard: verify we extracted a valid setup block
    expect(setupBlock).toContain('browse/dist/browse');

    const result = await runSkillTest({
      prompt: `Follow these instructions to find the browse binary and run a basic command.

${setupBlock}

After finding the binary, run: $B goto ${testServer.url}
Then run: $B text
Report whether it worked.`,
      workingDirectory: tmpDir,
      maxTurns: 10,
      timeout: 60_000,
      testName: 'skillmd-setup-discovery',
      runId,
    });

    recordE2E(evalCollector, 'SKILL.md setup block discovery', 'Skill E2E tests', result);
    expect(result.browseErrors).toHaveLength(0);
    expect(result.exitReason).toBe('success');
  }, 90_000);

  testConcurrentIfSelected('skillmd-no-local-binary', async () => {
    // Create a tmpdir with no browse binary — no local .claude/skills/gstack/browse/dist/browse
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-empty-'));

    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const setupStart = skillMd.indexOf('## SETUP');
    const setupEnd = skillMd.indexOf('## IMPORTANT');
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    const result = await runSkillTest({
      prompt: `Follow these instructions exactly. Run the bash code block below and report what it outputs.

${setupBlock}

Report the exact output. Do NOT try to fix or install anything — just report what you see.`,
      workingDirectory: emptyDir,
      maxTurns: 5,
      timeout: 30_000,
      testName: 'skillmd-no-local-binary',
      runId,
    });

    // Setup block should either find the global binary (READY) or show NEEDS_SETUP.
    // On dev machines with gstack installed globally, the fallback path
    // ~/.claude/skills/gstack/browse/dist/browse exists, so we get READY.
    // The important thing is it doesn't crash or give a confusing error.
    const allText = result.output || '';
    recordE2E(evalCollector, 'SKILL.md setup block (no local binary)', 'Skill E2E tests', result);
    expect(allText).toMatch(/READY|NEEDS_SETUP/);
    expect(result.exitReason).toBe('success');

    // Clean up
    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
  }, 60_000);

  testConcurrentIfSelected('skillmd-outside-git', async () => {
    // Create a tmpdir outside any git repo
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-nogit-'));

    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const setupStart = skillMd.indexOf('## SETUP');
    const setupEnd = skillMd.indexOf('## IMPORTANT');
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    const result = await runSkillTest({
      prompt: `Follow these instructions exactly. Run the bash code block below and report what it outputs.

${setupBlock}

Report the exact output — either "READY: <path>" or "NEEDS_SETUP".`,
      workingDirectory: nonGitDir,
      maxTurns: 5,
      timeout: 30_000,
      testName: 'skillmd-outside-git',
      runId,
    });

    // Should either find global binary (READY) or show NEEDS_SETUP — not crash
    const allText = result.output || '';
    recordE2E(evalCollector, 'SKILL.md outside git repo', 'Skill E2E tests', result);
    expect(allText).toMatch(/READY|NEEDS_SETUP/);

    // Clean up
    try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch {}
  }, 60_000);

  testConcurrentIfSelected('contributor-mode', async () => {
    const contribDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-contrib-'));
    const logsDir = path.join(contribDir, 'contributor-logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const result = await runSkillTest({
      prompt: `You are in contributor mode (gstack_contributor=true). You just ran this browse command and it failed:

$ /nonexistent/browse goto https://example.com
/nonexistent/browse: No such file or directory

Per the contributor mode instructions, file a field report to ${logsDir}/browse-missing-binary.md using the Write tool. Include all required sections: title, what you tried, what happened, rating, repro steps, raw output, what would make it a 10, and the date/version footer.`,
      workingDirectory: contribDir,
      maxTurns: 5,
      timeout: 30_000,
      testName: 'contributor-mode',
      runId,
    });

    logCost('contributor mode', result);
    // Override passed: this test intentionally triggers a browse error (nonexistent binary)
    // so browseErrors will be non-empty — that's expected, not a failure
    recordE2E(evalCollector, 'contributor mode report', 'Skill E2E tests', result, {
      passed: result.exitReason === 'success',
    });

    // Verify a contributor log was created with expected format
    const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.md'));
    expect(logFiles.length).toBeGreaterThan(0);

    // Verify report has key structural sections (agent may phrase differently)
    const logContent = fs.readFileSync(path.join(logsDir, logFiles[0]), 'utf-8');
    // Must have a title (# heading)
    expect(logContent).toMatch(/^#\s/m);
    // Must mention the failed command or browse
    expect(logContent).toMatch(/browse|nonexistent|not found|no such file/i);
    // Must have some kind of rating
    expect(logContent).toMatch(/rating|\/10/i);
    // Must have steps or reproduction info
    expect(logContent).toMatch(/step|repro|reproduce/i);

    // Clean up
    try { fs.rmSync(contribDir, { recursive: true, force: true }); } catch {}
  }, 90_000);

  testConcurrentIfSelected('session-awareness', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-session-'));

    // Set up a git repo so there's project/branch context to reference
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: sessionDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(sessionDir, 'app.rb'), '# my app\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);
    run('git', ['checkout', '-b', 'feature/add-payments']);
    // Add a remote so the agent can derive a project name
    run('git', ['remote', 'add', 'origin', 'https://github.com/acme/billing-app.git']);

    // Extract AskUserQuestion format instructions from generated SKILL.md
    const skillMd = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const aqStart = skillMd.indexOf('## AskUserQuestion Format');
    const aqEnd = skillMd.indexOf('\n## ', aqStart + 1);
    const aqBlock = skillMd.slice(aqStart, aqEnd > 0 ? aqEnd : undefined);

    const outputPath = path.join(sessionDir, 'question-output.md');

    const result = await runSkillTest({
      prompt: `You are running a gstack skill. The session preamble detected _SESSIONS=4 (the user has 4 gstack windows open).

${aqBlock}

You are on branch feature/add-payments in the billing-app project. You were reviewing a plan to add Stripe integration.

You've hit a decision point: the plan doesn't specify whether to use Stripe Checkout (hosted) or Stripe Elements (embedded). You need to ask the user which approach to use.

Since this is non-interactive, DO NOT actually call AskUserQuestion. Instead, write the EXACT text you would display to the user (the full AskUserQuestion content) to the file: ${outputPath}

Remember: _SESSIONS=4, so ELI16 mode is active. The user is juggling multiple windows and may not remember what this conversation is about. Re-ground them.`,
      workingDirectory: sessionDir,
      maxTurns: 8,
      timeout: 60_000,
      testName: 'session-awareness',
      runId,
    });

    logCost('session awareness', result);
    recordE2E(evalCollector, 'session awareness ELI16', 'Skill E2E tests', result);

    // Verify the output contains ELI16 re-grounding context
    if (fs.existsSync(outputPath)) {
      const output = fs.readFileSync(outputPath, 'utf-8');
      const lower = output.toLowerCase();
      // Must mention project name
      expect(lower.includes('billing') || lower.includes('acme')).toBe(true);
      // Must mention branch
      expect(lower.includes('payment') || lower.includes('feature')).toBe(true);
      // Must mention what we're working on
      expect(lower.includes('stripe') || lower.includes('checkout') || lower.includes('payment')).toBe(true);
      // Must have a RECOMMENDATION
      expect(output).toContain('RECOMMENDATION');
    } else {
      // Check agent output as fallback
      const output = result.output || '';
      expect(output).toContain('RECOMMENDATION');
    }

    // Clean up
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  }, 90_000);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
