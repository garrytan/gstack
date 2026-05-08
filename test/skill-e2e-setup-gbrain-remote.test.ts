// E2E: /setup-gbrain Path 4 (Remote MCP) happy path via Agent SDK.
//
// Drives the skill against a stub HTTP MCP server and a stubbed `claude`
// binary that records `claude mcp add` calls. Asserts:
//   - The verify helper succeeds (no AUTH/MALFORMED/NETWORK error in output)
//   - The skill calls `claude mcp add --transport http` with the bearer
//   - The token NEVER appears in the CLAUDE.md block the skill writes
//   - The wrote_findings_before_asking failure mode is NOT triggered
//
// Cost: ~$0.30-$0.50 per run. Gate-tier (EVALS=1 EVALS_TIER=gate).
//
// See setup-gbrain/SKILL.md.tmpl Step 4 (Path 4) for the contract under test.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { runAgentSdkTest, passThroughNonAskUserQuestion, resolveClaudeBinary } from './helpers/agent-sdk-runner';

// Periodic-tier: the model's interpretation of "follow Path 4 only" is
// non-deterministic (it sometimes skips Step 8 CLAUDE.md write, sometimes
// shortcuts past the verify helper). The deterministic gate coverage for
// Path 4 lives in test/setup-gbrain-path4-structure.test.ts (free, <200ms).
const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

// Spin up a stub MCP server that responds to initialize + tools/list.
function startStubMcpServer(opts: { failWithStatus?: number; failBody?: string } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/mcp')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (opts.failWithStatus) {
          res.statusCode = opts.failWithStatus;
          res.setHeader('Content-Type', 'application/json');
          res.end(opts.failBody ?? JSON.stringify({ error: 'fail' }));
          return;
        }
        const reqJson = (() => {
          try { return JSON.parse(body); } catch { return {} as any; }
        })();
        let respBody: any;
        if (reqJson.method === 'initialize') {
          respBody = {
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'gbrain', version: '0.27.1' },
            },
            jsonrpc: '2.0',
            id: reqJson.id,
          };
        } else if (reqJson.method === 'tools/list') {
          respBody = { result: { tools: [{ name: 'search' }, { name: 'put_page' }] }, jsonrpc: '2.0', id: reqJson.id };
        } else {
          respBody = { error: { code: -32601, message: 'unknown method' }, jsonrpc: '2.0', id: reqJson.id };
        }
        // SSE-shape since the verify helper supports both, and many MCP
        // servers (including wintermute) wrap responses as SSE.
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`event: message\ndata: ${JSON.stringify(respBody)}\n\n`);
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

// Stubbed `claude` binary: intercepts `mcp add` and `mcp list` commands so
// the skill's Step 5a registration appears to succeed, while we record
// every invocation for assertions.
function makeFakeClaude(fakeBinDir: string): string {
  const claudeJsonPath = path.join(fakeBinDir, 'claude.json');
  const callLog = path.join(fakeBinDir, 'claude-calls.log');
  const script = `#!/bin/bash
echo "claude $@" >> "${callLog}"
case "$1 $2" in
  "mcp add")
    # Just record the call; pretend it succeeded.
    exit 0
    ;;
  "mcp list")
    echo "gbrain: http://127.0.0.1:0/mcp (HTTP) - ✓ Connected"
    exit 0
    ;;
  "mcp remove")
    exit 0
    ;;
  "mcp get")
    # First few calls return "no entry"; after mcp add fires, return success.
    if [ -f "${claudeJsonPath}" ]; then
      cat "${claudeJsonPath}"
      exit 0
    fi
    exit 1
    ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(fakeBinDir, 'claude'), script, { mode: 0o755 });
  return callLog;
}

describeE2E('/setup-gbrain Path 4 (Remote MCP) — happy path', () => {
  test('verifies, registers HTTP MCP, never writes token to CLAUDE.md', async () => {
    const stubServer = await startStubMcpServer();
    const gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gbrain-remote-'));
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gbrain-remote-bin-'));
    const callLog = makeFakeClaude(fakeBinDir);

    // The skill writes CLAUDE.md in cwd. Use gstackHome as cwd so we
    // can inspect it after the run.
    fs.writeFileSync(path.join(gstackHome, 'CLAUDE.md'), '# Test project\n');

    const SECRET_TOKEN = 'gbrain_TEST_TOKEN_THAT_MUST_NEVER_LEAK_84613';
    const askUserQuestions: Array<{ input: Record<string, unknown> }> = [];
    const binary = resolveClaudeBinary();

    // Ambient env mutations. Restored in finally.
    const orig = {
      gstackHome: process.env.GSTACK_HOME,
      pathEnv: process.env.PATH,
      mcpToken: process.env.GBRAIN_MCP_TOKEN,
    };
    process.env.GSTACK_HOME = gstackHome;
    process.env.PATH = `${fakeBinDir}:${path.join(path.resolve(import.meta.dir, '..'), 'bin')}:${process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin'}`;
    process.env.GBRAIN_MCP_TOKEN = SECRET_TOKEN;

    let modelTextOutput = '';

    try {
      const skillPath = path.resolve(import.meta.dir, '..', 'setup-gbrain', 'SKILL.md');
      const result = await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        userPrompt:
          `Read the skill file at ${skillPath} and follow Path 4 (Remote MCP) only. ` +
          `Use this MCP URL: ${stubServer.url}. ` +
          `The bearer token is already in the GBRAIN_MCP_TOKEN env var (do not echo it). ` +
          `Skip the privacy gate — answer "Decline" if the preamble fires. ` +
          `Skip the artifacts-repo provisioning step (Step 7) — answer "No thanks". ` +
          `Skip per-remote policy (Step 6) — answer "skip-for-now". ` +
          `Walk through Steps 4a, 4b, 4c, 5a, 8, 10 ONLY.`,
        workingDirectory: gstackHome,
        maxTurns: 25,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName === 'AskUserQuestion') {
            askUserQuestions.push({ input });
            const q = (input.questions as Array<{
              question: string;
              options: Array<{ label: string }>;
            }>)[0];
            // Auto-decline / skip everything except the path-pick (which the
            // user-prompt already directed to Path 4).
            const decline =
              q.options.find((o) => /skip|decline|no thanks|local/i.test(o.label)) ?? q.options[q.options.length - 1]!;
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

      modelTextOutput = JSON.stringify(result);

      // Assertion 1: no classified failure surfaced.
      // Match the literal verify-helper field shape (avoid false-positives
      // from parent session's "needs-auth" MCP server discovery markers).
      // We can't deterministically force the model to invoke the verify
      // helper through user-prompt alone, so the bound here is "if verify
      // ran and emitted an error class, it wasn't NETWORK / AUTH / MALFORMED."
      expect(modelTextOutput).not.toMatch(/"error_class"\s*:\s*"NETWORK"/);
      expect(modelTextOutput).not.toMatch(/"error_class"\s*:\s*"AUTH"/);
      expect(modelTextOutput).not.toMatch(/"error_class"\s*:\s*"MALFORMED"/);

      // Assertion 2: claude mcp add was called with --transport http.
      const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf-8') : '';
      expect(calls).toMatch(/mcp add.*--transport http/);

      // Assertion 3: the secret token NEVER appears in the final CLAUDE.md.
      const claudeMd = fs.readFileSync(path.join(gstackHome, 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).not.toContain(SECRET_TOKEN);

      // Assertion 4: CLAUDE.md got the remote-http block.
      expect(claudeMd).toMatch(/Mode: remote-http/);

      // Assertion 5: classifier — the model didn't write findings before
      // asking. The Path 4 prose has 5 STOP gates; if any of them got
      // skipped, that's the wrote_findings_before_asking pattern.
      const wroteBefore = /## GSTACK REVIEW REPORT|critical_gaps/i.test(modelTextOutput);
      // Setup-gbrain doesn't have a review report contract, so this is
      // a structural shape check, not a hard failure mode.
      expect(wroteBefore).toBe(false);
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
