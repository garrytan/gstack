import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');

describe('setup: Apple Silicon codesign', () => {
  test('setup script contains codesign block for Darwin arm64', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    // Verify the codesign guard checks both Darwin and arm64
    expect(content).toContain('$(uname -s)" = "Darwin"');
    expect(content).toContain('$(uname -m)" = "arm64"');
    // Verify remove-then-resign two-step pattern
    expect(content).toContain('codesign --remove-signature');
    expect(content).toContain('codesign -s - -f');
  });

  test('codesign block covers all compiled binaries', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    // Extract the binaries from the codesign for-loop
    const forMatch = content.match(/for _bin in ([^;]+);/);
    expect(forMatch).toBeTruthy();
    const binaries = forMatch![1].trim().split(/\s+/);
    // All four compiled binaries from `bun run build` must be covered
    expect(binaries).toContain('browse/dist/browse');
    expect(binaries).toContain('browse/dist/find-browse');
    expect(binaries).toContain('design/dist/design');
    expect(binaries).toContain('bin/gstack-global-discover');
  });

  test('codesign block is inside the NEEDS_BUILD=1 branch', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    // The codesign block should appear after `bun run build` and before the
    // `if [ ! -x "$BROWSE_BIN" ]` guard that checks the build succeeded.
    const buildIdx = content.indexOf('bun run build');
    const codesignIdx = content.indexOf('codesign --remove-signature');
    const browseCheckIdx = content.indexOf('gstack setup failed: browse binary missing');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(codesignIdx).toBeGreaterThan(buildIdx);
    expect(browseCheckIdx).toBeGreaterThan(codesignIdx);
  });

  test('codesign block is idempotent (skips missing binaries)', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    // The loop must guard with a file-existence + executable check before codesigning
    expect(content).toContain('[ -f "$_bin_path" ] && [ -x "$_bin_path" ] || continue');
  });

  test('codesign failure is a warning, not a fatal error', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    // On codesign failure, log a warning but don't exit
    expect(content).toContain('warning: codesign failed for');
    // Should NOT have `set -e` causing exit on codesign failure
    // (the `|| true` after --remove-signature and the if-guard around -s - -f handle this)
    expect(content).toContain('codesign --remove-signature "$_bin_path" 2>/dev/null || true');
  });

  test('codesign shell snippet is syntactically valid', () => {
    // Extract the codesign block and validate it parses as bash
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    const match = content.match(
      /# macOS Apple Silicon: ad-hoc codesign[\s\S]*?done\n\s*fi/
    );
    expect(match).toBeTruthy();
    const snippet = match![0];
    // Wrap in a function to make it a complete script, then syntax-check
    const testScript = `#!/usr/bin/env bash\nset -e\n_test_fn() {\n${snippet}\n}\n`;
    const result = spawnSync('bash', ['-n', '-c', testScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });
});
