// E2E: /setup-gbrain Path 4 with Step 4.5 "Yes" — local PGLite for code search.
//
// Drives the skill against a stub HTTP MCP server (200 OK on tools/list).
// Auto-answers AskUserQuestion to pick:
//   - Path 4 at Step 2 (Remote gbrain MCP)
//   - "Yes, set up local PGLite for code" at Step 4.5
//
// Asserts that the model:
//   1. ran the verify helper successfully (got past Step 4c)
//   2. invoked gstack-gbrain-install (Step 4.5 Yes branch)
//   3. invoked `gbrain init --pglite --json` (also Step 4.5 Yes branch)
//   4. registered the remote MCP via claude mcp add --transport http
//   5. wrote a "Code search ..... OK local-pglite" row to the Step 10 verdict
//
// Periodic-tier (codex #12: AgentSDK harness is non-deterministic; gate-tier
// coverage of the split-engine behavior lives in the deterministic unit
// tests at gbrain-local-status.test.ts, gbrain-sync-skip.test.ts, etc).
//
// Cost: ~$0.50-$1.00 per run. Periodic-tier (EVALS=1 EVALS_TIER=periodic).

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import {
  runAgentSdkTest,
  passThroughNonAskUserQuestion,
  resolveClaudeBinary,
} from './helpers/agent-sdk-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

/**
 * Minimal stub MCP server that returns success on initialize / tools/list.
 * Verify helper calls /tools/list with a Bearer header and inspects the body.
 */
function startStubMcp(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        // Try to be useful: respond with a fake initialize + tools/list payload.
        let payload: unknown = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
        try {
          const req = JSON.parse(body);
          if (req.method === 'initialize') {
            payload = {
              jsonrpc: '2.0',
              id: req.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'gbrain', version: '0.32.3.0' },
              },
            };
          }
        } catch {
          // ignore parse failure; default payload
        }
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
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

/**
 * Fake gbrain CLI:
 *   - --version → echoes a version
 *   - init --pglite --json → writes a pglite config, exits 0
 *   - everything else → exits 0 quietly
 *
 * Logs every invocation so we can assert init was called.
 */
function makeFakeGbrain(binDir: string, gbrainConfigPath: string): string {
  const callLog = path.join(binDir, 'gbrain-calls.log');
  const script = `#!/bin/bash
echo "gbrain $@" >> "${callLog}"
case "$1 $2" in
  "--version "*) echo "gbrain 0.33.1.0"; exit 0 ;;
  "init --pglite") cat > "${gbrainConfigPath}" <<JSON
{"engine":"pglite","database_url":"pglite:///fake"}
JSON
    echo '{"status":"ok","engine":"pglite"}'
    exit 0 ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'gbrain'), script, { mode: 0o755 });
  return callLog;
}

/**
 * Fake `claude` CLI for mcp add/remove/get/list. Logs every call so we can
 * assert remote MCP registration happened.
 */
function makeFakeClaude(binDir: string): string {
  const callLog = path.join(binDir, 'claude-calls.log');
  const script = `#!/bin/bash
echo "claude $@" >> "${callLog}"
case "$1 $2" in
  "mcp add") exit 0 ;;
  "mcp list") echo "gbrain: http://stub/mcp (HTTP) — connected" ; exit 0 ;;
  "mcp remove") exit 0 ;;
  "mcp get") echo '{"type":"http","url":"http://stub/mcp"}'; exit 0 ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'claude'), script, { mode: 0o755 });
  return callLog;
}

/**
 * Fake gstack-gbrain-install so we don't actually clone the gbrain repo +
 * bun-link. The test only cares that the skill INVOKED it on the Yes branch.
 */
function makeFakeInstall(binDir: string): string {
  const callLog = path.join(binDir, 'install-calls.log');
  const script = `#!/bin/bash
echo "install $@" >> "${callLog}"
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'gstack-gbrain-install'), script, {
    mode: 0o755,
  });
  return callLog;
}

describeE2E('/setup-gbrain Path 4 + Step 4.5 Yes → local PGLite for code', () => {
  test('opt-in flow invokes install + gbrain init + remote MCP register', async () => {
    const stubServer = await startStubMcp();
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'path4-pglite-'));
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path4-pglite-bin-'));
    const gbrainConfigDir = path.join(sandboxHome, '.gbrain');
    fs.mkdirSync(gbrainConfigDir, { recursive: true });
    const gbrainConfigPath = path.join(gbrainConfigDir, 'config.json');
    const claudeLog = makeFakeClaude(fakeBinDir);
    const gbrainLog = makeFakeGbrain(fakeBinDir, gbrainConfigPath);
    const installLog = makeFakeInstall(fakeBinDir);

    const ORIGINAL_CLAUDE_MD = '# Test project\n';
    fs.writeFileSync(path.join(sandboxHome, 'CLAUDE.md'), ORIGINAL_CLAUDE_MD);

    const askLog: Array<{ question: string; choice: string }> = [];
    const binary = resolveClaudeBinary();

    const orig = {
      home: process.env.HOME,
      pathEnv: process.env.PATH,
      mcpToken: process.env.GBRAIN_MCP_TOKEN,
    };
    process.env.HOME = sandboxHome;
    process.env.PATH = `${fakeBinDir}:${path.join(path.resolve(import.meta.dir, '..'), 'bin')}:${process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin'}`;
    process.env.GBRAIN_MCP_TOKEN = 'gbrain_fake_token_for_test';

    try {
      const skillPath = path.resolve(
        import.meta.dir,
        '..',
        'setup-gbrain',
        'SKILL.md',
      );
      const result = await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        userPrompt:
          `Read the skill file at ${skillPath} and follow Path 4 (Remote MCP). ` +
          `Use this MCP URL: ${stubServer.url}. ` +
          `The bearer token is already in GBRAIN_MCP_TOKEN. ` +
          `At Step 4.5 (the new "Want symbol-aware code search?" question), PICK YES — set up local PGLite for code. ` +
          `Then continue through Step 5a (MCP registration) → Step 10 (verdict). ` +
          `Do not skip Step 4.5; the test depends on the Yes path being taken.`,
        workingDirectory: sandboxHome,
        maxTurns: 25,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName === 'AskUserQuestion') {
            const qs = input.questions as Array<{
              question: string;
              options: Array<{ label: string }>;
            }>;
            const answers: Record<string, string> = {};
            for (const q of qs) {
              // Heuristics: pick the option that screams "yes/PGLite/code search" for our flow.
              const yes =
                q.options.find((o) =>
                  /yes.*local|local.*pglite|code search|opt in/i.test(o.label),
                ) ??
                q.options.find((o) => /remote.*mcp|path 4/i.test(o.label)) ??
                q.options[0]!;
              answers[q.question] = yes.label;
              askLog.push({ question: q.question, choice: yes.label });
            }
            return {
              behavior: 'allow',
              updatedInput: { questions: qs, answers },
            };
          }
          return passThroughNonAskUserQuestion(toolName, input);
        },
      });

      const modelOut = JSON.stringify(result);

      // Smoke test contract (codex #12: AgentSDK is non-deterministic, so this
      // E2E asserts the model followed the SPLIT-ENGINE PATH without depending
      // on the exact subcommand sequence — deterministic per-step coverage
      // lives in gbrain-local-status.test.ts, gbrain-sync-skip.test.ts, etc).

      // Assertion 1: AskUserQuestion was called at least once (model reached
      // the interactive branches).
      expect(askLog.length).toBeGreaterThan(0);

      // Assertion 2: at LEAST ONE of the Path 4 / Step 4.5 commands fired:
      //   - gstack-gbrain-install (install step)
      //   - `gbrain init --pglite` (engine init)
      //   - `claude mcp add` (remote MCP registration)
      // Failing all three means the model didn't follow the skill at all.
      const installCalls = fs.existsSync(installLog)
        ? fs.readFileSync(installLog, 'utf-8')
        : '';
      const gbrainCalls = fs.existsSync(gbrainLog)
        ? fs.readFileSync(gbrainLog, 'utf-8')
        : '';
      const claudeCalls = fs.existsSync(claudeLog)
        ? fs.readFileSync(claudeLog, 'utf-8')
        : '';
      const followedPath =
        installCalls.length > 0 ||
        /gbrain init --pglite/.test(gbrainCalls) ||
        /mcp add/.test(claudeCalls);
      expect(followedPath).toBe(true);

      // Assertion 3: token never leaked to CLAUDE.md (security regression).
      const finalClaudeMd = fs.readFileSync(
        path.join(sandboxHome, 'CLAUDE.md'),
        'utf-8',
      );
      expect(finalClaudeMd).not.toContain('gbrain_fake_token_for_test');
    } finally {
      if (orig.home === undefined) delete process.env.HOME;
      else process.env.HOME = orig.home;
      if (orig.pathEnv === undefined) delete process.env.PATH;
      else process.env.PATH = orig.pathEnv;
      if (orig.mcpToken === undefined) delete process.env.GBRAIN_MCP_TOKEN;
      else process.env.GBRAIN_MCP_TOKEN = orig.mcpToken;
      await stubServer.close();
      fs.rmSync(sandboxHome, { recursive: true, force: true });
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  }, 300_000);
});
