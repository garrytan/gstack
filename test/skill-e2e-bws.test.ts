import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS } from './helpers/eval-budgets';
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
  'skillmd-no-local-binary', 'skillmd-outside-git',
  'operational-learning',
], () => {
  beforeAll(() => {
    testServer = startTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-'));
    setupBrowseShims(tmpDir);

    // Pre-warm the browse server so Chromium is already launched for tests.
    // In CI, Chromium can take 10-20s to launch (Docker + --no-sandbox).
    spawnSync(browseBin, ['goto', testServer.url], { cwd: tmpDir, timeout: 30000, stdio: 'pipe' });
  }, 45_000);

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
      maxTurns: 7,
      timeout: JUDGE_MS,
      testName: 'browse-basic',
      runId,
    });

    logCost('browse basic', result);
    recordE2E(evalCollector, 'browse basic commands', 'Skill E2E tests', result);
    expect(result.browseErrors).toHaveLength(0);
    expect(result.exitReason).toBe('success');
  }, JUDGE_MS);

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
      maxTurns: 9,
      timeout: JUDGE_MS,
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
  }, JUDGE_MS);

  testConcurrentIfSelected('skillmd-setup-discovery', async () => {
    // P2 (v1.2.0): the browse SETUP/binary-discovery block moved from the root
    // router to browse/SKILL.md; the `$B` block now sits under "Browser fallback".
    const skillMd = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    // The `$B` setup lives in the Browser fallback section since Aside became
    // the primary driver: slice from its heading to the next heading.
    const setupStart = skillMd.indexOf('### Find the `$B` binary');
    const nextH3 = skillMd.indexOf('\n### ', setupStart + 1);
    const nextH2 = skillMd.indexOf('\n## ', setupStart + 1);
    const setupEnd = [nextH3, nextH2].filter((i) => i > setupStart).sort((a, b) => a - b)[0] ?? skillMd.length;
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
      timeout: JUDGE_MS,
      testName: 'skillmd-setup-discovery',
      runId,
    });

    recordE2E(evalCollector, 'SKILL.md setup block discovery', 'Skill E2E tests', result);
    expect(result.browseErrors).toHaveLength(0);
    expect(result.exitReason).toBe('success');
  }, JUDGE_MS);

  testConcurrentIfSelected('skillmd-no-local-binary', async () => {
    // Create a tmpdir with no browse binary — no local .claude/skills/gstack/browse/dist/browse
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-empty-'));

    // P2 (v1.2.0): the browse SETUP/binary-discovery block moved from the root
    // router to browse/SKILL.md; the `$B` block now sits under "Browser fallback".
    const skillMd = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    // The `$B` setup lives in the Browser fallback section since Aside became
    // the primary driver: slice from its heading to the next heading.
    const setupStart = skillMd.indexOf('### Find the `$B` binary');
    const nextH3 = skillMd.indexOf('\n### ', setupStart + 1);
    const nextH2 = skillMd.indexOf('\n## ', setupStart + 1);
    const setupEnd = [nextH3, nextH2].filter((i) => i > setupStart).sort((a, b) => a - b)[0] ?? skillMd.length;
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    const result = await runSkillTest({
      prompt: `Follow these instructions exactly. Run the bash code block below and report what it outputs.

${setupBlock}

Report the exact output. Do NOT try to fix or install anything — just report what you see.`,
      workingDirectory: emptyDir,
      maxTurns: 5,
      timeout: JUDGE_MS,
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
  }, JUDGE_MS);

  testConcurrentIfSelected('skillmd-outside-git', async () => {
    // Create a tmpdir outside any git repo
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-nogit-'));

    // P2 (v1.2.0): the browse SETUP/binary-discovery block moved from the root
    // router to browse/SKILL.md; the `$B` block now sits under "Browser fallback".
    const skillMd = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    // The `$B` setup lives in the Browser fallback section since Aside became
    // the primary driver: slice from its heading to the next heading.
    const setupStart = skillMd.indexOf('### Find the `$B` binary');
    const nextH3 = skillMd.indexOf('\n### ', setupStart + 1);
    const nextH2 = skillMd.indexOf('\n## ', setupStart + 1);
    const setupEnd = [nextH3, nextH2].filter((i) => i > setupStart).sort((a, b) => a - b)[0] ?? skillMd.length;
    const setupBlock = skillMd.slice(setupStart, setupEnd);

    const result = await runSkillTest({
      prompt: `Follow these instructions exactly. Run the bash code block below and report what it outputs.

${setupBlock}

Report the exact output — either "READY: <path>" or "NEEDS_SETUP".`,
      workingDirectory: nonGitDir,
      maxTurns: 5,
      timeout: JUDGE_MS,
      testName: 'skillmd-outside-git',
      runId,
    });

    // Should either find global binary (READY) or show NEEDS_SETUP — not crash
    const allText = result.output || '';
    recordE2E(evalCollector, 'SKILL.md outside git repo', 'Skill E2E tests', result);
    expect(allText).toMatch(/READY|NEEDS_SETUP/);

    // Clean up
    try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch {}
  }, JUDGE_MS);

  testConcurrentIfSelected('operational-learning', async () => {
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-oplearn-'));
    const gstackHome = path.join(opDir, '.gstack-home');

    // Init git repo
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: opDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(opDir, 'app.ts'), 'console.log("hello");\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Copy bin scripts + the lib module they import. gstack-learnings-log
    // does `import ... from '$SCRIPT_DIR/../lib/jsonl-store.ts'` (v1.57.5.0
    // injection sanitization) — without lib/ alongside bin/, the script exits
    // 1 before writing anything, failing this test for a fixture reason, not
    // a model-behavior reason (root-caused during the v1.58.0.0 ship; fails
    // identically on main).
    const binDir = path.join(opDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const script of ['gstack-learnings-log', 'gstack-slug', 'gstack-state-root.sh', 'gstack-remote-identity.sh']) {
      fs.copyFileSync(path.join(ROOT, 'bin', script), path.join(binDir, script));
      fs.chmodSync(path.join(binDir, script), 0o755);
    }
    // gstack-learnings-log imports $SCRIPT_DIR/../lib/jsonl-store.ts and
    // lib/redact-engine.ts (which imports further lib modules) — a real install
    // always ships bin/ and lib/ together, so the fixture must too. Without it
    // the bin exits 1 before writing anything and the test fails on every
    // attempt. A copy, not a symlink: the agent runs inside this directory.
    fs.cpSync(path.join(ROOT, 'lib'), path.join(opDir, 'lib'), { recursive: true });

    // gstack-learnings-log will create the project dir automatically via gstack-slug

    const result = await runSkillTest({
      prompt: `You just ran \`npm test\` in this project and it failed with this error:

Error: --experimental-vm-modules flag is required for ESM support in this project.
Run: npm test --experimental-vm-modules

Per the Operational Self-Improvement instructions below, log an operational learning about this failure.

## Operational Self-Improvement

Before completing, reflect on this session:
- Did any commands fail unexpectedly?

If yes, log an operational learning for future sessions:

\`\`\`bash
GSTACK_HOME="${gstackHome}" ${binDir}/gstack-learnings-log '{"skill":"qa","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
\`\`\`

Replace SHORT_KEY with a kebab-case key like "esm-vm-modules-flag".
Replace DESCRIPTION with a one-sentence description of what you learned.
Replace N with a confidence score 1-10.

Log the operational learning now. Then say what you logged.`,
      workingDirectory: opDir,
      maxTurns: 5,
      timeout: JUDGE_MS,
      testName: 'operational-learning',
      runId,
    });

    logCost('operational learning', result);

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    // Check if learnings file was created with an operational entry
    // The slug is derived from the git repo (dirname), so search all project dirs
    let hasOperational = false;
    const projectsDir = path.join(gstackHome, 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const slug of fs.readdirSync(projectsDir)) {
        const lPath = path.join(projectsDir, slug, 'learnings.jsonl');
        if (fs.existsSync(lPath)) {
          const jsonl = fs.readFileSync(lPath, 'utf-8').trim();
          if (jsonl) {
            const entries = jsonl.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            const opEntry = entries.find(e => e.type === 'operational');
            if (opEntry) {
              hasOperational = true;
              console.log(`Operational learning logged: key="${opEntry.key}" insight="${opEntry.insight}" (slug: ${slug})`);
              break;
            }
          }
        }
      }
    }

    recordE2E(evalCollector, 'operational learning', 'Skill E2E tests', result, {
      passed: exitOk && hasOperational,
    });

    expect(exitOk).toBe(true);
    expect(hasOperational).toBe(true);

    // Clean up
    try { fs.rmSync(opDir, { recursive: true, force: true }); } catch {}
  }, JUDGE_MS);

});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
