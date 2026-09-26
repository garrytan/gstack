import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { CanUseTool, HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdkResult, QueryProvider } from './agent-sdk-runner';
import type { EvalTestEntry } from './eval-store';
import { CAPTURE_MS } from './eval-budgets';
import { readWorkflowExcerpt } from './workflow-excerpt';

export type ShipHookCase = 'ship-managed-hook-refresh' | 'ship-unmanaged-hook-consent' | 'ship-local-hook-preservation';
const ROOT = path.resolve(import.meta.dir, '../..');
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const oldHook = '#!/bin/sh\n# gstack-redact pre-push (managed)\n_input="$(cat)"\nprintf "%s" "$_input" | "$(git rev-parse --git-path hooks/pre-push.local)" "$@"\n';
const unmanagedHook = '#!/bin/sh\n# gstack-redact pre-push (managed) extra\nexit 42\n';
const localPolicy = '#!/bin/sh\ncat > "$HOME/received"\nexit 37\n';
const refs = 'refs/heads/a aaaa refs/heads/a bbbb\nrefs/heads/b cccc refs/heads/b dddd\n';

export function createShipHookFixture(id: ShipHookCase, root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shook-'))) {
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o700);
  const repo = path.join(root, 'project');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const installed = path.join(home, '.claude/skills/gstack/bin');
  const receipts = path.join(root, 'receipts');
  const protectedFiles = new Map<string, string>();
  const write = (file: string, text: string, executable = false) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const target = fs.lstatSync(file, { throwIfNoEntry: false }) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    const relative = path.relative(fs.realpathSync(root), target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('fixture write escaped its temporary root');
    fs.writeFileSync(file, text, { mode: executable ? 0o755 : 0o600 });
    protectedFiles.set(file, text);
  };
  fs.mkdirSync(repo);
  fs.mkdirSync(state);
  const env = { HOME: home, GSTACK_HOME: state, GSTACK_STATE_ROOT: state, CLAUDE_PLUGIN_DATA: '',
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
  const initialized = spawnSync('git', ['init', '-q', repo], { env, encoding: 'utf8', timeout: 10000 });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  const hook = path.join(repo, '.git/hooks/pre-push');
  write(hook, id === 'ship-managed-hook-refresh' ? oldHook : unmanagedHook, true);
  if (id !== 'ship-unmanaged-hook-consent') write(hook + '.local', localPolicy, true);
  if (id === 'ship-managed-hook-refresh') protectedFiles.delete(hook);
  write(path.join(state, 'config.yaml'), 'redact_prepush_hook: true\n');
  write(path.join(installed, 'gstack-config'), `#!/bin/sh\nprintf 'CONFIG:%s\\n' "$*" >> ${quote(receipts)}\nexec bash ${quote(path.join(ROOT, 'bin/gstack-config'))} "$@"\n`, true);
  write(path.join(installed, 'gstack-redact'), `#!/bin/sh\nprintf 'INSTALL:%s\\n' "$*" >> ${quote(receipts)}\nexec ${quote(process.execPath)} ${quote(path.join(ROOT, 'bin/gstack-redact'))} "$@"\n`, true);
  const workflow = readWorkflowExcerpt('ship/SKILL.md', '**Credential pre-push guard', '**Idempotency check');
  write(path.join(repo, 'workflow.md'), workflow);
  const guard = workflow.match(/```bash\n([\s\S]*?)```/)![1].trim();
  const readable = new Set([path.join(repo, 'workflow.md'), hook, hook + '.local']);
  const commands = new Set([guard, 'git config --get core.hooksPath', 'git rev-parse --git-path hooks/pre-push', 'git rev-parse --git-path hooks/pre-push.local']);
  const executions: Array<{ tool: string; input: Record<string, unknown>; allowed: boolean }> = [];
  const interactions: Array<{ disposition: string; input: unknown }> = [];
  const prompt = `Load gstack's /ship credential pre-push guard from workflow.md and run only that workflow excerpt. Inspect the actual repository, apply its rules, report the outcome, and stop before pushing.

Declared fixture interactions: Read workflow.md and the local hook files; Bash for the supplied guard block verbatim and these read-only commands: git config --get core.hooksPath, git rev-parse --git-path hooks/pre-push, git rev-parse --git-path hooks/pre-push.local. Run each listed inspection command in its own Bash call; do not chain commands or append an echo/status probe. A missing core.hooksPath setting may return exit 1 without requiring another command. One native AskUserQuestion about hook modification is supported if the workflow calls for it; the owner declines modifications. Use Read rather than shell commands to inspect files. No other command, file edit, direct receipt access, directory change, background command, commit, push, config change, installation phase or unrelated /ship phase is supported. HOME and GSTACK_HOME already belong to this fixture; do not change them.`;
  const invalid = (tool: string, input: Record<string, unknown>) => {
    if (tool === 'Read') return typeof input.file_path !== 'string' || !readable.has(path.resolve(repo, input.file_path)) ? 'Read outside declared fixture paths' : undefined;
    if (tool === 'Bash') return typeof input.command !== 'string' || input.run_in_background || !commands.has(input.command.trim()) ? 'Bash outside declared fixture commands' : undefined;
    if (tool === 'AskUserQuestion') return interactions.some(event => event.disposition === 'declined') ? 'Duplicate owner question' : undefined;
    return 'Tool outside declared fixture interactions';
  };
  const preToolUse: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') throw new Error('unexpected native hook event');
    const toolInput = input.tool_input as Record<string, unknown>;
    const reason = invalid(input.tool_name, toolInput);
    executions.push({ tool: input.tool_name, input: toolInput, allowed: !reason });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: reason ? 'deny' : input.tool_name === 'AskUserQuestion' ? 'ask' : 'allow',
      ...(reason ? { permissionDecisionReason: reason } : {}),
      ...(input.tool_name === 'Bash' && !reason ? { updatedInput: { command: toolInput.command, timeout: 10000, run_in_background: false } } : {}) } };
  };
  const canUseTool: CanUseTool = async (tool, input) => {
    const reason = invalid(tool, input);
    if (reason) {
      interactions.push({ disposition: 'unsupported', input });
      return { behavior: 'deny', message: reason };
    }
    if (tool !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    const questions = input.questions as Array<{ question: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }>;
    const question = questions?.[0];
    const decline = question?.options?.find(option => /^(?:[A-D][).]\s*)?(no\b|decline\b|do not\b|skip\b|leave\b|keep\b)/i.test(option.label));
    if (questions?.length !== 1 || question.multiSelect || !/hook|guard|chain|credential/i.test(question.question) || !decline) {
      interactions.push({ disposition: 'unsupported', input });
      return { behavior: 'deny', message: 'Only one hook modification question with a decline option is supported.' };
    }
    interactions.push({ disposition: 'declined', input });
    return { behavior: 'allow', updatedInput: { ...input, answers: { [question.question]: decline.label } } };
  };
  const snapshot = () => ({ receipts: read(receipts), hook: read(hook), localHook: read(hook + '.local'), localExists: fs.existsSync(hook + '.local'),
    executions, interactions, changedProtectedFiles: [...protectedFiles].filter(([file, bytes]) => read(file) !== bytes).map(([file]) => path.relative(root, file)),
    workflowSha256: createHash('sha256').update(workflow).digest('hex') });
  return { id, root, repo, home, env, hook, receipts, guard, prompt, preToolUse, canUseTool, snapshot };
}

export function shipHookFailures(fixture: ReturnType<typeof createShipHookFixture>, result: Pick<AgentSdkResult, 'exitReason' | 'output'>) {
  const evidence = fixture.snapshot();
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  check(result.exitReason === 'success', `actor ended: ${result.exitReason}`);
  check(evidence.changedProtectedFiles.length === 0, 'protected policy or fixture files changed');
  check(!evidence.executions.some(event => !event.allowed) && !evidence.interactions.some(event => event.disposition === 'unsupported'), 'undeclared interaction');
  check(evidence.executions.some(event => event.tool === 'Read' && event.allowed && path.resolve(fixture.repo, event.input.file_path as string) === path.join(fixture.repo, 'workflow.md')), 'workflow was not read through native hook');
  check(evidence.executions.some(event => event.tool === 'Bash' && event.allowed && (event.input.command as string).trim() === fixture.guard), 'guard was not executed through native hook');
  check(evidence.receipts.includes('CONFIG:get redact_prepush_hook\n'), 'actual config helper was not called');
  const installs = evidence.receipts.match(/^INSTALL:install-prepush-hook$/gm)?.length ?? 0;
  let callback: { status: number | null; received: string } | undefined;
  if (fixture.id === 'ship-managed-hook-refresh') {
    check(installs === 1, 'expected exactly one actual installer call');
    check(evidence.hook !== oldHook && evidence.hook.includes('_input="$(cat; printf x)"'), 'managed wrapper was not refreshed');
    check(evidence.localHook === localPolicy, 'local policy changed');
    check(evidence.interactions.length === 0, 'managed refresh unnecessarily requested consent');
    const invoked = spawnSync('bash', [fixture.hook, 'origin', 'synthetic'], { cwd: fixture.repo, env: fixture.env, input: refs, encoding: 'utf8', timeout: 10000 });
    callback = { status: invoked.status, received: read(path.join(fixture.home, 'received')) };
    check(callback.status === 37 && callback.received === refs, 'refreshed wrapper lost local policy status or complete stdin');
    check(/refresh|updat|install|current/i.test(result.output), 'refresh outcome was not acknowledged');
  } else {
    check(installs === 0, 'installer invoked without applicable consent');
    check(evidence.hook === unmanagedHook, 'unmanaged policy changed');
    if (fixture.id === 'ship-unmanaged-hook-consent') {
      check(evidence.interactions.filter(event => event.disposition === 'declined').length === 1, 'unmanaged-hook consent was not requested');
      check(!evidence.localExists, 'declined install created a local policy');
      check(/declin|unchanged|not install|not modif|preserv|left|leave/i.test(result.output), 'declined modification was not acknowledged');
    } else {
      check(evidence.localHook === localPolicy, 'existing local policy changed');
      check(evidence.interactions.length === 0, 'existing local policy requires manual integration, not consent to overwrite');
      check(/manual/i.test(result.output), 'manual integration was not reported');
    }
  }
  return { failures, evidence: { ...evidence, callback } };
}

export async function runShipHookActor(id: ShipHookCase, record: (entry: EvalTestEntry) => void, injectedQuery?: QueryProvider, artifactDirectory?: string) {
  const artifacts = artifactDirectory ?? process.env.GSTACK_EVAL_DIR;
  if (!artifacts) throw new Error('ship hook actor requires an explicit GSTACK_EVAL_DIR for durable evidence');
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { runAgentSdkTest, resolveClaudeBinary } = await import('./agent-sdk-runner');
  let fixture = createShipHookFixture(id);
  const started = Date.now();
  const attempts: Array<{ events: SDKMessage[]; evidence?: ReturnType<typeof fixture.snapshot> }> = [];
  let result: AgentSdkResult | undefined;
  let finalEvidence: unknown;
  let failure: unknown;
  let passed = false;
  const evidenceFile = path.join(artifacts, `${id}-${randomUUID()}.json`);
  try {
    const binary = injectedQuery ? undefined : resolveClaudeBinary();
    if (!injectedQuery && !binary) throw new Error('native ship hook actor requires the pinned Claude CLI');
    result = await runAgentSdkTest({ systemPrompt: { type: 'preset', preset: 'claude_code' }, userPrompt: fixture.prompt,
      workingDirectory: fixture.repo, env: fixture.env, maxTurns: 12, signal: AbortSignal.timeout(CAPTURE_MS - 20000),
      allowedTools: ['Read', 'Bash', 'AskUserQuestion'], settingSources: [], testName: id,
      pathToClaudeCodeExecutable: binary ?? undefined,
      canUseTool: (...args) => fixture.canUseTool(...args),
      onRetry: () => {
        attempts.at(-1)!.evidence = fixture.snapshot();
        const root = fixture.root;
        fs.rmSync(root, { recursive: true, force: true });
        fixture = createShipHookFixture(id, root);
      },
      queryProvider: options => {
        const attempt: typeof attempts[number] = { events: [] };
        attempts.push(attempt);
        const stream = (injectedQuery ?? query)({ ...options, options: { ...options.options, allowedTools: [],
          hooks: { PreToolUse: [{ hooks: [(...args) => fixture.preToolUse(...args)] }] } } });
        return new Proxy(stream, { get(target, property) {
          if (property === Symbol.asyncIterator) return async function* () {
            try { for await (const event of target) { attempt.events.push(event); yield event; } }
            finally { attempt.evidence = fixture.snapshot(); }
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    });
    const verdict = shipHookFailures(fixture, result);
    finalEvidence = verdict.evidence;
    if (verdict.failures.length) throw new Error(verdict.failures.join('; '));
    passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      const output = JSON.stringify({ assistant: result?.output, error: failure === undefined ? undefined : String(failure),
        evidence: finalEvidence ?? fixture.snapshot(), attempts });
      fs.writeFileSync(evidenceFile, output + '\n', { mode: 0o600 });
      record({ name: id, suite: 'ship-hook-boundary', tier: 'e2e', passed, duration_ms: Date.now() - started,
        cost_usd: result?.costUsd ?? 0, transcript: result?.events, prompt: fixture.prompt, turns_used: result?.turnsUsed,
        model: result?.model, output, error: failure === undefined ? undefined : String(failure),
        exit_reason: passed ? 'success' : result?.exitReason === 'success' ? 'assertion_failed' : result?.exitReason ?? 'runner_error' });
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  }
  return evidenceFile;
}
