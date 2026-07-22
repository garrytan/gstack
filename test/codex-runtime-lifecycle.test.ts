import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { satisfiesVersion, selectRoot, verifyCodexRuntime } from '../lib/codex-runtime-health';
import { updateCodexHook } from '../scripts/codex-hook-config';
import { codexHookState } from '../scripts/codex-hook-state';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-runtime-'));
  roots.push(root);
  return root;
}

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function entrypointHash(root: string): string {
  return sha(canonical({
    skill: sha(fs.readFileSync(path.join(root, 'SKILL.md'))),
    metadata: sha(fs.readFileSync(path.join(root, 'agents/openai.yaml'))),
    dependencies: sha(fs.readFileSync(path.join(root, 'runtime-dependencies.json'))),
  }));
}

function runtimeFixture(root: string): void {
  write(path.join(root, 'SKILL.md'), 'MODEL_OVERLAY: gpt\n');
  write(path.join(root, 'agents/openai.yaml'), 'name: gstack\n');
  write(path.join(root, 'runtime-dependencies.json'), '{}\n');
  write(path.join(root, 'bin/probe'), '#!/bin/sh\n');
  fs.chmodSync(path.join(root, 'bin/probe'), 0o755);
  const content = entrypointHash(root);
  const identifiers = {
    capability_registry_digest: 'a'.repeat(64),
    runtime_asset_digest: 'b'.repeat(64),
    release_artifact_digest: 'c'.repeat(64),
  };
  const contract = {
    contract_version: '1.0.0',
    identifiers,
    assets: [],
    requirements: [],
    entrypoints: [{
      name: 'gstack',
      source_skill: 'gstack',
      content_sha256: content,
      dependencies: [],
      requirements: { inherited: [], explicit: [] },
    }],
  };
  write(path.join(root, 'runtime/codex-runtime-contract.json'), `${JSON.stringify(contract)}\n`);
  write(path.join(root, '.gstack-install.json'), `${JSON.stringify({
    target: 'global',
    selected_installation_digest: 'd'.repeat(64),
    source_root: null,
    asset_hashes: {},
    ...identifiers,
  })}\n`);
}

describe('Codex runtime root and health', () => {
  test('repo sidecar wins over the global fallback and explicit root wins over both', () => {
    const repo = temp();
    const sidecar = path.join(repo, '.agents/skills/gstack');
    fs.mkdirSync(sidecar, { recursive: true });
    expect(selectRoot(path.join(repo, 'nested'))).toEqual({ root: sidecar, source: 'sidecar' });
    expect(selectRoot(repo, path.join(repo, 'explicit'))).toEqual({
      root: path.join(repo, 'explicit'),
      source: 'explicit',
    });
  });

  test('health binds the receipt, contract, overlay, entrypoint bytes, and dependencies', () => {
    const root = temp();
    runtimeFixture(root);
    const result = verifyCodexRuntime({ root, entrypoint: 'gstack', skipEnvironment: true });
    expect(result.ok).toBe(true);
    write(path.join(root, 'SKILL.md'), 'MODEL_OVERLAY: gpt\ntampered\n');
    expect(verifyCodexRuntime({ root, entrypoint: 'gstack', skipEnvironment: true }).ok).toBe(false);
  });

  test('version comparison is fail-closed', () => {
    expect(satisfiesVersion('codex 0.144.1', '>=0.144.0')).toBe(true);
    expect(satisfiesVersion('codex 0.143.9', '>=0.144.0')).toBe(false);
    expect(satisfiesVersion('unknown', '>=0.144.0')).toBe(false);
  });
});

describe('Codex hook lifecycle', () => {
  test('install/update/uninstall preserves unrelated SessionStart hooks', () => {
    const root = temp();
    const file = path.join(root, 'hooks.json');
    write(file, `${JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/other/hook' }] }] }, other: true })}\n`);
    updateCodexHook(file, 'install');
    expect(updateCodexHook(file, 'check')).toBe(true);
    let parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(JSON.stringify(parsed)).toContain('/other/hook');
    expect(JSON.stringify(parsed)).toContain('gstack-codex-runtime-health');
    updateCodexHook(file, 'uninstall');
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(JSON.stringify(parsed)).toContain('/other/hook');
    expect(JSON.stringify(parsed)).not.toContain('gstack-codex-runtime-health');
    expect(parsed.other).toBe(true);
  });

  test('uses Codex own hook API to observe and activate exact trust state', async () => {
    const dir = temp();
    const fake = path.join(dir, 'codex');
    write(fake, `#!/usr/bin/env bun
for await (const line of Bun.stdin.stream().pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({ transform(chunk, controller) { for (const row of chunk.split('\\n')) if (row) controller.enqueue(row); } }))) {
  const message = JSON.parse(line);
  if (message.id === 1) console.log(JSON.stringify({id:1,result:{}}));
  if (message.id === 2) console.log(JSON.stringify({id:2,result:{data:[{hooks:[{key:'/tmp/hooks.json:session_start:0:0',enabled:true,trustStatus:'trusted',currentHash:'sha256:abc',matcher:'startup|resume|clear|compact',command:'~/.codex/skills/gstack/bin/gstack-codex-runtime-health --quiet',timeoutSec:10,statusMessage:'Checking gstack runtime'}]}]}}));
  if (message.id === 3) console.log(JSON.stringify({id:3,result:{}}));
}
`);
    fs.chmodSync(fake, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous}`;
    try {
      expect(await codexHookState('status', dir)).toMatchObject({
        present: true,
        enabled: true,
        trustStatus: 'trusted',
        currentHash: 'sha256:abc',
      });
      expect(await codexHookState('trust', dir)).toMatchObject({
        present: true,
        enabled: true,
        trustStatus: 'trusted',
      });
    } finally {
      process.env.PATH = previous;
    }
  }, 15_000);
});
