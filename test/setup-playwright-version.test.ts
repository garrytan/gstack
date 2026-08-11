import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(import.meta.dir, '..');
const setup = fs.readFileSync(path.join(root, 'setup'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = fs.readFileSync(path.join(root, 'bun.lock'), 'utf8');

describe('Playwright setup version consistency', () => {
  test('package and lock select the same exact release', () => {
    const version = packageJson.dependencies.playwright;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock).toContain(`"playwright": "${version}"`);
    expect(lock).toContain(`"playwright": ["playwright@${version}"`);
    expect(lock).toContain(`"playwright-core": ["playwright-core@${version}"`);
  });

  test('browser download uses the installed package version', () => {
    expect(setup).toContain('require("playwright/package.json").version');
    expect(setup).toContain('bunx "playwright@$pw_version" install chromium');
    expect(setup).not.toMatch(/^\s*bunx playwright install chromium\s*$/m);
  });

  test('verification requires the full executable before launch', () => {
    expect(setup).toContain('fs.existsSync(chromium.executablePath())');
    expect(setup).toContain('existsSync(chromium.executablePath())');
  });
});
