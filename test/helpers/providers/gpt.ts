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
import { CODEX_FRONTIER_MODEL } from '../../../scripts/resolvers/constants';

/**
 * GPT adapter — wraps the OpenAI `codex` CLI (codex exec with --json output).
 *
 * Codex uses ~/.codex/ for auth (not OPENAI_API_KEY). The --json flag emits
 * JSONL events; we parse `turn.completed` for usage and `agent_message` / etc.
 * for output aggregation.
 */
export class GptAdapter implements ProviderAdapter {
  readonly name = 'gpt';
  readonly family = 'gpt' as const;

  async available(): Promise<AvailabilityCheck> {
    const res = spawnSync('sh', ['-c', 'command -v codex'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'codex CLI not found on PATH. Install: npm i -g @openai/codex' };
    }
    // Auth sniff: ~/.codex/ should contain auth state after `codex login`
    const codexDir = path.join(os.homedir(), '.codex');
    const hasFileAuth = fs.existsSync(codexDir);
    if (!hasFileAuth && !process.env.OPENAI_API_KEY) {
      return { ok: false, reason: 'No Codex auth found. Run `codex login` or export OPENAI_API_KEY.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    const model = opts.model ?? process.env.GSTACK_CODEX_MODEL ?? CODEX_FRONTIER_MODEL;

    try {
      const out = execFileSync('codex', codexExecArgs(opts, model), {
        cwd: opts.workdir,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
      return resultFromCodexStream(out,{model,durationMs:Date.now()-start});
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
    return estimateCostUsd(tokens, model ?? CODEX_FRONTIER_MODEL);
  }

  private emptyResult(durationMs: number, error: RunResult['error'], model?: string): RunResult {
    return {
      output: '',
      tokens: { input: 0, output: 0 },
      durationMs,
      toolCalls: 0,
      modelUsed: model ?? CODEX_FRONTIER_MODEL,
      error,
    };
  }
}

/**
 * Map `codex exec --json` output.
 * Codex reports cached_input_tokens as a subset of input_tokens; split them so
 * tokens.input is uncached-only and tokens.cached is the disjoint cache-read count.
 */
export function resultFromCodexStream(raw:string,opts:{model?:string;durationMs?:number}={}):RunResult{
  let output='',input=0,cached=0,out=0,toolCalls=0,modelUsed:string|undefined;
  for(const line of raw.split('\n')){
    const text=line.trim();if(!text)continue;
    try{
      const obj=JSON.parse(text);
      if(obj.type==='item.completed'&&obj.item){
        if(obj.item.type==='agent_message'&&typeof obj.item.text==='string')output+=(output?'\n':'')+obj.item.text;
        else if(obj.item.type==='command_execution')toolCalls++;
      }else if(obj.type==='turn.completed'){
        const usage=obj.usage??{},turnCached=usage.cached_input_tokens??0;input+=Math.max(0,(usage.input_tokens??0)-turnCached);cached+=turnCached;out+=usage.output_tokens??0;
        if(typeof obj.model==='string'&&obj.model)modelUsed=obj.model;
      }
    }catch{/* Codex can mix diagnostic text into the JSONL stream. */}
  }
  const durationMs=opts.durationMs??0,resolvedModel=modelUsed||opts.model||CODEX_FRONTIER_MODEL;
  return{output,tokens:{input,cached,output:out},durationMs,toolCalls,modelUsed:resolvedModel};
}

/** Exported so free tests can inspect the exact paid-CLI boundary without running it. */
export function codexExecArgs(opts: RunOpts, model: string): string[] {
  const args = ['exec', opts.prompt, '-C', opts.workdir, '-s', 'read-only', '--skip-git-repo-check', '--json', '-m', model];
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}
