import { 
  AdapterExecutionContext, 
  AdapterExecutionResult,
  asString,
  asNumber,
  asBoolean,
  parseObject,
  renderTemplate,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess
} from '@paperclipai/adapter-utils/server-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // 1. Read config
  const cwd = asString(ctx.config.cwd);
  const model = asString(ctx.config.model, 'claude-3.5-sonnet');
  const timeoutSec = asNumber(ctx.config.timeoutSec, 120);
  const graceSec = asNumber(ctx.config.graceSec, 15);
  const sessionHistoryLimit = asNumber(ctx.config.sessionHistoryLimit, 10);

  // 2. Validate cwd
  let absoluteCwd: string;
  try {
    absoluteCwd = ensureAbsoluteDirectory(cwd);
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Invalid cwd: ${err.message}`,
      usage: null,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      provider: null,
      model: null,
      costUsd: null,
      resultJson: null,
      summary: null,
      clearSession: false,
    };
  }

  // 3. Build environment
  const env = {
    ...process.env,
    ...buildPaperclipEnv(ctx.agent),
    // Inject OpenCode specific env vars
    OPENCODE_MODEL: model,
    // Note: OpenCode uses environment variables for API keys, but we rely on the user's configuration
    // We don't inject API keys here because OpenCode reads them from its own config or env vars.
    // However, we can inject the Paperclip API key if needed for the paperclip skill.
    // But note: the paperclip skill is injected via the skills directory, not via env.
  };

  // 4. Resolve session
  // OpenCode uses SQLite database for session storage, so we don't manage session via env vars.
  // Instead, we rely on OpenCode's built-in session management which uses the cwd to store sessions.
  // We don't need to do anything special for session resume because OpenCode handles it internally
  // based on the working directory.

  // 5. Render prompt
  const prompt = renderTemplate(
    'You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.',
    {
      agentId: ctx.agent.id,
      companyId: ctx.agent.companyId,
      runId: ctx.runId,
      company: ctx.context.company,
      agent: ctx.context.agent,
      run: ctx.context.run,
      context: ctx.context,
    }
  );

  // 6. Call onMeta (we don't have onMeta in the context, but the skill says to call it)
  // Actually, the context has onMeta? Let's check the AdapterExecutionContext interface from the skill.
  // The skill says: `onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;`
  // We'll call it if available.
  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: ctx.agent.adapterType,
      agentId: ctx.agent.id,
      runId: ctx.runId,
      // We don't have the prompt in the meta, but we can include the config without secrets
      config: {
        model,
        timeoutSec,
        graceSec,
        sessionHistoryLimit,
        // Note: we don't include cwd in meta because it's not secret, but we can if needed.
        // However, the skill says to use redactEnvForLogs for env, but for config we just pass non-secret fields.
      },
    });
  }

  // 7. Spawn the process
  // We need to check if the opencode command is available
  let command = 'opencode';
  try {
    ensureCommandResolvable(command, absoluteCwd, env);
  } catch (err) {
    return {
      exitCode: 127,
      signal: null,
      timedOut: false,
      errorMessage: `OpenCode CLI not found: ${err.message}`,
      usage: null,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      provider: null,
      model: null,
      costUsd: null,
      resultJson: null,
      summary: null,
      clearSession: false,
    };
  }

  // We'll run opencode in non-interactive mode with the prompt
  // Note: OpenCode non-interactive mode: opencode -p "your prompt"
  // We also want to set the working directory
  const args = ['-p', prompt];

  // We also want to set the data directory to be inside the cwd to avoid conflicts
  // OpenCode uses a data directory (default: .opencode) in the current working directory.
  // We can leave it as default, which will be inside the cwd.

  let childProcess;
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  try {
    const { 
      exitCode, 
      signal, 
      output, 
      timeout 
    } = await runChildProcess(
      ctx.runId,
      command,
      args,
      {
        cwd: absoluteCwd,
        env,
        timeout: timeoutSec * 1000, // convert to milliseconds
        maxBuffer: 1024 * 1024, // 1MB max buffer
      }
    );

    // Collect output
    stdout = output.stdout ?? '';
    stderr = output.stderr ?? '';

    // Parse the output to extract usage, sessionId, etc.
    // For OpenCode, the non-interactive mode outputs the response directly.
    // We don't have a structured output for usage, so we'll set usage to null.
    // We also don't have a session ID in the output for non-interactive mode.
    // However, OpenCode does store sessions in the database, so we can try to get the latest session.
    // But for simplicity, we'll not return session info in this version.

    // We'll consider the exit code from the process
    const result: AdapterExecutionResult = {
      exitCode,
      signal,
      timedOut: timeout,
      errorMessage: timeout ? 'Process timed out' : (stderr.length > 0 ? stderr : null),
      usage: null, // OpenCode doesn't provide usage in non-interactive mode output
      sessionId: null, // We don't have a session ID to return
      sessionParams: null, // We don't manage session params in the adapter
      sessionDisplayId: null,
      provider: null, // We don't know the provider from the output
      model,
      costUsd: null, // We don't have cost info
      resultJson: null, // We could store the raw output, but the skill doesn't require it
      summary: stdout.trim(), // The summary is the stdout
      clearSession: false, // We don't clear the session because we don't manage it
    };

    return result;
  } catch (err) {
    // If runChildProcess throws, it's likely a timeout or error
    return {
      exitCode: 1,
      signal: null,
      timedOut: err.timedOut ?? false,
      errorMessage: err.message ?? 'Unknown error',
      usage: null,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      provider: null,
      model: null,
      costUsd: null,
      resultJson: null,
      summary: null,
      clearSession: false,
    };
  }
}