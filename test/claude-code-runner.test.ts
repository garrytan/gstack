import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runClaudeCode } from '../lib/claude-code';

const ROOT = path.resolve(import.meta.dir, '..');
const DIR = mkdtempSync(path.join(tmpdir(), 'claude-code-runner-'));
const FAKE = path.join(DIR, 'fake claude.ts');
const DESCENDANT = path.join(DIR, 'pipe holder.ts');
const CAPTURE = path.join(DIR, 'capture.json');
const PID = path.join(DIR, 'descendant.pid');

// Publish readiness only after the grandchild has initialized and flushed both
// inherited pipes; a PID returned by spawn alone does not establish that state.
writeFileSync(DESCENDANT, `
import { writeFileSync } from 'node:fs';
setInterval(() => {}, 1000);
await new Promise(resolve => process.stdout.write(' ', resolve));
await new Promise(resolve => process.stderr.write(' ', resolve));
writeFileSync(process.env.PID_FILE!, String(process.pid));
`);

writeFileSync(FAKE, `
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
const prompt = await Bun.stdin.text();
writeFileSync(process.env.CAPTURE!, JSON.stringify({args:process.argv.slice(2),prompt,cwd:process.cwd(),model:process.env.ANTHROPIC_MODEL,auth:process.env.ANTHROPIC_API_KEY}));
const mode = process.env.FAKE_MODE;
if (mode === 'timeout' || mode === 'descendant' || mode === 'escaped') {
  rmSync(process.env.PID_FILE!, { force: true });
  const child = spawn(process.execPath, [process.env.DESCENDANT!], {stdio:['ignore','inherit','inherit'], detached:mode === 'escaped'});
  const readyBy = Date.now() + 2000;
  while (!existsSync(process.env.PID_FILE!)) {
    if (child.exitCode !== null || Date.now() >= readyBy) throw new Error('Descendant did not initialize its inherited pipes');
    await Bun.sleep(5);
  }
  if (mode === 'timeout') await new Promise(() => {});
}
if (mode === 'auth') { process.stderr.write('Not logged in. Please run claude /login.'); process.exit(1); }
if (mode === 'overflow') {
  const block = Buffer.alloc(1024 * 1024, 120);
  for(let i=0;i<18;i++) { process.stdout.write(block); process.stderr.write(block); }
  await new Promise(() => {});
}
if (mode === 'malformed') { process.stdout.write('broken JSON'); process.exit(0); }
if (mode === 'array') { process.stdout.write('[]'); process.exit(0); }
if (mode === 'null') { process.stdout.write('null'); process.exit(0); }
const result = {
  result: mode === 'empty' ? '  ' : mode === 'large-success' ? 'x'.repeat(2 * 1024 * 1024) : '[P1] Seeded defect in changed.ts',
  is_error:mode === 'error',
  session_id:'session-123',
  usage:{input_tokens:12,output_tokens:34,cache_read_input_tokens:5},
  modelUsage:{'claude-first':{inputTokens:4},'claude-fallback':{inputTokens:8}},
};
await new Promise(resolve => process.stdout.write(JSON.stringify(result),resolve));
process.exit(mode === 'nonzero' ? 7 : 0);
`);

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function env(mode = 'success'): NodeJS.ProcessEnv {
  return { ...process.env, GSTACK_CLAUDE_BIN: process.execPath, GSTACK_CLAUDE_BIN_ARGS: JSON.stringify([FAKE]),
    FAKE_MODE: mode, CAPTURE, PID_FILE: PID, DESCENDANT, ANTHROPIC_MODEL: 'configured-model', ANTHROPIC_API_KEY: 'fake-test-credential' };
}

function run(mode = 'success', extra: Partial<Parameters<typeof runClaudeCode>[0]> = {}) {
  return runClaudeCode({cwd:DIR, access:'none', timeoutMs:5000, prompt:'review this', env:env(mode), ...extra});
}

function capture() { return JSON.parse(readFileSync(CAPTURE, 'utf8')); }

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // Linux can leave a killed orphan briefly as a zombie before init reaps it.
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';
    return true;
  } catch { return false; }
}

async function expectDescendantDead() {
  const pid = Number(readFileSync(PID, 'utf8'));
  try {
    for (let i = 0; i < 20 && running(pid); i++) await Bun.sleep(25);
    expect(running(pid)).toBe(false);
  } finally {
    if (running(pid)) process.kill(pid, 'SIGKILL');
  }
}

function cleanupDescendant() {
  let pid: number;
  try { pid = Number(readFileSync(PID, 'utf8')); } catch { return; }
  if (Number.isSafeInteger(pid) && pid > 0 && running(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Exited after the liveness check. */ }
  }
}

describe('Claude Code restricted execution', () => {
  test('explicit model override stays one literal argument across access modes and resume', async () => {
    const model = 'custom-model "quoted" $(touch /never)';
    for (const access of ['none', 'read-only'] as const) {
      const result = await run('success', { access, resume: 'session-123', env: { ...env(), GSTACK_CLAUDE_MODEL: model } });
      expect(result.status).toBe('completed');
      const args = capture().args;
      expect(args.filter((arg: string) => arg === '--model')).toHaveLength(1);
      expect(args[args.indexOf('--model') + 1]).toBe(model);
      expect(args[args.indexOf('--resume') + 1]).toBe('session-123');
      expect(capture().auth).toBe('fake-test-credential');
    }
    await run('success', { env: { ...env(), GSTACK_CLAUDE_MODEL: undefined } });
    expect(capture().args).not.toContain('--model');
    expect(capture().model).toBe('configured-model');
  });

  test('stdin stays literal; explicit tools, MCP and hook restrictions preserve configured auth/model', async () => {
    const prompt = 'quotes "\' `touch /never` $(touch /never)\nEOF\n--dangerously-skip-permissions';
    const result = await run('success', {prompt});
    expect(result.status).toBe('completed');
    expect(capture().prompt).toBe(prompt);
    expect(capture().cwd).toBe(DIR);
    expect(capture().model).toBe('configured-model');
    expect(capture().auth).toBe('fake-test-credential');
    const args = capture().args;
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    const capability = args[args.indexOf('--append-system-prompt') + 1];
    expect(capability).toContain('No tools are available');
    expect(capability).toContain('Do not attempt or simulate tool calls');
    expect(capability).toContain('If essential context is missing, identify it explicitly');
    expect(capability).not.toContain(prompt);
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--strict-mcp-config');
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({mcpServers:{}});
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({disableAllHooks:true});
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('mcp__*');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain(prompt);
    expect(result.modelUsage).toEqual({'claude-first':{inputTokens:4},'claude-fallback':{inputTokens:8}});
    expect(result.usage).toEqual({input_tokens:12,output_tokens:34,cache_read_input_tokens:5});
    expect(result.model).toBeUndefined();
    expect(result.session_id).toBe('session-123');
  });

  test('consult exposes only file reading tools and preserves a literal resume argument', async () => {
    const resume = 'session " with spaces $(touch /never)';
    expect((await run('success', {access:'read-only', resume})).status).toBe('completed');
    const args = capture().args;
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob');
    expect(args).not.toContain('--append-system-prompt');
    expect(args[args.indexOf('--resume') + 1]).toBe(resume);
    expect(args).not.toContain('--no-session-persistence');
  });

  test('PATH command overrides and argument prefixes resolve in the invocation environment', async () => {
    const cliEnv = env();
    cliEnv.GSTACK_CLAUDE_BIN = path.basename(process.execPath);
    cliEnv.PATH = `${path.dirname(process.execPath)}${path.delimiter}${cliEnv.PATH}`;
    expect((await run('success', {env:cliEnv})).status).toBe('completed');
    expect(capture().args[0]).toBe('-p');
  });

  test('WSL-style launcher prefixes remain ordered literal argv entries', async () => {
    const cliEnv = env();
    cliEnv.GSTACK_CLAUDE_BIN_ARGS = JSON.stringify([FAKE,'claude','--configured-option','a value with spaces']);
    expect((await run('success',{env:cliEnv})).status).toBe('completed');
    expect(capture().args.slice(0,4)).toEqual(['claude','--configured-option','a value with spaces','-p']);
  });

  test('missing CLI and broken absolute overrides have distinct actionable failures', async () => {
    const missing = await run('success', {env:{PATH:DIR}});
    expect(missing.status).toBe('unavailable');
    expect(missing.error?.code).toBe('not-found');
    expect(missing.error?.message).toContain('GSTACK_CLAUDE_BIN');
    const broken = await run('success', {env:{GSTACK_CLAUDE_BIN:path.join(DIR,'missing-cli')}});
    expect(broken.status).toBe('unavailable');
    expect(broken.error?.code).toBe('spawn');
  });

  for (const [mode, code] of [
    ['auth','authentication'], ['nonzero','exit'], ['error','provider-error'],
    ['malformed','invalid-json'], ['array','invalid-response'], ['null','invalid-response'], ['empty','empty-response'],
  ]) {
    test(`${mode} cannot become a successful review`, async () => {
      const result = await run(mode);
      expect(result.status).not.toBe('completed');
      expect(result.result).toBe('');
      expect(result.error?.code).toBe(code);
      if (mode === 'auth') expect(result.error?.message).toContain('interactively');
    });
  }

  test('the combined stdout/stderr limit terminates a noisy CLI', async () => {
    const result = await run('overflow');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('output-limit');
    expect(result.stderr!.length).toBeLessThanOrEqual(16 * 1024);
  });

  test('timeout kills its descendants and clears process signal listeners', async () => {
    rmSync(PID, { force: true });
    const before = ['SIGINT','SIGTERM','exit'].map(name => process.listenerCount(name));
    const start = Date.now();
    try {
      const result = await run('timeout', {timeoutMs:500});
      expect(result.status).toBe('unavailable');
      expect(result.error?.code).toBe('timeout');
      expect(Date.now() - start).toBeLessThan(2000);
      expect(['SIGINT','SIGTERM','exit'].map(name => process.listenerCount(name))).toEqual(before);
      await expectDescendantDead();
    } finally { cleanupDescendant(); }
  });

  test('a child exiting with inherited pipes is unavailable within the drain deadline', async () => {
    rmSync(PID, { force: true });
    const start = Date.now();
    try {
      const result = await run('descendant');
      expect(result.status).toBe('unavailable');
      expect(result.error?.code).toBe('output-drain');
      expect(Date.now() - start).toBeLessThan(2000);
      // taskkill /T cannot discover an orphan after its parent has exited.
      // Windows termination is covered by the timeout case while the parent
      // is alive; cleanup below still runs if a drain assertion fails.
      if (process.platform !== 'win32') await expectDescendantDead();
    } finally { cleanupDescendant(); }
  });

  test.skipIf(process.platform === 'win32')('an escaped pipe holder cannot wedge draining or count as coverage', async () => {
    const start = Date.now();
    try {
      const result = await run('escaped');
      expect(result.status).toBe('unavailable');
      expect(result.error?.code).toBe('output-drain');
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      const pid = Number(readFileSync(PID, 'utf8'));
      if (running(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  test('CLI exits nonzero for malformed responses and argument failures', () => {
    const cli = path.join(ROOT, 'bin/gstack-claude-code');
    for (const mode of ['success','malformed','error','auth']) {
      const result = spawnSync(process.execPath, [cli,'--cwd',DIR,'--access','none','--timeout-ms','5000'], {
        env:env(mode), input:'a prompt', encoding:'utf8', timeout:10000,
      });
      expect(result.status).toBe(mode === 'success' ? 0 : 1);
      expect(JSON.parse(result.stdout).status === 'completed').toBe(mode === 'success');
    }
    const invalid = spawnSync(process.execPath, [cli,'--access','write'], {encoding:'utf8', timeout:5000});
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).error.code).toBe('arguments');
  });

  test('CLI flushes a large successful JSON response before exiting', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT,'bin/gstack-claude-code'),'--cwd',DIR,'--access','none','--timeout-ms','5000'], {
      env:env('large-success'), input:'prompt', encoding:'utf8', timeout:10000, maxBuffer:8 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('completed');
    expect(parsed.result.length).toBe(2 * 1024 * 1024);
  });
});
