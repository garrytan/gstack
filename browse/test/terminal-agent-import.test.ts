import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
const agent = new URL('../src/terminal-agent.ts', import.meta.url).href;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('importing terminal-agent helpers does not boot the CLI or install process handlers', () => {
  const root = mkdtempSync(join(tmpdir(), 'terminal-agent-import-'));
  roots.push(root);
  const result = Bun.spawnSync([process.execPath, '-e', `
    const errors = process.listenerCount('uncaughtException');
    const rejections = process.listenerCount('unhandledRejection');
    await import(${JSON.stringify(agent)});
    await Bun.sleep(2300);
    if (process.listenerCount('uncaughtException') !== errors || process.listenerCount('unhandledRejection') !== rejections) process.exit(2);
    console.log('imported without boot');
  `], {
    env: { ...process.env, HOME: root, BROWSE_STATE_FILE: join(root, 'browse.json'), BROWSE_AGENT_GEN: 'missing-record' },
    timeout: 6000,
  });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain('imported without boot');
  expect(new TextDecoder().decode(result.stderr)).not.toContain('[terminal-agent]');
}, 8000);

test('direct terminal-agent execution still refuses an unconfirmed startup record', () => {
  const root = mkdtempSync(join(tmpdir(), 'terminal-agent-direct-'));
  roots.push(root);
  const result = Bun.spawnSync([process.execPath, new URL('../src/terminal-agent.ts', import.meta.url).pathname], {
    env: { ...process.env, HOME: root, BROWSE_STATE_FILE: join(root, 'browse.json'), BROWSE_AGENT_GEN: 'missing-record' },
    timeout: 6000,
  });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain('terminal-agent startup record was not confirmed');
}, 8000);
