import {
  type ProviderAdapter,
  type RunOpts,
  type RunResult,
  type AvailabilityCheck,
} from './types';
import { estimateCostUsd } from '../pricing';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveClaudeCommand } from '../../../lib/claude-bin';
import { resolveEvalModel } from '../../../lib/eval-model';

/**
 * Claude adapter — wraps the `claude` CLI via claude -p.
 *
 * For brevity and to avoid duplicating the full stream-json parser, this adapter
 * uses claude CLI in non-interactive mode (--print) with the simpler JSON output
 * format.
 */
export interface ClaudeAdapterOptions {
  /** Child environment for a run; defaults to claudeExecEnvironment over process.env. */
  environment?: (opts: RunOpts) => Record<string, string>;
  /** Treat an explicit error or empty `result` envelope as a failed run. */
  strict?: boolean;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude';
  readonly family = 'claude' as const;

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async available(): Promise<AvailabilityCheck> {
    // Binary on PATH (or GSTACK_CLAUDE_BIN override). Routes through the shared
    // resolver so Windows + override paths behave the same as production sites.
    const resolved = resolveClaudeCommand();
    if (!resolved) {
      return { ok: false, reason: 'claude CLI not found on PATH. Install from https://claude.ai/download or npm i -g @anthropic-ai/claude-code (or set GSTACK_CLAUDE_BIN)' };
    }
    // Auth sniff: ~/.claude/.credentials.json OR ANTHROPIC_API_KEY OR (macOS)
    // the Keychain entry subscription installs use instead of the creds file.
    // #1890: the default macOS install stores OAuth under the generic-password
    // service "Claude Code-credentials" and never writes .credentials.json,
    // so the file-or-env sniff reported "No Claude auth found" while
    // `claude -p` worked fine. Metadata probe only (no -w — never reads the
    // secret), and any failure of `security` itself falls through to the
    // not-found reason rather than throwing.
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const hasCreds = fs.existsSync(credsPath);
    const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
    let hasKeychain = false;
    if (!hasCreds && !hasKey && process.platform === 'darwin') {
      try {
        const probe = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
          stdio: 'ignore',
          timeout: 5000,
        });
        hasKeychain = probe.status === 0;
      } catch {
        hasKeychain = false;
      }
    }
    if (!hasCreds && !hasKey && !hasKeychain) {
      return { ok: false, reason: 'No Claude auth found. Log in via `claude` interactive session, or export ANTHROPIC_API_KEY.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    const resolved = resolveClaudeCommand();
    if (!resolved) {
      throw new Error('claude CLI not resolvable (set GSTACK_CLAUDE_BIN or install)');
    }
    const model = opts.model ?? process.env.EVALS_MODEL ?? resolveEvalModel('capture');
    const args = claudeExecArgs(opts, model, resolved.argsPrefix);
    const env = this.options.environment ? this.options.environment(opts) : claudeExecEnvironment(process.env);

    try {
      const out = execFileSync(resolved.command, args, {
        input: opts.prompt,
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        // Default GSTACK_HEADLESS=1 so a benchmark run classifies as headless (an
        // AskUserQuestion failure BLOCKs rather than emitting unanswerable prose).
        env,
      });
      return resultFromClaudeOutput(out,{model,durationMs:Date.now()-start,producer:!!this.options.strict});
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const e = err as { code?: string; stderr?: Buffer; signal?: string; message?: string };
      const stderr = e.stderr?.toString() ?? '';
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return this.emptyResult(durationMs, { code: 'timeout', reason: `exceeded ${opts.timeoutMs}ms` }, model);
      }
      if (/unauthorized|auth|login/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'auth', reason: stderr.slice(0, 400) }, model);
      }
      if (/rate[- ]?limit|429/i.test(stderr)) {
        return this.emptyResult(durationMs, { code: 'rate_limit', reason: stderr.slice(0, 400) }, model);
      }
      return this.emptyResult(durationMs, { code: 'unknown', reason: (e.message ?? stderr ?? 'unknown').slice(0, 400) }, model);
    }
  }

  estimateCost(tokens: { input: number; output: number; cached?: number }, model?: string): number {
    return estimateCostUsd(tokens, model ?? resolveEvalModel('capture'));
  }

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model ?? resolveEvalModel('capture'),
      error,
    };
  }
}

/** Map Claude JSON output; strict callers require the documented nonblank `result` envelope. */
export function resultFromClaudeOutput(raw:string,opts:{model?:string;durationMs?:number;producer?:boolean}={}):RunResult{
  const durationMs=opts.durationMs??0,defaultModel=opts.model??resolveEvalModel('capture');
  try{
    const obj=JSON.parse(raw),explicitError=obj?.is_error===true||(typeof obj?.subtype==='string'&&obj.subtype!=='success'),validResult=!explicitError&&typeof obj?.result==='string'&&obj.result.trim().length>0;
    if(opts.producer&&!validResult)return{output:'',tokens:{input:0,output:0},durationMs,toolCalls:0,modelUsed:typeof obj?.model==='string'&&obj.model?obj.model:defaultModel,error:{code:'unknown',reason:'empty or invalid output from claude CLI (exit 0)'}};
    const output=typeof obj?.result==='string'?obj.result:String(obj?.result??''),usage=obj?.usage??{};
    const modelsBilled=obj?.modelUsage&&typeof obj.modelUsage==='object'?Object.keys(obj.modelUsage):undefined;
    return{output,tokens:{input:usage.input_tokens??0,output:usage.output_tokens??0,cached:usage.cache_read_input_tokens,cacheWrite:usage.cache_creation_input_tokens},durationMs,toolCalls:obj?.num_turns??0,modelUsed:typeof obj?.model==='string'&&obj.model?obj.model:defaultModel,...(modelsBilled?{modelsBilled}:{})};
  }catch{
    if(opts.producer)return{output:'',tokens:{input:0,output:0},durationMs,toolCalls:0,modelUsed:defaultModel,error:{code:'unknown',reason:'empty or invalid output from claude CLI (exit 0)'}};
    return{output:raw,tokens:{input:0,output:0},durationMs,toolCalls:0,modelUsed:defaultModel};
  }
}

export function claudeExecArgs(opts: RunOpts, model: string, argsPrefix: readonly string[] = []): string[] {
  const args = [...argsPrefix, '-p', '--output-format', 'json', '--model', model];
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

export function claudeExecEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...source, GSTACK_HEADLESS: '1' } as Record<string, string>;
}
