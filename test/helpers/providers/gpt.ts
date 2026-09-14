import {
  csoProducerChildEnvironment,
  csoProducerHelperGeneration,
  csoProducerHelperHome,
  csoProducerProviderCommand,
  csoProducerSourceDirectory,
  csoProducerStateDirectory,
  CSO_PRODUCER_SHELL_ENV,
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
import { atomicWriteSync } from '../../../lib/fs-atomic';

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

  async available(opts?: RunOpts): Promise<AvailabilityCheck> {
    const producerCommand = csoProducerProviderCommand(opts ?? { prompt: '', workdir: '/', timeoutMs: 1 });
    const res = producerCommand ? { status: 0 } : spawnSync('sh', ['-c', 'command -v codex'], { timeout: 2000 });
    if (res.status !== 0) {
      return { ok: false, reason: 'codex CLI not found on PATH. Install: npm i -g @openai/codex' };
    }
    // Auth sniff: ~/.codex/ should contain auth state after `codex login`
    const codexDir = path.join(os.homedir(), '.codex');
    const hasFileAuth = !opts?.csoProducer && fs.existsSync(codexDir);
    if (!hasFileAuth && !process.env.OPENAI_API_KEY) {
      return { ok: false, reason: 'No Codex auth found. Paid CSO producers require OPENAI_API_KEY; other evals may use `codex login`.' };
    }
    return { ok: true };
  }

  async run(opts: RunOpts): Promise<RunResult> {
    const start = Date.now();
    // Existing callers retain `-s read-only`. CSO producer calls use an isolated
    // CODEX_HOME with a reviewed permission profile written below.
    const model = opts.model ?? process.env.GSTACK_CODEX_MODEL ?? CODEX_FRONTIER_MODEL;
    const stateDirectory = csoProducerStateDirectory(opts);

    try {
      if (stateDirectory) prepareCodexProducerState(opts);
      const args = codexExecArgs(opts, model);
      const command = csoProducerProviderCommand(opts);
      const out = execFileSync(command?.executable ?? 'codex', [...(command?.argsPrefix ?? []), ...args], {
        cwd: codexExecWorkingDirectory(opts),
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        ...(opts.csoProducer ? { env: codexExecEnvironment(opts, process.env) } : {}),
      });
      return resultFromCodexStream(out,{model,durationMs:Date.now()-start,producer:!!opts.csoProducer});
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
    } finally {
      if (stateDirectory) removeCodexProducerState(stateDirectory);
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

/** Map `codex exec --json` output while requiring evidence-bearing text for paid producers. */
export function resultFromCodexStream(raw:string,opts:{model?:string;durationMs?:number;producer?:boolean}={}):RunResult{
  let output='',input=0,out=0,toolCalls=0,modelUsed:string|undefined;
  for(const line of raw.split('\n')){
    const text=line.trim();if(!text)continue;
    try{
      const obj=JSON.parse(text);
      if(obj.type==='item.completed'&&obj.item){
        if(obj.item.type==='agent_message'&&typeof obj.item.text==='string')output+=(output?'\n':'')+obj.item.text;
        else if(obj.item.type==='command_execution')toolCalls++;
      }else if(obj.type==='turn.completed'){
        const usage=obj.usage??{};input+=usage.input_tokens??0;out+=usage.output_tokens??0;
        if(typeof obj.model==='string'&&obj.model)modelUsed=obj.model;
      }
    }catch{/* Codex can mix diagnostic text into the JSONL stream. */}
  }
  const durationMs=opts.durationMs??0,resolvedModel=modelUsed||opts.model||CODEX_FRONTIER_MODEL;
  if(opts.producer&&!output.trim())return{output:'',tokens:{input:0,output:0},durationMs,toolCalls:0,modelUsed:resolvedModel,error:{code:'unknown',reason:'empty output from codex CLI (exit 0)'}};
  return{output,tokens:{input,output:out},durationMs,toolCalls,modelUsed:resolvedModel};
}

export interface CodexProducerPaths {
  root: string;
  home: string;
  workdir: string;
  config: string;
}

export function codexProducerPaths(stateDirectory: string): CodexProducerPaths {
  const root = path.join(stateDirectory, 'codex-provider');
  return { root, home: path.join(root, 'home'), workdir: path.join(root, 'work'), config: path.join(root, 'home', 'config.toml') };
}

export function codexProducerConfig(opts: RunOpts): string {
  const launcher = opts.csoProducer?.helperLauncher;
  if (!launcher) throw new Error('CSO producer helper launcher is required');
  const sourceDirectory = csoProducerSourceDirectory(opts);
  if (!sourceDirectory) throw new Error('CSO producer source directory is required');
  const helperHome = csoProducerHelperHome(opts);
  if (!helperHome) throw new Error('CSO producer helper home is required');
  const generation = csoProducerHelperGeneration(opts);
  if (!generation) throw new Error('CSO producer helper generation is required');
  const directory = path.dirname(launcher), suffix = process.platform === 'win32' ? '.exe' : '';
  const trustedArtifacts = [
    path.join(directory, `cso-eval-producer${suffix}`), launcher,
    path.join(directory, `gstack-cso-core${suffix}`), path.join(directory, `gstack-cso-watchdog${suffix}`),
    generation,
  ];
  const grants = [...trustedArtifacts, sourceDirectory].map(file => `${JSON.stringify(file)} = "read"`).join('\n');
  return `approval_policy = "never"
default_permissions = "cso-producer"
allow_login_shell = false
check_for_update_on_startup = false

[shell_environment_policy]
inherit = "all"
include_only = ${JSON.stringify(CSO_PRODUCER_SHELL_ENV)}
ignore_default_excludes = false
experimental_use_profile = false

[permissions.cso-producer]
description = "CSO producer: private state plus one immutable source snapshot"

[permissions.cso-producer.filesystem]
":root" = "deny"
":minimal" = "read"
${grants}
${JSON.stringify(helperHome)} = "write"

[permissions.cso-producer.filesystem.":workspace_roots"]
"." = "write"

[permissions.cso-producer.network]
enabled = false
`;
}

export function prepareCodexProducerState(opts: RunOpts): CodexProducerPaths {
  const stateDirectory = csoProducerStateDirectory(opts);
  if (!stateDirectory) throw new Error('CSO producer state directory is required');
  const paths = codexProducerPaths(stateDirectory);
  if (fs.existsSync(paths.root)) throw new Error('CODEX_PRODUCER_STATE_EXISTS');
  fs.mkdirSync(paths.root, { mode: 0o700 });
  fs.mkdirSync(paths.home, { mode: 0o700 });
  fs.mkdirSync(paths.workdir, { mode: 0o700 });
  atomicWriteSync(paths.config, codexProducerConfig(opts), { mode: 0o600, noReplace: true });
  return paths;
}

export function removeCodexProducerState(stateDirectory: string): void {
  fs.rmSync(codexProducerPaths(stateDirectory).root, { recursive: true, force: true });
}

/** Exported so free tests can inspect the exact paid-CLI boundary without running it. */
export function codexExecArgs(opts: RunOpts, model: string): string[] {
  const stateDirectory = csoProducerStateDirectory(opts);
  const args = ['exec', opts.prompt, '-C', stateDirectory ? codexProducerPaths(stateDirectory).workdir : opts.workdir];
  if (stateDirectory) {
    if (opts.extraArgs?.length) throw new Error('CSO producer does not accept extra provider arguments');
    args.push(
      '--strict-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check',
    );
  } else {
    args.push('-s', 'read-only', '--skip-git-repo-check');
  }
  args.push('--json', '-m', model);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

export function codexExecWorkingDirectory(opts: RunOpts): string {
  const stateDirectory = csoProducerStateDirectory(opts);
  return stateDirectory ? codexProducerPaths(stateDirectory).workdir : opts.workdir;
}

export function codexExecEnvironment(opts: RunOpts, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!opts.csoProducer) return source as Record<string, string>;
  const stateDirectory = csoProducerStateDirectory(opts)!;
  const paths = codexProducerPaths(stateDirectory);
  return { ...csoProducerChildEnvironment('gpt', source), HOME: paths.home, CODEX_HOME: paths.home, GSTACK_HOME: csoProducerHelperHome(opts)! };
}
