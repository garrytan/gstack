import { describe, test, expect } from 'bun:test';
import { resolveConfig, ensureStateDir, readVersionHash, getGitRoot, getRemoteSlug, resolveGstackHome, resolveChromiumProfile, cleanSingletonLocks } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('config', () => {
  describe('getGitRoot', () => {
    test('returns a path when in a git repo', () => {
      const root = getGitRoot();
      expect(root).not.toBeNull();
      expect(fs.existsSync(path.join(root!, '.git'))).toBe(true);
    });
  });

  describe('resolveConfig', () => {
    test('uses git root by default', () => {
      const config = resolveConfig({});
      const gitRoot = getGitRoot();
      expect(gitRoot).not.toBeNull();
      expect(config.projectDir).toBe(gitRoot);
      expect(config.stateDir).toBe(path.join(gitRoot!, '.gstack'));
      expect(config.stateFile).toBe(path.join(gitRoot!, '.gstack', 'browse.json'));
    });

    test('derives paths from BROWSE_STATE_FILE when set', () => {
      const stateFile = '/tmp/test-config/.gstack/browse.json';
      const config = resolveConfig({ BROWSE_STATE_FILE: stateFile });
      expect(config.stateFile).toBe(stateFile);
      expect(config.stateDir).toBe('/tmp/test-config/.gstack');
      expect(config.projectDir).toBe('/tmp/test-config');
    });

    test('log paths are in stateDir', () => {
      const config = resolveConfig({});
      expect(config.consoleLog).toBe(path.join(config.stateDir, 'browse-console.log'));
      expect(config.networkLog).toBe(path.join(config.stateDir, 'browse-network.log'));
      expect(config.dialogLog).toBe(path.join(config.stateDir, 'browse-dialog.log'));
    });
  });

  describe('ensureStateDir', () => {
    test('creates directory if it does not exist', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-config-test-${Date.now()}`);
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      expect(fs.existsSync(config.stateDir)).toBe(false);
      ensureStateDir(config);
      expect(fs.existsSync(config.stateDir)).toBe(true);
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('is a no-op if directory already exists', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-config-test-${Date.now()}`);
      const stateDir = path.join(tmpDir, '.gstack');
      fs.mkdirSync(stateDir, { recursive: true });
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(stateDir, 'browse.json') });
      ensureStateDir(config); // should not throw
      expect(fs.existsSync(config.stateDir)).toBe(true);
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('adds .gstack/ to .gitignore if not present', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.gstack/');
      expect(content).toBe('node_modules/\n.gstack/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('does not duplicate .gstack/ in .gitignore', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.gstack/\n');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\n.gstack/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('handles .gitignore without trailing newline', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules\n.gstack/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('logs warning to browse-server.log on non-ENOENT gitignore error', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      // Create a read-only .gitignore (no .gstack/ entry → would try to append)
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
      fs.chmodSync(path.join(tmpDir, '.gitignore'), 0o444);
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config); // should not throw
      // Verify warning was written to server log
      const logPath = path.join(config.stateDir, 'browse-server.log');
      expect(fs.existsSync(logPath)).toBe(true);
      const logContent = fs.readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('Warning: could not update .gitignore');
      // .gitignore should remain unchanged
      const gitignoreContent = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignoreContent).toBe('node_modules/\n');
      // Cleanup
      fs.chmodSync(path.join(tmpDir, '.gitignore'), 0o644);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('skips if no .gitignore exists', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('getRemoteSlug', () => {
    test('returns owner-repo format for current repo', () => {
      const slug = getRemoteSlug();
      // This repo has an origin remote — should return a slug
      expect(slug).toBeTruthy();
      expect(slug).toMatch(/^[a-zA-Z0-9._-]+-[a-zA-Z0-9._-]+$/);
    });

    test('parses SSH remote URLs', () => {
      // Test the regex directly since we can't mock Bun.spawnSync easily
      const url = 'git@github.com:garrytan/gstack.git';
      const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      expect(match).not.toBeNull();
      expect(`${match![1]}-${match![2]}`).toBe('garrytan-gstack');
    });

    test('parses HTTPS remote URLs', () => {
      const url = 'https://github.com/garrytan/gstack.git';
      const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      expect(match).not.toBeNull();
      expect(`${match![1]}-${match![2]}`).toBe('garrytan-gstack');
    });

    test('parses HTTPS remote URLs without .git suffix', () => {
      const url = 'https://github.com/garrytan/gstack';
      const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      expect(match).not.toBeNull();
      expect(`${match![1]}-${match![2]}`).toBe('garrytan-gstack');
    });
  });

  describe('readVersionHash', () => {
    test('returns null when .version file does not exist', () => {
      const result = readVersionHash('/nonexistent/path/browse');
      expect(result).toBeNull();
    });

    test('reads version from .version file adjacent to execPath', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-version-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const versionFile = path.join(tmpDir, '.version');
      fs.writeFileSync(versionFile, 'abc123def\n');
      const result = readVersionHash(path.join(tmpDir, 'browse'));
      expect(result).toBe('abc123def');
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});

describe('resolveServerScript', () => {
  // Import the function from cli.ts
  const { resolveServerScript } = require('../src/cli');

  test('uses BROWSE_SERVER_SCRIPT env when set', () => {
    const result = resolveServerScript({ BROWSE_SERVER_SCRIPT: '/custom/server.ts' }, '', '');
    expect(result).toBe('/custom/server.ts');
  });

  test('finds server.ts adjacent to cli.ts in dev mode', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const result = resolveServerScript({}, srcDir, '');
    expect(result).toBe(path.join(srcDir, 'server.ts'));
  });

  test('throws when server.ts cannot be found', () => {
    expect(() => resolveServerScript({}, '/nonexistent/$bunfs', '/nonexistent/browse'))
      .toThrow('Cannot find server.ts');
  });
});

describe('resolveNodeServerScript', () => {
  const { resolveNodeServerScript } = require('../src/cli');

  test('finds server-node.mjs in dist from dev mode', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const distFile = path.resolve(srcDir, '..', 'dist', 'server-node.mjs');
    const fs = require('fs');
    // Only test if the file exists (it may not be built yet)
    if (fs.existsSync(distFile)) {
      const result = resolveNodeServerScript(srcDir, '');
      expect(result).toBe(distFile);
    }
  });

  test('returns null when server-node.mjs does not exist', () => {
    const result = resolveNodeServerScript('/nonexistent/$bunfs', '/nonexistent/browse');
    expect(result).toBeNull();
  });

  test('finds server-node.mjs adjacent to compiled binary', () => {
    const distDir = path.resolve(__dirname, '../dist');
    const distFile = path.join(distDir, 'server-node.mjs');
    const fs = require('fs');
    if (fs.existsSync(distFile)) {
      const result = resolveNodeServerScript('/$bunfs/something', path.join(distDir, 'browse'));
      expect(result).toBe(distFile);
    }
  });
});

describe('version mismatch detection', () => {
  test('detects when versions differ', () => {
    const stateVersion = 'abc123';
    const currentVersion = 'def456';
    expect(stateVersion !== currentVersion).toBe(true);
  });

  test('no mismatch when versions match', () => {
    const stateVersion = 'abc123';
    const currentVersion = 'abc123';
    expect(stateVersion !== currentVersion).toBe(false);
  });

  test('no mismatch when either version is null', () => {
    const currentVersion: string | null = null;
    const stateVersion: string | undefined = 'abc123';
    // Version mismatch only triggers when both are present
    const shouldRestart = currentVersion !== null && stateVersion !== undefined && currentVersion !== stateVersion;
    expect(shouldRestart).toBe(false);
  });
});

describe('isServerHealthy', () => {
  const { isServerHealthy } = require('../src/cli');
  const http = require('http');

  test('returns true for a healthy server', async () => {
    const server = http.createServer((_req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;
    try {
      expect(await isServerHealthy(port)).toBe(true);
    } finally {
      server.close();
    }
  });

  test('returns false for an unhealthy server', async () => {
    const server = http.createServer((_req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unhealthy' }));
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;
    try {
      expect(await isServerHealthy(port)).toBe(false);
    } finally {
      server.close();
    }
  });

  test('returns false when server is not running', async () => {
    // Use a port that's almost certainly not in use
    expect(await isServerHealthy(59999)).toBe(false);
  });

  test('returns false on non-200 response', async () => {
    const server = http.createServer((_req: any, res: any) => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;
    try {
      expect(await isServerHealthy(port)).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('startup error log', () => {
  test('write and read error log', () => {
    const tmpDir = path.join(os.tmpdir(), `browse-error-log-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const errorLogPath = path.join(tmpDir, 'browse-startup-error.log');
    const errorMsg = 'Cannot find module playwright';
    fs.writeFileSync(errorLogPath, `2026-03-23T00:00:00.000Z ${errorMsg}\n`);
    const content = fs.readFileSync(errorLogPath, 'utf-8').trim();
    expect(content).toContain(errorMsg);
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp prefix
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('resolveGstackHome', () => {
  test('honors GSTACK_HOME env var when set', () => {
    const orig = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = '/tmp/custom-gstack-home';
    try {
      expect(resolveGstackHome()).toBe('/tmp/custom-gstack-home');
    } finally {
      if (orig === undefined) delete process.env.GSTACK_HOME;
      else process.env.GSTACK_HOME = orig;
    }
  });

  test('falls back to os.homedir() + /.gstack when env unset', () => {
    const orig = process.env.GSTACK_HOME;
    delete process.env.GSTACK_HOME;
    try {
      expect(resolveGstackHome()).toBe(path.join(os.homedir(), '.gstack'));
    } finally {
      if (orig !== undefined) process.env.GSTACK_HOME = orig;
    }
  });
});

describe('resolveChromiumProfile', () => {
  test('explicit arg wins over env and default', () => {
    const orig = process.env.CHROMIUM_PROFILE;
    process.env.CHROMIUM_PROFILE = '/tmp/env-profile';
    try {
      expect(resolveChromiumProfile('/tmp/explicit-profile')).toBe('/tmp/explicit-profile');
    } finally {
      if (orig === undefined) delete process.env.CHROMIUM_PROFILE;
      else process.env.CHROMIUM_PROFILE = orig;
    }
  });

  test('CHROMIUM_PROFILE env honored when no explicit arg', () => {
    const orig = process.env.CHROMIUM_PROFILE;
    process.env.CHROMIUM_PROFILE = '/tmp/env-profile';
    try {
      expect(resolveChromiumProfile()).toBe('/tmp/env-profile');
    } finally {
      if (orig === undefined) delete process.env.CHROMIUM_PROFILE;
      else process.env.CHROMIUM_PROFILE = orig;
    }
  });

  test('falls back to resolveGstackHome()/chromium-profile when nothing set', () => {
    const origEnv = process.env.CHROMIUM_PROFILE;
    const origHome = process.env.GSTACK_HOME;
    delete process.env.CHROMIUM_PROFILE;
    process.env.GSTACK_HOME = '/tmp/fallback-gstack';
    try {
      expect(resolveChromiumProfile()).toBe('/tmp/fallback-gstack/chromium-profile');
    } finally {
      if (origEnv !== undefined) process.env.CHROMIUM_PROFILE = origEnv;
      if (origHome === undefined) delete process.env.GSTACK_HOME;
      else process.env.GSTACK_HOME = origHome;
    }
  });

  test('ignores empty-string explicit arg, falls through to env/default', () => {
    const orig = process.env.CHROMIUM_PROFILE;
    process.env.CHROMIUM_PROFILE = '/tmp/env-profile';
    try {
      expect(resolveChromiumProfile('')).toBe('/tmp/env-profile');
    } finally {
      if (orig === undefined) delete process.env.CHROMIUM_PROFILE;
      else process.env.CHROMIUM_PROFILE = orig;
    }
  });
});

describe('cleanSingletonLocks', () => {
  test('removes SingletonLock/Socket/Cookie when basename is chromium-profile', () => {
    const tmpDir = path.join(os.tmpdir(), `clean-locks-${Date.now()}`, 'chromium-profile');
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      fs.writeFileSync(path.join(tmpDir, f), 'stale');
    }
    cleanSingletonLocks(tmpDir);
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      expect(fs.existsSync(path.join(tmpDir, f))).toBe(false);
    }
    fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true });
  });

  test('refuses to clean unrecognized profile dir basename', () => {
    const tmpDir = path.join(os.tmpdir(), `unrelated-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const lockFile = path.join(tmpDir, 'SingletonLock');
    fs.writeFileSync(lockFile, 'should-survive');
    const origWarn = console.warn;
    let warned = '';
    console.warn = (msg: string) => { warned = msg; };
    try {
      cleanSingletonLocks(tmpDir);
      expect(warned).toContain('refusing to clean unrecognized profile dir');
      expect(fs.existsSync(lockFile)).toBe(true); // not deleted
    } finally {
      console.warn = origWarn;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('respects explicit CHROMIUM_PROFILE env even with non-standard basename', () => {
    const tmpDir = path.join(os.tmpdir(), `custom-name-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'SingletonLock'), 'stale');
    const orig = process.env.CHROMIUM_PROFILE;
    process.env.CHROMIUM_PROFILE = tmpDir;
    try {
      cleanSingletonLocks(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, 'SingletonLock'))).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.CHROMIUM_PROFILE;
      else process.env.CHROMIUM_PROFILE = orig;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('second call on empty dir does not throw (ENOENT swallowed)', () => {
    const tmpDir = path.join(os.tmpdir(), `empty-locks-${Date.now()}`, 'chromium-profile');
    fs.mkdirSync(tmpDir, { recursive: true });
    expect(() => cleanSingletonLocks(tmpDir)).not.toThrow();
    expect(() => cleanSingletonLocks(tmpDir)).not.toThrow();
    fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true });
  });
});
