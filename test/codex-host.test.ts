/**
 * The Codex host for paid gate cases (GSTA-49 TM2): host selection with
 * skip-with-reason (never a failure), per-case host metadata over every gate
 * case, real Codex cost accounting against captured `codex exec --json`
 * usage events (Codex CLI 0.160.0, gpt-6.1-sol), and runner parity.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLAUDE_ONLY_REASONS, E2E_HOSTS, hostSkipReason, resolveEvalHost } from './helpers/e2e-hosts';
import { E2E_TIERS, E2E_TOUCHFILES } from './helpers/touchfiles';
import { addCodexTurnUsage, codexUsageCostUsd, NO_CODEX_USAGE, parseCodexJSONL, type CodexResult } from './helpers/codex-session-runner';
import { runRecordedCodexEval } from './helpers/codex-eval';
import { codexHostExecArgs, codexHostModel, codexHostToolCalls, codexHostTranscript, unwrapShellCommand } from './helpers/codex-host-runner';
import { coverageAuditReadEvidence } from './helpers/coverage-audit-evidence';
import { runSkillTest } from './helpers/session-runner';
import { readSessionLedger } from './helpers/session-ledger';
import { preflightAnthropicApi } from './helpers/anthropic-preflight';
import type { EvalTestEntry } from './helpers/eval-store';
import { buildRunManifest } from '../scripts/test-paid-shards';
import { codexShardAccess, fileCaseRegistration, partitionHostExclusions, scopeCodexAccess, shardCaseId, shardFile } from '../scripts/lib/paid-cases';
import { parseRunManifest } from '../scripts/lib/paid-plan';
import { attributeJUnitCase } from '../scripts/lib/paid-report';

const ROOT = path.resolve(import.meta.dir, '..');
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'test/fixtures/codex-host', name), 'utf8').split('\n').filter(Boolean);
const COMMANDS = fixture('exec-commands.jsonl');
const FILE_CHANGE = fixture('exec-file-change.jsonl');
const gateCases = Object.keys(E2E_TIERS).filter(id => E2E_TIERS[id] === 'gate').sort();
const adapterCases = Object.keys(E2E_HOSTS).filter(id => E2E_HOSTS[id] === 'both');
const scratch: string[] = [];
const tempDir = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); scratch.push(dir); return dir; };
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('host selection: Claude-only cases skip with a reason, never fail', () => {
  test('EVALS_HOST defaults to claude, accepts codex and refuses anything else', () => {
    expect(resolveEvalHost({})).toBe('claude');
    expect(resolveEvalHost({ EVALS_HOST: ' ' })).toBe('claude');
    expect(resolveEvalHost({ EVALS_HOST: 'codex' })).toBe('codex');
    expect(() => resolveEvalHost({ EVALS_HOST: 'gemini' })).toThrow('EVALS_HOST must be one of claude, codex');
  });

  test('the Anthropic preflight never pings claude on the Codex host', () => {
    const pinged: string[] = [];
    const spawn = ((cmd: string) => { pinged.push(cmd); return { status: 127, stdout: '', stderr: '' }; }) as unknown as typeof spawnSync;
    expect(preflightAnthropicApi({ EVALS_HOST: 'codex' }, spawn)).toBe('skipped');
    expect(pinged).toEqual([]);
    expect(() => preflightAnthropicApi({}, spawn)).toThrow('`claude` not found on PATH');
    expect(pinged).toEqual(['sh']);
  });

  test('every case runs on Claude; on Codex only adapter cases run and the rest carry their reason', () => {
    for (const id of gateCases) expect(hostSkipReason(id, 'claude')).toBeNull();
    for (const id of adapterCases) expect(hostSkipReason(id, 'codex')).toBeNull();
    expect(hostSkipReason('plan-mode-no-op', 'codex')).toBe(`Claude-only on the codex host: ${CLAUDE_ONLY_REASONS.pty}`);
    expect(hostSkipReason('ship-docsync-store', 'codex')).toContain('not ported to the Codex host');
    expect(hostSkipReason('plan-ceo-review', 'codex')).toContain('no Codex host metadata');
  });

  test('the module selection drops Claude-only cases on the Codex host', () => {
    const root = tempDir('codex-host-root-');
    fs.mkdirSync(path.join(root, 'home', '.codex'), { recursive: true });
    const run = spawnSync('bun', ['-e', "const h = await import('./test/helpers/e2e-helpers'); console.log(JSON.stringify(h.selectedTests))"], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, EVALS: '1', EVALS_TIER: 'gate', EVALS_HOST: 'codex', EVALS_PREFLIGHT_OK: '1', GSTACK_CODEX_HOST_ROOT: root,
        EVALS_SELECTION_JSON: JSON.stringify({ selected: null, reason: 'test' }) },
    });
    expect(run.status, run.stderr).toBe(0);
    expect((JSON.parse(run.stdout.trim().split('\n').at(-1)!) as string[]).sort()).toEqual([...adapterCases].sort());
    expect(run.stderr).toContain(`EVALS_HOST=codex: ${adapterCases.length} tests; ${gateCases.length - adapterCases.length} Claude-only skipped`);
  });

  test('the planner excludes Claude-only shards with their reason and plans every adapter case', () => {
    const manifest = buildRunManifest({ tier: 'gate', profile: 'full', sliceBudgetMs: 420_000, jobs: 2, evalsAll: true, skipJudges: true,
      env: { EVALS_ALL: '1', EVALS_HOST: 'codex' }, rootDir: ROOT });
    expect(manifest.host).toBe('codex');
    const planned = manifest.entries.filter(entry => entry.status === 'planned');
    const casesOf = (key: string) => {
      const id = shardCaseId(key);
      if (id !== null) return [id];
      return fileCaseRegistration(shardFile(key), fs.readFileSync(path.join(ROOT, shardFile(key)), 'utf8')).registered.filter(c => E2E_TIERS[c] === 'gate');
    };
    const reachable = new Set(planned.flatMap(entry => casesOf(entry.file)).filter(id => E2E_HOSTS[id] === 'both'));
    expect([...reachable].sort()).toEqual([...adapterCases].sort());
    for (const entry of planned) expect(casesOf(entry.file).some(id => E2E_HOSTS[id] === 'both'), entry.file).toBe(true);
    const hostExcluded = manifest.entries.filter(entry => entry.status === 'excluded' && entry.reason?.includes('Claude-only on the codex host'));
    expect(hostExcluded.length).toBeGreaterThan(0);
    for (const entry of hostExcluded) expect(entry.reason, entry.file).toStartWith('skipped: ');
    expect(manifest.entries.some(entry => entry.file === 'test/skill-e2e-ship-docsync.test.ts#ship-docsync-store' && entry.status === 'excluded')).toBe(true);
  });

  test('the Claude host plans exactly as before, with no host on the manifest', () => {
    const manifest = buildRunManifest({ tier: 'gate', profile: 'full', sliceBudgetMs: 420_000, jobs: 2, evalsAll: true, skipJudges: true,
      env: { EVALS_ALL: '1' }, rootDir: ROOT });
    expect(manifest.host).toBeUndefined();
    expect(manifest.entries.some(entry => entry.reason?.includes('Claude-only'))).toBe(false);
    expect(partitionHostExclusions(['a.test.ts', 'b.test.ts#x'], 'gate', 'claude')).toEqual({ runnable: ['a.test.ts', 'b.test.ts#x'], excluded: [] });
  });

  test('the report deselects a skipped Claude-only testcase on the Codex host (zero credit, never SKIPPED or failed)', () => {
    const tc = { name: 'review-dashboard-via', classname: '', outcome: 'skipped' as const, timeMs: 0, line: 10 };
    const key = 'test/skill-e2e-review-attribution.test.ts';
    expect(attributeJUnitCase(tc, { key, tier: 'gate', host: 'codex' })).toEqual({ kind: 'deselected', reason: hostSkipReason('review-dashboard-via', 'codex')! });
    expect(attributeJUnitCase(tc, { key, tier: 'gate' })).toEqual({ kind: 'case', id: 'review-dashboard-via' });
    expect(attributeJUnitCase({ ...tc, name: 'review-base-branch' }, { key, tier: 'gate', host: 'codex' })).toEqual({ kind: 'case', id: 'review-base-branch' });
  });

  test('a manifest names only a non-default host, and the executor refuses a cross-host run', () => {
    const base = { version: 1, tier: 'gate', evalsAll: true, sliceCount: 1, selectionReason: 'x', entries: [] };
    expect(parseRunManifest(JSON.stringify({ ...base, host: 'codex' })).host).toBe('codex');
    expect(() => parseRunManifest(JSON.stringify({ ...base, host: 'claude' }))).toThrow('manifest host invalid');
    expect(() => parseRunManifest(JSON.stringify({ ...base, host: 'gemini' }))).toThrow('manifest host invalid');
    const plan = path.join(tempDir('codex-host-plan-'), 'manifest.json');
    fs.writeFileSync(plan, JSON.stringify({ ...base, host: 'codex' }));
    const run = spawnSync('bun', ['run', 'scripts/test-paid-shards.ts', '--tier', 'gate', '--plan', plan, '--slice', '1', '--list'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, EVALS_HOST: 'claude', EVALS_TIER: 'gate' },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toContain('manifest host codex != EVALS_HOST claude');
  });
});

describe('per-case host metadata', () => {
  test('covers every gate case exactly once, and nothing else', () => {
    expect(Object.keys(E2E_HOSTS).sort()).toEqual(gateCases);
    for (const id of Object.keys(E2E_HOSTS)) expect(Object.hasOwn(E2E_TOUCHFILES, id), id).toBe(true);
  });

  test('classifies 52 adapter-only, 29 Claude-specific, 26 rework and 1 host-neutral case', () => {
    const counts: Record<string, number> = {};
    for (const support of Object.values(E2E_HOSTS)) counts[support] = (counts[support] ?? 0) + 1;
    expect(counts.both).toBe(52);
    expect(counts.rework).toBe(26);
    expect(counts['host-neutral']).toBe(1);
    expect(['pty', 'sdk', 'subagents', 'skill-tool', 'hermetic', 'self-host'].reduce((sum, reason) => sum + (counts[reason] ?? 0), 0)).toBe(29);
  });
});

describe('Codex cost accounting from captured usage events', () => {
  test('parses every token class of turn.completed (cache reads and writes are subsets of input)', () => {
    const commands = parseCodexJSONL(COMMANDS);
    expect(commands.usage).toEqual({ input: 25009, cached_input: 12437, cache_write_input: 12566, output: 86, reasoning_output: 0 });
    expect(commands.tokens).toBe(25095);
    expect(parseCodexJSONL(FILE_CHANGE).usage).toEqual({ input: 25020, cached_input: 12440, cache_write_input: 12574, output: 137, reasoning_output: 0 });
    expect(parseCodexJSONL(['{"type":"thread.started","thread_id":"t"}']).usage).toBeNull();
    const twoTurns = [COMMANDS, FILE_CHANGE].map(lines => JSON.parse(lines.find(line => line.includes('turn.completed'))!).usage)
      .reduce(addCodexTurnUsage, NO_CODEX_USAGE);
    expect(twoTurns).toEqual({ input: 50029, cached_input: 24877, cache_write_input: 25140, output: 223, reasoning_output: 0 });
  });

  test('prices with lib/pricing.ts: uncached input (cache writes included) at input, cache reads at the cached rate', () => {
    const usage = parseCodexJSONL(COMMANDS).usage!;
    // gpt-6.1-sol: 12,572 x $2 + 12,437 x $0.10 + 86 x $10 per million.
    expect(codexUsageCostUsd(usage, 'gpt-6.1-sol')).toBe(0.027248);
    expect(codexUsageCostUsd(parseCodexJSONL(FILE_CHANGE).usage!, 'gpt-6.1-sol')).toBe(0.027774);
    // gpt-6-astra: 12,572 x $10 + 12,437 x $1 + 86 x $50 per million.
    expect(codexUsageCostUsd(usage, 'gpt-6-astra')).toBe(0.142457);
    expect(codexUsageCostUsd(usage, 'gpt-0-unpriced')).toBeNull();
  });

  test('runRecordedCodexEval records real cost and billing instead of cost_known: false', async () => {
    const evalDir = tempDir('codex-host-ledger-');
    const previous = process.env.GSTACK_EVAL_DIR;
    process.env.GSTACK_EVAL_DIR = evalDir;
    try {
      const recorded: EvalTestEntry[] = [];
      const result: CodexResult = { ...parseCodexJSONL(COMMANDS), exitCode: 0, durationMs: 5, rawLines: COMMANDS, stderr: '', model: 'gpt-6.1-sol' };
      await runRecordedCodexEval({ name: 'cost-case', suite: 's', budgetMs: 10_000, run: async () => result, validate: () => {}, record: entry => recorded.push(entry) });
      expect(recorded[0]).toMatchObject({ passed: true, cost_usd: 0.027248, model: 'gpt-6.1-sol', token_usage: result.usage });
      expect(recorded[0]!.cost_known).toBeUndefined();
      const noTurn: CodexResult = { ...parseCodexJSONL([]), exitCode: 0, durationMs: 5, rawLines: [], stderr: '' };
      await runRecordedCodexEval({ name: 'no-turn', suite: 's', budgetMs: 10_000, run: async () => noTurn, validate: () => {}, record: entry => recorded.push(entry) });
      expect(recorded[1]).toMatchObject({ cost_usd: 0, cost_known: false });
      const rows = readSessionLedger(evalDir);
      expect(rows.map(row => [row.test_name, row.billed])).toEqual([['cost-case', true], ['no-turn', false]]);
      expect(rows[0]).toMatchObject({ runner: 'codex', model: 'gpt-6.1-sol', cost_usd: 0.027248, tokens: result.usage });
    } finally {
      if (previous === undefined) delete process.env.GSTACK_EVAL_DIR; else process.env.GSTACK_EVAL_DIR = previous;
    }
  });
});

describe('Codex runner parity', () => {
  test('maps command_execution to Bash (unwrapped, with output) and file_change to Write/Edit', () => {
    expect(codexHostToolCalls(COMMANDS)).toEqual([
      { tool: 'Bash', input: { command: "printf 'hi' > hello.txt\nprintf 'hello' > hello.txt\ncat hello.txt" }, output: 'hello' },
    ]);
    expect(codexHostToolCalls(FILE_CHANGE)).toEqual([
      { tool: 'Write', input: { file_path: '/tmp/codex-host-fixture/notes.md', kind: 'add' }, output: '' },
      { tool: 'Edit', input: { file_path: '/tmp/codex-host-fixture/notes.md', kind: 'update' }, output: '' },
    ]);
  });

  test('the transcript is the Claude stream-json shape the case observers read', () => {
    const output = '`cat hello.txt` output: `hello`';
    const transcript = codexHostTranscript(COMMANDS, '/tmp/codex-host-fixture', output);
    expect(transcript[0]).toEqual({ type: 'system', subtype: 'init', cwd: '/tmp/codex-host-fixture', session_id: '01a150b3-ae5a-7932-ba51-4c295c66adf4', tools: [] });
    expect(transcript.slice(1).map(event => [event.type, event.message?.content[0].type ?? event.subtype])).toEqual([
      ['assistant', 'text'], ['assistant', 'tool_use'], ['user', 'tool_result'], ['assistant', 'text'], ['result', 'success']]);
    expect(transcript[2].message.content[0]).toEqual({ type: 'tool_use', id: 'item_1', name: 'Bash', input: { command: "printf 'hi' > hello.txt\nprintf 'hello' > hello.txt\ncat hello.txt" } });
    expect(transcript[3].message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'item_1', content: 'hello', is_error: false });
    expect(transcript.at(-1)).toMatchObject({ type: 'result', result: output });
    const edits = codexHostTranscript(FILE_CHANGE, '/tmp/codex-host-fixture', '').filter(event => event.type === 'assistant' && event.message.content[0].type === 'tool_use');
    expect(edits.map(event => [event.message.content[0].name, event.message.content[0].input.file_path])).toEqual([
      ['Write', '/tmp/codex-host-fixture/notes.md'], ['Edit', '/tmp/codex-host-fixture/notes.md']]);
    // A Codex `cat` of a fixture file is a read the coverage-audit evidence credits, as a native Bash read is.
    const source = { path: '/w/src/billing.ts', content: 'export const a = 1;\n' };
    const tests = { path: '/w/test/billing.test.ts', content: 'test("a", () => {});\n' };
    const read = (id: string, file: string, out: string) => JSON.stringify({ type: 'item.completed', item: { id, type: 'command_execution', command: `/bin/bash -lc 'cat ${file}'`, aggregated_output: out, exit_code: 0, status: 'completed' } });
    const lines = ['{"type":"thread.started","thread_id":"t1"}', read('item_0', 'src/billing.ts', source.content), read('item_1', 'test/billing.test.ts', tests.content)];
    expect(coverageAuditReadEvidence(codexHostTranscript(lines, '/w', ''), { cwd: '/w', source, tests })).toEqual({ sourceRead: true, testsRead: true });
    const failed = lines.map(line => line.replace('"exit_code":0', '"exit_code":1'));
    expect(coverageAuditReadEvidence(codexHostTranscript(failed, '/w', ''), { cwd: '/w', source, tests })).toEqual({ sourceRead: false, testsRead: false });
  });

  test('unwraps only a single well-formed bash -lc word', () => {
    expect(unwrapShellCommand("/bin/bash -lc 'git diff main...HEAD'")).toBe('git diff main...HEAD');
    expect(unwrapShellCommand("/bin/bash -lc 'echo '\"'\"'x'\"'\"''")).toBe("echo 'x'");
    expect(unwrapShellCommand('/bin/bash -lc "echo \\"\\$HOME\\""')).toBe('echo "$HOME"');
    expect(unwrapShellCommand('bash -lc ls')).toBe('ls');
    expect(unwrapShellCommand('git status')).toBe('git status');
    expect(unwrapShellCommand("/bin/bash -lc 'unterminated")).toBe("/bin/bash -lc 'unterminated");
    expect(unwrapShellCommand("/bin/bash -lc 'a' 'b'")).toBe("/bin/bash -lc 'a' 'b'");
  });

  test('sandbox, effort and model settings', () => {
    expect(codexHostExecArgs('gpt-6.1-sol', 'go', {})).toEqual(['exec', '--json', '-s', 'danger-full-access', '--skip-git-repo-check', '--model', 'gpt-6.1-sol', 'go']);
    expect(codexHostExecArgs('gpt-6.1-sol', 'go', { GSTACK_CODEX_EFFORT: 'high' })).toContain('model_reasoning_effort="high"');
    expect(codexHostExecArgs('m', 'go', { GSTACK_CODEX_SANDBOX: 'workspace-write' })).toEqual(
      ['exec', '--json', '-s', 'workspace-write', '--skip-git-repo-check', '--model', 'm', '-c', 'sandbox_workspace_write.network_access=true', 'go']);
    expect(() => codexHostExecArgs('m', 'go', { GSTACK_CODEX_SANDBOX: 'none' })).toThrow('GSTACK_CODEX_SANDBOX');
    expect(() => codexHostExecArgs('m', 'go', { GSTACK_CODEX_EFFORT: 'high" -c x="y' })).toThrow('GSTACK_CODEX_EFFORT');
    expect(codexHostModel('claude-opus-4-7', { GSTACK_CODEX_MODEL: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol');
    expect(codexHostModel('gpt-6-astra', { GSTACK_CODEX_MODEL: 'gpt-6.1-sol' })).toBe('gpt-6-astra');
    expect(codexHostModel(undefined, {})).toBe('gpt-6-astra');
  });

  test('every shard on the Codex host gets the CI Codex install', () => {
    expect(codexShardAccess(['test/skill-e2e-review.test.ts'], 'gate')).toBe('none');
    expect(codexShardAccess(['test/skill-e2e-review.test.ts'], 'gate', 'codex')).toBe('path');
    const env: NodeJS.ProcessEnv = { EVALS_HOST: 'codex', EVALS_TIER: 'gate', PATH: '/usr/bin', GSTACK_CI_CODEX_BIN_DIR: '/opt/codex/bin', GSTACK_CI_CODEX_HOME: '/home/runner/.ci-codex' };
    scopeCodexAccess(env, ['test/skill-e2e-review.test.ts']);
    expect(env.PATH).toBe(`/opt/codex/bin${path.delimiter}/usr/bin`);
    expect(env.CODEX_HOME).toBe('/home/runner/.ci-codex');
  });

  test('runSkillTest on EVALS_HOST=codex runs codex exec and returns a priced SkillTestResult', async () => {
    const dir = tempDir('codex-host-run-');
    const root = path.join(dir, 'runtime');
    fs.mkdirSync(path.join(root, 'home', '.codex'), { recursive: true });
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const argsFile = path.join(dir, 'args.txt');
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s\\n' "$CODEX_HOME" >> '${argsFile}'\ncat '${path.join(ROOT, 'test/fixtures/codex-host/exec-commands.jsonl')}'\n`, { mode: 0o755 });
    const evalDir = path.join(dir, 'evals');
    const saved = { ...process.env };
    Object.assign(process.env, { EVALS_HOST: 'codex', GSTACK_CODEX_MODEL: 'gpt-6.1-sol', GSTACK_CODEX_HOST_ROOT: root, GSTACK_EVAL_DIR: evalDir, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    try {
      const result = await runSkillTest({ prompt: 'Run the fixture.', workingDirectory: dir, model: 'claude-opus-4-7', timeout: 30_000, testName: 'host-switch' });
      expect(result).toMatchObject({ exitReason: 'success', model: 'gpt-6.1-sol', output: '`cat hello.txt` output: `hello`', browseErrors: [] });
      expect(result.toolCalls.map(call => call.input.command)).toEqual(["printf 'hi' > hello.txt\nprintf 'hello' > hello.txt\ncat hello.txt"]);
      expect(result.costEstimate).toMatchObject({ estimatedCost: 0.027248, estimatedTokens: 25095, turnsUsed: 3 });
      expect(result.tokenUsage).toEqual(parseCodexJSONL(COMMANDS).usage!);
      const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(args.slice(0, 7)).toEqual(['exec', '--json', '-s', 'danger-full-access', '--skip-git-repo-check', '--model', 'gpt-6.1-sol']);
      expect(args.at(-2)).toBe('Run the fixture.');
      expect(args.at(-1)).toBe(path.join(root, 'home', '.codex'));
      expect(readSessionLedger(evalDir)).toEqual([expect.objectContaining({ runner: 'codex', test_name: 'host-switch', end: 'completed', billed: true, cost_usd: 0.027248 })]);
      // The native lifecycle sees the codex group owner at spawn and settles after its exit.
      const seen: string[] = [];
      await runSkillTest({ prompt: 'Run the fixture.', workingDirectory: dir, timeout: 30_000, testName: 'host-lifecycle', nativeLifecycle: {
        onSpawn: pid => { seen.push(`spawn ${pid > 0}`); },
        onSettled: async ({ deadline, exited }) => { seen.push(`settled ${exited} ${deadline > Date.now()}`); },
      } });
      expect(seen).toEqual(['spawn true', 'settled true true']);
      await expect(runSkillTest({ prompt: 'Run the fixture.', workingDirectory: dir, timeout: 30_000, testName: 'host-lifecycle-refused', nativeLifecycle: {
        onSpawn: () => { throw new Error('native process is not group owner'); },
        onSettled: async () => {},
      } })).rejects.toThrow('native process is not group owner');
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
