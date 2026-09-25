import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { buildGbrainEnv, execGbrainText, spawnGbrain, spawnGbrainAsync } from '../lib/gbrain-exec';

let fixture: string;
let home: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
let configPath: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'gbrain-child-env-'));
  home = join(fixture, 'brain home');
  cwd = join(fixture, 'caller');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(cwd);
  configPath = join(home, '.gbrain/config.json');
  const bin = join(fixture, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gbrain'), `#!/usr/bin/env bun
console.log(JSON.stringify({ url: process.env.DATABASE_URL, brainUrl: process.env.GBRAIN_DATABASE_URL, keep: process.env.KEEP, home: process.env.GBRAIN_HOME }));
`, { mode: 0o755 });
  env = { PATH: `${bin}:${process.env.PATH}`, HOME: fixture, GBRAIN_HOME: home, KEEP: 'unchanged' };
  writeFileSync(join(cwd, '.env.local'), 'DATABASE_URL=postgresql://dotenv.invalid/app\nGBRAIN_DATABASE_URL=postgresql://dotenv.invalid/brain\n');
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

async function capture(mode: string) {
  if (mode === 'exec') return JSON.parse(execGbrainText([], { baseEnv: env, cwd, timeout: 10_000 }));
  if (mode === 'sync') {
    const result = spawnGbrain([], { baseEnv: env, cwd, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }
  return await new Promise<any>((resolve, reject) => {
    const child = spawnGbrainAsync([], { baseEnv: env, cwd });
    let text = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out')); }, 10_000);
    child.stdout!.on('data', chunk => { text += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        expect(code).toBe(0);
        resolve(JSON.parse(text));
      } catch (error) { reject(error); }
    });
  });
}

describe('explicit PGLite child environment', () => {
  test('real Bun launcher control autoloads cwd dotenv when keys are absent', () => {
    const result = spawnSync('gbrain', [], { cwd, env, encoding: 'utf-8', timeout: 10_000 });
    expect(result.status).toBe(0);
    const actual = JSON.parse(result.stdout);
    expect(actual.url).toBe('postgresql://dotenv.invalid/app');
    expect(actual.brainUrl).toBe('postgresql://dotenv.invalid/brain');
  });

  for (const mode of ['sync', 'async', 'exec']) {
    for (const inherited of [false, true]) {
      test(`${mode} clears remote values and blocks dotenv refill (inherited=${inherited})`, async () => {
        writeFileSync(configPath, '{"engine":"pglite","database_path":"local-only"}');
        if (inherited) Object.assign(env, { DATABASE_URL: 'postgresql://caller.invalid/app', GBRAIN_DATABASE_URL: 'postgresql://caller.invalid/brain' });
        const before = { ...env };
        const actual = await capture(mode);
        expect(actual.url).toBe('');
        expect(actual.brainUrl).toBe('');
        expect(actual.keep).toBe('unchanged');
        expect(actual.home).toBe(home);
        expect(env).toEqual(before);
      });
    }
  }

  test('explicit compatibility override preserves the actual child environment', async () => {
    writeFileSync(configPath, '{"engine":"pglite"}');
    Object.assign(env, { GSTACK_RESPECT_ENV_DATABASE_URL: '1', DATABASE_URL: 'postgresql://intentional.invalid/app', GBRAIN_DATABASE_URL: 'postgresql://intentional.invalid/brain' });
    const actual = await capture('sync');
    expect(actual.url).toBe(env.DATABASE_URL);
    expect(actual.brainUrl).toBe(env.GBRAIN_DATABASE_URL);
  });

  for (const raw of [undefined, '{broken', 'null', '[]', '{"engine":"future"}', '{"engine":"future","database_url":"postgresql://ignored.invalid/brain"}', '{"engine":"postgres"}']) {
    test(`missing, corrupt or nonlocal config keeps env-only behavior: ${raw}`, async () => {
      if (raw !== undefined) writeFileSync(configPath, raw);
      Object.assign(env, { DATABASE_URL: 'postgresql://intentional.invalid/app', GBRAIN_DATABASE_URL: 'postgresql://intentional.invalid/brain' });
      const actual = await capture('sync');
      expect(actual.url).toBe(env.DATABASE_URL);
      expect(actual.brainUrl).toBe(env.GBRAIN_DATABASE_URL);
    });
  }

  test('remote config still seeds DATABASE_URL without changing intentional gbrain override', async () => {
    writeFileSync(configPath, '{"engine":"postgres","database_url":"postgresql://configured.invalid/brain"}');
    env.GBRAIN_DATABASE_URL = 'postgresql://intentional.invalid/brain';
    const actual = await capture('sync');
    expect(actual.url).toBe('postgresql://configured.invalid/brain');
    expect(actual.brainUrl).toBe(env.GBRAIN_DATABASE_URL);
  });

  test('a malformed database URL never becomes a child environment value', () => {
    writeFileSync(configPath, '{"database_url":{"unexpected":"shape"}}');
    env.DATABASE_URL = 'postgresql://intentional.invalid/app';
    expect(buildGbrainEnv({ baseEnv: env }).DATABASE_URL).toBe(env.DATABASE_URL);
  });
});
