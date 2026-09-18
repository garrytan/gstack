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
// The Step 4 body lives in setup-gbrain/sections/brain-init.md (carved), so
// the fixture is built via buildSetupGbrainFixture: skeleton + the brain-init
// and claude-md-persist sections inlined (Step 8 writes the Mode: remote-http
// block this test asserts on).

import { test, expect, afterAll } from 'bun:test';
import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { runAgentSdkTest, toSkillTestResult, passThroughNonAskUserQuestion, resolveClaudeBinary, type AgentSdkResult, type QueryProvider, type RunAgentSdkOptions } from './helpers/agent-sdk-runner';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { publicEvents, redactPublicValue } from './helpers/setup-gbrain-sandbox';
import { EvalCollector } from './helpers/eval-store';
import { resolveEvalModel } from '../lib/eval-model';
import { buildSetupGbrainFixture } from './helpers/setup-gbrain-fixture';

// Periodic-tier: the model's interpretation of "follow Path 4 only" is
// non-deterministic (it sometimes skips Step 8 CLAUDE.md write, sometimes
// shortcuts past the verify helper). The deterministic gate coverage for
// Path 4 lives in test/setup-gbrain-path4-structure.test.ts (free, <200ms).
const describeE2E = describeE2ETier('periodic');
const evalCollector = e2eTierEnabled('periodic') ? new EvalCollector('e2e', undefined, 'setup-gbrain-remote') : null;
afterAll(async () => { await evalCollector?.finalize(); });

// Spin up a stub MCP server that responds to initialize + tools/list.
function startStubMcpServer(opts: { failWithStatus?: number; failBody?: string } = {}, signal?: AbortSignal): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
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
    const abortSetup = () => { server.close(); server.closeAllConnections(); reject(signal?.reason ?? new Error('MCP fixture setup aborted')); };
    if (signal?.aborted) { abortSetup(); return; }
    signal?.addEventListener('abort', abortSetup, { once: true });
    server.once('error', (error) => { signal?.removeEventListener('abort', abortSetup); server.close(); reject(error); });
    server.listen(0, '127.0.0.1', () => {
      signal?.removeEventListener('abort', abortSetup);
      if (signal?.aborted) { abortSetup(); return; }
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        // Called only after cancelling this attempt's SDK queries.
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
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
    const attemptId = `remote-${Date.now()}-${randomUUID()}`;
    const evidenceDir = path.join(process.env.GSTACK_EVAL_DIR ?? path.resolve(import.meta.dir, '..', '.context', 'gbrain-fixture-evidence'), attemptId);
    const evidencePath = path.join(evidenceDir, 'evidence.json');
    const SECRET_TOKEN = 'gbrain_TEST_TOKEN_THAT_MUST_NEVER_LEAK_84613';
    const started = Date.now();
    const sdkController = new AbortController();
    const queries = new Set<Query>();
    const cleanupErrors: string[] = [], diagnosticErrors: string[] = [];
    const events: unknown[] = [], permissions: unknown[] = [], stages: Array<{ stage: string; elapsedMs: number }> = [];
    let stage = 'created', finalized = false, failure: string | undefined;
    let stubServer: Awaited<ReturnType<typeof startStubMcpServer>> | undefined;
    let gstackHome: string | undefined, fakeBinDir: string | undefined, callLog = '';
    let result: AgentSdkResult | undefined, queryCount = 0, querySettled = 0;
    let cleanupPromise: Promise<void> | undefined;
    let callSnapshot: string | null = null, claudeMdSnapshot: string | null = null;
    const retain = () => {
      if (finalized) return;
      fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      if (callLog && fs.existsSync(callLog)) callSnapshot = fs.readFileSync(callLog, 'utf8');
      const claudeMd = gstackHome ? path.join(gstackHome, 'CLAUDE.md') : '';
      if (claudeMd && fs.existsSync(claudeMd)) claudeMdSnapshot = fs.readFileSync(claudeMd, 'utf8');
      const evidence = redactPublicValue({ attemptId, stage, stages, failure,
        workBudgetMs: CAPTURE_MS, sdkMax429Retries: 3, queryCount, querySettled,
        pendingOwnedQueries: queries.size, cleanupErrors, diagnosticErrors,
        sdkCancelled: sdkController.signal.aborted, events, permissions,
        fixture: { gstackHome, fakeBinDir, url: stubServer?.url,
          claudeCalls: callSnapshot, claudeMd: claudeMdSnapshot },
        result: result ? { exitReason: result.exitReason, durationMs: result.durationMs, costUsd: result.costUsd,
          turnsUsed: result.turnsUsed, model: result.model, sdkVersion: result.sdkVersion,
          sdkClaudeCodeVersion: result.sdkClaudeCodeVersion, resolvedBinaryPath: result.resolvedBinaryPath,
          output: result.output, toolCalls: result.toolCalls } : undefined,
      }, SECRET_TOKEN);
      const temporary = path.join(evidenceDir, 'evidence.tmp');
      fs.writeFileSync(temporary, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, evidencePath);
    };
    const mark = (next: string) => { if (!finalized) { stage = next; stages.push({ stage, elapsedMs: Date.now() - started }); retain(); } };
    const errorText = (error: unknown) => redactPublicValue(error instanceof Error ? `${error.name}: ${error.message}` : String(error), SECRET_TOKEN) as string;
    const closeQuery = (source: Query) => {
      try { source.close(); queries.delete(source); }
      catch (error) { cleanupErrors.push(`SDK close: ${errorText(error)}`); }
    };
    const cancelSdk = () => {
      sdkController.abort();
      for (const source of queries) closeQuery(source);
    };
    const cleanup = () => cleanupPromise ??= (async () => {
      cancelSdk(); // Cancel every owned SDK attempt before closing fixture HTTP connections.
      const markCleanup = (next: string) => { try { mark(next); } catch (error) { diagnosticErrors.push(errorText(error)); } };
      markCleanup('cleanup-start');
      try { await stubServer?.close(); } catch (error) { cleanupErrors.push(`HTTP close: ${errorText(error)}`); }
      for (const owned of [gstackHome, fakeBinDir]) {
        if (owned) try { fs.rmSync(owned, { recursive: true, force: true }); }
        catch (error) { cleanupErrors.push(`Fixture removal: ${errorText(error)}`); }
      }
      markCleanup('cleanup-complete');
    })();
    const collector = evalCollector ? { addTest: (entry: any) => evalCollector.addTest(redactPublicValue(entry, SECRET_TOKEN)) } as EvalCollector : null;
    try {
      await runRecordedOfficeHoursAttempt({
        collector, name: 'setup-gbrain-remote', suite: 'setup-gbrain', model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
        budgetMs: Math.max(0, CAPTURE_MS - (Date.now() - started)),
        run: async (deadlineSignal) => {
          const signal = AbortSignal.any([deadlineSignal, sdkController.signal]);
          signal.throwIfAborted();
          mark('setup-start');
          stubServer = await startStubMcpServer({}, signal);
          signal.throwIfAborted();
          gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gbrain-remote-'));
          fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-gbrain-remote-bin-'));
          callLog = makeFakeClaude(fakeBinDir);
          fs.writeFileSync(path.join(gstackHome, 'CLAUDE.md'), '# Test project\n');
          const askUserQuestions: Array<{ input: Record<string, unknown> }> = [];
          const binary = resolveClaudeBinary();
          const childEnv = {
            GSTACK_HOME: gstackHome, GBRAIN_MCP_TOKEN: SECRET_TOKEN,
            PATH: `${fakeBinDir}:${path.join(path.resolve(import.meta.dir, '..'), 'bin')}:${process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin'}`,
          };
          const skillPath = path.join(gstackHome, 'setup-gbrain-SKILL.md');
          fs.writeFileSync(skillPath, buildSetupGbrainFixture(['brain-init.md', 'claude-md-persist.md']));
          // Let the already-armed work deadline observe slow synchronous setup
          // before any SDK query is created. No extra model work is allowed.
          if (Date.now() - started >= CAPTURE_MS) await new Promise(resolve => setTimeout(resolve, 0));
          signal.throwIfAborted();
          mark('prepared');
          const queryProvider: QueryProvider = (input) => {
            signal.throwIfAborted();
            const source = query(input);
            queries.add(source); const queryOrdinal = ++queryCount;
            mark('sdk-query-start');
            const observed = (async function* () {
              try {
                for await (const event of source) {
                  signal.throwIfAborted();
                  if (!finalized) { events.push(...publicEvents([event]).map(event => ({ queryOrdinal, ...(event as object) }))); retain(); }
                  yield event;
                }
              } finally {
                closeQuery(source); querySettled++;
                if (!finalized) try { retain(); } catch (error) { diagnosticErrors.push(errorText(error)); }
              }
            })();
            return Object.assign(observed, { close: () => closeQuery(source) }) as ReturnType<QueryProvider>;
          };
          const sdkOptions: RunAgentSdkOptions = {
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            env: childEnv,
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
          };
          mark('sdk-start');
          const captured = await runAgentSdkTest({ ...sdkOptions, signal, queryProvider,
            // Preserve this caller's original default SDK429 policy and fresh Bun retry.
            maxRetries: 3,
            canUseTool: async (...args) => {
              signal.throwIfAborted();
              const entry: Record<string, unknown> = { tool: args[0], input: args[1] };
              permissions.push(entry); retain();
              const decision = await sdkOptions.canUseTool!(...args);
              signal.throwIfAborted();
              entry.decision = decision; retain();
              return decision;
            },
          });
          signal.throwIfAborted();
          result = captured;
          mark('sdk-returned');
          const mapped = toSkillTestResult(captured);
          return { ...mapped, ...redactPublicValue({ output: mapped.output,
            transcript: publicEvents(captured.events), toolCalls: mapped.toolCalls, browseErrors: mapped.browseErrors }, SECRET_TOKEN) };
        },
        validate: async (_captured, signal) => {
          signal.throwIfAborted();
          mark('assertions');
          let assertionFailed = false, assertionFailure: unknown;
          try {
            const result = resultValue();
            // Max-turns may still complete this artifact contract; a returned
            // runner failure cannot be accepted from earlier file writes.
            if (!['success', 'error_max_turns'].includes(result.exitReason)) {
              const details = result.events.flatMap((event: any) => event.type === 'result' && Array.isArray(event.errors)
                ? event.errors.filter((error: unknown) => typeof error === 'string') : []).join('\n');
              throw new Error(`SDK returned unsuccessful exit reason: ${result.exitReason}${details ? `\n${details}` : ''}`);
            }
            // The same error-class assertions inspect public SDK fields only.
            const modelTextOutput = JSON.stringify({ ...result,
              events: publicEvents(result.events), assistantTurns: publicEvents(result.assistantTurns) });

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
            if (!/mcp add.*--transport http/.test(calls)) {
              // Failure evidence: without this, the transcript dies with the test
              // and every triage pass starts blind (three did).
              const bashCmds = result.toolCalls
                .filter((t) => t.tool === 'Bash')
                .map((t) => String((t.input as { command?: string })?.command ?? '').slice(0, 200));
              console.error(redactPublicValue(
                `[setup-gbrain-remote] mcp-add never hit the fake shim.\n` +
                `exitReason=${result.exitReason} turns=${result.turnsUsed}\n` +
                `--- bash commands (${bashCmds.length}) ---\n${bashCmds.join('\n')}\n` +
                `--- final text (last 1500 chars) ---\n${result.output.slice(-1500)}`, SECRET_TOKEN
              ));
            }
            expect(calls).toMatch(/mcp add.*--transport http/);

            // Assertion 3: the secret token NEVER appears in the final CLAUDE.md.
            const claudeMd = fs.readFileSync(path.join(gstackHome!, 'CLAUDE.md'), 'utf-8');
            expect(claudeMd).not.toContain(SECRET_TOKEN);

            // Assertion 4: CLAUDE.md got the remote-http block.
            expect(claudeMd).toMatch(/Mode: remote-http/);

            // Assertion 5: classifier — the model didn't write findings before
            // asking. The Path 4 prose has 5 STOP gates; if any of them got
            // skipped, that's the wrote_findings_before_asking pattern.
            // Scan the ASSISTANT's text only: modelTextOutput includes public
            // event including the child's Read of the skill file, whose generated
            // footer contains the literal "GSTACK REVIEW REPORT" — a guaranteed
            // false positive on both trees.
            const wroteBefore = /## GSTACK REVIEW REPORT|critical_gaps/i.test(result.output);
            // Setup-gbrain doesn't have a review report contract, so this is
            // a structural shape check, not a hard failure mode.
            expect(wroteBefore).toBe(false);
          } catch (error) { assertionFailed = true; assertionFailure = error; }
          await cleanup();
          if (assertionFailed) throw assertionFailure;
          if (cleanupErrors.length || diagnosticErrors.length) throw new Error([...cleanupErrors, ...diagnosticErrors].join('\n'));
          signal.throwIfAborted();
          // Evidence persistence is part of validation, before the recorder can accept PASS.
          mark('passed');
          finalized = true;
        },
      });
    } catch (error) {
      failure = redactPublicValue(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error), SECRET_TOKEN);
      await cleanup();
      // A failed cleanup/diagnostic cannot replace the original runner or assertion failure.
      finalized = false;
      try { mark('failed'); } catch (diagnostic) { diagnosticErrors.push(errorText(diagnostic)); }
      throw new Error(`${failure}\nSecondary cleanup/diagnostic failures: ${[...cleanupErrors, ...diagnosticErrors].join('; ') || 'none'}\nEvidence: ${evidencePath}`);
    } finally { finalized = true; }
    function resultValue(): AgentSdkResult {
      if (!result) throw new Error('SDK result missing before assertions');
      return result;
    }
  }, CAPTURE_MS + OFFICE_HOURS_BUN_GRACE_MS);
});
