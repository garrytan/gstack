/**
 * Windows Setup E2E workflow regression guard for #1530.
 *
 * The unit shell-compat test proves package.json no longer contains Bun-hostile
 * subshell redirections. This workflow-level guard makes sure the Windows E2E
 * job keeps exercising the actual install/build path that caught the original
 * Windows Bun crash.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW = path.resolve(import.meta.dir, '..', '.github', 'workflows', 'windows-setup-e2e.yml');
const content = fs.readFileSync(WORKFLOW, 'utf-8');

describe('windows-setup-e2e.yml #1530 regression coverage', () => {
  test('runs the real Windows build path that used to crash Bun', () => {
    expect(content).toMatch(/runs-on:\s*windows-latest/);
    expect(content).toContain('run: bun run build');
    expect(content).toContain('shell: bash');
    expect(content).toContain("GSTACK_SKIP_PLAYWRIGHT: '1'");
  });

  test('is triggered by the files that can regress the Windows build chain', () => {
    for (const triggerPath of [
      'package.json',
      'scripts/build.sh',
      'scripts/write-version-files.sh',
      'setup',
      '.github/workflows/windows-setup-e2e.yml',
    ]) {
      expect(content).toContain(`- '${triggerPath}'`);
    }
  });

  test('verifies the build outputs that prove bun run build completed', () => {
    expect(content).toContain('Verify binaries exist');
    for (const binary of [
      'browse/dist/browse',
      'browse/dist/find-browse',
      'design/dist/design',
      'bin/gstack-global-discover',
    ]) {
      expect(content).toContain(binary);
    }
  });
});
