#!/usr/bin/env bun
/** Query/trust gstack's Codex hook through Codex's own app-server API. */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isManagedGstackHook } from './codex-hook-config';

export interface CodexHookState {
  present: boolean;
  enabled?: boolean;
  trustStatus?: string;
  currentHash?: string;
  key?: string;
  matcher?: string;
  command?: string;
  timeoutSec?: number;
  statusMessage?: string | null;
}

export async function codexHookState(action: 'status' | 'trust', cwd = process.cwd()): Promise<CodexHookState> {
  return await new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let settled = false;
    const finish = (value?: CodexHookState, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value!);
    };
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const timer = setTimeout(() => finish(undefined, new Error('Codex hook-state query timed out')), 8000);
    child.on('error', error => finish(undefined, error));
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'hooks/list', params: { cwds: [path.resolve(cwd)] } });
        } else if (message.id === 2 && message.result) {
          const hooks = message.result.data?.flatMap((item: any) => item.hooks || []) || [];
          const hook = hooks.find((item: any) => isManagedGstackHook({ command: item.command }));
          if (!hook) { finish({ present: false }); continue; }
          const state: CodexHookState = {
            present: true,
            enabled: hook.enabled,
            trustStatus: hook.trustStatus,
            currentHash: hook.currentHash,
            key: hook.key,
            matcher: hook.matcher,
            command: hook.command,
            timeoutSec: hook.timeoutSec,
            statusMessage: hook.statusMessage,
          };
          if (action === 'status') finish(state);
          else send({
            id: 3,
            method: 'config/batchWrite',
            params: {
              edits: [{
                keyPath: 'hooks.state',
                value: { [hook.key]: { trusted_hash: hook.currentHash, enabled: true } },
                mergeStrategy: 'upsert',
              }],
              reloadUserConfig: true,
            },
          });
        } else if (message.id === 3) {
          if (message.error) finish(undefined, new Error(`Codex refused hook trust update: ${message.error.message || 'unknown error'}`));
          else finish({ present: true, enabled: true, trustStatus: 'trusted' });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'gstack-runtime', version: '1.0.0' }, capabilities: null } });
  });
}

if (import.meta.main) {
  const action = process.argv[2] as 'status' | 'trust';
  if (!['status', 'trust'].includes(action)) throw new Error('usage: codex-hook-state.ts status|trust [cwd]');
  const result = await codexHookState(action, process.argv[3] || process.cwd());
  console.log(JSON.stringify(result));
  if (!result.present || result.enabled === false || (action === 'status' && result.trustStatus !== 'trusted')) process.exit(1);
}
