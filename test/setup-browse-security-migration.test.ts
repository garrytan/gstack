import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const REPAIR = fs.readFileSync(path.join(ROOT, 'bin/gstack-browse-repair.ts'), 'utf8');

describe('setup Browse security recovery', () => {
  test('runs the legacy extension migration on every setup, not only version changes', () => {
    const beforeVersionMigrations = SETUP.slice(0, SETUP.indexOf('# 8. Run pending version migrations'));
    expect(beforeVersionMigrations).toContain('gstack-browse-migrate.ts');
    expect(beforeVersionMigrations).toContain('--legacy-extension-path "$SOURCE_GSTACK_DIR/extension"');
    expect(beforeVersionMigrations).toContain('close GStack Browser and rerun ./setup');
  });

  test('repairs a broken browser cache with a bounded health-checked path', () => {
    expect(REPAIR).toContain('const MAX_INSTALL_MS = 300_000');
    expect(REPAIR).toContain("'chrome-mac-arm64.zip'");
    expect(REPAIR).toContain("'chrome-headless-shell-mac-arm64.zip'");
    expect(REPAIR).toContain("[executable, '--version']");
    expect(REPAIR).toContain("'INSTALLATION_COMPLETE'");
  });
});
