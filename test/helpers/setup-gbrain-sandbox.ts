/** Owned Path 4 fixtures and per-attempt, token-redacted evidence. No ambient env writes. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createHash, randomUUID } from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  runAgentSdkTest,
  toSkillTestResult,
  type AgentSdkResult,
  type QueryProvider,
  type RunAgentSdkOptions,
} from './agent-sdk-runner';
import { buildSetupGbrainFixture } from './setup-gbrain-fixture';
import { CAPTURE_MS } from './eval-budgets';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './office-hours-attempt';
import type { EvalCollector, EvalTestEntry } from './eval-store';
import { redactFindingSpans } from '../../lib/redact-engine';

export const SETUP_GBRAIN_FINALIZE_MS = OFFICE_HOURS_BUN_GRACE_MS;

const ROOT = path.resolve(import.meta.dir, '..', '..');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const OMITTED = '[Public diagnostics omitted: redaction limit]';
export function redactPublicValue(value: unknown, token: string, unsafe = () => {}): any {
  if (typeof value === 'string') {
    const redacted = redactFindingSpans(value.replaceAll(token, '[REDACTED_FIXTURE_TOKEN]'), { repoVisibility: 'private' });
    if (redacted === null) { unsafe(); return OMITTED; }
    return redacted;
  }
  if (Array.isArray(value)) return value.map(item => redactPublicValue(item, token, unsafe));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [redactPublicValue(key, token, unsafe), redactPublicValue(item, token, unsafe)]));
  return value;
}

/** Retain the prior Path 4 public projection; SDK private fields are never read. */
export function publicEvents(events: readonly unknown[]): unknown[] {
  return events.flatMap((event: any) => {
    if (event.type === 'system' && event.subtype === 'init') return [{
      type: event.type, subtype: event.subtype, session_id: event.session_id,
      cwd: event.cwd, model: event.model, tools: event.tools, claude_code_version: event.claude_code_version,
    }];
    if (event.type !== 'assistant' && event.type !== 'user') return [];
    const content = Array.isArray(event.message?.content) ? event.message.content.flatMap((block: any) => {
      if (block.type === 'text') return [{ type: block.type, text: block.text }];
      if (block.type === 'tool_use') return [{ type: block.type, id: block.id, name: block.name, input: block.input }];
      if (block.type === 'tool_result') return [{ type: block.type, tool_use_id: block.tool_use_id,
        is_error: block.is_error, content: typeof block.content === 'string' ? block.content :
          Array.isArray(block.content) ? block.content.filter((b: any) => b.type === 'text').map((b: any) => ({ type: 'text', text: b.text })) : [] }];
      return [];
    }) : [];
    return content.length ? [{ type: event.type, session_id: event.session_id,
      parent_tool_use_id: event.parent_tool_use_id,
      message: { id: event.message.id, role: event.message.role, content } }] : [];
  });
}

function publicDiagnostics(result: AgentSdkResult, token: string) {
  let unsafe = false;
  // Redact strings before serialization so credential URLs cannot consume JSON
  // punctuation or replace the actual assertion outcome with a parse error.
  const safe = redactPublicValue({ output: result.output, transcript: publicEvents(result.events),
    browseErrors: result.browseErrors, toolCalls: result.toolCalls }, token, () => { unsafe = true; });
  return unsafe ? { output: OMITTED, transcript: [], browseErrors: [], toolCalls: [] } : safe;
}

function parseRecord(text: string | null) {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return { malformed: true, text }; }
}

export async function createSetupGbrainSandbox(options: {
  name: string;
  status: 200 | 401;
  sections: string[];
  originalClaudeMd: string;
  evidenceRoot?: string;
}) {
  const attemptId = `${options.name}-${Date.now()}-${randomUUID()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-fixture-'));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const evidenceDir = path.join(options.evidenceRoot ?? path.join(ROOT, '.context', 'gbrain-fixture-evidence'), attemptId);
  for (const dir of [home, state, bin, path.join(home, '.gbrain'), evidenceDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const token = `gbrain_fixture_${randomUUID()}`;
  const redact = (text: string): string => redactPublicValue(text, token);
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let rpc: { method?: string; id?: number } = {};
      try { rpc = JSON.parse(body); } catch { /* Verifier evidence retains only safe metadata. */ }
      requests.push({
        method: req.method, rpcMethod: rpc.method ?? null, status: options.status,
        authorizationPresent: !!req.headers.authorization,
        authorizationMatches: req.headers.authorization === `Bearer ${token}`,
      });
      res.statusCode = options.status;
      res.setHeader('Content-Type', options.status === 200 ? 'text/event-stream' : 'application/json');
      const payload = options.status === 401
        ? { error: 'unauthorized', error_description: 'invalid or expired auth token' }
        : { jsonrpc: '2.0', id: rpc.id ?? 1, result: rpc.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gbrain', version: '0.32.3.0' } }
          : { tools: [] } };
      res.end(options.status === 200 ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload));
    });
  });
  const cleanup = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server has no address');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const claudeMdPath = path.join(home, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, options.originalClaudeMd);
    fs.writeFileSync(path.join(root, 'mcp-state.json'), '{"registered":false}', { mode: 0o600 });
    const controlPath = path.join(root, 'control.json');
    // Ephemeral control is private and removed in cleanup. It is never copied to evidence.
    fs.writeFileSync(controlPath, JSON.stringify({ root, repo: ROOT, token, url }), { mode: 0o600 });
    const originalFixture = buildSetupGbrainFixture(options.sections);
    const names = new Set([
      'claude', 'gbrain', 'gstack-gbrain-install',
      ...Array.from(originalFixture.matchAll(/~\/\.claude\/skills\/gstack\/bin\/([\w.-]+)/g), (m) => m[1]!),
    ]);
    const helperPaths: Record<string, { owned: string; source: string | null; sha256: string | null }> = {};
    fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
    for (const name of names) {
      const owned = path.join(bin, name);
      const fake = ['claude', 'gbrain', 'gstack-gbrain-install'].includes(name);
      const source = fake ? null : path.join(ROOT, 'bin', name);
      if (source && !fs.existsSync(source)) throw new Error(`fixture helper missing: ${name}`);
      if (name.endsWith('.sh')) fs.symlinkSync(source!, owned);
      else {
        // A TS entrypoint also works for the skill's explicit `bun <helper>` calls.
        fs.writeFileSync(owned,
          '#!/usr/bin/env -S bun run\n' +
          `process.argv = [process.argv[0], process.argv[1], ${JSON.stringify(controlPath)}, ${JSON.stringify(name)}, ...process.argv.slice(2)];\n` +
          `await import(${JSON.stringify(path.join(import.meta.dir, 'setup-gbrain-fixture-command.ts'))});\n`,
          { mode: 0o700 });
      }
      helperPaths[name] = { owned, source, sha256: source ? hash(fs.readFileSync(source, 'utf8')) : null };
    }
    const skill = buildSetupGbrainFixture(options.sections, { helperBinDir: bin });
    const skillPath = path.join(home, 'setup-gbrain-SKILL.md');
    fs.writeFileSync(skillPath, skill);
    const env: Record<string, string> = {
      HOME: home, GBRAIN_HOME: home, GSTACK_HOME: state, GBRAIN_MCP_TOKEN: token,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
      GSTACK_DETECT_NO_CACHE: '1',
    };
    const snapshot = () => {
      const claudeMd = read(claudeMdPath);
      return {
        mcp: parseRecord(read(path.join(root, 'mcp-state.json'))),
        gbrainConfig: read(path.join(home, '.gbrain', 'config.json')),
        claudeConfig: read(path.join(home, '.claude.json')),
        claudeMdSha256: claudeMd === null ? null : hash(claudeMd),
        claudeMdTokenLeak: claudeMd?.includes(token) ?? false,
        claudeMdUnchanged: claudeMd === options.originalClaudeMd,
      };
    };
    const initial = snapshot();
    const commands = () => (read(path.join(root, 'commands.jsonl')) ?? '').trim().split('\n')
      .filter(Boolean).map(parseRecord);
    const evidencePath = path.join(evidenceDir, 'evidence.json');
    const retain = (run: Record<string, unknown>) => {
      const evidence = {
        attemptId, skillSha256: hash(skill),
        sectionSha256: Object.fromEntries(options.sections.map((name) => [name, hash(fs.readFileSync(path.join(ROOT, 'setup-gbrain', 'sections', name), 'utf8'))])),
        helperPaths, initial, final: snapshot(), requestCount: requests.length, requests, commands: commands(), ...run,
      };
      fs.writeFileSync(path.join(evidenceDir, 'fixture.md'), redact(skill), { mode: 0o600 });
      const temporary = path.join(evidenceDir, 'evidence.tmp');
      fs.writeFileSync(temporary, JSON.stringify(redactPublicValue(evidence, token), null, 2), { mode: 0o600 });
      fs.renameSync(temporary, evidencePath);
    };
    retain({ stage: 'prepared' });
    return {
      root, home, state, bin, env, url, token, skillPath, evidencePath, requests,
      commands, snapshot, retain, redact, cleanup,
    };
  } catch (error) {
    const failure = redact(error instanceof Error ? error.message : String(error));
    try {
      fs.writeFileSync(path.join(evidenceDir, 'setup-error.json'), JSON.stringify({ attemptId, stage: 'setup-failed', failure }), { mode: 0o600 });
    } finally { await cleanup(); }
    throw new Error(`setup-gbrain fixture setup failed: ${failure}. Evidence: ${evidenceDir}`);
  }
}

export type SetupGbrainSandbox = Awaited<ReturnType<typeof createSetupGbrainSandbox>>;

/** Preserve stream/callback evidence even when the SDK throws before returning a result. */
export async function runSetupGbrainAttempt(
  fixture: SetupGbrainSandbox,
  options: Omit<RunAgentSdkOptions, 'env' | 'workingDirectory' | 'maxRetries'>,
  check: (result: AgentSdkResult) => void | Promise<void>,
  budgetMs = CAPTURE_MS,
  recording?: { collector: EvalCollector | null; name: string; suite: string },
) {
  const events: unknown[] = [];
  const permissions: unknown[] = [];
  let configuration: Record<string, unknown> | null = null;
  let result: AgentSdkResult | undefined;
  let failure: string | undefined;
  let stage = 'running';
  let finalized = false;
  const started = Date.now();
  let sdkVersion = 'unknown';
  try {
    sdkVersion = JSON.parse(fs.readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version;
  } catch { /* Best-effort metadata must not prevent failure evidence/cleanup. */ }
  const provider = options.queryProvider ?? query;
  const queryProvider: QueryProvider = (input) => {
    const childEnv = input.options?.env ?? {};
    configuration = {
      hermetic: process.env.EVALS_HERMETIC !== '0',
      tokenPresent: !!childEnv.GBRAIN_MCP_TOKEN,
      tokenMatches: childEnv.GBRAIN_MCP_TOKEN === fixture.token,
      homeMatches: childEnv.HOME === fixture.home,
      gbrainHomeMatches: childEnv.GBRAIN_HOME === fixture.home,
      gstackHomeMatches: childEnv.GSTACK_HOME === fixture.state,
      ownedBinFirst: childEnv.PATH?.split(path.delimiter)[0] === fixture.bin,
      model: input.options?.model, sdkVersion, binary: input.options?.pathToClaudeCodeExecutable ?? 'sdk-default',
    };
    const source = provider(input);
    const observed = (async function* () {
      for await (const event of source) {
        if (!finalized) { events.push(event); retain(); }
        yield event;
      }
    })();
    // Preserve the SDK's explicit cancellation surface through observation.
    return Object.assign(observed, { close: () => source.close?.() }) as ReturnType<QueryProvider>;
  };
  const retain = () => {
    if (finalized) return;
    const diagnostics = result ? publicDiagnostics(result, fixture.token) : undefined;
    fixture.retain({
      stage, configuration,
      result: result ? { exitReason: result.exitReason, durationMs: result.durationMs, costUsd: result.costUsd,
        turnsUsed: result.turnsUsed, model: result.model, sdkVersion: result.sdkVersion,
        sdkClaudeCodeVersion: result.sdkClaudeCodeVersion, resolvedBinaryPath: result.resolvedBinaryPath,
        firstResponseMs: result.firstResponseMs, maxInterTurnMs: result.maxInterTurnMs, ...diagnostics } : undefined,
      events: publicEvents(events), permissions, failure, elapsedMs: Date.now() - started,
      modelOutputTokenLeak: result?.output.includes(fixture.token) ?? false,
    });
  };
  const collector = recording?.collector ? { addTest(entry: EvalTestEntry) {
    recording.collector!.addTest(redactPublicValue(entry, fixture.token));
  } } as EvalCollector : null;
  try {
    // Work deadline → SDK cancellation → bounded settlement → sanitized
    // evidence → fixture cleanup. Bun's outer timeout includes finalization.
    await runRecordedOfficeHoursAttempt({
      collector, name: recording?.name ?? 'setup-gbrain', suite: recording?.suite ?? 'setup-gbrain', model: options.model ?? 'sdk-default',
      budgetMs: Math.max(0, budgetMs - (Date.now() - started)),
      run: async (deadlineSignal) => {
        const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
        const captured = await runAgentSdkTest({
          ...options, env: fixture.env, workingDirectory: fixture.home, signal,
          // Shard retries own fresh fixtures; SDK retries would combine state.
          maxRetries: 0, queryProvider,
          ...(options.canUseTool ? { canUseTool: async (...args) => {
            signal.throwIfAborted();
            const entry: Record<string, unknown> = { tool: args[0], input: args[1] };
            permissions.push(entry);
            retain();
            const decision = await options.canUseTool!(...args);
            signal.throwIfAborted();
            entry.decision = decision;
            retain();
            return decision;
          } } : {}),
        });
        if (!finalized) result = captured;
        return { ...toSkillTestResult(captured), ...publicDiagnostics(captured, fixture.token) };
      },
      validate: async (_captured, signal) => {
        signal.throwIfAborted();
        options.signal?.throwIfAborted();
        stage = 'before-assertions';
        retain();
        if (result!.exitReason !== 'success') throw new Error(`setup-gbrain runner exited ${result!.exitReason}`);
        await check(result!);
        signal.throwIfAborted();
        options.signal?.throwIfAborted();
        stage = 'passed';
      },
    });
  } catch (error) {
    failure = fixture.redact(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error));
    stage = 'failed';
    // Assertion diagnostics can include model text. Only the sanitized message escapes.
    throw new Error(`${failure}\nEvidence: ${fixture.evidencePath}`);
  } finally {
    try { retain(); } finally { finalized = true; await fixture.cleanup(); }
  }
}
