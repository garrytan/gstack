import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const temporaryRoots: string[] = [];
const originalEnvironment = {
  BROWSE_STATE_FILE: process.env.BROWSE_STATE_FILE,
  GSTACK_HOME: process.env.GSTACK_HOME,
  CHROMIUM_PROFILE: process.env.CHROMIUM_PROFILE,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function unbuiltCliUrl(): string {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cli-unbuilt-'));
  temporaryRoots.push(temporaryRoot);

  const sourceDir = path.join(ROOT, 'browse', 'src');
  const fixtureDir = path.join(temporaryRoot, 'browse', 'src');
  fs.cpSync(sourceDir, fixtureDir, { recursive: true });

  return `${pathToFileURL(path.join(fixtureDir, 'cli.ts')).href}?test=${Date.now()}`;
}

describe('Windows Node server bundle guard', () => {
  test('imports CLI helpers before the generated bundle exists', async () => {
    const cli = await import(unbuiltCliUrl());

    expect(typeof cli.extractGlobalFlags).toBe('function');
  });

  test('keeps the actionable missing-bundle error at Windows launch time', async () => {
    const cli = await import('../src/cli');

    expect(() => cli.requireWindowsNodeServerScript(null, true))
      .toThrow('server-node.mjs not found. Run `bun run build` to generate the Windows server bundle.');
  });

  test('rejects a missing Windows bundle before changing state or Chromium locks', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cli-start-'));
    temporaryRoots.push(temporaryRoot);
    const stateDir = path.join(temporaryRoot, '.gstack');
    const stateFile = path.join(stateDir, 'browse.json');
    const chromiumProfile = path.join(temporaryRoot, 'chromium-profile');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(chromiumProfile);
    fs.writeFileSync(stateFile, 'sentinel state');
    fs.writeFileSync(path.join(chromiumProfile, 'SingletonLock'), 'sentinel lock');
    process.env.BROWSE_STATE_FILE = stateFile;
    process.env.GSTACK_HOME = temporaryRoot;
    process.env.CHROMIUM_PROFILE = chromiumProfile;

    const cli = await import(unbuiltCliUrl());

    await expect(cli.startServer(undefined, { isWindows: true, nodeServerScript: null }))
      .rejects.toThrow('server-node.mjs not found. Run `bun run build` to generate the Windows server bundle.');
    expect(fs.readFileSync(stateFile, 'utf-8')).toBe('sentinel state');
    expect(fs.readFileSync(path.join(chromiumProfile, 'SingletonLock'), 'utf-8')).toBe('sentinel lock');
  });
});
