import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  type ContextSyncConfig,
  hashFile,
  initConfig,
  logicalIdFor,
  normalizePathForId,
  runCommit,
  scanConfig,
} from '../context-sync/src/core';

const ROOT = path.resolve(import.meta.dir, '..');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-sync-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('context-sync core', () => {
  test('normalizes paths and hashes files deterministically', async () => {
    const file = writeFile('source/chat.jsonl', '{"role":"user","content":"hello"}\n');
    expect(normalizePathForId('C:\\Users\\Owner\\.codex\\sessions')).toBe('c:/users/owner/.codex/sessions');
    expect(logicalIdFor('codex-sessions', '2026/05/chat.jsonl')).toBe(logicalIdFor('codex-sessions', '2026\\05\\CHAT.jsonl'));
    expect(await hashFile(file)).toBe(await hashFile(file));
  });

  test('init creates an isolated per-device config', () => {
    const configPath = path.join(tmpDir, '.gstack', 'context-sync', 'config.json');
    const result = initConfig({
      configPath,
      deviceId: 'pc-test',
      driveRoot: path.join(tmpDir, 'drive'),
      homeDir: path.join(tmpDir, 'home'),
      platform: 'win32',
    });

    expect(result.created).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(result.config.deviceId).toBe('pc-test');
    expect(result.config.sources.some(source => source.id === 'codex-sessions')).toBe(true);
  });

  test('dry-run discovers safe files, skips risky stores, and writes no Drive raw files', async () => {
    const sourceRoot = path.join(tmpDir, 'source');
    writeFile('source/chat.jsonl', '{"role":"user","content":"hello sk-abcdefghijklmnopqrstuvwxyz123456"}\n');
    writeFile('source/auth.sqlite', 'opaque');
    writeFile('source/Cache/cache.txt', 'cache');
    const driveRoot = path.join(tmpDir, 'drive');

    const report = await scanConfig(configFor('pc-test', driveRoot, sourceRoot));

    expect(report.dryRun).toBe(true);
    expect(report.plannedCopies.length).toBe(1);
    expect(report.estimatedBytes).toBeGreaterThan(0);
    expect(report.sensitiveFindings[0].patterns).toContain('openai-key');
    expect(report.skippedRisk.some(item => item.reason.includes('opaque app database'))).toBe(true);
    expect(report.skippedRisk.some(item => item.reason.includes('risk path skipped'))).toBe(true);
    expect(fs.existsSync(driveRoot)).toBe(false);
  });

  test('commit writes raw copies, redacted readable files, indexes, control files, and manifests', async () => {
    const sourceRoot = path.join(tmpDir, 'source');
    writeFile('source/chat.jsonl', '{"role":"user","content":"hello sk-abcdefghijklmnopqrstuvwxyz123456"}\n');
    const driveRoot = path.join(tmpDir, 'drive');

    const result = await runCommit(configFor('pc-test', driveRoot, sourceRoot));

    const rawPath = path.join(driveRoot, 'devices', 'pc-test', 'codex-sessions', 'raw', 'chat.jsonl');
    const readablePath = path.join(driveRoot, 'devices', 'pc-test', 'codex-sessions', 'readable', 'chat.jsonl.md');
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(readablePath)).toBe(true);
    expect(fs.readFileSync(readablePath, 'utf-8')).toContain('[REDACTED:openai-key]');
    expect(fs.existsSync(path.join(driveRoot, '_control', 'schema.json'))).toBe(true);
    expect(fs.existsSync(path.join(driveRoot, 'index', 'chats.jsonl'))).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(result.manifest.copiedCount).toBe(1);
  });

  test('rerun dedupes matching hashes instead of creating conflicts', async () => {
    const sourceRoot = path.join(tmpDir, 'source');
    writeFile('source/chat.jsonl', '{"role":"user","content":"same"}\n');
    const driveRoot = path.join(tmpDir, 'drive');
    const config = configFor('pc-test', driveRoot, sourceRoot);

    await runCommit(config);
    const second = await runCommit(config);

    expect(second.manifest.dedupedCount).toBe(1);
    expect(second.manifest.conflictCount).toBe(0);
  });

  test('different device versions with the same logical path are labeled as conflicts', async () => {
    const driveRoot = path.join(tmpDir, 'drive');
    const sourceA = path.join(tmpDir, 'source-a');
    const sourceB = path.join(tmpDir, 'source-b');
    writeFile('source-a/chat.jsonl', '{"role":"user","content":"from pc"}\n');
    writeFile('source-b/chat.jsonl', '{"role":"user","content":"from mac"}\n');

    await runCommit(configFor('pc-test', driveRoot, sourceA));
    const resultB = await runCommit(configFor('mac-test', driveRoot, sourceB));

    expect(resultB.manifest.conflictCount).toBe(1);
    expect(fs.existsSync(path.join(driveRoot, 'conflicts'))).toBe(true);
    const chatRows = fs.readFileSync(path.join(driveRoot, 'index', 'chats.jsonl'), 'utf-8').trim().split('\n');
    expect(chatRows.length).toBe(2);
  });

  test('CLI refuses commit mode unless --commit is explicit', () => {
    const configPath = path.join(tmpDir, '.gstack', 'context-sync', 'config.json');
    const sourceRoot = path.join(tmpDir, 'source');
    writeFile('source/chat.jsonl', '{"role":"user","content":"same"}\n');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(configFor('pc-test', path.join(tmpDir, 'drive'), sourceRoot), null, 2)}\n`);

    const result = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-context-sync'), 'run', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('run requires --commit');
  });

  test('CLI summary mode returns counts without dumping the full planned list', () => {
    const configPath = path.join(tmpDir, '.gstack', 'context-sync', 'config.json');
    const sourceRoot = path.join(tmpDir, 'source');
    writeFile('source/chat.jsonl', '{"role":"user","content":"same"}\n');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(configFor('pc-test', path.join(tmpDir, 'drive'), sourceRoot), null, 2)}\n`);

    const result = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-context-sync'), 'scan', '--dry-run', '--summary', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.plannedCount).toBe(1);
    expect(parsed.report).toBeUndefined();
    expect(parsed.summary.plannedSamples.length).toBe(1);
  });
});

function configFor(deviceId: string, driveRoot: string, sourceRoot: string): ContextSyncConfig {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    deviceId,
    driveRoot,
    sources: [
      {
        id: 'codex-sessions',
        kind: 'chat',
        path: sourceRoot,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function writeFile(relativePath: string, content: string): string {
  const fullPath = path.join(tmpDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}
