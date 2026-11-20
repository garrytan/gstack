/**
 * A real Codex reads the hooks.json gstack writes (GST-3172), with no model call: Codex 0.170 skips the whole file
 * when it holds a key it does not know, the user's hooks included, so this is the check that matters most. Each
 * run points Codex at a provider on a closed local port, so it runs SessionStart and UserPromptSubmit hooks and
 * then retries the network until the test stops it. Skips without codex 0.170+ on PATH, unless
 * GSTACK_REQUIRE_CODEX=1 (the codex-hooks CI job), where a missing codex fails instead.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const version = (() => {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return /^codex-cli (\d+)\.(\d+)\.(\d+)/m.exec(r.stdout ?? '');
})();
const usable = !!version && (Number(version[1]) > 0 || Number(version[2]) >= 170);
const required = process.env.GSTACK_REQUIRE_CODEX === '1';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-real-codex-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const home = () => path.join(dir, 'codex');
const marker = () => path.join(dir, 'user-session-start');
const routeLog = () => path.join(dir, 'state', 'hooks', 'skill-route.log');

/** The user's own SessionStart hook, then gstack's three groups through gstack-settings-hook's Codex format. */
function install(): void {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(path.join(home(), 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch ' + marker(), timeout: 5 }] }] },
  }, null, 2));
  const hook = (args: string[]) => {
    const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-settings-hook'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_HOOKS_FORMAT: 'codex', CODEX_HOME: home() }, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status).toBe(0);
  };
  const shims = path.join(ROOT, 'hosts', 'codex', 'hooks');
  hook(['ensure-event', '--event', 'UserPromptSubmit', '--command', path.join(shims, 'codex-skill-route-hook'), '--source', 'gstack-skill-route', '--timeout', '5']);
  hook(['ensure-event', '--event', 'PreToolUse', '--command', path.join(shims, 'codex-destructive-guard-hook'), '--source', 'gstack-destructive-guard', '--matcher', 'Bash', '--timeout', '10']);
  hook(['ensure-event', '--event', 'Stop', '--command', path.join(shims, 'codex-skill-contract-stop-hook'), '--source', 'gstack-skill-contract', '--timeout', '10']);
  const skills = path.join(dir, 'skills', 'gstack-review');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: review\ndescription: Review a diff before it lands.\n---\n');
}

/** Run codex exec until both hooks would have fired (or Codex reached the network), then stop it. */
async function codexExec(extra: string[]): Promise<string> {
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const child = spawn('codex', ['exec', '--skip-git-repo-check', ...extra, '-c', 'model_provider=gstack_null',
    '-c', 'model_providers.gstack_null={name="null",base_url="http://127.0.0.1:9/v1",wire_api="responses"}', 'please review my changes'], {
    cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '', HOME: dir, CODEX_HOME: home(), OPENAI_API_KEY: 'sk-not-a-real-key', SHELL: '/bin/bash',
      GSTACK_STATE_ROOT: path.join(dir, 'state'), GSTACK_INSTALLED_SKILLS_DIR: path.join(dir, 'skills'),
    },
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !/Reconnecting|stream error|error sending request/i.test(out)) await Bun.sleep(250);
  await Bun.sleep(1000);
  child.kill('SIGKILL');
  return out;
}

/** Run codex exec to completion against a local stub model that answers every turn at once; returns each request body. */
async function codexAgainstStub(prompt: string): Promise<string[]> {
  const bodies: string[] = [];
  const sse = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      bodies.push(await req.text());
      const item = { type: 'message', id: 'msg_stub', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'stub', annotations: [] }] };
      const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };
      return new Response(sse({ type: 'response.created', response: { id: 'resp_stub' } })
        + sse({ type: 'response.output_item.done', output_index: 0, item })
        + sse({ type: 'response.completed', response: { id: 'resp_stub', usage } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  try {
    const work = path.join(dir, 'work');
    fs.mkdirSync(work, { recursive: true });
    const child = spawn('codex', ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-c', 'model_provider=gstack_stub',
      '-c', `model_providers.gstack_stub={name="stub",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses"}`, prompt], {
      cwd: work, stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '', HOME: dir, CODEX_HOME: home(), OPENAI_API_KEY: 'sk-not-a-real-key', SHELL: '/bin/bash',
        GSTACK_STATE_ROOT: path.join(dir, 'state'), GSTACK_INSTALLED_SKILLS_DIR: path.join(home(), 'skills'),
      },
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    await new Promise(resolve => child.on('exit', resolve));
    clearTimeout(killer);
  } finally {
    server.stop(true);
  }
  return bodies;
}

/** Codex's own view of its hooks: app-server's hooks/list gives each handler's trust key, current hash and status. */
async function listHooks(): Promise<{ hooks: { key: string; command?: string; currentHash: string; trustStatus: string }[]; warnings: string[]; errors: unknown[] }> {
  const child = spawn('codex', ['app-server'], {
    cwd: dir, stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH ?? '', HOME: dir, CODEX_HOME: home(), OPENAI_API_KEY: 'sk-not-a-real-key' },
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  for (const msg of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'gstack-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'initialized' },
    { jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [dir] } },
  ]) child.stdin.write(JSON.stringify(msg) + '\n');
  const deadline = Date.now() + 30_000;
  let reply: any;
  while (Date.now() < deadline && !reply) {
    reply = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(m => m?.id === 2);
    if (!reply) await Bun.sleep(100);
  }
  child.kill('SIGKILL');
  if (!reply?.result) throw new Error('codex app-server gave no hooks/list reply: ' + out.slice(-500));
  return reply.result.data[0];
}

describe.skipIf(!usable && !required)('real codex reads the hooks.json gstack writes', () => {
  test('codex 0.170 or newer is on PATH', () => {
    expect(version?.[0] ?? 'no codex on PATH').toMatch(/^codex-cli /);
    expect(usable).toBe(true);
  });

  test("Codex runs the user's hook and gstack's routing hook from the merged file", async () => {
    install();
    const out = await codexExec(['--dangerously-bypass-hook-trust']);
    expect(fs.existsSync(marker())).toBe(true);
    expect(fs.readFileSync(routeLog(), 'utf8')).toMatch(/event=routed skill=review .*host=codex/);
    expect(out).not.toContain('failed to parse hooks config');
  }, 90_000);

  test("the routing hint names the skill the way Codex lists it, and that $mention loads the skill's body", async () => {
    install();
    const skill = path.join(home(), 'skills', 'gstack-review');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review a diff before it lands.\n---\nREAL_CODEX_SKILL_BODY\n');
    const [routed] = await codexAgainstStub('please review my changes');
    const hinted = /this request fits the ([A-Za-z0-9_:-]+) skill/.exec(routed ?? '')?.[1];
    expect(hinted).toBe('review');
    expect(routed).toContain(`- ${hinted}: Review a diff before it lands. (file: `);
    expect((await codexAgainstStub(`$${hinted} look at this`)).join('\n')).toContain('REAL_CODEX_SKILL_BODY');
    expect((await codexAgainstStub('$gstack-review look at this')).join('\n')).not.toContain('REAL_CODEX_SKILL_BODY');
  }, 200_000);

test("removing gstack's group before yours leaves an empty group, and Codex still trusts your hook at the same key", async () => {
    fs.mkdirSync(home(), { recursive: true });
    const file = path.join(home(), 'hooks.json');
    const gstackGuard = path.join(home(), 'skills', 'gstack', 'hosts', 'codex', 'hooks', 'codex-destructive-guard-hook');
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard', timeout: 3 }] };
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: gstackGuard, timeout: 10 }] }, mine] } }, null, 2));
    const before = (await listHooks()).hooks.find(h => h.command === '/usr/local/bin/my-guard')!;
    expect(before.key).toBe(fs.realpathSync(file) + ':pre_tool_use:1:0');
    fs.writeFileSync(path.join(home(), 'config.toml'), '[hooks.state."' + before.key + '"]\ntrusted_hash = "' + before.currentHash + '"\n');
    expect((await listHooks()).hooks.find(h => h.key === before.key)?.trustStatus).toBe('trusted');
    const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-settings-hook'), 'prune-stale', '--all'], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_HOOKS_FORMAT: 'codex', CODEX_HOME: home() }, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual([{ hooks: [] }, mine]);
    const after = await listHooks();
    expect(after.warnings).toEqual([]);
    expect(after.errors).toEqual([]);
    expect(after.hooks.map(h => [h.key, h.trustStatus])).toEqual([[before.key, 'trusted']]);
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [mine] } }, null, 2));
    expect((await listHooks()).hooks.map(h => [h.key.split(':').slice(-2).join(':'), h.trustStatus])).toEqual([['0:0', 'untrusted']]);
  }, 120_000);

  test('a hook path with ( in it runs under Codex instead of exiting 2, which Codex reads as a block on every prompt', async () => {
    install();
    const odd = path.join(dir, 'hooks(2)');
    fs.symlinkSync(path.join(ROOT, 'hosts', 'codex', 'hooks'), odd);
    const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-settings-hook'), 'ensure-event', '--event', 'UserPromptSubmit', '--command', path.join(odd, 'codex-skill-route-hook'), '--source', 'gstack-skill-route', '--timeout', '5'], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, GSTACK_HOOKS_FORMAT: 'codex', CODEX_HOME: home() }, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const out = await codexExec(['--dangerously-bypass-hook-trust']);
    expect(fs.existsSync(marker())).toBe(true);
    expect(fs.readFileSync(routeLog(), 'utf8')).toMatch(/event=routed skill=review .*host=codex/);
    expect(out).not.toMatch(/blocked|exit code 2|syntax error/i);
  }, 90_000);

  test('negative controls: an unknown key makes Codex skip the whole file, and untrusted hooks never run', async () => {
    install();
    const file = path.join(home(), 'hooks.json');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.replace('"hooks": {', '"_gstack_source": "x",\n  "hooks": {'));
    await codexExec(['--dangerously-bypass-hook-trust']);
    expect(fs.existsSync(marker())).toBe(false);
    expect(fs.existsSync(routeLog())).toBe(false);
    fs.writeFileSync(file, good);
    await codexExec([]);
    expect(fs.existsSync(marker())).toBe(false);
    expect(fs.existsSync(routeLog())).toBe(false);
  }, 120_000);
});
