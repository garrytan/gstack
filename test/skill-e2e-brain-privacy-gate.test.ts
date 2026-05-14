/**
 * Privacy-gate E2E (periodic tier, paid).
 *
 * The gbrain-sync preamble block instructs the model to fire a one-time
 * AskUserQuestion when:
 *   - `BRAIN_SYNC: off` in the preamble echo (sync mode not on)
 *   - config `artifacts_sync_mode_prompted` is "false"
 *   - gbrain is detected on the host (binary on PATH or `gbrain doctor`
 *     --fast --json succeeds)
 *
 * This test stages all three conditions (via env + a fake `gbrain` binary
 * on PATH), runs a cheap gstack skill through the Agent SDK, intercepts
 * every tool use via canUseTool, and asserts: one of the AskUserQuestions
 * fired by the preamble is the privacy gate with its distinctive prose
 * and three options (full / artifacts-only / decline).
 *
 * Cost: ~$0.30-$0.50 per run. Periodic tier (EVALS=1 EVALS_TIER=periodic).
 *
 * See scripts/resolvers/preamble/generate-brain-sync-block.ts for the
 * prose contract this test locks in.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentSdkTest, passThroughNonAskUserQuestion, resolveClaudeBinary } from './helpers/agent-sdk-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('gbrain-sync privacy gate fires once via preamble', () => {
  test('gstack skill preamble fires the 3-option AskUserQuestion when gbrain is detected', async () => {
    // Stage a fresh GSTACK_HOME with artifacts_sync_mode_prompted=false.
    const gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-gate-gstack-'));
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-gate-bin-'));

    // Seed the config so the gate's condition passes.
    fs.writeFileSync(
      path.join(gstackHome, 'config.yaml'),
      'artifacts_sync_mode: off\nartifacts_sync_mode_prompted: false\n',
      { mode: 0o600 }
    );

    // Fake `gbrain` binary that makes the host-detection probe succeed.
    // The preamble checks `gbrain doctor --fast --json` OR `which gbrain`.
    // Either branch counts as "gbrain detected."
    fs.writeFileSync(
      path.join(fakeBinDir, 'gbrain'),
      '#!/bin/bash\n' +
        'case "$1" in\n' +
        '  doctor) echo \'{"status":"ok","schema_version":2}\' ; exit 0 ;;\n' +
        '  --version) echo "0.18.2" ; exit 0 ;;\n' +
        '  *) exit 0 ;;\n' +
        'esac\n',
      { mode: 0o755 }
    );

    const askUserQuestions: Array<{ input: Record<string, unknown> }> = [];
    const binary = resolveClaudeBinary();

    // Ambient env mutations — restored in finally so other tests in the file
    // don't inherit them.
    const origGstackHome = process.env.GSTACK_HOME;
    const origPath = process.env.PATH;
    process.env.GSTACK_HOME = gstackHome;
    process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin'}`;

    try {
      // Pick a small skill with the preamble and load it via Read to force
      // the model to execute every preamble directive. A narrow "run /learn"
      // prompt often gets reduced to a direct action, skipping the preamble
      // gates. Mirror the plan-mode-no-op test pattern: ask the model to
      // follow the skill's instructions in full.
      const learnSkill = path.resolve(
        import.meta.dir,
        '..',
        'learn',
        'SKILL.md'
      );
      await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        userPrompt:
          `Read the skill file at ${learnSkill} and follow its instructions from the top, including every preamble directive. Execute every bash block. If any AskUserQuestion fires, present it.`,
        workingDirectory: gstackHome,
        maxTurns: 10,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        // NOTE: do NOT pass `env:` here. When the Agent SDK gets an explicit
        // env object, its auth pipeline doesn't pick up ANTHROPIC_API_KEY the
        // same way as when env is undefined (SDK-internal detail, verified
        // against the plan-mode-no-op test which passes no env and auths
        // cleanly). Instead, mutate process.env before the call so the SDK
        // inherits our overrides ambiently.
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName === 'AskUserQuestion') {
            askUserQuestions.push({ input });
            // Auto-answer "Decline — keep everything local" (option C)
            // so the skill can continue without actually turning on sync.
            const q = (input.questions as Array<{
              question: string;
              options: Array<{ label: string }>;
            }>)[0];
            const decline =
              q.options.find((o) => /decline|keep everything local|no thanks/i.test(o.label)) ??
              q.options[q.options.length - 1]!;
            return {
              behavior: 'allow',
              updatedInput: {
                questions: input.questions,
                answers: { [q.question]: decline.label },
              },
            };
          }
          return passThroughNonAskUserQuestion(toolName, input);
        },
      });

      // Assertion 1: the privacy gate fired.
      const privacyQuestions = askUserQuestions.filter((aq) => {
        const qs = aq.input.questions as Array<{ question: string }>;
        return qs.some(
          (q) =>
            /publish.*session memory|private github repo|gbrain indexes/i.test(q.question)
        );
      });
      expect(privacyQuestions.length).toBeGreaterThanOrEqual(1);

      // Assertion 2: the question has the three expected options.
      const gate = privacyQuestions[0]!.input.questions as Array<{
        question: string;
        options: Array<{ label: string }>;
      }>;
      const labels = gate[0]!.options.map((o) => o.label.toLowerCase()).join(' | ');
      // Full / artifacts-only / decline are the three canonical options.
      expect(labels).toMatch(/everything|allowlisted|full/);
      expect(labels).toMatch(/artifact/);
      expect(labels).toMatch(/decline|local|no thanks/);

      // Assertion 3: the gate should NOT fire twice in one run.
      // (The preamble is supposed to be idempotent within a session.)
      expect(privacyQuestions.length).toBe(1);
    } finally {
      // Restore ambient env before other tests.
      if (origGstackHome === undefined) delete process.env.GSTACK_HOME;
      else process.env.GSTACK_HOME = origGstackHome;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      fs.rmSync(gstackHome, { recursive: true, force: true });
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  }, 180_000);

  test('privacy gate does NOT fire when artifacts_sync_mode_prompted is already true', async () => {
    // Same staging, but prompted=true this time. Gate should be silent.
    const gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-gate-off-'));
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-gate-off-bin-'));

    fs.writeFileSync(
      path.join(gstackHome, 'config.yaml'),
      'artifacts_sync_mode: off\nartifacts_sync_mode_prompted: true\n',
      { mode: 0o600 }
    );

    fs.writeFileSync(
      path.join(fakeBinDir, 'gbrain'),
      '#!/bin/bash\necho \'{"status":"ok"}\'\nexit 0\n',
      { mode: 0o755 }
    );

    const askUserQuestions: Array<{ input: Record<string, unknown> }> = [];
    const binary = resolveClaudeBinary();

    // Ambient env mutations (see note on the first test).
    const origGstackHome = process.env.GSTACK_HOME;
    const origPath = process.env.PATH;
    process.env.GSTACK_HOME = gstackHome;
    process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin'}`;

    try {
      await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        userPrompt:
          'Run /learn with no arguments. Just report the learnings count.',
        workingDirectory: gstackHome,
        maxTurns: 4,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName === 'AskUserQuestion') {
            askUserQuestions.push({ input });
            // Pass through whatever the model asks; don't prefer anything.
            const q = (input.questions as Array<{
              question: string;
              options: Array<{ label: string }>;
            }>)[0];
            return {
              behavior: 'allow',
              updatedInput: {
                questions: input.questions,
                answers: { [q.question]: q.options[0]!.label },
              },
            };
          }
          return passThroughNonAskUserQuestion(toolName, input);
        },
      });

      // No AskUserQuestion should have matched the privacy gate's prose.
      const privacyQuestions = askUserQuestions.filter((aq) => {
        const qs = aq.input.questions as Array<{ question: string }>;
        return qs.some(
          (q) =>
            /publish.*session memory|private github repo|gbrain indexes/i.test(q.question)
        );
      });
      expect(privacyQuestions.length).toBe(0);
    } finally {
      if (origGstackHome === undefined) delete process.env.GSTACK_HOME;
      else process.env.GSTACK_HOME = origGstackHome;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      fs.rmSync(gstackHome, { recursive: true, force: true });
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  }, 180_000);
});
