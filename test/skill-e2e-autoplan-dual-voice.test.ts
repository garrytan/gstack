import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { initializePlan, prepareMethodology, createSnapshot } from '../bin/gstack-autoplan-snapshot';
import { autoplanDualVoiceEvidence, loadAutoplanDualCommandContract } from './helpers/autoplan-dual-voice-evidence';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { buildSeedConfig, seedHermeticGstackHome, seedHermeticRuntimeView } from './helpers/hermetic-env';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, logCost, recordE2E,
  copyDirSync, createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// E2E for /autoplan's dual-voice (Claude subagent + Codex). Periodic tier:
// non-deterministic, costs ~$1/run, not a gate. The purpose is to catch
// regressions where one of the two voices fails silently post-hardening.

const evalCollector = createEvalCollector('e2e-autoplan-dual-voice');

describeIfSelected('Autoplan dual-voice E2E', ['autoplan-dual-voice'], () => {
  let workDir: string;
  let planPath: string;
  let entryPath: string;
  let activePlan: string;
  let methodologySha256: string;
  let stateDir: string;
  let attemptEnv: Record<string, string>;

  const cleanup = () => {
    try {
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    } finally {
      if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    }
  };

  // Bun retries repeat the body and these hooks. A prior attempt's amended
  // plan, review artifacts and native session must never become retry input.
  const prepareAttempt = () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-autoplan-dv-'));
    stateDir = '';
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-dv-state-'));
    const configDir = path.join(stateDir, '.claude');
    const gstackHome = path.join(stateDir, 'gstack-home');
    const tempDir = path.join(stateDir, 'tmp');
    fs.mkdirSync(configDir);
    fs.mkdirSync(gstackHome);
    fs.mkdirSync(tempDir, { mode: 0o700 });
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(buildSeedConfig({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.GSTACK_ANTHROPIC_API_KEY,
      trustedDirs: [workDir],
    })), { mode: 0o600 });
    seedHermeticGstackHome(gstackHome);
    // Canonical skill paths must resolve inside this attempt's HOME as well
    // as Claude's config. Link the existing guarded runtime view, including
    // bin/lib and review assets; copied slash-command skeletons are not enough.
    const runtime = path.join(configDir, 'skills', 'gstack');
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    seedHermeticRuntimeView(ROOT, runtime);
    attemptEnv = { HOME: stateDir, CLAUDE_CONFIG_DIR: configDir,
      GSTACK_HOME: gstackHome, GSTACK_STATE_ROOT: gstackHome,
      TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir,
      // Preserve the same outside-reviewer auth/model home across HOME isolation.
      CODEX_HOME: process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex') };

    const run = (cmd: string, args: string[]) => {
      const result = spawnSync(cmd, args, { cwd: workDir, encoding: 'utf8', timeout: 10000 });
      if (result.error || result.status !== 0)
        throw new Error(`Dual-voice fixture setup failed: ${result.error?.message ?? result.stderr}`);
    };

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    // The plan adds a skill to an existing generator. Supply that small,
    // working project so review does not have to invent its missing toolchain.
    const projectFiles: Record<string, string> = {
      'README.md': '# Skill Toolbox\n\nThe /about skill prints the project name.\n\n'
        + 'Author skills in `<name>/SKILL.md.tmpl`. Register their directories in the\n'
        + '`skills` array in package.json, then run `bun run gen:skill-docs`. The generator\n'
        + 'copies each template to `<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`\n'
        + 'for project discovery. `bun test` checks existing skill content.\n',
      'package.json': JSON.stringify({ name: 'skill-toolbox', private: true, skills: ['about'],
        scripts: { 'gen:skill-docs': 'bun scripts/gen-skill-docs.ts', test: 'bun test' } }, null, 2) + '\n',
      'about/SKILL.md.tmpl': '---\nname: about\ndescription: Show the project name.\n---\nPrint "Skill Toolbox".\n',
      'scripts/gen-skill-docs.ts': `import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { skills } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const name of skills) {
  const source = readFileSync(new URL('../' + name + '/SKILL.md.tmpl', import.meta.url), 'utf8');
  for (const directory of [name, '.claude/skills/' + name]) {
    const output = fileURLToPath(new URL('../' + directory + '/SKILL.md', import.meta.url));
    mkdirSync(dirname(output), {recursive: true});
    writeFileSync(output, source);
  }
}
`,
      'test/about.test.ts': `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
test('about is generated and discoverable', () => {
  const source = readFileSync(new URL('../about/SKILL.md.tmpl', import.meta.url), 'utf8');
  expect(readFileSync(new URL('../about/SKILL.md', import.meta.url), 'utf8')).toBe(source);
  expect(readFileSync(new URL('../.claude/skills/about/SKILL.md', import.meta.url), 'utf8')).toBe(source);
});
`,
    };
    for (const [relative, content] of Object.entries(projectFiles)) {
      const file = path.join(workDir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run(process.execPath, ['scripts/gen-skill-docs.ts']);
    run('git', ['add', '.']);
    run('git', ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Existing skill project']);

    // Copy /autoplan + its review-skill dependencies (they're loaded from disk).
    copyDirSync(path.join(ROOT, 'autoplan'), path.join(workDir, 'autoplan'));
    copyDirSync(path.join(ROOT, 'plan-ceo-review'), path.join(workDir, 'plan-ceo-review'));
    copyDirSync(path.join(ROOT, 'plan-eng-review'), path.join(workDir, 'plan-eng-review'));
    copyDirSync(path.join(ROOT, 'plan-design-review'), path.join(workDir, 'plan-design-review'));
    copyDirSync(path.join(ROOT, 'plan-devex-review'), path.join(workDir, 'plan-devex-review'));

    // Register the skills as project-level slash commands. The root copies
    // above are NOT enough on their own: claude -p only discovers skills under
    // .claude/skills/, and an unregistered slash command short-circuits with
    // "Unknown command: /autoplan" (0 turns, ~1s) on claude >= 2.x — the model
    // never runs, so both voice assertions fail. Same install pattern as
    // installSkills() in skill-routing-e2e.test.ts.
    const skillsBase = path.join(workDir, '.claude', 'skills');
    for (const skill of ['autoplan', 'plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review']) {
      const dest = path.join(skillsBase, skill);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(ROOT, skill, 'SKILL.md'), path.join(dest, 'SKILL.md'));
      // Carved skills (autoplan + the plan-* reviews) keep their phase/review
      // bodies in on-demand sections/ that the skeleton STOP-Reads — mirror the
      // real install (which links sections/ next to SKILL.md) so the registered
      // skeleton's section reads resolve inside the fixture.
      const sections = path.join(ROOT, skill, 'sections');
      if (fs.existsSync(sections)) {
        copyDirSync(sections, path.join(dest, 'sections'));
      }
    }

    // Write a tiny plan file for /autoplan to review.
    planPath = path.join(workDir, 'TEST_PLAN.md');
    fs.writeFileSync(planPath, `# Test Plan: add /greet skill

## Context
Add /greet to the existing Skill Toolbox project, using its current template,
registration and generation conventions. Its only behavior is to print "hello".

## Scope
- Author greet/SKILL.md.tmpl with frontmatter name "greet", description "Print a welcome message.", and body 'Print "hello".'
- Append "greet" to the package.json skills array, preserving "about". Run the existing gen:skill-docs command to generate greet/SKILL.md and .claude/skills/greet/SKILL.md from that template.
- Add one test/greet.test.ts unit test asserting the expected frontmatter and body, and byte equality between the template and both generated files. Keep the existing about test.
`);

    // Standalone integration entry: real inputs, no claimed Step 0/spec review.
    // The separate chain case covers /autoplan startup and complete phase order.
    activePlan = path.join(stateDir, 'active-plan.md');
    const restorePath = path.join(stateDir, 'restore.md');
    initializePlan(planPath, activePlan, restorePath);
    const methodology = prepareMethodology('ceo', path.join(ROOT, 'plan-ceo-review/SKILL.md'), restorePath);
    methodologySha256 = methodology.sha256;
    const initialSnapshot = createSnapshot('ceo', activePlan, restorePath, methodology.methodologyPath);
    const core = fs.readFileSync(path.join(ROOT, 'autoplan/SKILL.md'), 'utf8');
    const phase = fs.readFileSync(path.join(ROOT, 'autoplan/sections/ceo-phase.md'), 'utf8');
    const excerpt = (source: string, start: string, end: string) => {
      const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
      if (a < 0 || b < a || source.indexOf(start, a + start.length) >= 0)
        throw Error('Autoplan phase entry source boundary changed');
      return source.slice(a, b);
    };
    const principles = excerpt(core, '## The 6 Decision Principles', '## Sequential Execution');
    const preflight = excerpt(core, '## Phase 0.5: Outside reviewer preflight', '## Phase 1: CEO Review');
    const dual = excerpt(phase, 'Step 0.5 (Dual Voices):', 'Sections 1-11 —');
    entryPath = path.join(stateDir, 'ceo-dual-entry.md');
    fs.writeFileSync(entryPath, `# Standalone CEO dual-voice review

This invocation covers the outside preflight and CEO Step 0.5 dual voices below.
The implementation is supplied directly at this phase boundary. Step 0 and its
Spec Review Loop have not run in this fixture; no prior review or completion is
claimed. The full /autoplan startup, primary review sections and later phases are
covered by a separate end-to-end invocation. Execute this section's real native
review, available outside review and consensus; report their actual results.

Bindings:
- SNAPSHOT_TOOL: ${JSON.stringify(fs.realpathSync(path.join(runtime, 'bin/gstack-autoplan-snapshot.ts')))}
- ACTIVE_PLAN: ${JSON.stringify(activePlan)}
- RESTORE_PATH: ${JSON.stringify(restorePath)}
- methodologyPath: ${JSON.stringify(methodology.methodologyPath)}
- Initial implementation snapshot (input only): ${JSON.stringify(initialSnapshot.snapshotPath)}

Before dispatch, Read the bound methodology file completely using these actual
ranges: ${JSON.stringify(methodology.readRanges)}. They contain the full current
CEO methodology, not an abridged test rubric. Then execute the following exact
current preflight and dual-voice section; preserve its native completion barrier,
input binding, outside fallback and consensus rules.

${principles}${preflight}${dual}`, { mode: 0o444, flag: 'wx' });
  };

  beforeEach(() => {
    try {
      prepareAttempt();
    } catch (error) {
      cleanup();
      throw error;
    }
  });

  afterEach(cleanup);
  afterAll(() => finalizeEvalCollector(evalCollector));

  // Skip entirely unless evals enabled (periodic tier).
  test.skipIf(!evalsEnabled)(
    'both Claude + Codex voices produce output in Phase 1 (within timeout)',
    async () => {
      // This bounded metric requires real Phase 1 voice execution, not complete
      // pipeline exit. A timeout before either dispatch remains a failure.
      const result = await runSkillTest({
        testName: 'autoplan-dual-voice',
        workingDirectory: workDir,
        env: attemptEnv,
        prompt: `Read ${JSON.stringify(entryPath)} and execute the standalone CEO dual-voice review described there.`,
        timeout: CAPTURE_LONG_MS, // 10 min
        // This real phase spawns subagents and calls codex via Bash; it needs the
        // full tool set to get past Phase 1. Bash+Read+Write alone wasn't
        // enough — the skill stalled trying to invoke Agent/Skill.
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'Skill'],
        maxTurns: 40,
        runId,
      });

      const evidence = autoplanDualVoiceEvidence(Array.isArray(result.transcript) ? result.transcript : [], {
        ownedRoots: [workDir, stateDir], cwd: workDir, activePlan, methodologySha256,
        commands: loadAutoplanDualCommandContract(ROOT),
      });
      expect(evidence.claudeVoiceFired, evidence.reasons.join('; ')).toBe(true);
      expect(evidence.codexVoiceFired || evidence.codexUnavailable, evidence.reasons.join('; ')).toBe(true);
      expect(evidence.reviewDispatched).toBe(true);

      logCost('autoplan-dual-voice', result);
      recordE2E(evalCollector, 'autoplan-dual-voice', 'Autoplan dual-voice E2E', result, {
        passed: evidence.claudeVoiceFired && (evidence.codexVoiceFired || evidence.codexUnavailable) && evidence.reviewDispatched,
      });
    },
    630_000, // per-test timeout slightly > spawn timeout so cleanup can run
  );
});
