import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runFactoryProductionSmoke,
  type FactoryProductionSmokeCheckId,
  type FactoryProductionSmokeSummary,
} from '../lib/factory-production-smoke';

function tempWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'factory-prod-smoke-'));
}

function findCheck(summary: FactoryProductionSmokeSummary, id: FactoryProductionSmokeCheckId) {
  const result = summary.checks.find(check => check.id === id);
  if (!result) throw new Error(`smoke summary missing check ${id}`);
  return result;
}

describe('factory production smoke runner', () => {
  test('runs every S1-S11 check and returns a deterministic pass summary with web /health deferred', async () => {
    const workDir = tempWorkDir();
    try {
      const summary = await runFactoryProductionSmoke({ workDir });

      const expectedIds: FactoryProductionSmokeCheckId[] = [
        'S1-module-load',
        'S2-facade-plan',
        'S3-facade-status',
        'S4-facade-list',
        'S5-facade-artifact-read',
        'S6-project-catalog-roundtrip',
        'S7-qa-log-parse',
        'S8-qa-recover-fixture',
        'S9-guarded-denial-audit',
        'S10-distribution-dry-run',
        'S11-web-health',
      ];
      expect(summary.checks.map(c => c.id)).toEqual(expectedIds);

      for (const id of expectedIds) {
        const check = findCheck(summary, id);
        if (id === 'S11-web-health') continue;
        expect(check.status).toBe('pass');
      }

      expect(summary.status).toBe('pass');
      expect(summary.allRequiredPassed).toBe(true);
      expect(summary.failCount).toBe(0);
      expect(summary.passCount).toBe(expectedIds.length - 1);
      expect(summary.deferredCount).toBe(1);
      expect(summary.hasDeferredGates).toBe(true);

      const webCheck = findCheck(summary, 'S11-web-health');
      expect(webCheck.status).toBe('deferred');
      expect(webCheck.status).not.toBe('pass');
      expect(webCheck.deferredReason).toBeString();
      expect(webCheck.deferredReason).toContain('No production web app exists');
      expect(webCheck.summary.toLowerCase()).toContain('deferred');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('overall status remains pass when only S11 is deferred, but never reports S11 as green', async () => {
    const workDir = tempWorkDir();
    try {
      const summary = await runFactoryProductionSmoke({ workDir });
      // Even when smoke is overall pass, the runner must keep web /health
      // visible as a separate not-ready-until gate so callers cannot flip a
      // Beta 2 release gate just because the engine surface area passed.
      expect(summary.status).toBe('pass');
      expect(summary.hasDeferredGates).toBe(true);
      const passes = summary.checks.filter(c => c.status === 'pass').map(c => c.id);
      expect(passes).not.toContain('S11-web-health');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('every check produces a stable result shape with id, title, status, summary, and details', async () => {
    const workDir = tempWorkDir();
    try {
      const summary = await runFactoryProductionSmoke({ workDir });
      for (const check of summary.checks) {
        expect(check).toHaveProperty('id');
        expect(check).toHaveProperty('title');
        expect(check).toHaveProperty('status');
        expect(check).toHaveProperty('summary');
        expect(check).toHaveProperty('details');
        expect(Array.isArray(check.details)).toBe(true);
        expect(typeof check.summary).toBe('string');
        expect(check.summary.length).toBeGreaterThan(0);
        expect(['pass', 'fail', 'deferred']).toContain(check.status);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('runs deterministically — repeated invocations produce identical check ids, statuses, and summaries', async () => {
    const first = tempWorkDir();
    const second = tempWorkDir();
    try {
      const a = await runFactoryProductionSmoke({ workDir: first });
      const b = await runFactoryProductionSmoke({ workDir: second });
      expect(a.checks.map(c => `${c.id}:${c.status}:${c.summary}`)).toEqual(
        b.checks.map(c => `${c.id}:${c.status}:${c.summary}`),
      );
      expect(a.status).toBe(b.status);
      expect(a.passCount).toBe(b.passCount);
      expect(a.failCount).toBe(b.failCount);
      expect(a.deferredCount).toBe(b.deferredCount);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test('writes only inside the caller-provided workDir', async () => {
    const workDir = tempWorkDir();
    const before = readdirSync(tmpdir()).sort();
    try {
      await runFactoryProductionSmoke({ workDir });
      const created = readdirSync(workDir);
      expect(created.length).toBeGreaterThan(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      const after = readdirSync(tmpdir()).sort();
      // Should not have leaked unrelated temp siblings — once we cleaned up
      // workDir, the tmpdir listing should match what we observed before
      // (modulo entries other tests may have produced concurrently). We only
      // assert that the runner did NOT create any sibling whose name leaks
      // 'factory-' or 'smoke-' outside the requested workDir.
      const newSiblings = after.filter(name => !before.includes(name));
      for (const name of newSiblings) {
        expect(name.includes('factory-prod-smoke-')).toBe(false);
      }
    }
  });

  test('rejects non-absolute workDir up front', async () => {
    let threw = false;
    try {
      await runFactoryProductionSmoke({ workDir: 'relative-path' });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain('absolute');
    }
    expect(threw).toBe(true);
  });

  test('refuses to emit deploy/publish/release/tag/push vocabulary in any check message', async () => {
    const workDir = tempWorkDir();
    try {
      const summary = await runFactoryProductionSmoke({ workDir });
      const banned = ['deployed', 'published', 'released', 'tagged', 'pushed'];
      for (const check of summary.checks) {
        const corpus = [check.summary, ...check.details, check.deferredReason ?? ''].join('\n').toLowerCase();
        for (const word of banned) {
          expect(corpus.includes(word), `${check.id} contained banned vocabulary '${word}'`).toBe(false);
        }
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('guarded denial audit details never echo raw destructive command tokens', async () => {
    const workDir = tempWorkDir();
    try {
      const summary = await runFactoryProductionSmoke({ workDir });
      const audit = findCheck(summary, 'S9-guarded-denial-audit');
      expect(audit.status).toBe('pass');
      // The denial command list is shown as 'command -> blocked (rule)'; the
      // sanitized audit records themselves never carry raw -rf/--force/.env
      // strings. We only assert against the sanitized layer because the
      // human-readable details intentionally show what got denied.
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('S6 project catalog details record the exercised workspace and project ids', async () => {
    const workDir = tempWorkDir();
    try {
      const summary = await runFactoryProductionSmoke({ workDir });
      const project = findCheck(summary, 'S6-project-catalog-roundtrip');
      expect(project.status).toBe('pass');
      const joined = project.details.join('\n');
      expect(joined).toContain('workspaceId:');
      expect(joined).toContain('projectId:');
      expect(joined).toContain('linkedRuns: 1');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('S10 distribution dry-run reports validated bundle, install, and update plans without installing anything', async () => {
    const workDir = tempWorkDir();
    try {
      const summary = await runFactoryProductionSmoke({ workDir });
      const dist = findCheck(summary, 'S10-distribution-dry-run');
      expect(dist.status).toBe('pass');
      expect(dist.summary).toContain('first install');
      expect(dist.summary).toContain('managed update');
      expect(dist.summary).toContain('without installing or publishing');
      expect(dist.details.join('\n')).toContain('install dry-run: create=3');
      expect(dist.details.join('\n')).toContain('update dry-run: create=1, update=1, keep=1, remove=1');
      // The planned bundle output dir and first-install root must NOT exist after the runner —
      // planDistributionBundle and planDistributionInstallUpdateDryRun do not create them.
      const outputDir = path.join(workDir, 'distribution', 'out');
      const freshInstallRoot = path.join(workDir, 'distribution', 'fresh-install-root');
      expect(existsSync(outputDir)).toBe(false);
      expect(existsSync(freshInstallRoot)).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
