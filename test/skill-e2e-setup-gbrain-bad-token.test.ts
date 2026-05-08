// E2E: /setup-gbrain Path 4 with a bad bearer token via Agent SDK.
//
// Drives the skill against a stub HTTP MCP server that returns 401
// (auth-shape body). Asserts that the AUTH classifier hint shows up
// AND no MCP registration happens (no claude mcp add --transport http
// in the call log; no half-written CLAUDE.md block). This is the
// regression guard for the "verify failed → STOP" gate.
//
// Cost: ~$0.30-$0.50 per run. Gate-tier (EVALS=1 EVALS_TIER=gate).

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { runAgentSdkTest, passThroughNonAskUserQuestion, resolveClaudeBinary } from './helpers/agent-sdk-runner';

// Periodic-tier (companion to skill-e2e-setup-gbrain-remote.test.ts).
// Deterministic gate coverage lives in setup-gbrain-path4-structure.test.ts.
const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

function startStub401(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: 'unauthorized', error_description: 'invalid or expired auth token' })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function makeFakeClaude(fakeBinDir: string): string {
  const callLog = path.join(fakeBinDir, 'claude-calls.log');
  const script = `#!/bin/bash
echo "claude $@" >> "${callLog}"
case "$1 $2" in
  "mcp add") exit 0 ;;
  "mcp list") echo "no gbrain" ; exit 0 ;;
  "mcp remove") exit 0 ;;
  "mcp get") exit 1 ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(fakeBinDir, 'claude'), script, { mode: 0o755 });
  return callLog;
}

describeE2E('/setup-gbrain Path 4 — bad token STOPs cleanly', () => {
  test('AUTH classifier fires, no MCP registration, no CLAUDE.md mutation', async () => {
    const stubServer = await startStub401();
    const gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gbrain-bad-'));
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gbrain-bad-bin-'));
    const callLog = makeFakeClaude(fakeBinDir);

    const ORIGINAL_CLAUDE_MD = '# Test project\n\nSome existing content here.\n';
    fs.writeFileSync(path.join(gstackHome, 'CLAUDE.md'), ORIGINAL_CLAUDE_MD);

    const BAD_TOKEN = 'gbrain_BAD_TOKEN_67890_DELIBERATELY_INVALID';
    const askUserQuestions: Array<{ input: Record<string, unknown> }> = [];
    const binary = resolveClaudeBinary();

    const orig = {
      gstackHome: process.env.GSTACK_HOME,
      pathEnv: process.env.PATH,
      mcpToken: process.env.GBRAIN_MCP_TOKEN,
    };
    process.env.GSTACK_HOME = gstackHome;
    process.env.PATH = `${fakeBinDir}:${path.join(path.resolve(import.meta.dir, '..'), 'bin')}:${process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin'}`;
    process.env.GBRAIN_MCP_TOKEN = BAD_TOKEN;

    let modelTextOutput = '';

    try {
      const skillPath = path.resolve(import.meta.dir, '..', 'setup-gbrain', 'SKILL.md');
      const result = await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        userPrompt:
          `Read the skill file at ${skillPath} and follow Path 4 (Remote MCP) only. ` +
          `Use this MCP URL: ${stubServer.url}. ` +
          `The bearer token is already in the GBRAIN_MCP_TOKEN env var. ` +
          `If verify fails (Step 4c), follow the skill's STOP rule — surface the error and stop. ` +
          `Do NOT register the MCP if verify failed. ` +
          `Do NOT modify CLAUDE.md if verify failed.`,
        workingDirectory: gstackHome,
        maxTurns: 15,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName === 'AskUserQuestion') {
            askUserQuestions.push({ input });
            const q = (input.questions as Array<{
              question: string;
              options: Array<{ label: string }>;
            }>)[0];
            const decline = q.options.find((o) => /skip|decline|no/i.test(o.label)) ?? q.options[0]!;
            return {
              behavior: 'allow',
              updatedInput: { questions: input.questions, answers: { [q.question]: decline.label } },
            };
          }
          return passThroughNonAskUserQuestion(toolName, input);
        },
      });

      modelTextOutput = JSON.stringify(result);

      // Assertion 1: the AUTH classifier hint surfaced somewhere in the run.
      // The verify helper outputs `"error_class": "AUTH"` and the hint
      // "rotate token on the brain host" — at least one should be visible.
      const hintShown =
        /error_class.*AUTH/i.test(modelTextOutput) ||
        /rotate token/i.test(modelTextOutput) ||
        /AUTH.*HTTP 401/i.test(modelTextOutput);
      expect(hintShown).toBe(true);

      // Assertion 2: claude mcp add was NEVER called (verify failed → STOP).
      const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf-8') : '';
      expect(calls).not.toMatch(/mcp add.*--transport http/);

      // Assertion 3: CLAUDE.md is unchanged (no half-written block).
      const finalClaudeMd = fs.readFileSync(path.join(gstackHome, 'CLAUDE.md'), 'utf-8');
      expect(finalClaudeMd).toBe(ORIGINAL_CLAUDE_MD);

      // Assertion 4: the bad token never leaked to CLAUDE.md.
      expect(finalClaudeMd).not.toContain(BAD_TOKEN);
    } finally {
      if (orig.gstackHome === undefined) delete process.env.GSTACK_HOME; else process.env.GSTACK_HOME = orig.gstackHome;
      if (orig.pathEnv === undefined) delete process.env.PATH; else process.env.PATH = orig.pathEnv;
      if (orig.mcpToken === undefined) delete process.env.GBRAIN_MCP_TOKEN; else process.env.GBRAIN_MCP_TOKEN = orig.mcpToken;
      await stubServer.close();
      fs.rmSync(gstackHome, { recursive: true, force: true });
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  }, 240_000);
});
