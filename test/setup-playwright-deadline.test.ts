import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SETUP = readFileSync(join(import.meta.dir, '..', 'setup'), 'utf8');

describe('setup Playwright failure containment', () => {
  test('serializes setup with a portable stale-pid lock', () => {
    expect(SETUP).toContain('SETUP_LOCK_DIR="${GSTACK_HOME:-$HOME/.gstack}/.setup.lock.d"');
    expect(SETUP).toContain('if mkdir "$SETUP_LOCK_DIR" 2>/dev/null; then');
    expect(SETUP).toContain('kill -0 "$_setup_lock_pid"');
    expect(SETUP).toContain('gstack setup is already running for this install');
    expect(SETUP).toContain('trap cleanup_setup EXIT');
  });

  test('bounds browser launch and install and kills descendants', () => {
    expect(SETUP).toContain('run_with_deadline "$probe_timeout" node -e');
    expect(SETUP).toContain('run_with_deadline "$probe_timeout" bun --eval');
    expect(SETUP).toContain('run_with_deadline "$_playwright_install_timeout" bunx playwright install chromium');
    expect(SETUP).toContain('terminate_process_tree "$child"');
    expect(SETUP).toContain('GSTACK_PLAYWRIGHT_PROBE_TIMEOUT_SECONDS');
    expect(SETUP).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS');
  });

  test('uses Node for the macOS launch probe', () => {
    expect(SETUP).toContain('[ "$IS_WINDOWS" -eq 1 ] || [ "$(uname -s)" = "Darwin" ]');
  });

  test('continues to skill registration after Chromium failure', () => {
    const failure = SETUP.indexOf('Browser-backed skills will be unavailable until Chromium setup succeeds.');
    const registration = SETUP.indexOf('link_claude_skill_dirs "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"');
    expect(failure).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(failure);
    expect(SETUP.slice(failure, registration)).not.toMatch(/^\s*exit 1\s*$/m);
  });
});
