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

/** The user's own SessionStart hook, then gstack's two groups through gstack-settings-hook's Codex format. */
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

describe.skipIf(!usable && !required)('real codex reads the hooks.json gstack writes', () => {
  test('codex 0.170 or newer is on PATH', () => {
    expect(version?.[0] ?? 'no codex on PATH').toMatch(/^codex-cli /);
    expect(usable).toBe(true);
  });

  test("Codex runs the user's hook and gstack's routing hook from the merged file", async () => {
    install();
    const out = await codexExec(['--dangerously-bypass-hook-trust']);
    expect(fs.existsSync(marker())).toBe(true);
    expect(fs.readFileSync(routeLog(), 'utf8')).toMatch(/event=routed skill=gstack-review .*host=codex/);
    expect(out).not.toContain('failed to parse hooks config');
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
