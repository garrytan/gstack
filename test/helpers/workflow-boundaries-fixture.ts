import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CanUseTool, HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdkResult, QueryProvider } from './agent-sdk-runner';
import type { EvalTestEntry } from './eval-store';
import { CAPTURE_MS } from './eval-budgets';

export type BoundaryCase = 'investigate-owned-completion' | 'investigate-owned-abort' |
  'investigate-owned-ending-error';

const ROOT = path.resolve(import.meta.dir, '../..');
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

export function createBoundaryFixture(id: BoundaryCase, root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gbound-'))) {
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  fs.chmodSync(root, 0o700);
  const repo = path.join(root, 'project');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const installed = path.join(home, '.claude/skills/gstack');
  const receipts = path.join(root, 'receipts');
  const boundary = path.join(state, 'freeze-dir.txt');
  const source = path.join(repo, 'src/value.js');
  const interactions: Array<{ tool: string; disposition: string; input: unknown; owner?: string }> = [];
  const executions: Array<{ tool: string; input: Record<string, unknown>; allowed: boolean }> = [];
  const commands = new Map<string, string>();
  const readable = new Set([path.join(repo, 'workflow.md'), source]);
  const protectedFiles = new Map<string, string>();
  const write = (file: string, text: string, executable = false) => {
    let ancestor = path.dirname(file);
    while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = path.dirname(ancestor);
    const resolved = fs.realpathSync(ancestor);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('fixture write escapes its isolated root');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const parent = fs.realpathSync(path.dirname(file));
    if (!parent.startsWith(root + path.sep) ||
      (fs.lstatSync(file, { throwIfNoEntry: false }) && !fs.realpathSync(file).startsWith(root + path.sep))) {
      throw new Error('fixture write escapes its isolated root');
    }
    fs.writeFileSync(file, text, { mode: executable ? 0o755 : 0o600 });
    protectedFiles.set(file, text);
  };
  fs.mkdirSync(repo);
  fs.mkdirSync(state);
  const env = {
    HOME: home, GSTACK_HOME: state, CLAUDE_PLUGIN_DATA: '', CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${path.join(root, 'bin')}:${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
  const generated = read(path.join(ROOT, 'investigate/SKILL.md'));
  const scope = generated.match(/^## Scope Lock\n[\s\S]*?(?=^## )/m)?.[0];
  if (!scope) throw new Error('generated /investigate Scope Lock missing');
  write(path.join(repo, 'workflow.md'), scope);
  const blocks = [...scope.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1].trim());
  if (blocks.length !== 3) throw new Error('Scope Lock must have availability, acquisition and release blocks');
  commands.set(blocks[0], 'availability');
  commands.set(blocks[1].replace('<detected-directory>', 'src'), 'acquire');
  commands.set('bash ./verify.sh', 'verify');
  const releaseTemplate = blocks[2];
  for (const file of ['careful/bin/hook-extract.sh', 'freeze/bin/check-freeze.sh']) {
    write(path.join(installed, file), read(path.join(ROOT, file)), true);
  }
  write(path.join(installed, 'freeze/bin/freeze-state-real.sh'), read(path.join(ROOT, 'freeze/bin/freeze-state.sh')), true);
  write(path.join(installed, 'freeze/bin/freeze-state.sh'), `#!/bin/bash
printf 'ACTION:%s:%s\\n' "$1" "\${2:-}" >> ${quote(receipts)}
_out=$(bash ${quote(path.join(installed, 'freeze/bin/freeze-state-real.sh'))} "$@")
_rc=$?
printf '%s\\nRESULT:%s\\n' "$_out" "$_rc" >> ${quote(receipts)}
printf '%s\\n' "$_out"
exit "$_rc"
`, true);
  write(source, 'export function value() { return 1; }\n');
  protectedFiles.delete(source);
  write(path.join(repo, 'verify.sh'), `#!/bin/bash
printf 'VERIFY\\n' >> ${quote(receipts)}
${id === 'investigate-owned-ending-error'
  ? "printf 'FIXTURE_ENDING_ERROR: required verifier is unavailable; end this investigation without retry.\\n' >&2\n_rc=69"
  : `${quote(process.execPath)} -e 'import { value } from "./src/value.js"; if (value() !== 2) process.exit(1); console.log("FIXTURE_VERIFIED")'\n_rc=$?`}
printf 'VERIFY_STATUS:%s\\n' "$_rc" >> ${quote(receipts)}
exit "$_rc"
`, true);
  const prompt = `Load gstack's /investigate Scope Lock workflow from workflow.md. This is a bounded
fixture: the root cause is established, value() returns 1 but must return 2. Apply
the scope workflow. After acquisition, ask the owner via AskUserQuestion whether
to continue or abort. If continuing, use Edit to change src/value.js, then run
bash ./verify.sh. Do not run other investigation phases.

Supported interactions: Read workflow.md and src/value.js; Bash for the supplied
scope blocks and verifier; Edit only src/value.js, changing only the return value
from 1 to 2; one continue/abort question. Use the Bash blocks verbatim, substitute
src for <detected-directory>, and your returned token for <retained-owner-token>.
The only verifier command is exactly bash ./verify.sh. Never combine commands,
change directories or run a command in the background.
No installation, other file
edits, direct state-file access, or deleting state outside the supplied helper.
The owner may explicitly abort at that question. Honor that answer.
A FIXTURE_ENDING_ERROR verifier result ends the investigation, not a new repair.
Finish with the actual outcome and scope disposition. HOME and GSTACK_HOME are
already isolated to this fixture. Do not change them.`;
  const invalidTool = (tool: string, input: Record<string, unknown>): string | undefined => {
    const continued = interactions.some(event => event.disposition === 'continue-investigation');
    const owner = read(receipts).match(/^FREEZE_OWNER=([a-f0-9]{32})$/m)?.[1];
    const owned = !!owner && read(boundary) === `${path.join(repo, 'src')}\ngstack-freeze-v1:${owner}\n`;
    if (tool === 'Read') {
      if (typeof input.file_path !== 'string' || !readable.has(path.resolve(repo, input.file_path))) return 'Read is limited to the workflow and declared source paths.';
    } else if (tool === 'Bash') {
      if (typeof input.command !== 'string' || input.run_in_background) return 'Only foreground fixture commands are supported.';
      const command = input.command.trim();
      if (owner && command === releaseTemplate.replace('<retained-owner-token>', owner)) return;
      const action = commands.get(command);
      if (!action) return 'Use one of the declared Bash blocks verbatim; state reads and receipt writes are forbidden.';
      if (action === 'acquire' && owner) return 'This run already acquired its boundary.';
      if (action === 'verify' && (!continued || !owned)) return 'Verification requires continuation and the active owned boundary.';
    } else if (tool === 'Edit') {
      if (typeof input.file_path !== 'string' || path.resolve(repo, input.file_path) !== source || !continued || !owned) return 'Only the continued investigation under its owned boundary may edit its source file.';
      const current = read(source);
      if (typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string' ||
        current !== 'export function value() { return 1; }\n' ||
        current.replace(input.old_string, input.new_string) !== 'export function value() { return 2; }\n') return 'The only permitted edit changes the existing return value from 1 to 2.';
    } else if (tool === 'AskUserQuestion') {
      if (interactions.some(event => event.tool === 'AskUserQuestion')) return 'Only one declared owner question is supported.';
    } else return 'This tool is outside the declared fixture interactions.';
  };
  const preToolUse: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') throw new Error('unexpected fixture hook');
    const toolInput = input.tool_input as Record<string, unknown>;
    const reason = invalidTool(input.tool_name, toolInput);
    executions.push({ tool: input.tool_name, input: toolInput, allowed: !reason });
    if (reason) interactions.push({ tool: input.tool_name, disposition: 'unsupported-tool', input: toolInput });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: reason ? 'deny' : input.tool_name === 'AskUserQuestion' ? 'ask' : 'allow',
      ...(reason ? { permissionDecisionReason: reason } : {}),
      ...(input.tool_name === 'Bash' && !reason ? { updatedInput: { command: toolInput.command, timeout: 10000, run_in_background: false } } : {}) } };
  };
  const canUseTool: CanUseTool = async (tool, input) => {
    const invalid = invalidTool(tool, input);
    if (invalid) {
      interactions.push({ tool, disposition: 'unsupported-tool', input });
      return { behavior: 'deny', message: invalid };
    }
    if (tool === 'AskUserQuestion') {
      const owner = read(boundary).match(/gstack-freeze-v1:([a-f0-9]{32})/)?.[1];
      const questions = input.questions as Array<{ question: string; options: Array<{ label: string }> }>;
      const question = questions?.[0];
      const abort = id === 'investigate-owned-abort';
      const choice = question?.options?.find(option => (abort ? /\b(abort|stop|cancel)\b/i : /\b(continue|proceed)\b/i).test(option.label));
      if (!owner || questions?.length !== 1 || !choice || !/continue|proceed|abort/i.test(question.question)) {
        interactions.push({ tool, disposition: 'unsupported-question', input, owner });
        return { behavior: 'deny', message: 'Ask only whether to continue or abort, after scope acquisition.' };
      }
      interactions.push({ tool, disposition: abort ? 'explicit-abort' : 'continue-investigation', input, owner });
      return { behavior: 'allow', updatedInput: { ...input, answers: { [question.question]: choice.label } } };
    }
    return { behavior: 'allow', updatedInput: input };
  };
  const snapshot = () => ({ receipts: read(receipts), boundary: read(boundary), source: read(source), interactions, executions,
    changedProtectedFiles: [...protectedFiles].filter(([file, bytes]) => read(file) !== bytes).map(([file]) => path.relative(root, file)) });
  return { id, root, repo, env, prompt, source, receipts, boundary, installed, canUseTool, preToolUse, snapshot };
}

export function boundaryFailures(fixture: ReturnType<typeof createBoundaryFixture>, result: Pick<AgentSdkResult, 'exitReason' | 'events' | 'assistantTurns'>) {
  const evidence = fixture.snapshot();
  const session = result.events.find(event => event.type === 'system' && event.subtype === 'init')?.session_id;
  const assistant = result.assistantTurns.filter(event => event.session_id === session && event.parent_tool_use_id === null && event.message.role === 'assistant');
  const finalId = assistant.at(-1)?.message.id;
  const finalText = session && finalId ? assistant.filter(event => event.message.id === finalId)
    .flatMap(event => event.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  check(result.exitReason === 'success', `actor ended: ${result.exitReason}`);
  check(evidence.changedProtectedFiles.length === 0, 'protected fixture files changed');
  check(!evidence.interactions.some(event => /invalid|unsupported/.test(event.disposition)), 'undeclared interaction');
  check(evidence.executions.some(event => event.tool === 'Bash' && event.allowed), 'registered native hook saw no Bash execution');
  const owners = [...evidence.receipts.matchAll(/^FREEZE_OWNER=([a-f0-9]{32})$/gm)].map(match => match[1]);
  check(owners.length === 1, 'actor must acquire exactly one run-owned boundary');
  check(evidence.receipts.includes(`FREEZE_DIR=${path.join(fixture.repo, 'src')}\n`), 'actor did not acquire the affected module');
  check(evidence.receipts.includes(`ACTION:release:${owners[0]}\n`), 'actor did not release its acquired owner token');
  check(evidence.receipts.includes('FREEZE_RELEASED:'), 'helper did not confirm owned cleanup');
  check(!evidence.boundary && !fs.existsSync(fixture.boundary), 'owned boundary remains');
  if (fixture.id === 'investigate-owned-abort') {
    check(evidence.interactions.some(event => event.disposition === 'explicit-abort' && event.owner === owners[0]), 'explicit abort was not delivered after acquisition');
    check(evidence.source === 'export function value() { return 1; }\n', 'edit occurred despite explicit abort');
    check(!evidence.receipts.includes('VERIFY\n'), 'verifier ran after abort');
    check(/abort|stop|cancel/i.test(finalText), 'actor did not acknowledge abort');
  } else {
    check(evidence.executions.filter(event => event.tool === 'Edit' && event.allowed).length === 1, 'expected one allowed native Edit');
    check(evidence.interactions.some(event => event.disposition === 'continue-investigation' && event.owner === owners[0]), 'continuation was not authorized under the acquired owner');
    check(evidence.source.includes('return 2'), 'requested correction is missing');
    check(evidence.receipts.match(/^VERIFY$/gm)?.length === 1, 'verifier did not run exactly once');
    if (fixture.id === 'investigate-owned-ending-error') {
      check(evidence.receipts.includes('VERIFY_STATUS:69\n'), 'ending verifier error was not delivered');
      check(/error|unavailable|cannot|could not|unable/i.test(finalText), 'ending error not acknowledged');
    } else check(evidence.receipts.includes('VERIFY_STATUS:0\n'), 'verification did not succeed');
  }
  return failures;
}

export async function runBoundaryActor(id: BoundaryCase, record: (entry: EvalTestEntry) => void, provider?: QueryProvider) {
  const started = Date.now();
  let fixture: ReturnType<typeof createBoundaryFixture> | undefined;
  let result: AgentSdkResult | undefined;
  let passed = false;
  let error: unknown;
  const attempts: Array<{ events: SDKMessage[]; evidence?: ReturnType<ReturnType<typeof createBoundaryFixture>['snapshot']> }> = [];
  try {
    fixture = createBoundaryFixture(id);
    const { runAgentSdkTest, resolveClaudeBinary } = await import('./agent-sdk-runner');
    const executable = resolveClaudeBinary();
    if (!provider && !executable) throw new Error('F9 actor requires the pinned native Claude CLI');
    const query = provider ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    result = await runAgentSdkTest({
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      userPrompt: fixture.prompt, workingDirectory: fixture.repo, env: fixture.env,
      pathToClaudeCodeExecutable: executable ?? undefined,
      allowedTools: ['Read', 'Bash', 'Edit', 'AskUserQuestion'], settingSources: [],
      canUseTool: (...args) => fixture!.canUseTool(...args), maxTurns: 12, signal: AbortSignal.timeout(CAPTURE_MS - 20000),
      testName: id,
      onRetry: () => {
        attempts.at(-1)!.evidence = fixture!.snapshot();
        const root = fixture!.root;
        fs.rmSync(root, { recursive: true, force: true });
        fixture = createBoundaryFixture(id, root);
      },
      queryProvider: options => {
        const attempt: typeof attempts[number] = { events: [] };
        attempts.push(attempt);
        const stream = query({ ...options, options: { ...options.options,
          allowedTools: [], hooks: { PreToolUse: [{ hooks: [(...args) => fixture!.preToolUse(...args)] }] },
        } });
        return new Proxy(stream, { get(target, property) {
          if (property === Symbol.asyncIterator) return async function* () {
            try { for await (const event of target) { attempt.events.push(event); yield event; } }
            finally { attempt.evidence = fixture!.snapshot(); }
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    });
    const failures = boundaryFailures(fixture, result);
    if (failures.length) throw new Error(failures.join('; '));
    passed = true;
  } catch (failure) {
    error = failure;
    throw failure;
  } finally {
    try {
      record({ name: id, suite: 'workflow-boundaries', tier: 'e2e', passed,
        duration_ms: Date.now() - started, cost_usd: result?.costUsd ?? 0,
        transcript: result?.events, prompt: fixture?.prompt, turns_used: result?.turnsUsed, model: result?.model,
        output: JSON.stringify({ assistant: result?.output, error: error === undefined ? undefined : String(error), evidence: fixture?.snapshot(), attempts }),
        exit_reason: passed ? 'success' : result?.exitReason === 'success' ? 'assertion_failed' : result?.exitReason ?? 'runner_error' });
    } finally {
      if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}
