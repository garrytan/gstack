// E2E: /setup-gbrain Path 4 with a bad bearer token via Agent SDK.
//
// Drives the skill against a stub HTTP MCP server that returns 401
// (auth-shape body). Asserts that the AUTH classifier hint shows up
// AND no MCP registration happens (no claude mcp add --transport http
// in the call log; no half-written CLAUDE.md block). This is the
// regression guard for the "verify failed → STOP" gate.
//
// Cost: ~$0.30-$0.50 per run. Periodic-tier (EVALS=1 EVALS_TIER=periodic).
//
// Carve-aware: the Step 4 Path 4 body (collect URL/token, verify, STOP rule)
// lives in setup-gbrain/sections/brain-init.md, so the fixture inlines that
// section into the skeleton via buildSetupGbrainFixture. Step 8 is not needed:
// on a failed verify the skill STOPs before any CLAUDE.md write.

import { test, expect } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  passThroughNonAskUserQuestion,
  resolveClaudeBinary,
} from './helpers/agent-sdk-runner';
import { createSetupGbrainSandbox, runSetupGbrainAttempt, SETUP_GBRAIN_FINALIZE_MS } from './helpers/setup-gbrain-sandbox';

const describeE2E = describeE2ETier('periodic');

describeE2E('/setup-gbrain Path 4 — bad token STOPs cleanly', () => {
  test('AUTH classifier fires, no MCP registration, no CLAUDE.md mutation', async () => {
    const started = Date.now();
    // Resolve the real SDK runner before placing the owned fake claude on child PATH.
    const binary = resolveClaudeBinary();
    const fixture = await createSetupGbrainSandbox({
      name: 'bad-token', status: 401, sections: ['brain-init.md'],
      originalClaudeMd: '# Test project\n\nSome existing content here.\n',
    });
    await runSetupGbrainAttempt(fixture, {
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      userPrompt:
        `Read the skill file at ${fixture.skillPath} and follow Path 4 (Remote MCP) only. ` +
        `Use this MCP URL: ${fixture.url}. ` +
        `The bearer token is already in the GBRAIN_MCP_TOKEN env var; use it without printing it. ` +
        `If verify fails (Step 4c), follow the skill's STOP rule — surface the error and stop. ` +
        `Do NOT register the MCP if verify failed. Do NOT modify CLAUDE.md if verify failed.`,
      maxTurns: 15,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      canUseTool: async (toolName, input) => {
        if (toolName !== 'AskUserQuestion') return passThroughNonAskUserQuestion(toolName, input);
        const questions = input.questions as Array<{
          question: string; options: Array<{ label: string }>;
        }>;
        const answers = Object.fromEntries(questions.map((q) => [
          q.question,
          (q.options.find((o) => /skip|decline|no/i.test(o.label)) ?? q.options[0]!).label,
        ]));
        return { behavior: 'allow', updatedInput: { questions, answers } };
      },
    }, (result) => {
      const modelText = JSON.stringify(result);
      const hintShown = /error_class.*AUTH/i.test(modelText) || /rotate token/i.test(modelText) || /AUTH.*HTTP 401/i.test(modelText);
      expect(hintShown).toBe(true);
      // Establish that the AUTH hint came from the real verifier hitting our stub.
      expect(fixture.requests.some((r) => r.status === 401 && r.authorizationMatches)).toBe(true);
      const calls = fixture.commands();
      const verified = calls.some((c) => c.command === 'gstack-gbrain-mcp-verify' && c.phase === 'end' &&
        c.exitCode === 1 && /"error_class":\s*"AUTH"/.test(c.stdout));
      expect(verified).toBe(true);
      expect(calls.some((c) => c.command === 'claude' && c.phase === 'start' && c.args[0] === 'mcp' && c.args[1] === 'add')).toBe(false);
      expect(fixture.snapshot().mcp.registered).toBe(false);
      expect(fixture.snapshot().claudeMdUnchanged).toBe(true);
      expect(fixture.snapshot().claudeMdTokenLeak).toBe(false);
      expect(result.output.includes(fixture.token)).toBe(false);
    }, CAPTURE_MS - (Date.now() - started));
  }, CAPTURE_MS + SETUP_GBRAIN_FINALIZE_MS);
});
