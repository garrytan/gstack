import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ceoOnlyEvidence, listFiles } from './helpers/autoplan-ceo-only-evidence';
import { PTY_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import { buildSeedConfig, seedHermeticGstackHome, seedHermeticRuntimeView } from './helpers/hermetic-env';
import { FORCING_FLOOR_CEO } from './fixtures/forcing-finding-seeds';
import {
  ROOT, runId, evalsEnabled, describeIfSelected, logCost, recordE2E, copyDirSync, createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';

// /autoplan --ceo-only must finish a CEO review without asking anything (GST-537).
// The seed is the plan that makes interactive /plan-ceo-review ask a question
// (test/skill-e2e-plan-ceo-finding-floor.test.ts is the control on the same seed).
// Every check is a pure function over the transcript and files,
// proven against negative controls in test/autoplan-ceo-only.test.ts.

const evalCollector = createEvalCollector('e2e-autoplan-ceo-only');
// Declared roots in the isolated HOME: the state root, the host's own config and temp, and
// Bun's package cache (the runtime writes it under HOME on first use; run gsta215-e2e-2).
const OWNED_HOME_ROOTS = ['gstack-home', '.claude', 'tmp', '.bun/install/cache', '.capy/git-shim.log'];

describeIfSelected('Autoplan CEO-only E2E', ['autoplan-ceo-only'], () => {
  let workDir = '';
  let stateDir = '';
  let env: Record<string, string> = {};
  let homeBefore: string[] = [];

  const cleanup = () => {
    for (const dir of [workDir, stateDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  };

  beforeEach(() => {
    try {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-autoplan-ceo-only-'));
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-autoplan-ceo-only-state-'));
      const configDir = path.join(stateDir, '.claude');
      const gstackHome = path.join(stateDir, 'gstack-home');
      const tempDir = path.join(stateDir, 'tmp');
      fs.mkdirSync(configDir);
      fs.mkdirSync(gstackHome);
      fs.mkdirSync(tempDir, { mode: 0o700 });
      fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(buildSeedConfig({
        apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.GSTACK_ANTHROPIC_API_KEY, trustedDirs: [workDir],
      })), { mode: 0o600 });
      seedHermeticGstackHome(gstackHome);
      fs.mkdirSync(path.join(configDir, 'skills'));
      seedHermeticRuntimeView(ROOT, path.join(configDir, 'skills', 'gstack'));
      env = { HOME: stateDir, CLAUDE_CONFIG_DIR: configDir, GSTACK_HOME: gstackHome, GSTACK_STATE_ROOT: gstackHome,
        TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir };

      const git = (...args: string[]) => {
        const r = spawnSync('git', args, { cwd: workDir, encoding: 'utf8', timeout: 10_000 });
        if (r.error || r.status !== 0) throw new Error(`CEO-only fixture setup failed: ${r.error?.message ?? r.stderr}`);
      };
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');
      // The seed's first line asks for a /tmp plan copy; the plan itself is the rest.
      fs.writeFileSync(path.join(workDir, 'PLAN.md'), FORCING_FLOOR_CEO.split('\n').slice(2).join('\n') + '\n');
      fs.writeFileSync(path.join(workDir, 'README.md'), '# Acme API\n\nA paid HTTP API with one pricing tier.\n');
      git('add', '.');
      git('-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Plan');
      for (const skill of ['autoplan', 'plan-ceo-review']) {
        const dest = path.join(workDir, '.claude', 'skills', skill);
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(path.join(ROOT, skill, 'SKILL.md'), path.join(dest, 'SKILL.md'));
        copyDirSync(path.join(ROOT, skill, 'sections'), path.join(dest, 'sections'));
      }
      homeBefore = listFiles(stateDir, OWNED_HOME_ROOTS);
    } catch (error) {
      cleanup();
      throw error;
    }
  });

  afterEach(cleanup);
  afterAll(() => finalizeEvalCollector(evalCollector));

  // Titled by its E2E id so scripts/lib/paid-cases.ts needs no CASE_TEST_NAMES entry.
  test.skipIf(!evalsEnabled)('autoplan-ceo-only', async () => {
    const result = await runSkillTest({
      testName: 'autoplan-ceo-only',
      workingDirectory: workDir,
      env,
      prompt: '/autoplan --ceo-only --no-outside\n\nReview the plan in PLAN.md.',
      timeout: PTY_LONG_MS,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'Skill'],
      maxTurns: 200,
      runId,
    });
    const before = new Set(homeBefore);
    const evidence = ceoOnlyEvidence({
      transcript: Array.isArray(result.transcript) ? result.transcript : [],
      output: result.output,
      strayWrites: listFiles(stateDir, OWNED_HOME_ROOTS).filter(f => !before.has(f)),
      mustMention: [/developer/i, /talk|interview|validat|evidence|research/i],
    });
    logCost('autoplan-ceo-only', result);
    recordE2E(evalCollector, 'autoplan-ceo-only', 'Autoplan CEO-only E2E', result, {
      passed: evidence.passed, ...(evidence.reasons.length ? { error: evidence.reasons.join('; ') } : {}),
    });
    expect(evidence.reasons).toEqual([]);
  }, PTY_LONG_MS + 60_000);
});
