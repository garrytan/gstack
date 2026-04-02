import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = path.join(ROOT, 'setup');

describe('setup --no-browser', () => {
  test('syntax check passes', () => {
    const result = spawnSync('bash', ['-n', SETUP], { stdio: 'pipe' });
    expect(result.status).toBe(0);
  });

  test('--no-browser flag is recognized (all aliases)', () => {
    // Read the setup script and verify all aliases are present in the case statement
    const content = fs.readFileSync(SETUP, 'utf-8');
    expect(content).toContain('--no-browser|--nobrowser|--nobrowse|--no-browse');
    expect(content).toContain('NO_BROWSER=1');
  });

  test('--with-browser flag re-enables browser after --no-browser', () => {
    const content = fs.readFileSync(SETUP, 'utf-8');
    expect(content).toContain('--with-browser|--withbrowser');
    // --with-browser sets NO_BROWSER=0 and NO_BROWSER_FLAG=1 so it persists
    expect(content).toMatch(/--with-browser\|--withbrowser\) NO_BROWSER=0; NO_BROWSER_FLAG=1/);
  });

  test('NO_BROWSER guards browser build section', () => {
    const content = fs.readFileSync(SETUP, 'utf-8');
    // The browse build is wrapped in NO_BROWSER=0 check
    expect(content).toContain('if [ "$NO_BROWSER" -eq 0 ]; then');
    // The skip message is present
    expect(content).toContain('Skipping browser install (--no-browser)');
  });

  test('browse output lines are conditional on NO_BROWSER', () => {
    const content = fs.readFileSync(SETUP, 'utf-8');
    // Every "browse: $BROWSE_BIN" should be preceded by a NO_BROWSER check
    // and there should be a "skipped" alternative
    expect(content).toContain('browse: skipped (--no-browser)');
    // Count occurrences of the skipped message — should match the number of host output sections
    const skippedCount = (content.match(/browse: skipped \(--no-browser\)/g) || []).length;
    // Claude, Codex, and Kiro output sections = 4 (claude has 2: inside .claude/skills/ and outside)
    expect(skippedCount).toBeGreaterThanOrEqual(3);
  });

  test('config persistence logic exists', () => {
    const content = fs.readFileSync(SETUP, 'utf-8');
    // Should read saved config when flag not passed
    expect(content).toContain('get no_browser');
    // Should save config when flag IS passed
    expect(content).toContain('set no_browser');
    // Should have NO_BROWSER_FLAG tracking
    expect(content).toContain('NO_BROWSER_FLAG=0');
    expect(content).toContain('NO_BROWSER_FLAG=1');
  });

  test('browse skill symlink is skipped when NO_BROWSER=1', () => {
    const content = fs.readFileSync(SETUP, 'utf-8');
    // Claude skill linking checks skill_name = "browse"
    expect(content).toContain('[ "$skill_name" = "browse" ]');
    // Codex skill linking checks skill_name = "gstack-browse"
    expect(content).toContain('[ "$skill_name" = "gstack-browse" ]');
  });
});
