import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('CI eval workflows run natively without Docker', () => {
  for (const workflow of ['.github/workflows/evals.yml', '.github/workflows/evals-periodic.yml']) {
    test(`${workflow} has no Docker image build or job container`, () => {
      const content = read(workflow);
      expect(content).not.toContain('docker/');
      expect(content).not.toContain('docker/build-push-action');
      expect(content).not.toContain('docker/login-action');
      expect(content).not.toContain('container:');
      expect(content).not.toContain('IMAGE: ghcr.io');
      expect(content).not.toMatch(/\bDocker\b/i);
      expect(content).not.toContain('PLAYWRIGHT_BROWSERS_PATH: /opt/playwright-browsers');
    });

    test(`${workflow} installs Playwright natively with the Ubuntu 26.04 override`, () => {
      const content = read(workflow);
      expect(content).toContain('PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: ubuntu24.04-x64');
      expect(content).toContain('bunx playwright install --with-deps chromium');
    });
  }

  test('legacy Docker CI image files are removed', () => {
    expect(fs.existsSync(path.join(ROOT, '.github/workflows/ci-image.yml'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, '.github/docker/Dockerfile.ci'))).toBe(false);
  });

  test('make-pdf Playwright gate uses the Ubuntu 26.04 override on Linux', () => {
    const content = read('.github/workflows/make-pdf-gate.yml');
    expect(content).toContain('PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: ubuntu24.04-x64');
    expect(content).toContain('bunx playwright install chromium');
  });
});
