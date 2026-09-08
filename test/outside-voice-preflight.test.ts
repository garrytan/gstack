/** Execute each outside-review fence with no state from a previous shell. */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { outsideVoiceCommand, outsideVoicePreflight } from '../scripts/resolvers/outside-voice';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-outside-preflight-'));
afterAll(() => fs.rmSync(TEMP, { recursive: true, force: true }));

function fixture() {
  const dir = fs.mkdtempSync(path.join(TEMP, 'case-'));
  const repo = path.join(dir, "repo ' $(touch NEVER)");
  const home = path.join(dir, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr);
  const capture = path.join(dir, 'capture.json');
  const fake = path.join(dir, 'fake-claude.ts');
  fs.writeFileSync(fake, `const prompt=await Bun.stdin.text(); await Bun.write(process.env.FIXTURE_CAPTURE!,JSON.stringify({prompt,args:process.argv.slice(2)})); console.log(JSON.stringify({result:'Recommendation: ship because the isolated fixture completed its review.'}));`);
  const env = { ...process.env, HOME: home, CODEX_HOME: '', GSTACK_HOME: path.join(home, '.gstack'),
    GSTACK_ROOT: '', GSTACK_BIN: '', GSTACK_ACTIVE_HOST: 'codex', CODEX_THREAD_ID: 'fixture', CODEX_SANDBOX: '', CLAUDECODE: '',
    GSTACK_CLAUDE_BIN: process.execPath, GSTACK_CLAUDE_BIN_ARGS: JSON.stringify([fake]), FIXTURE_CAPTURE: capture };
  const install = (destination: string) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(ROOT, destination, 'dir');
    return destination;
  };
  const local = path.join(repo, '.agents/skills/gstack');
  const global = path.join(home, '.codex/skills/gstack');
  const ctx: TemplateContext = { host: 'codex', model: 'gpt', skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', paths: HOST_PATHS.codex };
  const run = (command: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['-c', command], {
    cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000,
  });
  const preflight = (overrides: NodeJS.ProcessEnv = {}) => {
    const rendered = outsideVoicePreflight(ctx, { disabledBehavior: 'opt-in' });
    const command = rendered.match(/```bash\n([\s\S]*?)\n```/)![1];
    return run(`${command}\nprintf 'RESOLVED_ROOT: %s\\n' "$GSTACK_ROOT"`, overrides);
  };
  return { repo, home, env, local, global, ctx, capture, install, run, preflight };
}

describe('outside reviewer runtime discovery in fresh shells', () => {
  test('a repo-local installation resolves before any preamble exports exist', () => {
    const f = fixture();
    f.install(f.local);
    f.install(f.global);
    const result = f.preflight();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${f.local}`);
    expect(result.stderr).toBe('');
    // The availability probe resolves a CLI; it must not dispatch a review.
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('global installation and CODEX_HOME both work without a local installation', () => {
    const f = fixture();
    f.install(f.global);
    expect(f.preflight().stdout).toContain(`RESOLVED_ROOT: ${f.global}`);
    const codexHome = path.join(f.home, 'custom codex');
    const custom = f.install(path.join(codexHome, 'skills/gstack'));
    const result = f.preflight({ CODEX_HOME: codexHome });
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${custom}`);
  });

  test('valid explicit runtime roots take priority and stale roots fall back locally', () => {
    const f = fixture();
    f.install(f.local);
    const explicit = f.install(path.join(f.home, 'explicit runtime'));
    expect(f.preflight({ GSTACK_ROOT: explicit }).stdout).toContain(`RESOLVED_ROOT: ${explicit}`);
    expect(f.preflight({ GSTACK_BIN: path.join(explicit, 'bin') }).stdout).toContain(`RESOLVED_ROOT: ${explicit}`);
    const result = f.preflight({ GSTACK_ROOT: '/missing/gstack', GSTACK_BIN: '/missing/gstack/bin' });
    expect(result.stdout).toContain('CODEX_MODE: ready');
    expect(result.stdout).toContain(`RESOLVED_ROOT: ${f.local}`);
  });

  test('missing CLI reports not_installed rather than an import-path failure', () => {
    const f = fixture();
    f.install(f.local);
    const result = f.preflight({ GSTACK_CLAUDE_BIN: 'missing-gstack-claude-fixture-command' });
    expect(result.stdout).toContain('CODEX_MODE: not_installed');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('master switch is read from the discovered runtime before outside dispatch', () => {
    const f = fixture();
    f.install(f.local);
    const config = spawnSync(path.join(ROOT, 'bin/gstack-config'), ['set', 'codex_reviews', 'disabled'], {
      cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 5000,
    });
    expect(config.status).toBe(0);
    const command = outsideVoicePreflight(f.ctx, { disabledBehavior: 'codex-only' }).match(/```bash\n([\s\S]*?)\n```/)![1];
    const result = f.run(command);
    expect(result.stdout).toContain('CODEX_MODE: disabled');
    expect(fs.existsSync(f.capture)).toBe(false);
  });

  test('invocation independently discovers runtime and sends the literal prompt', () => {
    const f = fixture();
    f.install(f.local);
    const prompt = path.join(f.repo, "prompt ' literal.txt");
    fs.writeFileSync(prompt, 'Review literal $(touch NEVER) and `touch NEVER` text.');
    const command = outsideVoiceCommand(f.ctx, { promptFile: prompt, timeoutMs: 3000 });
    const result = f.run(command);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OUTSIDE_STATUS: completed provider=claude-code host=codex');
    expect(JSON.parse(fs.readFileSync(f.capture, 'utf8')).prompt).toBe(fs.readFileSync(prompt, 'utf8'));
    expect(fs.existsSync(path.join(f.repo, 'NEVER'))).toBe(false);
  });
});
