/**
 * Tests for bin/gstack-diff-scope — verifies scope signal detection.
 *
 * Creates temp git repos with specific file patterns and verifies
 * the correct SCOPE_* variables are output.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const SCRIPT = join(import.meta.dir, '..', 'bin', 'gstack-diff-scope');

const dirs: string[] = [];

function createRepo(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-scope-test-'));
  dirs.push(dir);

  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);

  // Base commit
  writeFileSync(join(dir, 'README.md'), '# test\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial']);

  // Feature branch with specified files
  run('git', ['checkout', '-b', 'feature/test']);
  for (const f of files) {
    const fullPath = join(dir, f);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (dirPath !== dir) mkdirSync(dirPath, { recursive: true });
    writeFileSync(fullPath, '# test content\n');
  }
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'add files']);

  return dir;
}

function runScope(dir: string): Record<string, string> {
  const result = spawnSync('bash', [SCRIPT, 'main'], {
    cwd: dir, stdio: 'pipe', timeout: 5000,
  });
  const output = result.stdout.toString().trim();
  const vars: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const [key, val] = line.split('=');
    if (key && val) vars[key] = val;
  }
  return vars;
}

afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe('gstack-diff-scope', () => {
  // --- Existing scope signals ---

  test('detects frontend files', () => {
    const dir = createRepo(['styles.css', 'component.tsx']);
    const scope = runScope(dir);
    expect(scope.SCOPE_FRONTEND).toBe('true');
  });

  test('detects backend files', () => {
    const dir = createRepo(['app.rb', 'service.py']);
    const scope = runScope(dir);
    expect(scope.SCOPE_BACKEND).toBe('true');
  });

  // #1810: ESM/CJS and explicit-module TS extensions matched no category, so an
  // .mjs/.cjs/.mts/.cts-only PR skipped the backend reviewer entirely.
  test('detects ESM/CJS/explicit-module backend files (#1810)', () => {
    for (const f of ['server.mjs', 'worker.cjs', 'config.mts', 'legacy.cts']) {
      const scope = runScope(createRepo([f]));
      expect(scope.SCOPE_BACKEND).toBe('true');
    }
  });

  test('detects test files', () => {
    const dir = createRepo(['test/app.test.ts']);
    const scope = runScope(dir);
    expect(scope.SCOPE_TESTS).toBe('true');
  });

  // --- New scope signals (Review Army) ---

  test('detects migrations via db/migrate/', () => {
    const dir = createRepo(['db/migrate/20260330_create_users.rb']);
    const scope = runScope(dir);
    expect(scope.SCOPE_MIGRATIONS).toBe('true');
  });

  test('detects migrations via generic migrations/', () => {
    const dir = createRepo(['app/migrations/0001_initial.py']);
    const scope = runScope(dir);
    expect(scope.SCOPE_MIGRATIONS).toBe('true');
  });

  test('detects migrations via prisma', () => {
    const dir = createRepo(['prisma/migrations/20260330/migration.sql']);
    const scope = runScope(dir);
    expect(scope.SCOPE_MIGRATIONS).toBe('true');
  });

  test('detects API via controller files', () => {
    const dir = createRepo(['app/controllers/users_controller.rb']);
    const scope = runScope(dir);
    expect(scope.SCOPE_API).toBe('true');
  });

  test('detects API via route files', () => {
    const dir = createRepo(['src/routes/api.ts']);
    const scope = runScope(dir);
    expect(scope.SCOPE_API).toBe('true');
  });

  test('detects API via GraphQL schemas', () => {
    const dir = createRepo(['schema.graphql']);
    const scope = runScope(dir);
    expect(scope.SCOPE_API).toBe('true');
  });

  test('detects auth files', () => {
    const dir = createRepo(['app/services/auth_service.rb']);
    const scope = runScope(dir);
    expect(scope.SCOPE_AUTH).toBe('true');
  });

  test('detects session files', () => {
    const dir = createRepo(['lib/session_manager.ts']);
    const scope = runScope(dir);
    expect(scope.SCOPE_AUTH).toBe('true');
  });

  test('detects JWT files', () => {
    const dir = createRepo(['utils/jwt_helper.py']);
    const scope = runScope(dir);
    expect(scope.SCOPE_AUTH).toBe('true');
  });

  test('detects config via bun.lock (Bun v1.2+ text lockfile)', () => {
    const dir = createRepo(['bun.lock']);
    const scope = runScope(dir);
    expect(scope.SCOPE_CONFIG).toBe('true');
  });

  test('returns false for all new signals when no matching files', () => {
    const dir = createRepo(['docs/readme.md', 'config.yml']);
    const scope = runScope(dir);
    expect(scope.SCOPE_MIGRATIONS).toBe('false');
    expect(scope.SCOPE_API).toBe('false');
    expect(scope.SCOPE_AUTH).toBe('false');
  });

  test('outputs all 9 scope variables', () => {
    const dir = createRepo(['app.ts']);
    const scope = runScope(dir);
    expect(Object.keys(scope)).toHaveLength(9);
    expect(scope).toHaveProperty('SCOPE_FRONTEND');
    expect(scope).toHaveProperty('SCOPE_BACKEND');
    expect(scope).toHaveProperty('SCOPE_PROMPTS');
    expect(scope).toHaveProperty('SCOPE_TESTS');
    expect(scope).toHaveProperty('SCOPE_DOCS');
    expect(scope).toHaveProperty('SCOPE_CONFIG');
    expect(scope).toHaveProperty('SCOPE_MIGRATIONS');
    expect(scope).toHaveProperty('SCOPE_API');
    expect(scope).toHaveProperty('SCOPE_AUTH');
  });
});

// ---------------------------------------------------------------------------
// #2526 / #2455 / #2299 — glob classes, exit-code contract, dirty-tree union,
// independent categories.
// ---------------------------------------------------------------------------

function runScopeFull(dir: string): { vars: Record<string, string>; status: number; stdout: string } {
  const result = spawnSync('bash', [SCRIPT, 'main'], {
    cwd: dir, stdio: 'pipe', timeout: 5000,
  });
  const stdout = result.stdout.toString();
  const vars: Record<string, string> = {};
  for (const line of stdout.trim().split('\n')) {
    if (line.startsWith('#')) continue;
    const [key, val] = line.split('=');
    if (key && val) vars[key] = val;
  }
  return { vars, status: result.status ?? -1, stdout };
}

describe('glob classes (table-driven, #2526 + #2455)', () => {
  // One row per glob class the case arms cover. `expects` lists every scope
  // that MUST be true; categories are independent (#2299), so extra true
  // flags beyond `expects` are asserted per-row via `alsoFalse`.
  const TABLE: { name: string; file: string; expects: string[]; alsoFalse?: string[] }[] = [
    // API — the #2526 headline: root-level api/ (Vercel/serverless layout).
    { name: 'root-level api/ (#2526)', file: 'api/ipospays/process-payment.ts', expects: ['SCOPE_API', 'SCOPE_BACKEND'] },
    { name: 'nested */api/*', file: 'src/api/foo.ts', expects: ['SCOPE_API', 'SCOPE_BACKEND'] },
    { name: 'controller name', file: 'app/controllers/users_controller.rb', expects: ['SCOPE_API', 'SCOPE_BACKEND'] },
    { name: 'openapi schema', file: 'openapi.yaml', expects: ['SCOPE_API', 'SCOPE_CONFIG'] },
    // Migrations — root-level migrations/ + the data_migrate gem's db/data (#2455).
    { name: 'root-level migrations/ (#2526)', file: 'migrations/0001_initial.sql', expects: ['SCOPE_MIGRATIONS'] },
    { name: 'nested */migrations/*', file: 'app/migrations/0001_initial.py', expects: ['SCOPE_MIGRATIONS', 'SCOPE_BACKEND'] },
    {
      name: 'db/data data migration (#2455) — MIGRATIONS and BACKEND both',
      file: 'db/data/20260804123456_backfill_x.rb',
      expects: ['SCOPE_MIGRATIONS', 'SCOPE_BACKEND'],
    },
    { name: 'data_migrations/ dir', file: 'data_migrations/backfill.rb', expects: ['SCOPE_MIGRATIONS', 'SCOPE_BACKEND'] },
    { name: 'db/migrate schema migration', file: 'db/migrate/20260330_create_users.rb', expects: ['SCOPE_MIGRATIONS', 'SCOPE_BACKEND'] },
    // Independent categories (#2299): test-suffixed frontend files carry BOTH.
    {
      name: 'Button.test.jsx is FRONTEND and TESTS (#2299)',
      file: 'src/Button.test.jsx',
      expects: ['SCOPE_FRONTEND', 'SCOPE_TESTS'],
      alsoFalse: ['SCOPE_BACKEND'], // frontend files never claim backend
    },
    { name: 'util.test.ts is BACKEND and TESTS (#2299)', file: 'src/util.test.ts', expects: ['SCOPE_BACKEND', 'SCOPE_TESTS'] },
    { name: 'auth code carries AUTH and BACKEND', file: 'src/lib/auth.ts', expects: ['SCOPE_AUTH', 'SCOPE_BACKEND'] },
    // Plain classes unchanged.
    { name: 'plain component', file: 'src/A.jsx', expects: ['SCOPE_FRONTEND'], alsoFalse: ['SCOPE_TESTS', 'SCOPE_BACKEND'] },
    { name: 'plain backend', file: 'server.go', expects: ['SCOPE_BACKEND'], alsoFalse: ['SCOPE_FRONTEND'] },
    { name: 'docs', file: 'docs/guide.md', expects: ['SCOPE_DOCS'] },
    { name: 'prompts', file: 'app/services/prompt_builder.rb', expects: ['SCOPE_PROMPTS', 'SCOPE_BACKEND'] },
  ];

  for (const row of TABLE) {
    test(row.name, () => {
      const { vars, status } = runScopeFull(createRepo([row.file]));
      expect(status).toBe(0);
      for (const key of row.expects) {
        expect(`${key}=${vars[key]}`).toBe(`${key}=true`);
      }
      for (const key of row.alsoFalse ?? []) {
        expect(`${key}=${vars[key]}`).toBe(`${key}=false`);
      }
      expect(vars.SCOPE_ERROR).toBeUndefined();
    });
  }
});

describe('exit-code contract (#2526)', () => {
  test('clean tree, no changes → all false, exit 0, no SCOPE_ERROR', () => {
    const dir = createRepo([]);
    const { vars, status } = runScopeFull(dir);
    expect(status).toBe(0);
    expect(vars.SCOPE_ERROR).toBeUndefined();
    expect(Object.values(vars).every((v) => v === 'false')).toBe(true);
  });

  test('changed files but ZERO matches → SCOPE_ERROR=unmatched + exit 2 + paths listed', () => {
    const dir = createRepo(['Makefile.custom', 'weird/layout.xyz']);
    const { vars, status, stdout } = runScopeFull(dir);
    expect(status).toBe(2);
    expect(vars.SCOPE_ERROR).toBe('unmatched');
    expect(stdout).toContain('# unmatched: weird/layout.xyz');
    // Still prints all nine flags so `source <(...)` consumers get vars.
    expect(vars.SCOPE_FRONTEND).toBe('false');
    expect(vars.SCOPE_API).toBe('false');
  });

  test('unresolvable base → SCOPE_ERROR=no_base + exit 2 (a green would mean "could not look")', () => {
    const dir = createRepo(['app.ts']);
    const result = spawnSync('bash', [SCRIPT, 'no-such-branch'], { cwd: dir, stdio: 'pipe', timeout: 5000 });
    expect(result.status).toBe(2);
    const out = result.stdout.toString();
    expect(out).toContain('SCOPE_ERROR=no_base');
    expect(out).toContain('SCOPE_FRONTEND=false');
  });

  test('output stays shell-safe for sourcing consumers in every state', () => {
    // eval'd rather than `source <(...)`: macOS system bash 3.2 sources a
    // process substitution as 0 bytes (st_size-based buffer on a FIFO), which
    // would test the shell, not the script. The property under test is that
    // every output line is a valid assignment or comment.
    const dir = createRepo(['weird/layout.xyz']);
    const result = spawnSync('bash', ['-c', `out="$(bash "${SCRIPT}" main)"; eval "$out"; echo "ERR=$SCOPE_ERROR FRONT=$SCOPE_FRONTEND"`], {
      cwd: dir, stdio: 'pipe', timeout: 5000,
    });
    expect(result.stdout.toString()).toContain('ERR=unmatched FRONT=false');
  });
});

describe('uncommitted work is visible (#2299)', () => {
  test('uncommitted change on a branch with no commits sets the scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-scope-dirty-'));
    dirs.push(dir);
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 't@t.com']);
    run('git', ['config', 'user.name', 'T']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Button.jsx'), '// x\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
    run('git', ['checkout', '-b', 'feat/x']); // no commits on the branch
    writeFileSync(join(dir, 'src', 'Button.jsx'), '// modified, uncommitted\n');
    const { vars, status } = runScopeFull(dir);
    expect(status).toBe(0);
    expect(vars.SCOPE_FRONTEND).toBe('true'); // was false pre-fix (all-false early exit)
  });

  test('an UNTRACKED new migration sets SCOPE_MIGRATIONS (reviewers must see it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-scope-untracked-'));
    dirs.push(dir);
    const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 't@t.com']);
    run('git', ['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'README.md'), '# t\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
    mkdirSync(join(dir, 'db', 'data'), { recursive: true });
    writeFileSync(join(dir, 'db', 'data', '20260816_backfill.rb'), '# data migration\n');
    const { vars, status } = runScopeFull(dir);
    expect(status).toBe(0);
    expect(vars.SCOPE_MIGRATIONS).toBe('true');
    expect(vars.SCOPE_BACKEND).toBe('true');
  });

  test('non-ASCII path still matches extension globs (NUL-safe file listing, #2526)', () => {
    const dir = createRepo(['docs/M2 — Notes.md']);
    const { vars, status } = runScopeFull(dir);
    expect(status).toBe(0);
    expect(vars.SCOPE_DOCS).toBe('true'); // pre-fix: git's octal quoting defeated *.md
  });
});
