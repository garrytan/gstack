// E2E: /setup-gbrain Path 4 with Step 4d "Yes" — local PGLite for code search.
//
// Drives the skill against a stub HTTP MCP server (200 OK on tools/list).
// Auto-answers AskUserQuestion to pick:
//   - Path 4 at Step 2 (Remote gbrain MCP)
//   - "Yes, set up local PGLite for code" at Step 4d
//
// Asserts that the model:
//   1. ran the verify helper successfully (got past Step 4c)
//   2. invoked gstack-gbrain-install (Step 4d Yes branch)
//   3. invoked `gbrain init --pglite --json` (also Step 4d Yes branch)
//   4. registered the remote MCP via claude mcp add --transport http
//   5. accepted the local-PGLite offer and left a local engine config
//
// Periodic-tier (codex #12: AgentSDK harness is non-deterministic; gate-tier
// coverage of the split-engine behavior lives in the deterministic unit
// tests at gbrain-local-status.test.ts, gbrain-sync-skip.test.ts, etc).
//
// Cost: ~$0.50-$1.00 per run. Periodic-tier (EVALS=1 EVALS_TIER=periodic).

import { test, expect, afterAll } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import {
  passThroughNonAskUserQuestion,
  resolveClaudeBinary,
} from './helpers/agent-sdk-runner';
import { createSetupGbrainSandbox, runSetupGbrainAttempt, SETUP_GBRAIN_FINALIZE_MS } from './helpers/setup-gbrain-sandbox';
import { chooseLocalPgliteFixtureAnswer } from './helpers/setup-gbrain-fixture';
import { EvalCollector } from './helpers/eval-store';

const describeE2E = describeE2ETier('periodic');
const evalCollector = e2eTierEnabled('periodic') ? new EvalCollector('e2e') : null;
afterAll(async () => { if (evalCollector) await evalCollector.finalize(); });

describeE2E('/setup-gbrain Path 4 + Step 4d Yes → local PGLite for code', () => {
  test('opt-in flow invokes install + gbrain init + remote MCP register', async () => {
    const started = Date.now();
    const binary = resolveClaudeBinary();
    const fixture = await createSetupGbrainSandbox({
      name: 'local-pglite', status: 200,
      sections: ['brain-init.md', 'claude-md-persist.md'], originalClaudeMd: '# Test project\n',
    });
    const askLog: Array<{ question: string; choice: string }> = [];
    await runSetupGbrainAttempt(fixture, {
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      userPrompt:
        `Read the skill file at ${fixture.skillPath} and follow Path 4 (Remote MCP). ` +
        `Use this MCP URL: ${fixture.url}. ` +
        `The bearer token is already in GBRAIN_MCP_TOKEN; use it without printing it. ` +
        `At Step 4d ("Want symbol-aware code search?"), ask the question and PICK YES — set up local PGLite for code. ` +
        `Then continue through Step 5a (MCP registration) → Step 10 (verdict). ` +
        `Decline optional artifacts sync. Do not skip the Step 4d local-PGLite offer.`,
      maxTurns: 25,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      canUseTool: async (toolName, input) => {
        if (toolName !== 'AskUserQuestion') return passThroughNonAskUserQuestion(toolName, input);
        const questions = input.questions as Array<{
          question: string; options: Array<{ label: string }>;
        }>;
        const answers: Record<string, string> = {};
        for (const q of questions) {
          const choice = chooseLocalPgliteFixtureAnswer(q);
          answers[q.question] = choice;
          askLog.push({ question: q.question, choice });
        }
        return { behavior: 'allow', updatedInput: { questions, answers } };
      },
    }, (result) => {
      expect(askLog.length).toBeGreaterThan(0);
      expect(askLog.some((q) => /code search|pglite|symbol/i.test(q.question) &&
        /yes|local|pglite/i.test(q.choice))).toBe(true);
      const calls = fixture.commands();
      expect(fixture.requests.some((r) => r.rpcMethod === 'initialize' && r.authorizationMatches)).toBe(true);
      expect(calls.some((c) => c.command === 'gstack-gbrain-mcp-verify' && c.phase === 'end' &&
        c.exitCode === 0 && /"status":\s*"success"/.test(c.stdout))).toBe(true);
      expect(calls.some((c) => c.command === 'gstack-gbrain-install' && c.phase === 'end' && c.exitCode === 0)).toBe(true);
      expect(calls.some((c) => c.command === 'gbrain' && c.phase === 'start' && c.args[0] === 'init' && c.args.includes('--pglite'))).toBe(true);
      expect(calls.some((c) => c.command === 'claude' && c.phase === 'start' && c.args[1] === 'add' && c.authorizationMatches)).toBe(true);
      const final = fixture.snapshot();
      expect(final.mcp.registered).toBe(true);
      expect(JSON.parse(final.gbrainConfig ?? '{}').engine).toBe('pglite');
      expect(final.claudeMdTokenLeak).toBe(false);
      expect(result.output.includes(fixture.token)).toBe(false);
    }, CAPTURE_MS - (Date.now() - started), {
      collector: evalCollector, name: 'setup-gbrain-path4-local-pglite', suite: 'setup-gbrain',
    });
  }, CAPTURE_MS + SETUP_GBRAIN_FINALIZE_MS);
});
