import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runBashScript } from './helpers/bash-script';

const source = readFileSync(resolve(import.meta.dir, '../.github/workflows/arm-setup-smoke.yml'), 'utf8');
const workflow = Bun.YAML.parse(source) as any;
const job = workflow.jobs['native-arm-setup'];
const scripts = job.steps.filter((step: any) => step.run).map((step: any) => step.run).join('\n');

describe('native ARM setup smoke workflow', () => {
  test('runs only for relevant PRs with read-only permissions and no persisted credentials', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    expect(workflow.on.pull_request.paths).toContain('setup');
    expect(workflow.on.pull_request.paths).toContain('bun.lock');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(job.steps[0].with['persist-credentials']).toBe(false);
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('github.token');
    expect(source).not.toContain('packages: write');
    for (const step of job.steps.filter((step: any) => step.uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('requires real native ARM and Ubuntu 26.04 without emulation or OS mocks', () => {
    expect(job['runs-on']).toBe('ubuntu-24.04-arm');
    expect(scripts).toContain('test "$(uname -m)" = aarch64');
    expect(scripts).toContain('test "$(docker info --format \'{{.Architecture}}\')" = aarch64');
    expect(scripts).toMatch(/image=ubuntu:26\.04@sha256:[0-9a-f]{64}/);
    expect(scripts).toContain('--platform linux/arm64');
    expect(scripts).toContain('test "$VERSION_ID" = 26.04');
    expect(scripts).toContain('test "$(node -p \'process.arch\')" = arm64');
    expect(source).not.toMatch(/qemu|binfmt|PLAYWRIGHT_HOST_PLATFORM_OVERRIDE/);
  });

  test('binds exact checkout and lockfile to setup and actual ARM Chromium rendering', () => {
    expect(scripts).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(scripts).toContain('git archive --format=tar HEAD');
    expect(scripts).toContain('sha256sum setup bun.lock package.json');
    expect(scripts.match(/sha256sum --check \/input\/source.sha256/g)).toHaveLength(2);
    expect(scripts).toContain('bun install --frozen-lockfile');
    expect(scripts).toContain('bash setup --host claude');
    expect(scripts).toContain('test ! -e "$PLAYWRIGHT_BROWSERS_PATH"');
    expect(scripts).toContain('Browser unavailable:|Chromium install skipped by request');
    expect(scripts).toContain('assert.equal(elf.readUInt16LE(18), 183)');
    expect(scripts).toContain('await chromium.launch(');
    expect(scripts).toContain('await page.screenshot()');
    expect(scripts).not.toContain('GSTACK_SKIP_PLAYWRIGHT=1');
  });

  test('keeps installation in a disposable container without host homes or credentials', () => {
    expect(scripts).toContain('dst=/input,readonly');
    expect(scripts.match(/--mount /g)).toHaveLength(1);
    const dockerRun = scripts.slice(scripts.indexOf('docker run '), scripts.indexOf("<<'CONTAINER'"));
    expect(dockerRun).not.toMatch(/--privileged|--network[ =]host|--volume| -v |docker\.sock:/);
    expect(scripts).toContain('runuser -u smoke -- env -i HOME=/home/smoke');
    expect(scripts).toContain('PLAYWRIGHT_BROWSERS_PATH=/home/smoke/browsers');
    expect(scripts).toContain('--security-opt no-new-privileges');
    expect(scripts).toContain('docker rm -f "$container"');
  });

  test('bounds cost and time, preserves failures and uploads source-bound logs', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    expect(job['timeout-minutes']).toBe(35);
    expect(job.steps.find((step: any) => step['timeout-minutes'])['timeout-minutes']).toBe(28);
    expect(scripts).toContain('--kill-after=30s 1500s');
    expect(scripts).toContain('--cpus=2 --memory=6g --pids-limit=1024');
    expect(scripts).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=600');
    expect(scripts).toContain('set -euo pipefail');
    expect(job.steps.some((step: any) => step['continue-on-error'])).toBe(false);
    const upload = job.steps.at(-1);
    expect(upload.if).toBe('always()');
    expect(upload.with['retention-days']).toBe(14);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(job.steps[1].with['bun-version']).toBe('1.4.0');
  });

  test('the registered shell step refuses a nonnative Docker daemon before pulling or running', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gstack-arm-smoke-'));
    try {
      writeFileSync(join(tmp, 'docker'), [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$DOCKER_CALLS"',
        'if [ "$1" = info ]; then echo x86_64; fi',
      ].join('\n'), { mode: 0o755 });
      const step = job.steps.find((step: any) => step.run?.includes('docker run '));
      const result = runBashScript(step.run, {
        timeout: 5000,
        cwd: tmp,
        env: {
          PATH: `${tmp}:${process.env.PATH ?? ''}`,
          HOME: tmp,
          RUNNER_TEMP: tmp,
          DOCKER_CALLS: join(tmp, 'docker-calls'),
          GITHUB_RUN_ID: 'fixture',
          GITHUB_RUN_ATTEMPT: '1',
        },
      });
      expect(result.status).toBe(1);
      const calls = readFileSync(join(tmp, 'docker-calls'), 'utf8');
      expect(calls).toContain('info --format {{.Architecture}}');
      expect(calls).toContain('rm -f gstack-arm-fixture-1');
      expect(calls).not.toMatch(/^(pull|run) /m);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
