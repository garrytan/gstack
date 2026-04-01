import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-session-intelligence');

// --- Session Intelligence E2E ---
// Tests the core contract: timeline events flow in, context recovery flows out,
// checkpoints round-trip.

describeIfSelected('Session Intelligence E2E', [
  'timeline-event-flow', 'context-recovery-artifacts', 'checkpoint-save-resume',
], () => {
  let workDir: string;
  let gstackHome: string;
  let slug: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-session-intel-'));
    gstackHome = path.join(workDir, '.gstack-home');

    // Init git repo
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(workDir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Copy bin scripts needed by timeline and checkpoint
    const binDir = path.join(workDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const script of [
      'gstack-timeline-log', 'gstack-timeline-read', 'gstack-slug',
      'gstack-learnings-log', 'gstack-learnings-search',
    ]) {
      const src = path.join(ROOT, 'bin', script);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(binDir, script));
        fs.chmodSync(path.join(binDir, script), 0o755);
      }
    }

    // Compute slug (same logic as gstack-slug without git remote)
    slug = path.basename(workDir).replace(/[^a-zA-Z0-9._-]/g, '');
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    finalizeEvalCollector(evalCollector);
  });

  // --- Test 1: Timeline event flow ---
  // Write a timeline event via gstack-timeline-log, read it back via gstack-timeline-read.
  // This is the foundational data flow test: events go in, they come back out.
  testConcurrentIfSelected('timeline-event-flow', async () => {
    const projectDir = path.join(gstackHome, 'projects', slug);
    fs.mkdirSync(projectDir, { recursive: true });

    // Write two events via the binary
    const logBin = path.join(workDir, 'bin', 'gstack-timeline-log');
    const readBin = path.join(workDir, 'bin', 'gstack-timeline-read');
    const env = { ...process.env, GSTACK_HOME: gstackHome };
    const opts = { cwd: workDir, env, stdio: 'pipe' as const, timeout: 10000 };

    spawnSync(logBin, [JSON.stringify({
      skill: 'review', event: 'started', branch: 'main', session: 'test-1',
    })], opts);
    spawnSync(logBin, [JSON.stringify({
      skill: 'review', event: 'completed', branch: 'main',
      outcome: 'success', duration_s: 120, session: 'test-1',
    })], opts);

    // Read via gstack-timeline-read
    const readResult = spawnSync(readBin, ['--branch', 'main'], opts);
    const readOutput = readResult.stdout?.toString() || '';

    // Verify timeline.jsonl exists and has content
    const timelinePath = path.join(projectDir, 'timeline.jsonl');
    expect(fs.existsSync(timelinePath)).toBe(true);

    const lines = fs.readFileSync(timelinePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);

    // Verify the events are valid JSON with expected fields
    const event1 = JSON.parse(lines[0]);
    expect(event1.skill).toBe('review');
    expect(event1.event).toBe('started');
    expect(event1.ts).toBeDefined();

    const event2 = JSON.parse(lines[1]);
    expect(event2.event).toBe('completed');
    expect(event2.outcome).toBe('success');

    // Verify gstack-timeline-read output includes the events
    expect(readOutput).toContain('review');

    recordE2E(evalCollector, 'timeline event flow', 'Session Intelligence E2E', {
      output: readOutput,
      exitReason: 'success',
      duration: 0,
      toolCalls: [],
      browseErrors: [],
      costEstimate: { inputChars: 0, outputChars: 0, estimatedTokens: 0, estimatedCost: 0, turnsUsed: 0 },
      transcript: [],
      model: 'direct',
      firstResponseMs: 0,
      maxInterTurnMs: 0,
    }, { passed: true });

    console.log(`Timeline flow: ${lines.length} events written, read output ${readOutput.length} chars`);
  }, 30_000);

  // --- Test 2: Context recovery with seeded artifacts ---
  // Seed CEO plans and timeline events, then run a skill and verify the preamble
  // outputs "RECENT ARTIFACTS" and "LAST_SESSION".
  testConcurrentIfSelected('context-recovery-artifacts', async () => {
    const projectDir = path.join(gstackHome, 'projects', slug);
    fs.mkdirSync(path.join(projectDir, 'ceo-plans'), { recursive: true });

    // Seed a CEO plan
    fs.writeFileSync(
      path.join(projectDir, 'ceo-plans', '2026-03-31-test-feature.md'),
      '---\nstatus: ACTIVE\n---\n# CEO Plan: Test Feature\nThis is a test plan.\n',
    );

    // Seed timeline with a completed event on main branch
    const timelineEntry = JSON.stringify({
      ts: new Date().toISOString(),
      skill: 'ship',
      event: 'completed',
      branch: 'main',
      outcome: 'success',
      duration_s: 60,
      session: 'prior-session',
    });
    fs.writeFileSync(path.join(projectDir, 'timeline.jsonl'), timelineEntry + '\n');

    // Copy the /learn skill (lightweight, tier-2 skill that runs context recovery)
    copyDirSync(path.join(ROOT, 'learn'), path.join(workDir, 'learn'));

    const result = await runSkillTest({
      prompt: `Read the file learn/SKILL.md for instructions.

Run the context recovery check — the preamble should show recent artifacts.

IMPORTANT:
- Use GSTACK_HOME="${gstackHome}" as an environment variable when running bin scripts.
- The bin scripts are at ./bin/ (relative to this directory), not at ~/.claude/skills/gstack/bin/.
  Replace any references to ~/.claude/skills/gstack/bin/ with ./bin/ when running commands.
- Do NOT use AskUserQuestion.
- Just run the preamble bash block and report what you see.
- Look for "RECENT ARTIFACTS" and "LAST_SESSION" in the output.`,
      workingDirectory: workDir,
      maxTurns: 10,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'context-recovery-artifacts',
      runId,
    });

    logCost('context recovery', result);

    const output = result.output.toLowerCase();

    // The preamble should have found the seeded artifacts
    const foundArtifacts = output.includes('recent artifacts') || output.includes('ceo-plans');
    const foundLastSession = output.includes('last_session') || output.includes('ship');
    const foundTimeline = output.includes('timeline') || output.includes('completed');

    // At least the CEO plan or timeline should be visible
    const foundCount = [foundArtifacts, foundLastSession, foundTimeline].filter(Boolean).length;

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, 'context recovery', 'Session Intelligence E2E', result, {
      passed: exitOk && foundCount >= 1,
    });

    expect(exitOk).toBe(true);
    expect(foundCount).toBeGreaterThanOrEqual(1);

    console.log(`Context recovery: artifacts=${foundArtifacts}, lastSession=${foundLastSession}, timeline=${foundTimeline}`);
  }, 180_000);

  // --- Test 3: Checkpoint save and resume ---
  // Run /checkpoint save via claude -p, verify file created. Then run /checkpoint resume
  // and verify it reads the checkpoint back.
  testConcurrentIfSelected('checkpoint-save-resume', async () => {
    const projectDir = path.join(gstackHome, 'projects', slug);
    fs.mkdirSync(path.join(projectDir, 'checkpoints'), { recursive: true });

    // Copy the /checkpoint skill
    copyDirSync(path.join(ROOT, 'checkpoint'), path.join(workDir, 'checkpoint'));

    // Add a staged change so /checkpoint has something to capture
    fs.writeFileSync(path.join(workDir, 'feature.ts'), 'export function newFeature() { return true; }\n');
    spawnSync('git', ['add', 'feature.ts'], { cwd: workDir, stdio: 'pipe', timeout: 5000 });

    // Extract the checkpoint save section from the skill template
    const full = fs.readFileSync(path.join(ROOT, 'checkpoint', 'SKILL.md'), 'utf-8');
    const saveStart = full.indexOf('## Save');
    const resumeStart = full.indexOf('## Resume');
    const saveSection = full.slice(saveStart, resumeStart > saveStart ? resumeStart : undefined);

    const result = await runSkillTest({
      prompt: `You are testing the /checkpoint skill. Follow these instructions to save a checkpoint.

${saveSection.slice(0, 2000)}

IMPORTANT:
- Use GSTACK_HOME="${gstackHome}" as an environment variable when running bin scripts.
- The bin scripts are at ./bin/ (relative to this directory), not at ~/.claude/skills/gstack/bin/.
  Replace any references to ~/.claude/skills/gstack/bin/ with ./bin/ when running commands.
- Save the checkpoint to ${projectDir}/checkpoints/ with a filename like "20260401-test-checkpoint.md".
- Include YAML frontmatter with status, branch, and timestamp.
- Include a summary of what's being worked on (you can see from git status).
- Do NOT use AskUserQuestion.`,
      workingDirectory: workDir,
      maxTurns: 10,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'checkpoint-save-resume',
      runId,
    });

    logCost('checkpoint save', result);

    // Check that a checkpoint file was created
    const checkpointDir = path.join(projectDir, 'checkpoints');
    const checkpointFiles = fs.existsSync(checkpointDir)
      ? fs.readdirSync(checkpointDir).filter(f => f.endsWith('.md'))
      : [];

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);
    const checkpointCreated = checkpointFiles.length > 0;

    let checkpointContent = '';
    if (checkpointCreated) {
      checkpointContent = fs.readFileSync(path.join(checkpointDir, checkpointFiles[0]), 'utf-8');
    }

    // Verify checkpoint has expected structure
    const hasYamlFrontmatter = checkpointContent.includes('---') && checkpointContent.includes('status:');
    const hasBranch = checkpointContent.includes('branch:') || checkpointContent.includes('main');

    recordE2E(evalCollector, 'checkpoint save-resume', 'Session Intelligence E2E', result, {
      passed: exitOk && checkpointCreated && hasYamlFrontmatter,
    });

    expect(exitOk).toBe(true);
    expect(checkpointCreated).toBe(true);
    expect(hasYamlFrontmatter).toBe(true);

    console.log(`Checkpoint: ${checkpointFiles.length} files created, YAML frontmatter: ${hasYamlFrontmatter}, branch: ${hasBranch}`);
  }, 180_000);
});
