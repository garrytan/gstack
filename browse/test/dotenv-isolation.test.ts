/**
 * D0: a project's .env and bunfig.toml must not reach gstack's binaries or
 * the Bun children the browse daemon starts in that project. Dotenv could set
 * GSTACK_CHROMIUM_NO_SANDBOX; a bunfig preload runs arbitrary code.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnTerminalAgent } from '../src/terminal-agent-control';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const CLI = path.join(ROOT, 'browse', 'src', 'cli.ts');

let project: string;
let marker: string;

function seedHostileProject(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'GSTACK_CHROMIUM_NO_SANDBOX=1\n');
  fs.writeFileSync(path.join(dir, 'preload.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  fs.writeFileSync(path.join(dir, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
}

function probeSource(out: string): string {
  return `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ sandbox: process.env.GSTACK_CHROMIUM_NO_SANDBOX ?? null }));\n`;
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(file) && Date.now() < deadline) await Bun.sleep(50);
  return fs.readFileSync(file, 'utf-8');
}

beforeEach(() => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-dotenv-'));
  project = path.join(scratch, 'project');
  marker = path.join(scratch, 'preload-ran');
  seedHostileProject(project);
});

afterEach(() => {
  fs.rmSync(path.dirname(project), { recursive: true, force: true });
});

describe('D0: project .env and bunfig.toml are ignored', () => {
  test('every compiled binary in scripts/build.sh turns dotenv and bunfig autoload off, and the flags work', () => {
    const lines = fs.readFileSync(path.join(ROOT, 'scripts', 'build.sh'), 'utf-8').split('\n').filter(l => /build --compile/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      expect(line).toContain('--no-compile-autoload-dotenv');
      expect(line).toContain('--no-compile-autoload-bunfig');
    }
    const out = path.join(path.dirname(project), 'probe.json');
    const src = path.join(path.dirname(project), 'probe.ts');
    const bin = path.join(path.dirname(project), process.platform === 'win32' ? 'probe-bin.exe' : 'probe-bin');
    fs.writeFileSync(src, probeSource(out));
    const build = Bun.spawnSync([process.execPath, 'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', src, '--outfile', bin], { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([bin], { cwd: project, env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf-8'))).toEqual({ sandbox: null });
    expect(fs.existsSync(marker)).toBe(false);
  }, 90_000);

  // The agent's owner identity comes from `ps`, which Windows runners lack.
  test.skipIf(process.platform === 'win32')('the terminal agent spawned in the project sees neither the .env value nor the bunfig preload', async () => {
    const stateDir = path.join(path.dirname(project), 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const out = path.join(stateDir, 'agent-env.json');
    const script = path.join(stateDir, 'agent-probe.ts');
    fs.writeFileSync(script, probeSource(out));
    const saved = process.env.GSTACK_CHROMIUM_NO_SANDBOX;
    delete process.env.GSTACK_CHROMIUM_NO_SANDBOX;
    try {
      const pid = spawnTerminalAgent({ stateFile: path.join(stateDir, 'browse.json'), serverPort: 1, ownerPid: process.pid, cwd: project, scriptPath: script });
      expect(pid).toBeGreaterThan(0);
      expect(JSON.parse(await waitForFile(out))).toEqual({ sandbox: null });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (saved !== undefined) process.env.GSTACK_CHROMIUM_NO_SANDBOX = saved;
    }
  }, 30_000);

  test.skipIf(process.platform === 'win32')('the browse server spawned from the project sees neither the .env value nor the bunfig preload', async () => {
    const stateFile = path.join(project, '.gstack', 'browse.json');
    const stub = path.join(path.dirname(project), 'stub-server.ts');
    fs.writeFileSync(stub, `
      import * as fs from 'node:fs';
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ status: 'healthy' }) });
      fs.writeFileSync(process.env.BROWSE_STATE_FILE!, JSON.stringify({
        pid: process.pid, port: server.port, token: 'dotenv-test', mode: 'launched',
        sandbox: process.env.GSTACK_CHROMIUM_NO_SANDBOX ?? null,
      }));
      setTimeout(() => server.stop(true), 5000);
    `);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(BROWSE_|GSTACK_|CHROMIUM_PROFILE$|CLAUDE_PLUGIN_DATA$)/.test(key)) env[key] = value;
    }
    Object.assign(env, {
      HOME: path.dirname(project),
      GSTACK_HOME: path.join(path.dirname(project), '.gstack'),
      BROWSE_STATE_FILE: stateFile,
      BROWSE_SERVER_SCRIPT: stub,
      BROWSE_PARENT_PID: '0',
      BROWSE_START_TIMEOUT: '20000',
    });
    // The shipped CLI is compiled without dotenv autoload; --no-env-file gives
    // the source CLI the same starting environment.
    const cli = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', CLI, 'status'], { cwd: project, env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => cli.kill('SIGKILL'), 40_000);
    const [code, stderr] = await Promise.all([cli.exited, new Response(cli.stderr).text()]);
    clearTimeout(timer);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    try { process.kill(state.pid, 'SIGKILL'); } catch {}
    expect(code, stderr).toBe(0);
    expect(state.sandbox).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);
});
