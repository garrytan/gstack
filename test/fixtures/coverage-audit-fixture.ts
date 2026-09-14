/**
 * Shared fixture for test coverage audit E2E tests.
 *
 * Creates a Node.js project with billing source code that has intentional
 * test coverage gaps: processPayment has happy-path-only tests,
 * refundPayment has no tests at all.
 *
 * Used by: ship-coverage-audit E2E, review-coverage-audit E2E
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export function createCoverageAuditFixture(dir: string): void {
  // Create a Node.js project WITH test framework but coverage gaps
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'test-coverage-app',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'echo "no tests yet"' },
    devDependencies: { vitest: '^1.0.0' },
  }, null, 2));

  // Create vitest config
  fs.writeFileSync(path.join(dir, 'vitest.config.ts'),
    `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n`);

  fs.writeFileSync(path.join(dir, 'VERSION'), '0.1.0.0\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');

  // Create source file with multiple code paths
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'billing.ts'), `
export function processPayment(amount: number, currency: string) {
  if (amount <= 0) throw new Error('Invalid amount');
  if (currency !== 'USD' && currency !== 'EUR') throw new Error('Unsupported currency');
  return { status: 'success', amount, currency };
}

export function refundPayment(paymentId: string, reason: string) {
  if (!paymentId) throw new Error('Payment ID required');
  if (!reason) throw new Error('Reason required');
  return { status: 'refunded', paymentId, reason };
}
`);

  // Create a test directory with ONE test (partial coverage)
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'billing.test.ts'), `
import { describe, test, expect } from 'vitest';
import { processPayment } from '../src/billing';

describe('processPayment', () => {
  test('processes valid payment', () => {
    const result = processPayment(100, 'USD');
    expect(result.status).toBe('success');
  });
  // GAP: no test for invalid amount
  // GAP: no test for unsupported currency
  // GAP: refundPayment not tested at all
});
`);

  // Init git repo with main branch
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial commit']);

  // Create feature branch
  run('git', ['checkout', '-b', 'feature/billing']);
}
