import { describe, test, expect } from 'bun:test';
import { resolveConfig, ensureProjectIgnoreEntry, ensureStateDir, readVersionHash, getGitRoot, getRemoteSlug } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function withTempGitRepo(
  setup: (tmpDir: string) => void,
  run: (tmpDir: string) => void,
): void {
  const prevCwd = process.cwd();
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browse-git-repo-')));

  try {
    const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: tmpDir, stderr: 'pipe' });
    if (init.exitCode !== 0) {
      throw new Error(init.stderr.toString() || 'git init failed');
    }

    setup(tmpDir);
    process.chdir(tmpDir);
    run(tmpDir);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('config', () => {
  describe('getGitRoot', () => {
    test('returns a path when in a git repo', () => {
      withTempGitRepo(
        () => {},
        tmpDir => {
          const root = getGitRoot();
          expect(root).toBe(tmpDir);
          expect(fs.existsSync(path.join(root!, '.git'))).toBe(true);
        },
      );
    });
  });

  describe('resolveConfig', () => {
    test('uses git root by default', () => {
      withTempGitRepo(
        () => {},
        tmpDir => {
          const config = resolveConfig({});
          const gitRoot = getGitRoot();
          expect(gitRoot).toBe(tmpDir);
          expect(config.projectDir).toBe(gitRoot);
          expect(config.stateDir).toBe(path.join(gitRoot!, '.gstack'));
          expect(config.stateFile).toBe(path.join(gitRoot!, '.gstack', 'browse.json'));
        },
      );
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

    test('does not mutate .gitignore as a side effect', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('ensureProjectIgnoreEntry', () => {
    test('adds .gstack/ to .git/info/exclude if not present', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '*.log\n');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      ensureProjectIgnoreEntry(config);
      const content = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
      expect(content).toContain('.gstack/');
      expect(content).toBe('*.log\n.gstack/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('does not duplicate .gstack/ in .git/info/exclude', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '*.log\n.gstack/\n');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      ensureProjectIgnoreEntry(config);
      const content = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
      expect(content).toBe('*.log\n.gstack/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('handles .git/info/exclude without trailing newline', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '*.log');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      ensureProjectIgnoreEntry(config);
      const content = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
      expect(content).toBe('*.log\n.gstack/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('logs warning to browse-server.log on git exclude write error', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '*.log\n');
      fs.chmodSync(path.join(tmpDir, '.git', 'info', 'exclude'), 0o444);
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      ensureProjectIgnoreEntry(config); // should not throw
      const logPath = path.join(config.stateDir, 'browse-server.log');
      expect(fs.existsSync(logPath)).toBe(true);
      const logContent = fs.readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('Warning: could not update git exclude');
      const excludeContent = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
      expect(excludeContent).toBe('*.log\n');
      fs.chmodSync(path.join(tmpDir, '.git', 'info', 'exclude'), 0o644);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('handles worktree-style .git files', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const worktreeGitDir = path.join(tmpDir, '.git-worktree');
      fs.mkdirSync(path.join(worktreeGitDir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: .git-worktree\n');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      ensureProjectIgnoreEntry(config);
      const content = fs.readFileSync(path.join(worktreeGitDir, 'info', 'exclude'), 'utf-8');
      expect(content).toBe('.gstack/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('skips if no git metadata exists', () => {
      const tmpDir = path.join(os.tmpdir(), `browse-gitignore-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpDir, '.gstack', 'browse.json') });
      ensureStateDir(config);
      ensureProjectIgnoreEntry(config);
      expect(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')).toBe('node_modules/\n');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('getRemoteSlug', () => {
    test('returns owner-repo format for current repo', () => {
      withTempGitRepo(
        tmpDir => {
          const remote = Bun.spawnSync(
            ['git', 'remote', 'add', 'origin', 'https://github.com/garrytan/gstack.git'],
            { cwd: tmpDir, stderr: 'pipe' },
          );
          if (remote.exitCode !== 0) {
            throw new Error(remote.stderr.toString() || 'git remote add failed');
          }
        },
        () => {
          const slug = getRemoteSlug();
          expect(slug).toBe('garrytan-gstack');
        },
      );
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
