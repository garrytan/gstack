/**
 * The Codex host for runSkillTest (EVALS_HOST=codex, GSTA-49 TM2): runs a
 * Claude-authored gate case through `codex exec --json` and returns the same
 * SkillTestResult shape, so the case's own assertions judge the outcome.
 *
 * Parity with the Claude runner (session-runner.ts):
 *   - runtime: the full gstack Codex runtime (`./setup --host codex`), installed
 *     once per process into a private CODEX_HOME holding the login's auth.json;
 *   - events: command_execution -> Bash ({ command } unwrapped from Codex's
 *     `bash -lc`, its output); file_change -> Write (add), Edit (update) or
 *     Delete per path; web_search -> WebSearch; mcp_tool_call -> mcp__server__tool;
 *     the last agent message is the output;
 *   - transcript: the Claude stream-json shape the cases' observers read: one
 *     system/init event (cwd, the Codex thread id as session_id), assistant text
 *     and tool_use events, user tool_result events (is_error from the exit code)
 *     and a final result event;
 *   - sandbox: GSTACK_CODEX_SANDBOX, default danger-full-access (the counterpart
 *     of claude -p --dangerously-skip-permissions; cases write outside their
 *     working directory, start loopback servers and browsers); workspace-write
 *     gets network access;
 *   - effort: GSTACK_CODEX_EFFORT sets model_reasoning_effort; unset keeps the
 *     model's default;
 *   - model: a non-Claude options.model, else GSTACK_CODEX_MODEL, else
 *     CODEX_FRONTIER_MODEL; a case's Claude model pin does not apply here;
 *   - cost: real accounting from `turn.completed` usage at lib/pricing.ts rates,
 *     recorded on the result, the eval record and the session ledger.
 *   - nativeLifecycle: onSpawn gets the codex process-group owner right after
 *     spawn; onSettled runs after its exit and group kill, within the drain grace.
 * Not translated: maxTurns (Codex has no turn cap), allowedTools/tools (Codex
 * has its own tool surface) and startupGraceMs (the timeout bounds the session).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CODEX_DRAIN_GRACE_MS, CodexHarnessError, codexUsageCostUsd, execCodex, type CodexResult } from './codex-session-runner';
import { getProjectEvalDir } from './eval-store';
import { hermeticChildEnv } from './hermetic-env';
import { SAFETY_RULES, locateRule, removeRule, safetyArm } from './safety-rules';
import { appendSessionLedger, sessionKey, type SessionEnd } from './session-ledger';
import { sanitizeTestName, scanBrowseErrors, type SkillTestResult } from './session-runner';
import { CODEX_FRONTIER_MODEL } from '../../scripts/resolvers/constants';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const SETUP_TIMEOUT_MS = 300_000;
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const EFFORT = /^[a-z]+$/;

/** The Codex model for a session: a Claude pin never reaches `codex --model`. */
export function codexHostModel(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit && !/^claude-/.test(explicit)) return explicit;
  return env.GSTACK_CODEX_MODEL || CODEX_FRONTIER_MODEL;
}

/** `codex exec` arguments for one session; the prompt is the last argument. */
export function codexHostExecArgs(model: string, prompt: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const sandbox = env.GSTACK_CODEX_SANDBOX || 'danger-full-access';
  if (!(CODEX_SANDBOXES as readonly string[]).includes(sandbox)) {
    throw new Error(`GSTACK_CODEX_SANDBOX must be one of ${CODEX_SANDBOXES.join(', ')}; got "${sandbox}"`);
  }
  const effort = env.GSTACK_CODEX_EFFORT;
  if (effort && !EFFORT.test(effort)) throw new Error(`GSTACK_CODEX_EFFORT must be a bare effort name; got "${effort}"`);
  return ['exec', '--json', '-s', sandbox, '--skip-git-repo-check', '--model', model,
    ...(sandbox === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    prompt];
}

/** The command inside Codex's `/bin/bash -lc <word>` wrapper, else the command unchanged. */
export function unwrapShellCommand(command: string): string {
  const match = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -lc (.+)$/s.exec(command);
  if (!match) return command;
  const word = match[1]!;
  let out = '';
  let i = 0;
  while (i < word.length) {
    const c = word[i]!;
    if (c === "'") {
      const end = word.indexOf("'", i + 1);
      if (end < 0) return command;
      out += word.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < word.length) {
        if (word[i] === '\\' && i + 1 < word.length && '"\\$`\n'.includes(word[i + 1]!)) { out += word[i + 1]; i += 2; }
        else if (word[i] === '"') { i++; closed = true; break; }
        else out += word[i++];
      }
      if (!closed) return command;
    } else if (c === '\\' && i + 1 < word.length) {
      out += word[i + 1];
      i += 2;
    } else if (/\s/.test(c)) {
      return command;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export type HostToolCall = SkillTestResult['toolCalls'][number];

const FILE_CHANGE_TOOLS: Record<string, string> = { add: 'Write', update: 'Edit', delete: 'Delete' };

/** Claude-shaped tool calls from completed Codex items, in order. */
export function codexHostToolCalls(rawLines: readonly string[]): HostToolCall[] {
  const calls: HostToolCall[] = [];
  for (const line of rawLines) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'item.completed' || !event.item) continue;
    const item = event.item;
    if (item.type === 'command_execution') {
      calls.push({ tool: 'Bash', input: { command: unwrapShellCommand(String(item.command ?? '')) }, output: String(item.aggregated_output ?? '') });
    } else if (item.type === 'file_change') {
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        calls.push({ tool: FILE_CHANGE_TOOLS[change?.kind] ?? 'Edit', input: { file_path: String(change?.path ?? ''), kind: change?.kind }, output: '' });
      }
    } else if (item.type === 'web_search') {
      calls.push({ tool: 'WebSearch', input: { query: item.query }, output: '' });
    } else if (item.type === 'mcp_tool_call') {
      calls.push({ tool: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {}, output: typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '') });
    }
  }
  return calls;
}

/**
 * Codex events as the Claude stream-json transcript the cases' observers read
 * (system/init, assistant text and tool_use, user tool_result, result).
 */
export function codexHostTranscript(rawLines: readonly string[], cwd: string, output: string): any[] {
  const events: any[] = [];
  let session = '';
  const say = (role: 'assistant' | 'user', content: any[]) => events.push({ type: role, session_id: session, parent_tool_use_id: null, message: { role, content } });
  for (const line of rawLines) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'thread.started') {
      session = String(event.thread_id ?? '');
      events.push({ type: 'system', subtype: 'init', cwd, session_id: session, tools: [] });
      continue;
    }
    if (event?.type !== 'item.completed' || !event.item) continue;
    const item = event.item;
    const id = String(item.id ?? `item_${events.length}`);
    if (item.type === 'agent_message' && item.text) say('assistant', [{ type: 'text', text: String(item.text) }]);
    else if (item.type === 'command_execution') {
      say('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command: unwrapShellCommand(String(item.command ?? '')) } }]);
      say('user', [{ type: 'tool_result', tool_use_id: id, content: String(item.aggregated_output ?? ''), is_error: item.exit_code !== 0 }]);
    } else if (item.type === 'file_change') {
      (Array.isArray(item.changes) ? item.changes : []).forEach((change: any, index: number) => {
        const useId = `${id}_${index}`;
        say('assistant', [{ type: 'tool_use', id: useId, name: FILE_CHANGE_TOOLS[change?.kind] ?? 'Edit', input: { file_path: String(change?.path ?? '') } }]);
        say('user', [{ type: 'tool_result', tool_use_id: useId, content: '', is_error: item.status !== 'completed' }]);
      });
    }
  }
  events.push({ type: 'result', subtype: 'success', session_id: session, result: output });
  return events;
}

let runtimeRoot: string | undefined;

/**
 * The rule-removed safety arm (GSTACK_SAFETY_ARM=removed) must hold on the
 * installed skills too, or the model reads the rule from ~/.codex/skills
 * (GST-840). Each installed skill whose markdown carries a registered rule
 * paragraph is a link into this checkout, so the link becomes a private copy
 * and every such file is rewritten without the paragraph. Files are replaced,
 * never written in place, so nothing reaches the checkout through a link.
 */
function removeSafetyRulesFromInstall(skillsDir: string): void {
  for (const name of fs.readdirSync(skillsDir)) {
    const dir = path.join(skillsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter(file => file.endsWith('.md'))
      .map(file => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8') }))
      .filter(({ text }) => SAFETY_RULES.some(rule => locateRule(text, rule)));
    if (!files.length) continue;
    if (fs.lstatSync(dir).isSymbolicLink()) {
      const target = fs.realpathSync(dir);
      fs.unlinkSync(dir);
      fs.cpSync(target, dir, { recursive: true });
    }
    for (const { file, text } of files) {
      const out = path.join(dir, file);
      fs.rmSync(out, { force: true });
      fs.writeFileSync(out, SAFETY_RULES.reduce((current, rule) => locateRule(current, rule) ? removeRule(current, rule) : current, text));
    }
  }
}

/**
 * Install the full gstack Codex runtime once per process: `./setup --host codex`
 * into a private HOME/CODEX_HOME, with the login home's auth.json copied in.
 * Returns the root holding home/.codex and tmp/ (Codex will not create its
 * helper aliases when CODEX_HOME sits under its own TMPDIR). A caller that
 * already prepared one passes it as GSTACK_CODEX_HOST_ROOT.
 */
export function prepareCodexHostRuntime(env: NodeJS.ProcessEnv = process.env): string {
  if (runtimeRoot) return runtimeRoot;
  const preset = env.GSTACK_CODEX_HOST_ROOT;
  if (preset) {
    if (!fs.existsSync(path.join(preset, 'home', '.codex'))) throw new Error(`GSTACK_CODEX_HOST_ROOT ${preset} has no home/.codex`);
    fs.mkdirSync(path.join(preset, 'tmp'), { recursive: true });
    if (safetyArm(env) === 'removed') removeSafetyRulesFromInstall(path.join(preset, 'home', '.codex', 'skills'));
    return runtimeRoot = preset;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-host-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  const tmp = path.join(root, 'tmp');
  for (const dir of [codexHome, tmp]) fs.mkdirSync(dir, { recursive: true });
  const auth = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  if (fs.existsSync(auth)) fs.copyFileSync(auth, path.join(codexHome, 'auth.json'));
  const setup = spawnSync(path.join(ROOT, 'setup'), ['--host', 'codex'], {
    cwd: ROOT, encoding: 'utf8', timeout: SETUP_TIMEOUT_MS,
    env: hermeticChildEnv({ HOME: home, CODEX_HOME: codexHome, TMPDIR: tmp }, { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] }),
  });
  if (setup.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`./setup --host codex failed (exit ${setup.status}${setup.error ? `, ${setup.error.message}` : ''}): ${(setup.stderr || setup.stdout || '').slice(-2000)}`);
  }
  process.once('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  if (safetyArm(env) === 'removed') removeSafetyRulesFromInstall(path.join(codexHome, 'skills'));
  runtimeRoot = root;
  return root;
}

type RunSkillTestOptions = Parameters<typeof import('./session-runner').runSkillTest>[0];

function exitReasonOf(result: CodexResult, aborted: boolean): string {
  if (result.exitCode === 124) return 'timeout';
  const failedTurn = result.rawLines.some(line => /"type":"(?:turn\.failed|error)"/.test(line));
  if (result.exitCode === 0) return failedTurn ? 'error_api' : 'success';
  if (aborted) return 'timeout';
  return failedTurn && !result.rawLines.some(line => line.includes('"type":"item.completed"')) ? 'error_api' : `exit_code_${result.exitCode}`;
}

const SESSION_ENDS: Record<string, SessionEnd> = { success: 'completed', timeout: 'session_timeout', error_api: 'api_error' };

/** runSkillTest on the Codex host. `appendSystemPrompt` arrives with any completion notice already applied. */
export async function runCodexHostSkillTest(options: RunSkillTestOptions): Promise<SkillTestResult> {
  const startTime = Date.now();
  const startMono = performance.now();
  const { workingDirectory, timeout = 120_000, testName, runId, signal } = options;
  const deadline = startTime + timeout;
  const model = codexHostModel(options.model);
  const prompt = options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${options.prompt}` : options.prompt;
  const root = prepareCodexHostRuntime();
  const safeName = testName ? sanitizeTestName(testName) : null;
  let runDir: string | null = null;
  if (runId) {
    try {
      runDir = path.join(path.dirname(getProjectEvalDir()), 'e2e-runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
    } catch { runDir = null; }
  }
  let firstResponseMs = 0;
  let lastItemMs = 0;
  let maxInterTurnMs = 0;
  const onLine = (line: string, elapsedMs: number) => {
    if (!firstResponseMs) firstResponseMs = Math.max(1, elapsedMs);
    if (runDir && safeName) { try { fs.appendFileSync(path.join(runDir, `${safeName}.ndjson`), line + '\n'); } catch { /* non-fatal */ } }
    if (!line.includes('"type":"item.completed"') || !/"type":"(?:command_execution|file_change)"/.test(line)) return;
    if (lastItemMs) maxInterTurnMs = Math.max(maxInterTurnMs, elapsedMs - lastItemMs);
    lastItemMs = elapsedMs;
  };

  let result: CodexResult;
  let harnessReason: string | undefined;
  let started = true;
  const lifecycle = options.nativeLifecycle;
  try {
    result = await execCodex(codexHostExecArgs(model, prompt), {
      cwd: workingDirectory, startTime, deadline, signal, onLine, ...(lifecycle ? { onSpawn: (pid: number) => lifecycle.onSpawn(pid) } : {}),
      env: hermeticChildEnv(
        { GSTACK_HEADLESS: '1', ...options.env, CODEX_HOME: path.join(root, 'home', '.codex'), TMPDIR: options.env?.TMPDIR ?? path.join(root, 'tmp') },
        { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] },
      ),
    });
  } catch (error) {
    if (!(error instanceof CodexHarnessError) || !error.result) throw error;
    result = error.result;
    started = !error.message.startsWith('Could not start Codex');
    harnessReason = /drain/.test(error.message) ? 'error_output_drain' : 'error_output_stream';
  }
  if (lifecycle) {
    const settleDeadline = Date.now() + CODEX_DRAIN_GRACE_MS;
    let hookTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        lifecycle.onSettled({ deadline: settleDeadline, exited: started }),
        new Promise<never>((_, reject) => { hookTimer = setTimeout(() => reject(new Error('native lifecycle settlement deadline exceeded')), CODEX_DRAIN_GRACE_MS); }),
      ]);
    } finally { clearTimeout(hookTimer); }
  }

  const exitReason = harnessReason ?? exitReasonOf(result, !!signal?.aborted);
  const toolCalls = codexHostToolCalls(result.rawLines);
  const events = result.rawLines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const messages = events.filter(event => event?.type === 'item.completed' && event.item?.type === 'agent_message');
  const output = String(messages.at(-1)?.item?.text ?? '');
  const turnsUsed = events.filter(event => event?.type === 'item.completed' && event.item?.type !== 'reasoning').length;
  const transcript = codexHostTranscript(result.rawLines, workingDirectory, output);
  const cost = result.usage ? codexUsageCostUsd(result.usage, model) : null;
  const browseErrors = scanBrowseErrors(toolCalls.filter(call => call.tool === 'Bash').map(call => call.output).join('\n') + '\n' + result.stderr);
  const duration = Date.now() - startTime;

  appendSessionLedger({ key: sessionKey('codex', testName), ...(testName ? { test_name: testName } : {}), runner: 'codex',
    started_at: new Date(startTime).toISOString(), budget_ms: timeout, elapsed_ms: performance.now() - startMono,
    end: exitReason === 'timeout' && signal?.aborted ? 'aborted' : SESSION_ENDS[exitReason] ?? 'error',
    ...(exitReason === 'timeout' ? { evidence: `armed ${timeout}ms session timeout fired` } : exitReason !== 'success' && result.stderr ? { evidence: result.stderr } : {}),
    billed: cost !== null, model, ...(cost !== null ? { cost_usd: cost, tokens: result.usage! } : {}) });

  if (exitReason !== 'success' || browseErrors.length > 0) {
    try {
      const failureDir = runDir || path.join(workingDirectory, '.gstack', 'test-transcripts');
      fs.mkdirSync(failureDir, { recursive: true });
      fs.writeFileSync(path.join(failureDir, safeName ? `${safeName}-failure.json` : `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
        JSON.stringify({ host: 'codex', model, prompt: prompt.slice(0, 500), testName: testName || 'unknown', exitReason, browseErrors, duration,
          stderr: result.stderr.slice(0, 2000), output: output.slice(0, 500) }, null, 2));
    } catch { /* non-fatal */ }
  }

  return {
    toolCalls, browseErrors, exitReason, duration, output, transcript, model, firstResponseMs, maxInterTurnMs,
    costEstimate: { inputChars: prompt.length, outputChars: output.length,
      estimatedTokens: (result.usage?.input ?? 0) + (result.usage?.output ?? 0), estimatedCost: cost ?? 0, turnsUsed },
    ...(result.usage ? { tokenUsage: result.usage } : {}),
    ...(cost === null ? { costKnown: false } : {}),
  };
}
