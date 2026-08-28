/**
 * /ship Step 18 doc-sync dispatch E2E — proves a live agent executing the
 * ship tail (Step 17 push → Step 19 PR creation) actually dispatches the
 * /document-release subagent BEFORE creating the PR. This is the behavioral
 * guardrail for the wiring pinned statically by
 * test/ship-document-release-dispatch.test.ts: the v1.54 carve made the
 * dispatch invisible once; this test makes that class of regression loud.
 *
 * Gating: whole-file gate-tier self-gate (describeE2ETier) COMPOSED with
 * diff-based selection (describeIfSelected). The self-gate keeps this file
 * out of the periodic shard census (near its ceiling) and under the hard
 * tier-alignment invariant. DELIBERATE TRADEOFF: tierless runs (`bun run
 * test:evals` / `test:e2e`) skip every tier-gated file, so this test does
 * NOT run there even when ship/** changed — use the gate lane locally:
 *   EVALS_TIER=gate bun run test:evals            # diff-selected gate lane
 *   EVALS=1 EVALS_TIER=gate EVALS_ALL=1 bun test test/skill-e2e-ship-docsync.test.ts
 *
 * Fixture layout (non-obvious — fake HOME + planted skill tree):
 *
 *   <workDir>/                            (passed as env HOME)
 *   ├── repo/               bare-remote git fixture, feature branch,
 *   │                       Steps 0-16 already "done" (VERSION bumped,
 *   │                       CHANGELOG entry, change committed, not pushed)
 *   ├── ship/SKILL-tail.md  sliced Step 17 → Step 20 from the generated
 *   │                       skeleton (live worktree, extract-don't-copy)
 *   ├── ship/sections/pr-body.md          planted copy (relative-resolution
 *   │                                     insurance)
 *   ├── gstack-home/.redact-prepush-prompted   marker + env GSTACK_HOME →
 *   │                       Step 17's credential pre-push guard takes its
 *   │                       silent "continue" branch instead of its
 *   │                       AskUserQuestion branch (gstack-config is absent
 *   │                       so REDACT_PREPUSH falls back to "false")
 *   └── .claude/skills/gstack/
 *       ├── ship/sections/pr-body.md      ← the STOP pointer's literal
 *       │                       `~/.claude/...` path resolves HERE via the
 *       │                       HOME override (CLAUDE_CONFIG_DIR is already
 *       │                       hermetic, so overriding HOME is safe)
 *       └── document-release/SKILL.md     ← stub: instructs the dispatched
 *                               subagent to emit the empty-result JSON
 *                               contract in 2-3 turns (the DISPATCH is what
 *                               is under test; Step 18 is non-blocking)
 *
 * The prompt is deliberately neutral — it does NOT command STOP-Read
 * compliance and does NOT name document-release. Priming the behavior under
 * test would make the assert tautological (and the prompt echoes into the
 * transcript, which is why asserts only ever read result.toolCalls).
 *
 * Cost: observed $0.63-1.04/run, 234-319s (9/9 burn-in + review runs passed;
 * gate tier confirmed).
 */
import { expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  createEvalCollector, recordE2E, finalizeEvalCollector, logCost,
} from './helpers/e2e-helpers';
import { describeE2ETier } from './helpers/e2e-gate';

const describeE2E = describeE2ETier('gate');
const evalCollector = createEvalCollector('e2e-ship-docsync');

const DOC_RELEASE_STUB = `---
name: document-release
description: Post-ship documentation update (E2E stub).
---

# Document Release (E2E stub)

You are running the documentation-sync workflow after a code push.
For this environment: compare the docs to the diff briefly; nothing needs
updating. Do NOT edit any files. Do NOT push.

Output EXACTLY this JSON object on the LAST line of your response, with no
text after it:

{"files_updated":[],"commit_sha":null,"pushed":false,"documentation_section":null}
`;

describeE2E('Ship doc-sync dispatch E2E (gate)', () => {
  describeIfSelected('Ship doc-sync dispatch E2E', ['ship-docsync'], () => {
    let workDir: string;
    let repoDir: string;
    let remoteDir: string;

    beforeAll(() => {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-docsync-home-'));
      remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-docsync-remote-'));
      repoDir = path.join(workDir, 'repo');

      // Bare remote + clone; Steps 0-16 "already done": feature branch with a
      // committed change, VERSION bumped, CHANGELOG entry written. Not pushed —
      // Step 17 (the slice's first step) does that.
      // Branch pinned with -b main / -c init.defaultBranch=main so operator git
      // config never leaks into the fixture (default-config machines would
      // otherwise create master and the later `push -u origin main` would fail).
      // Every setup command asserts status — a broken fixture must fail loud
      // and free here, never burn a paid run downstream.
      const assertOk = (r: ReturnType<typeof spawnSync>, what: string) => {
        if (r.status !== 0) {
          throw new Error(
            `ship-docsync fixture setup failed: ${what} → exit ${r.status}\n${r.stderr?.toString() ?? ''}`
          );
        }
        return r;
      };
      assertOk(
        spawnSync('git', ['init', '--bare', '-b', 'main'], { cwd: remoteDir, stdio: 'pipe', timeout: 15000 }),
        'git init --bare -b main'
      );
      assertOk(
        spawnSync('git', ['-c', 'init.defaultBranch=main', 'clone', remoteDir, repoDir], { stdio: 'pipe', timeout: 15000 }),
        'git clone'
      );
      const run = (cmd: string, args: string[]) =>
        assertOk(
          spawnSync(cmd, args, { cwd: repoDir, stdio: 'pipe', timeout: 10000 }),
          `${cmd} ${args.join(' ')}`
        );
      run('git', ['config', 'user.email', 'test@test.com']);
      run('git', ['config', 'user.name', 'Test']);
      run('git', ['config', 'commit.gpgsign', 'false']);
      fs.writeFileSync(path.join(repoDir, 'app.ts'), 'console.log("v1");\n');
      fs.writeFileSync(path.join(repoDir, 'VERSION'), '0.1.0.0\n');
      fs.writeFileSync(
        path.join(repoDir, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.1.0.0] - 2026-01-01\n\n- Initial release\n'
      );
      // The cwd-relative pr-body plant (below) lives inside this working tree;
      // ignore it so the fixture repo stays clean and the agent never tries to
      // commit test scaffolding.
      fs.writeFileSync(path.join(repoDir, '.gitignore'), 'ship/\n');
      run('git', ['add', 'app.ts', 'VERSION', 'CHANGELOG.md', '.gitignore']);
      run('git', ['commit', '-m', 'initial']);
      run('git', ['push', '-u', 'origin', 'main']);
      run('git', ['checkout', '-b', 'feature/docsync-test']);
      fs.writeFileSync(path.join(repoDir, 'app.ts'), 'console.log("v2");\n');
      fs.writeFileSync(path.join(repoDir, 'VERSION'), '0.1.0.1\n');
      fs.writeFileSync(
        path.join(repoDir, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.1.0.1] - 2026-01-02\n\n- Docsync test feature\n\n## [0.1.0.0] - 2026-01-01\n\n- Initial release\n'
      );
      run('git', ['add', 'app.ts', 'VERSION', 'CHANGELOG.md']);
      run('git', ['commit', '-m', 'feat: docsync test feature']);

      // Extract-don't-copy: slice the LIVE generated skeleton's Step 17→19
      // tail. Fail loudly on marker drift — a tolerant slice silently builds
      // a wrong fixture (mirrors extractSkillSections's throw-on-rename).
      const skeleton = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
      const start = skeleton.indexOf('## Step 17: Push');
      const end = skeleton.indexOf('## Step 20: Persist ship metrics');
      if (start === -1 || end === -1 || end <= start) {
        throw new Error(
          'ship/SKILL.md step markers moved — update the skill-e2e-ship-docsync fixture slice'
        );
      }
      const tail = skeleton.slice(start, end);
      fs.mkdirSync(path.join(workDir, 'ship', 'sections'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'ship', 'SKILL-tail.md'), tail);

      // Plant the real pr-body section at the STOP pointer's ~ path (HOME
      // override) and at a relative path as insurance.
      const prBody = fs.readFileSync(
        path.join(ROOT, 'ship', 'sections', 'pr-body.md'), 'utf-8'
      );
      const plantedSkills = path.join(workDir, '.claude', 'skills', 'gstack');
      fs.mkdirSync(path.join(plantedSkills, 'ship', 'sections'), { recursive: true });
      fs.mkdirSync(path.join(plantedSkills, 'document-release'), { recursive: true });
      fs.writeFileSync(path.join(plantedSkills, 'ship', 'sections', 'pr-body.md'), prBody);
      fs.writeFileSync(path.join(workDir, 'ship', 'sections', 'pr-body.md'), prBody);
      // Third plant: resolvable relative to the agent's cwd (repoDir), not just
      // relative to SKILL-tail.md — saves a wasted turn if the agent tries a
      // cwd-relative read before the ~ path.
      fs.mkdirSync(path.join(repoDir, 'ship', 'sections'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'ship', 'sections', 'pr-body.md'), prBody);
      fs.writeFileSync(
        path.join(plantedSkills, 'document-release', 'SKILL.md'),
        DOC_RELEASE_STUB
      );

      // Route Step 17's credential pre-push guard to its silent branch.
      fs.mkdirSync(path.join(workDir, 'gstack-home'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, 'gstack-home', '.redact-prepush-prompted'), ''
      );
    });

    afterAll(() => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(remoteDir, { recursive: true, force: true }); } catch {}
    });

    testConcurrentIfSelected('ship-docsync', async () => {
      const result = await runSkillTest({
        prompt: `You are executing the /ship workflow; your working directory is the git repo. Steps 0-16 are complete: tests passed, review done, VERSION bumped to 0.1.0.1, CHANGELOG updated, changes committed on branch feature/docsync-test. The remaining workflow is in ${path.join(workDir, 'ship', 'SKILL-tail.md')} — Read it and continue the workflow from Step 17 to completion. Base branch: main. There is no GitHub/GitLab service in this environment: if gh or glab commands fail, print the would-be PR title and body and stop. gstack helper binaries (gstack-*) are unavailable in this environment — treat their failures as no-ops and continue. Do NOT ask questions.`,
        workingDirectory: repoDir,
        maxTurns: 30,
        allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Agent', 'Task'],
        timeout: 480_000,
        env: {
          HOME: workDir,
          GSTACK_HOME: path.join(workDir, 'gstack-home'),
        },
        testName: 'ship-docsync',
        runId,
      });

      logCost('/ship doc-sync dispatch', result);

      // Assert ONLY on result.toolCalls — the prompt and skill text echo into
      // the transcript and would false-positive any transcript-wide match
      // (trap documented in skill-e2e-autoplan-dual-voice.test.ts).
      const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      // Matcher is dispatch-SPECIFIC, not mention-specific: both markers come
      // verbatim from the Step 18 subagent prompt dictated by pr-body.md. A
      // subagent that merely quotes section text mentioning "document-release"
      // (e.g. a PR-body drafter) must NOT count — that false-pass would mask
      // the exact regression this test exists to catch. Verified against
      // recorded burn-in transcripts: real dispatch inputs carry both markers.
      // Section-paste exclusion: a subagent handed the WHOLE pr-body.md as
      // context carries the markers too. The dictated Step 18 prompt never
      // contains the section's scaffolding, so its presence disqualifies.
      // Verified across all recorded runs: real dispatches match markers,
      // zero contain scaffold strings.
      const dispatchIdx = calls.findIndex((tc) => {
        if (tc.tool !== 'Agent' && tc.tool !== 'Task') return false;
        const input = JSON.stringify(tc.input ?? {});
        return (
          /document-release\/SKILL\.md|executing the \/document-release workflow/i.test(input) &&
          !/## Step 19: Create PR\/MR|Parent processing:/.test(input)
        );
      });
      const prCreateIdx = calls.findIndex(
        (tc) =>
          tc.tool === 'Bash' &&
          /gh pr create|glab mr create/.test(String((tc.input as any)?.command ?? ''))
      );
      const readPrBody = calls.some(
        (tc) =>
          (tc.tool === 'Read' &&
            /sections\/pr-body\.md/.test(String((tc.input as any)?.file_path ?? ''))) ||
          (tc.tool === 'Bash' &&
            /sections\/pr-body\.md/.test(String((tc.input as any)?.command ?? '')))
      );

      if (!readPrBody) {
        // Diagnostic only — near-tautological under any prompt; the dispatch
        // below is the invariant.
        console.warn('ship-docsync: pr-body.md was never opened');
      }

      recordE2E(evalCollector, '/ship doc-sync dispatch', 'Ship doc-sync dispatch E2E', result, {
        passed:
          dispatchIdx >= 0 &&
          (prCreateIdx < 0 || dispatchIdx < prCreateIdx) &&
          ['success', 'error_max_turns', 'timeout'].includes(result.exitReason),
      });

      // THE regression assert: the /document-release subagent was dispatched.
      expect(dispatchIdx).toBeGreaterThanOrEqual(0);
      // Sequencing: dispatch happens BEFORE PR creation (when a create was attempted).
      if (prCreateIdx >= 0) expect(dispatchIdx).toBeLessThan(prCreateIdx);
      // 'timeout' is acceptable ONLY because the dispatch assert above is
      // independently hard — a run that times out AFTER a clean dispatch
      // proves the invariant; one that times out before it already failed on
      // dispatchIdx. Never soften dispatchIdx to compensate.
      expect(['success', 'error_max_turns', 'timeout']).toContain(result.exitReason);

      console.log(
        `dispatchIdx=${dispatchIdx} prCreateIdx=${prCreateIdx} readPrBody=${readPrBody} exit=${result.exitReason}`
      );
    }, 540_000);
  });
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
