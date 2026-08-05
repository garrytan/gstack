/**
 * Tests for bin/gstack-diff-scope — verifies scope signal detection.
 *
 * Creates temp git repos with specific file patterns and verifies
 * the correct SCOPE_* variables are output.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
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
    // dirname(), not lastIndexOf('/'): join() emits BACKSLASHES on Windows, so the
    // hand-rolled scan returned -1, substring(0, -1) gave '', and mkdirSync('') threw
    // ENOENT -- every test in this file failed on Windows, including the no-subdir ones.
    const dirPath = dirname(fullPath);
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

  // Drizzle writes bare .sql files plus a meta/ journal into its `out` dir (default
  // ./drizzle), which matched NO migration pattern -- so a Drizzle PR dropping a column
  // DEFAULT scored SCOPE_MIGRATIONS=false and silently skipped the data-migration
  // reviewer, the one pass most relevant to that diff.
  test('detects migrations via drizzle output dir', () => {
    for (const f of [
      'drizzle/20260805040502_lazy_champions.sql',
      'drizzle/meta/_journal.json',
      'drizzle/meta/0001_snapshot.json',
    ]) {
      const scope = runScope(createRepo([f]));
      expect(scope.SCOPE_MIGRATIONS).toBe('true');
    }
  });

  test('detects migrations via drizzle in a monorepo package', () => {
    const dir = createRepo(['packages/db/drizzle/0001_init.sql']);
    const scope = runScope(dir);
    expect(scope.SCOPE_MIGRATIONS).toBe('true');
  });

  // `*/migrations/*` requires a parent segment, so a ROOT-level migrations/ dir --
  // Knex, Sequelize, golang-migrate, Atlas -- fell through.
  test('detects migrations via root-level migrations/', () => {
    const dir = createRepo(['migrations/001_init.sql']);
    const scope = runScope(dir);
    expect(scope.SCOPE_MIGRATIONS).toBe('true');
  });

  // Flyway and some Ecto/Java layouts use the SINGULAR `migration/`.
  test('detects migrations via singular migration/ (Flyway)', () => {
    for (const f of ['db/migration/V1__init.sql', 'src/main/resources/db/migration/V2__x.sql']) {
      const scope = runScope(createRepo([f]));
      expect(scope.SCOPE_MIGRATIONS).toBe('true');
    }
  });

  // The widened patterns must not fire on ORM CONFIG or on prose that merely contains
  // the word -- only on an actual path segment.
  test('does NOT flag drizzle config or migration prose as a migration', () => {
    for (const f of ['drizzle.config.ts', 'docs/migration-guide.md', 'src/db/schema.ts']) {
      const scope = runScope(createRepo([f]));
      expect(scope.SCOPE_MIGRATIONS).toBe('false');
    }
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
