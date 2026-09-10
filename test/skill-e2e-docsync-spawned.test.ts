/**
 * Spawned document-release subagent E2E — the behavioral proof of #2733's
 * JSON contract THROUGH A FIRING GATE. The existing coverage misses exactly
 * this: skill-e2e-ship-docsync.test.ts stubs document-release (no preamble,
 * no gates) and asserts only the dispatch; skill-e2e-workflow.test.ts runs
 * the real skill but suppresses the gates by prompt ("do NOT use
 * AskUserQuestion"). #2733 shipped through that hole — the subagent
 * prose-STOPped at the VERSION gate in every Conductor-hosted ship and the
 * parent's LAST-line JSON parse failed.
 *
 * This test plays the PARENT: it drives a claude -p run with the verbatim
 * Step 18 dispatch prompt extracted from the live ship/sections/pr-body.md
 * (drift-proof — a reworded prompt is exercised, not a copy), against a REAL
 * preamble-bearing document-release slice, in a Conductor-ambient env, with
 * the AUQ hooks seeded live. The VERSION-bump gate fires (VERSION is NOT
 * bumped on the fixture branch); the marked-spawned machinery must resolve
 * it to the recommended option (C — Skip) and the run must end with the
 * parseable JSON contract, `decisions` non-empty, VERSION untouched.
 *
 * Fixture layout (fake HOME, same pattern as ship-docsync):
 *
 *   <workDir>/                          (passed as env HOME)
 *   ├── repo/               git fixture: feature branch, committed change,
 *   │                       VERSION deliberately NOT bumped → Step 8 fires
 *   ├── gstack-home/        hermetic GSTACK_HOME (update_check: false)
 *   ├── claude-config/      CLAUDE_CONFIG_DIR: seeded .claude.json +
 *   │                       settings.json registering BOTH live AUQ hooks
 *   │                       (question-preference PreToolUse deny,
 *   │                       auq-error-fallback PostToolUse) — production
 *   │                       topology: a slipped AUQ call gets denied without
 *   │                       derailing the run. hermetic-env has no built-in
 *   │                       hook seeding, so this test writes its own.
 *   └── .claude/skills/gstack/
 *       ├── document-release/SKILL.md   sliced from the LIVE generated skill
 *       │                     (frontmatter + Preamble + AskUserQuestion
 *       │                     Format + Step 8 VERSION gate) — extract,
 *       │                     never copy the full 1900-line skill
 *       └── bin/              full live bin/ copy: the preamble's
 *                             `$HOME/.claude/skills/gstack/bin/gstack-skill-start`
 *                             resolves here; sibling bins degrade gracefully
 *
 * The dispatch prompt instructs the GSTACK_SESSION_KIND=spawned prefix; the
 * hooks run with the CHILD env (Conductor vars set, no per-command marker) —
 * exactly the production topology where hook env-blindness is permanent.
 *
 * Gating: gate-tier self-gate (deterministic safety/functional) composed
 * with diff selection. Run locally:
 *   EVALS=1 EVALS_TIER=gate EVALS_ALL=1 bun test test/skill-e2e-docsync-spawned.test.ts
 */
import { expect, beforeAll, afterAll } from 'bun:test';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
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
import { buildSeedConfig } from './helpers/hermetic-env';

const describeE2E = describeE2ETier('gate');
const evalCollector = createEvalCollector('e2e-docsync-spawned');

/** Slice [startMarker, next `\n## ` heading) out of content; throw on drift. */
function sliceSection(content: string, startMarker: string, what: string): string {
  const start = content.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`docsync-spawned fixture: marker "${startMarker}" moved in ${what} — update the slice`);
  }
  const end = content.indexOf('\n## ', start + startMarker.length);
  return content.slice(start, end === -1 ? undefined : end + 1);
}

/** Last line of the final message that parses as a JSON object (the model may
 *  close a code fence after the contract line — scan upward past that). */
/** The parent's contract is "parse the LAST line" — but the parent is a
 *  prose-instructed model, not a strict parser, and tolerates a trailing
 *  code-fence close after the JSON. Mirror that: scan upward past at most a
 *  fence line + blank noise, never deeper. */
const TRAILING_FENCE_TOLERANCE_LINES = 3;

function lastJsonLine(output: string): Record<string, unknown> | null {
  const lines = output.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - TRAILING_FENCE_TOLERANCE_LINES); i--) {
    const l = lines[i].replace(/^`+|`+$/g, '');
    if (!l.startsWith('{')) continue;
    try { return JSON.parse(l); } catch { return null; }
  }
  return null;
}

describeE2E('Spawned docsync JSON contract E2E (gate)', () => {
  describeIfSelected('Spawned docsync JSON contract', ['docsync-spawned'], () => {
    let workDir: string;
    let repoDir: string;
    let dispatchPrompt: string;

    beforeAll(() => {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-docsync-spawned-'));
      repoDir = path.join(workDir, 'repo');
      fs.mkdirSync(repoDir, { recursive: true });

      const assertOk = (r: ReturnType<typeof spawnSync>, what: string) => {
        if (r.status !== 0) {
          throw new Error(
            `docsync-spawned fixture setup failed: ${what} → exit ${r.status}\n${r.stderr?.toString() ?? ''}`
          );
        }
      };
      const run = (cmd: string, args: string[]) =>
        assertOk(spawnSync(cmd, args, { cwd: repoDir, stdio: 'pipe', timeout: 15000 }), `${cmd} ${args.join(' ')}`);
      run('git', ['init', '-b', 'main']);
      run('git', ['config', 'user.email', 'test@test.com']);
      run('git', ['config', 'user.name', 'Test']);
      run('git', ['config', 'commit.gpgsign', 'false']);
      fs.writeFileSync(path.join(repoDir, 'app.ts'), 'export const v = 1;\n');
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n\nA tiny app.\n');
      fs.writeFileSync(path.join(repoDir, 'VERSION'), '0.1.0.0\n');
      fs.writeFileSync(
        path.join(repoDir, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.1.0.0] - 2026-01-01\n\n- Initial release\n'
      );
      run('git', ['add', 'app.ts', 'README.md', 'VERSION', 'CHANGELOG.md']);
      run('git', ['commit', '-m', 'initial']);
      // Feature branch with a committed code change and VERSION deliberately
      // NOT bumped — Step 8's "If VERSION was NOT bumped" AUQ gate fires
      // (RECOMMENDATION: C — Skip). The spawned machinery must auto-choose it.
      run('git', ['checkout', '-b', 'feature/spawned-docsync']);
      fs.writeFileSync(path.join(repoDir, 'app.ts'), 'export const v = 2;\n');
      run('git', ['add', 'app.ts']);
      run('git', ['commit', '-m', 'feat: bump v']);

      // --- Sliced document-release skill (extract, never copy the full skill) ---
      const skill = fs.readFileSync(path.join(ROOT, 'document-release', 'SKILL.md'), 'utf-8');
      const releaseBody = fs.readFileSync(
        path.join(ROOT, 'document-release', 'sections', 'release-body.md'), 'utf-8'
      );
      const fmEnd = skill.indexOf('\n---', 3);
      if (!skill.startsWith('---') || fmEnd === -1) {
        throw new Error('docsync-spawned fixture: document-release frontmatter moved — update the slice');
      }
      const frontmatter = skill.slice(0, fmEnd + 5);
      const fixtureSkill = [
        frontmatter,
        '# Document Release (E2E slice: preamble + AUQ format + VERSION gate)\n',
        sliceSection(skill, '## Preamble (run first)', 'document-release/SKILL.md'),
        sliceSection(skill, '## AskUserQuestion Format', 'document-release/SKILL.md'),
        sliceSection(releaseBody, '## Step 8: VERSION Bump Question', 'document-release/sections/release-body.md'),
        '## Workflow end\n\nAfter Step 8 the workflow is complete for this environment — produce your final response exactly as your dispatch instructions specify.\n',
      ].join('\n');
      const plantedSkills = path.join(workDir, '.claude', 'skills', 'gstack');
      fs.mkdirSync(path.join(plantedSkills, 'document-release'), { recursive: true });
      fs.writeFileSync(path.join(plantedSkills, 'document-release', 'SKILL.md'), fixtureSkill);

      // Full live bin/ copy: the preamble fence resolves
      // $HOME/.claude/skills/gstack/bin/gstack-skill-start here ($0-relative
      // siblings like gstack-session-kind resolve too; the rest are
      // `|| true`-guarded and degrade silently).
      // filter: skip compiled binaries (a post-./setup bin/ carries the ~100MB
      // gstack-global-discover ELF; the scripts the preamble resolves are <2MB
      // total — copying the ELF would burn tmp disk + beforeAll time for nothing).
      fs.cpSync(path.join(ROOT, 'bin'), path.join(plantedSkills, 'bin'), {
        recursive: true,
        filter: (src) => {
          try { return !(fs.statSync(src).isFile() && fs.statSync(src).size > 5_000_000); }
          catch { return true; }
        },
      });

      // Hermetic GSTACK_HOME — update_check: false keeps the preamble off the
      // network (same gate the unit tests use).
      fs.mkdirSync(path.join(workDir, 'gstack-home'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, 'gstack-home', 'config.yaml'), 'update_check: false\n'
      );

      // --- CLAUDE_CONFIG_DIR with the LIVE AUQ hooks registered ---
      // hermetic-env has no hook-seeding support; write the registration
      // ourselves. Commands point at the live worktree hook sources (the
      // exact units under test) via `bun` — sibling/lib relative imports
      // resolve in place; state writes follow the child's GSTACK_HOME.
      const cfgDir = path.join(workDir, 'claude-config');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(cfgDir, '.claude.json'),
        JSON.stringify(buildSeedConfig({
          apiKey: process.env.ANTHROPIC_API_KEY,
          trustedDirs: [repoDir],
        }))
      );
      const hook = (f: string) => ({
        type: 'command',
        command: `bun ${path.join(ROOT, 'hosts', 'claude', 'hooks', f)}`,
        timeout: 5,
      });
      const AUQ_MATCHER = '(AskUserQuestion|mcp__.*__AskUserQuestion)';
      fs.writeFileSync(
        path.join(cfgDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: AUQ_MATCHER, hooks: [hook('question-preference-hook.ts')] }],
            PostToolUse: [{ matcher: AUQ_MATCHER, hooks: [hook('auq-error-fallback-hook.ts')] }],
          },
        }, null, 2)
      );

      // --- The dispatch prompt: verbatim from the LIVE regenerated section ---
      const prBody = fs.readFileSync(path.join(ROOT, 'ship', 'sections', 'pr-body.md'), 'utf-8');
      const pStart = prBody.indexOf('**Subagent prompt:**');
      const pEnd = prBody.indexOf('**Parent processing:**');
      if (pStart === -1 || pEnd === -1 || pEnd <= pStart) {
        throw new Error('docsync-spawned fixture: Step 18 prompt markers moved in pr-body.md — update the slice');
      }
      dispatchPrompt = prBody
        .slice(pStart + '**Subagent prompt:**'.length, pEnd)
        .split('\n')
        .map((l) => l.replace(/^> ?/, ''))
        .join('\n')
        .replace(/<branch>/g, 'feature/spawned-docsync')
        .replace(/<base>/g, 'main')
        .trim();
      // Parent-plausible environment note only (a real parent knows $HOME).
      // Deliberately NO "do not ask questions" priming — resolving the gate
      // without stopping IS the behavior under test.
      dispatchPrompt += `\n\n(Environment note: HOME is ${workDir}; the git repo is your working directory.)`;
    });

    afterAll(() => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    });

    testConcurrentIfSelected('docsync-spawned', async () => {
      const result = await runSkillTest({
        prompt: dispatchPrompt,
        workingDirectory: repoDir,
        maxTurns: 24,
        allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'],
        timeout: CAPTURE_LONG_MS,
        env: {
          HOME: workDir,
          GSTACK_HOME: path.join(workDir, 'gstack-home'),
          CLAUDE_CONFIG_DIR: path.join(workDir, 'claude-config'),
          // Production topology: the parent is a Conductor-hosted session and
          // the subagent inherits its env. The hermetic default GSTACK_HEADLESS
          // is cleared — a real parent session doesn't carry it (and empty
          // means unset per the -n guards).
          CONDUCTOR_WORKSPACE_PATH: '/tmp/conductor-ws-e2e',
          GSTACK_HEADLESS: '',
        },
        testName: 'docsync-spawned',
        runId,
      });

      logCost('spawned docsync JSON contract', result);

      const contract = lastJsonLine(result.output);
      const version = fs.readFileSync(path.join(repoDir, 'VERSION'), 'utf-8');

      recordE2E(evalCollector, 'spawned docsync JSON contract', 'Spawned docsync JSON contract', result, {
        passed:
          result.exitReason === 'success' &&
          contract !== null &&
          Array.isArray((contract as any)?.decisions) &&
          ((contract as any).decisions as unknown[]).length >= 1 &&
          version === '0.1.0.0\n',
      });

      // THE #2733 regression asserts: the run ended in the machine-parseable
      // contract (not a prose decision brief waiting for an answer)...
      expect(result.exitReason).toBe('success');
      expect(contract, `final message did not end with the JSON contract:\n${result.output.slice(-800)}`).not.toBeNull();
      for (const key of ['files_updated', 'commit_sha', 'pushed', 'documentation_section', 'decisions']) {
        expect(Object.keys(contract!), `contract missing key ${key}`).toContain(key);
      }
      // ...the fired VERSION gate was auto-chosen and RECORDED (transparency
      // mechanism — the parent prints these to the ship console)...
      const decisions = (contract as any).decisions;
      expect(Array.isArray(decisions)).toBe(true);
      expect(decisions.length, 'the fired VERSION gate must be recorded in decisions').toBeGreaterThanOrEqual(1);
      // The recorded decision must be ABOUT the gate that fired, not an
      // unrelated placeholder (codex finding: "any nonempty decision passes").
      expect(
        decisions.join(' '),
        'decisions must reference the VERSION-bump gate that fired',
      ).toMatch(/version|bump|skip/i);
      // ...and the gate resolved to its recommended option (C — Skip): the
      // subagent must NOT have bumped VERSION on its own.
      expect(version).toBe('0.1.0.0\n');

      console.log(
        `contractKeys=${contract ? Object.keys(contract).join(',') : 'none'} decisions=${JSON.stringify(decisions)} exit=${result.exitReason}`
      );
    }, CAPTURE_LONG_MS);
  });
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
