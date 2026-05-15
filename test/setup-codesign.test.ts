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
    // All compiled binaries from `bun run build` must be covered
    expect(binaries).toContain('browse/dist/browse');
    expect(binaries).toContain('browse/dist/find-browse');
    expect(binaries).toContain('design/dist/design');
    expect(binaries).toContain('make-pdf/dist/pdf');
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

  test('codesign failures surface stderr, verify signatures, and fail setup', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    expect(content).toContain('_codesign_err="$(mktemp)"');
    expect(content).toContain('codesign --remove-signature "$_bin_path" 2>"$_codesign_err"');
    expect(content).toContain('codesign -s - -f "$_bin_path" 2>"$_codesign_err"');
    expect(content).toContain('codesign --verify --strict "$_bin_path" 2>"$_codesign_err"');
    expect(content).toContain('_print_codesign_err');
    expect(content).toContain('_codesign_failures=$((_codesign_failures + 1))');
    expect(content).toContain('gstack setup failed: $_codesign_failures binaries did not codesign');
    expect(content).toContain('exit 1');
    expect(content).not.toContain('codesign --remove-signature "$_bin_path" 2>/dev/null || true');
  });

  test('codesign shell snippet is syntactically valid', () => {
    // Extract the codesign block and validate it parses as bash
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    const start = content.indexOf('# macOS Apple Silicon: ad-hoc codesign');
    const end = content.indexOf('# macOS: install coreutils', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const snippet = content.slice(start, end);
    // Wrap in a function to make it a complete script, then syntax-check
    const testScript = `#!/usr/bin/env bash\nset -e\n_test_fn() {\n${snippet}\n}\n`;
    const result = spawnSync('bash', ['-n', '-c', testScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });
});
