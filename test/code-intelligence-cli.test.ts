/**
 * bin/gstack-code-intelligence — CLI surface smoke tests.
 *
 * lib/code-intelligence/* is covered by test/code-intelligence.test.ts, which
 * also drives the CLI's `index` and `search` consent/policy refusal paths.
 * This file covers the argument-handling surface those tests skip: usage on
 * bad/missing subcommands, `select` and `consent` validation + state writes,
 * and the `suggest` offer gate — all hermetic under a mkdtemp GSTACK_HOME
 * (the selection store lives at $GSTACK_HOME/code-intelligence.json), and all
 * on paths that never call detectAvailable(), so nothing probes providers or
 * the network.
 *
 * Note: the CLI has no `--help` flag — every unrecognized action (including
 * `--help`) routes to the usage message on stderr with exit 1. Pinned below.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBin } from './helpers/run-bin';

const ROOT = path.resolve(import.meta.dir, '..');
const CLI = path.join(ROOT, 'bin', 'gstack-code-intelligence');

let home: string;
let workDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cli-home-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cli-work-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

function runCli(...args: string[]) {
  return runBin('bun', [CLI, ...args], { cwd: workDir, gstackHome: home, home });
}

function readStore(): { provider: string | null; consents: Record<string, boolean>; declined: boolean } {
  return JSON.parse(fs.readFileSync(path.join(home, 'code-intelligence.json'), 'utf-8'));
}

describe('gstack-code-intelligence: usage surface', () => {
  test('no arguments: usage on stderr, exit 1', () => {
    const result = runCli();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gstack-code-intelligence:');
    expect(result.stderr).toContain('Usage:');
    expect(result.stderr).toContain('select <provider>');
    expect(result.stdout).toBe('');
  });

  test('unknown subcommand: usage on stderr, exit 1', () => {
    const result = runCli('frobnicate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  test('--help has no exit-0 handler — it routes to the usage failure (current behavior)', () => {
    const result = runCli('--help');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });
});

describe('gstack-code-intelligence: select', () => {
  test('invalid provider is rejected with the select usage line', () => {
    const result = runCli('select', 'bogus-provider');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: select <gbrain|sourcebot|graphify|none>');
    expect(fs.existsSync(path.join(home, 'code-intelligence.json'))).toBe(false);
  });

  test('select with no argument is rejected the same way', () => {
    const result = runCli('select');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: select <gbrain|sourcebot|graphify|none>');
  });

  test('select none records the decline so the offer is never repeated', () => {
    const result = runCli('select', 'none');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('declined');
    expect(result.stdout).toContain('will not ask again');
    const store = readStore();
    expect(store.provider).toBeNull();
    expect(store.declined).toBe(true);
  });

  test('selecting the local provider persists it without an off-machine warning', () => {
    const result = runCli('select', 'graphify');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('selected Graphify.');
    expect(result.stdout).not.toContain('off this machine');
    const store = readStore();
    expect(store.provider).toBe('graphify');
    expect(store.declined).toBe(false);
  });

  test('selecting a non-local provider warns that content leaves the machine', () => {
    const result = runCli('select', 'gbrain');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('selected GBrain.');
    expect(result.stdout).toContain('off this machine');
    expect(readStore().provider).toBe('gbrain');
  });
});

describe('gstack-code-intelligence: consent', () => {
  test('the yes/no value is required — a bare path records NOTHING', () => {
    const result = runCli('consent', workDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('never assumed');
    expect(fs.existsSync(path.join(home, 'code-intelligence.json'))).toBe(false);
  });

  test('an unknown value records NOTHING', () => {
    const result = runCli('consent', workDir, 'maybe');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('never assumed');
    expect(fs.existsSync(path.join(home, 'code-intelligence.json'))).toBe(false);
  });

  test('consent yes persists true for the resolved repo path', () => {
    const result = runCli('consent', workDir, 'yes');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('indexing consent recorded');
    expect(readStore().consents[fs.realpathSync(workDir)] ?? readStore().consents[workDir]).toBe(true);
  });

  test('consent no persists an explicit DENIED — a "no" is a durable answer too', () => {
    const result = runCli('consent', workDir, 'no');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DENIED');
    expect(readStore().consents[fs.realpathSync(workDir)] ?? readStore().consents[workDir]).toBe(false);
  });

  test('consent with no path defaults to the cwd', () => {
    const result = runCli('consent', 'yes');
    expect(result.status).toBe(0);
    const consents = readStore().consents;
    const keys = Object.keys(consents);
    expect(keys.length).toBe(1);
    // resolve(cwd) — the child's cwd is workDir (possibly via a symlinked tmp).
    expect([workDir, fs.realpathSync(workDir)]).toContain(keys[0]);
    expect(consents[keys[0]]).toBe(true);
  });
});

describe('gstack-code-intelligence: suggest (offer gate)', () => {
  test('a non-repo directory never triggers the offer (--json)', () => {
    const result = runCli('suggest', workDir, '--json');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.offer).toBe(false);
    expect(parsed.reason).toBe('not-a-repo');
    expect(parsed.fileCount).toBeNull();
    expect([workDir, fs.realpathSync(workDir)]).toContain(parsed.repoPath);
  });

  test('a selected provider suppresses the offer before any repo probing', () => {
    expect(runCli('select', 'graphify').status).toBe(0);
    const result = runCli('suggest', workDir, '--json');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.offer).toBe(false);
    expect(parsed.reason).toBe('provider-selected');
  });

  test('an explicit decline suppresses the offer permanently', () => {
    expect(runCli('select', 'none').status).toBe(0);
    const result = runCli('suggest', workDir, '--json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe('declined');
  });

  test('human-readable no-offer output names the reason', () => {
    const result = runCli('suggest', workDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no offer (not-a-repo)');
  });
});

describe('gstack-code-intelligence: provider-requiring commands without a selection', () => {
  test('index refuses when no provider is selected', () => {
    const result = runCli('index', workDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no provider selected');
  });

  test('search refuses when no provider is selected', () => {
    const result = runCli('search', 'anything');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no provider selected');
  });

  test('search with no query prints the search usage', () => {
    const result = runCli('search');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: search <query...>');
  });
});
