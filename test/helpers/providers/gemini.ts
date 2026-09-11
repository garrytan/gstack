import {
  csoProducerChildEnvironment,
  csoProducerHelperHome,
  csoProducerHelperLauncher,
  csoProducerProviderCommand,
  csoProducerStateDirectory,
  validateCsoProducerStateDirectory,
  type ProviderAdapter,
  type RunOpts,
  type RunResult,
  type AvailabilityCheck,
} from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteSync } from '../../../lib/fs-atomic';

export type GeminiStreamParse = {
  output: string;
  tokens: { input: number; output: number };
  toolCalls: number;
  modelUsed?: string;
};

/**
 * Parse gemini NDJSON stream events (exported for unit tests).
 *
 * Current CLI (`--output-format stream-json`) emits:
 *   init  → model
 *   message { role, content, delta? } → concat assistant content
 *   tool_use → increment toolCalls
 *   result { stats: { input_tokens, output_tokens } } → tokens
 *
 * Legacy shape (still accepted):
 *   message { text } → concat text
 *   result { usage: { input_token_count, output_token_count } } → tokens
 */
export function parseGeminiStreamJson(raw: string): GeminiStreamParse {
  let output = '';
  let input = 0;
  let out = 0;
  let toolCalls = 0;
  let modelUsed: string | undefined;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj.type === 'init') {
        if (typeof obj.model === 'string' && obj.model) modelUsed = obj.model;
      } else if (obj.type === 'message') {
        // Current CLI: content + role. Role guard is required — the CLI echoes
        // the user prompt as role:'user', which must not land in output.
        if (obj.role === 'assistant' && typeof obj.content === 'string') {
          output += obj.content;
        } else if (typeof obj.text === 'string' && obj.role !== 'user') {
          // Legacy text field (no role, or assistant).
          output += obj.text;
        }
      } else if (obj.type === 'tool_use') {
        toolCalls += 1;
      } else if (obj.type === 'result') {
        const u = obj.usage ?? obj.stats ?? {};
        input += u.input_token_count ?? u.input_tokens ?? u.prompt_tokens ?? 0;
        out += u.output_token_count ?? u.output_tokens ?? u.completion_tokens ?? 0;
        if (typeof obj.model === 'string' && obj.model) modelUsed = obj.model;
      }
    } catch {
      // skip malformed lines
    }
  }
  return { output, tokens: { input, output: out }, toolCalls, modelUsed };
}

/**
 * Map a raw stream-json dump to a RunResult, including the empty-success
 * hardening from #2159. Exported so adapter e2e can exercise the full
 * post-CLI path without a live gemini binary.
 */
export function resultFromGeminiStream(
  raw: string,
  opts: { model?: string; durationMs?: number } = {},
): RunResult {
  const parsed = parseGeminiStreamJson(raw);
  const modelUsed = parsed.modelUsed || opts.model || 'gemini-2.5-pro';
  const durationMs = opts.durationMs ?? 0;
  if (!parsed.output.trim()) {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed,
      error: { code: 'unknown', reason: 'empty output from gemini CLI (exit 0)' },
    };
  }
  return {
    output: parsed.output,
    tokens: parsed.tokens,
    durationMs,
    toolCalls: parsed.toolCalls,
    modelUsed,
  };
}

/**
 * Gemini adapter — wraps the `gemini` CLI.
 *
 * Auth: GEMINI_API_KEY / GOOGLE_API_KEY (preferred), or ~/.gemini oauth.
 *   Personal OAuth free-tier is no longer supported by gemini CLI — use an
 *   AI Studio API key. Antigravity is a separate product/quota path.
 *
 * Headless flags always passed:
 *   --output-format stream-json  — NDJSON events (message/tool_use/result)
 *   --yolo                       — auto-approve tools (non-interactive)
 *
 * --skip-trust is gone: gemini-cli 0.34 removed the flag ("Unknown arguments:
 * skip-trust") — folder trust is settings-driven now and headless runs no
 * longer need a flag for temp workdirs.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini';
  readonly family = 'gemini' as const;

  async available(opts?: RunOpts): Promise<AvailabilityCheck> {
    const producerCommand = csoProducerProviderCommand(opts ?? { prompt: '', workdir: '/', timeoutMs: 1 });
    const res = producerCommand ? { status: 0 } : spawnSync('sh', ['-c', 'command -v gemini'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'gemini CLI not found on PATH. Install per https://github.com/google-gemini/gemini-cli' };
    }
    const legacyCfgDir = path.join(os.homedir(), '.config', 'gemini');
    const newCfgDir = path.join(os.homedir(), '.gemini');
    const newOauth = path.join(newCfgDir, 'oauth_creds.json');
    const hasCfg = !opts?.csoProducer && (fs.existsSync(legacyCfgDir) || fs.existsSync(newOauth));
    // CLI accepts either name; Google AI Studio keys are usually GEMINI_API_KEY.
    const hasKey = !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    if (!hasCfg && !hasKey) {
      return {
        ok: false,
        reason:
          'No Gemini auth found. Export GEMINI_API_KEY (or GOOGLE_API_KEY) from https://aistudio.google.com/app/apikey — personal OAuth free-tier is no longer supported by gemini CLI.',
      };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // Default to --yolo (non-interactive) and stream-json output so we can parse
    // tokens + tool calls. Callers can override via extraArgs. (--skip-trust was
    // removed in gemini-cli 0.34; passing it errors at argv parse.)
    try {
      const args = geminiExecArgs(opts);
      const command = csoProducerProviderCommand(opts);
      const out = execFileSync(command?.executable ?? 'gemini', [...(command?.argsPrefix ?? []), ...args], {
        cwd: geminiExecWorkingDirectory(opts),
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        env: geminiExecEnvironment(opts, process.env),
      });
      return resultFromGeminiStream(out, { model: opts.model, durationMs: Date.now() - start });
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
      const stderr = e.stderr?.toString() ?? '';
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, opts.model);
      }
      if (/unauthorized|auth|login|api key|ineligibletier|no longer supported/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'auth', reason: stderr.slice(0, 400) }, opts.model);
      }
      if (/rate[- ]?limit|429|quota/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'rate_limit', reason: stderr.slice(0, 400) }, opts.model);
      }
      return this.emptyResult(durationMs, { code: 'unknown', reason: (e.message ?? stderr ?? 'unknown').slice(0, 400) }, opts.model);
    }
  }

  estimateCost(tokens: { input: number; output: number; cached?: number }, model?: string): number {
    return estimateCostUsd(tokens, model ?? 'gemini-2.5-pro');
  }

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model ?? 'gemini-2.5-pro',
      error,
    };
  }
}

export interface GeminiProducerPaths {
  root: string;
  home: string;
  workdir: string;
  systemDefaults: string;
  systemSettings: string;
}

export function geminiProducerPaths(stateDirectory: string): GeminiProducerPaths {
  validateCsoProducerStateDirectory(stateDirectory);
  const root = path.join(stateDirectory, 'gemini-provider');
  return {
    root,
    home: path.join(root, 'home'),
    workdir: path.join(root, 'work'),
    systemDefaults: path.join(root, 'system-defaults.json'),
    systemSettings: path.join(root, 'system-settings.json'),
  };
}

/** Highest-precedence Gemini policy for a clean, one-cell producer host. */
const GEMINI_PRODUCER_BLOCKED_ENVIRONMENT = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
] as const;

export function geminiProducerSystemSettings(contextFileName: string, helperLauncher: string) {
  if (!/^\.gstack-cso-context-[a-f0-9]{32}\.md$/.test(contextFileName)) throw new Error('INVALID_GEMINI_CONTEXT_FILENAME');
  const helper = csoProducerHelperLauncher({ prompt: '', workdir: '/', timeoutMs: 1, csoProducer: { stateDirectory: '/', sourceDirectory: '/source', helperLauncher, helperGeneration: path.join(path.dirname(helperLauncher), '.gstack-cso-generation'), providerCommand: { executable: '/provider', argsPrefix: [] } } });
  if (!helper) throw new Error('CSO producer helper launcher is required');
  const tools = [`run_shell_command(${helper})`, 'write_file'];
  return {
    advanced: { ignoreLocalEnv: true },
    admin: {
      extensions: { enabled: false },
      mcp: { enabled: false },
      skills: { enabled: false },
    },
    context: {
      fileName: [contextFileName],
      includeDirectoryTree: false,
      loadMemoryFromIncludeDirectories: false,
      memoryBoundaryMarkers: [],
    },
    hooksConfig: { enabled: false },
    privacy: { usageStatisticsEnabled: false },
    security: {
      environmentVariableRedaction: { allowed: [], blocked: [...GEMINI_PRODUCER_BLOCKED_ENVIRONMENT], enabled: true },
      folderTrust: { enabled: false },
      toolSandboxing: false,
    },
    skills: { enabled: false },
    telemetry: { enabled: false, logPrompts: false },
    tools: { allowed: tools, core: tools, sandbox: false },
  };
}

export function prepareGeminiProducerState(stateDirectory: string, helperLauncher: string): GeminiProducerPaths {
  const paths = geminiProducerPaths(stateDirectory);
  if (fs.existsSync(paths.root)) throw new Error('GEMINI_PRODUCER_STATE_EXISTS');
  fs.mkdirSync(paths.root, { mode: 0o700 });
  fs.mkdirSync(paths.home, { mode: 0o700 });
  fs.mkdirSync(paths.workdir, { mode: 0o700 });
  const contextFileName = `.gstack-cso-context-${randomBytes(16).toString('hex')}.md`;
  atomicWriteSync(paths.systemDefaults, '{}\n', { mode: 0o600, noReplace: true });
  atomicWriteSync(paths.systemSettings, `${JSON.stringify(geminiProducerSystemSettings(contextFileName, helperLauncher), null, 2)}\n`, { mode: 0o600, noReplace: true });
  return paths;
}

export function removeGeminiProducerState(stateDirectory: string): void {
  const paths = geminiProducerPaths(stateDirectory);
  fs.rmSync(paths.root, { recursive: true, force: true });
}

export function geminiExecArgs(opts: RunOpts): string[] {
  const stateDirectory = csoProducerStateDirectory(opts);
  const args = ['-p', opts.prompt, '--output-format', 'stream-json'];
  if (stateDirectory) {
    if (opts.extraArgs?.length) throw new Error('CSO producer does not accept extra provider arguments');
    args.push(
      '--approval-mode', 'yolo',
      '--include-directories', geminiProducerPaths(stateDirectory).workdir,
      '-e', 'none',
    );
  } else {
    args.push('--yolo');
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

export function geminiExecWorkingDirectory(opts: RunOpts): string {
  const stateDirectory = csoProducerStateDirectory(opts);
  return stateDirectory ? geminiProducerPaths(stateDirectory).workdir : opts.workdir;
}

export function geminiExecEnvironment(
  opts: RunOpts,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const stateDirectory = csoProducerStateDirectory(opts);
  const paths = stateDirectory ? geminiProducerPaths(stateDirectory) : undefined;
  const env = paths ? csoProducerChildEnvironment('gemini', source) : { ...source } as Record<string, string>;
  // Prefer GEMINI_API_KEY when only that is set (CLI reads both).
  if (env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = env.GEMINI_API_KEY;
  if (paths) {
    env.HOME = paths.home;
    env.GSTACK_HOME = csoProducerHelperHome(opts)!;
    env.GEMINI_SANDBOX = 'false';
    env.GEMINI_TELEMETRY_ENABLED = 'false';
    env.GEMINI_TELEMETRY_LOG_PROMPTS = 'false';
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
    env.GEMINI_SYSTEM_MD = 'false';
    env.GEMINI_WRITE_SYSTEM_MD = 'false';
    env.GEMINI_CLI_HOME = paths.home;
    env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = paths.systemDefaults;
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = paths.systemSettings;
  }
  return env;
}
