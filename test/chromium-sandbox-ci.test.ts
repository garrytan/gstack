import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const workflow = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/free-tests.yml'), 'utf8')) as any;
const steps = workflow.jobs['free-suite'].steps;
const index = steps.findIndex((step: any) => step.name === 'Configure the bundled Chromium sandbox helper');
const command = steps[index]?.run;
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function run(options: { outside?: boolean; link?: boolean; mode?: string; corrupt?: boolean } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'chromium-ci-'));
  fixtures.push(fixture);
  const bin = path.join(fixture, 'bin');
  const home = path.join(fixture, 'home');
  const directory = options.outside ? path.join(fixture, 'outside') : path.join(home, '.cache/ms-playwright/chromium-1234/chrome-linux64');
  mkdirSync(bin, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, 'chrome');
  const helper = path.join(directory, 'chrome_sandbox');
  const installed = path.join(directory, 'chrome-sandbox');
  const receipt = path.join(fixture, 'install.json');
  writeFileSync(executable, 'synthetic browser');
  if (options.link) symlinkSync(executable, helper);
  else writeFileSync(helper, 'synthetic matching helper');
  writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_CHROME"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'stat'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_STAT"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'sudo'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify(args));
if (JSON.stringify(args.slice(0, 8)) !== JSON.stringify(['install', '-T', '-o', 'root', '-g', 'root', '-m', '4755']) || args.length !== 10) process.exit(2);
fs.copyFileSync(args[8], args[9]);
if (process.env.FIXTURE_CORRUPT === '1') fs.appendFileSync(args[9], 'changed');
`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-c', command], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH,
      FIXTURE_CHROME: executable, FIXTURE_STAT: options.mode ?? '0:4755',
      FIXTURE_RECEIPT: receipt, FIXTURE_CORRUPT: options.corrupt ? '1' : '0' },
  });
  return { result, helper, installed, calls: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null };
}

test('the actual CI sandbox setup uses the resolved bundled helper before tests without disabling protections', () => {
  expect(typeof command).toBe('string');
  expect(index).toBeGreaterThan(steps.findIndex((step: any) => step.name === 'Install Playwright Chromium'));
  expect(index).toBeLessThan(steps.findIndex((step: any) => step.name === 'Run free suite'));
  expect(command).not.toMatch(/--no-sandbox|chromiumSandbox:\s*false|sysctl|apparmor_restrict/);
  const { result, helper, installed, calls } = run();
  expect(result.status).toBe(0);
  expect(calls).toEqual(['install', '-T', '-o', 'root', '-g', 'root', '-m', '4755', helper, installed]);
  expect(readFileSync(installed)).toEqual(readFileSync(helper));
});

test('unexpected paths and linked helpers are refused before privileged installation', () => {
  for (const options of [{ outside: true }, { link: true }]) {
    const { result, calls } = run(options);
    expect(result.status).not.toBe(0);
    expect(calls).toBeNull();
  }
});

test('the actual CI setup requires root ownership, setuid mode, and unchanged helper bytes', () => {
  for (const options of [{ mode: '1000:4755' }, { mode: '0:755' }, { corrupt: true }]) {
    const { result, calls } = run(options);
    expect(result.status).not.toBe(0);
    expect(calls).not.toBeNull();
  }
});

const NAMESPACE_STEP = 'Let the bundled Chromium create its sandbox namespaces';
const PROFILE = '/etc/apparmor.d/gstack-playwright-chromium';

function grantNamespaces(command: string, options: { outside?: boolean } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'chromium-userns-'));
  fixtures.push(fixture);
  const bin = path.join(fixture, 'bin');
  const home = path.join(fixture, 'home');
  const directory = options.outside ? path.join(fixture, 'outside') : path.join(home, '.cache/ms-playwright/chromium-1234/chrome-linux64');
  mkdirSync(bin, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, 'chrome');
  const receipt = path.join(fixture, 'sudo.jsonl');
  writeFileSync(executable, 'synthetic browser');
  writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_CHROME"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'sudo'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdin = args[0] === 'tee' ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify({ args, stdin }) + '\\n');
`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-c', command], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_CHROME: executable, FIXTURE_RECEIPT: receipt },
  });
  const calls = existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { result, executable, calls };
}

for (const [job, suiteStep] of [['free-suite', 'Run free suite'], ['quick-bun-default', 'Run the quick free tier on the install-default Bun']]) {
  const jobSteps = workflow.jobs[job].steps;
  const at = jobSteps.findIndex((step: any) => step.name === NAMESPACE_STEP);
  const grant = jobSteps[at]?.run;

  test(`${job} grants user namespaces to the resolved bundled Chromium alone, after its helper and before its tests`, () => {
    expect(typeof grant).toBe('string');
    expect(at).toBeGreaterThan(jobSteps.findIndex((step: any) => step.name === 'Configure the bundled Chromium sandbox helper'));
    expect(at).toBeLessThan(jobSteps.findIndex((step: any) => step.name === suiteStep));
    expect(grant).not.toMatch(/--no-sandbox|chromiumSandbox:\s*false|sysctl|apparmor_restrict/);
    const { result, executable, calls } = grantNamespaces(grant);
    expect(result.status).toBe(0);
    expect(calls).toEqual([
      { args: ['tee', PROFILE], stdin: `abi <abi/4.0>,\ninclude <tunables/global>\nprofile gstack-playwright-chromium ${executable} flags=(unconfined) {\n  userns,\n}\n` },
      { args: ['apparmor_parser', '-r', PROFILE], stdin: null },
    ]);
  });

  test(`${job} refuses to grant namespaces to an unexpected Chromium path`, () => {
    const { result, calls } = grantNamespaces(grant, { outside: true });
    expect(result.status).not.toBe(0);
    expect(calls).toEqual([]);
  });
}
