/**
 * B4 (#1076, #1254) and F3: the rendered DESIGN SETUP and taste-profile fences,
 * executed with stub binaries.
 *
 * B4: an executable design binary that dies at launch (SIGKILL from an invalid
 * macOS code signature) used to print DESIGN_READY. Now the binary must start
 * within 10 seconds; a success is cached by inode + mtime.
 * F3: the taste-profile probe double-quoted `~/.claude/...`, so it never found
 * gstack-slug and always printed NO_TASTE_PROFILE; a failed slug lookup is now
 * reported as TASTE_PROFILE_UNAVAILABLE instead of "no profile".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGeneration } from '../scripts/gen-skill-docs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-design-probe-'));
const out = path.join(tmp, 'render');
const HOSTS = [{ name: 'claude', dir: (s: string) => path.join(out, s), root: '.claude/skills/gstack' },
  { name: 'codex', dir: (s: string) => path.join(out, '.agents', 'skills', `gstack-${s}`), root: '.codex/skills/gstack' }];

function fenceAfter(file: string, heading: string): string {
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(text.indexOf(heading)).match(/```bash\n([\s\S]*?)\n```/)![1];
}

/** A HOME with a gstack install whose design binary runs `body`. */
function world(root: string, body: string | null) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const install = path.join(home, root);
  const state = path.join(home, 'state');
  for (const dir of ['bin', 'lib', 'design/dist']) fs.mkdirSync(path.join(install, dir), { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(install, 'bin', 'gstack-paths'), `#!/bin/sh\necho "${state}"\n`, { mode: 0o755 });
  if (body !== null) fs.writeFileSync(path.join(install, 'design/dist/design'), `#!/bin/sh\necho launched >> "${home}/launches"\n${body}\n`, { mode: 0o755 });
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  return { home, install, state, cwd, launches: () => (fs.existsSync(path.join(home, 'launches')) ? fs.readFileSync(path.join(home, 'launches'), 'utf8').split('\n').filter(Boolean).length : 0) };
}

function run(script: string, w: { home: string; cwd: string }, PATH = '/usr/bin:/bin') {
  return spawnSync('env', ['-i', `HOME=${w.home}`, `PATH=${PATH}`, 'bash', '-c', script], { cwd: w.cwd, encoding: 'utf8', timeout: 30_000 });
}

beforeAll(async () => {
  const r = await runGeneration({ host: 'all', outputRoot: out });
  if (r.exitCode !== 0) throw new Error(r.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('B4: DESIGN_READY requires a binary that starts', () => {
  for (const host of HOSTS) {
    const setup = () => fenceAfter(path.join(host.dir('design-review'), 'SKILL.md'), '## DESIGN SETUP');

    test(`${host.name}: a binary that launches is ready, and the success is cached by inode and mtime`, () => {
      const w = world(host.root, 'exit 0');
      const first = run(setup(), w);
      expect(first.stdout.trim(), first.stderr).toBe(`DESIGN_READY: ${w.install}/design/dist/design`);
      expect(run(setup(), w).stdout.trim()).toStartWith('DESIGN_READY: ');
      expect(w.launches()).toBe(1);
      fs.writeFileSync(path.join(w.install, 'design/dist/design'), `#!/bin/sh\necho launched >> "${w.home}/launches"\nexit 3\n`);
      fs.utimesSync(path.join(w.install, 'design/dist/design'), new Date(), new Date(Date.now() + 5_000));
      expect(run(setup(), w).stdout.trim()).toBe(`DESIGN_NOT_AVAILABLE: ${w.install}/design/dist/design --version exited 3`);
    });

    test(`${host.name}: a binary killed at launch is not ready and names the fix`, () => {
      const w = world(host.root, 'kill -9 $$');
      const r = run(setup(), w);
      expect(r.stdout.trim()).toBe(`DESIGN_NOT_AVAILABLE: ${w.install}/design/dist/design --version exited 137 (killed at launch; on macOS usually an invalid code signature). Fix: cd ${w.install} && ./setup`);
      expect(fs.existsSync(path.join(w.state, 'design-ready'))).toBe(false);
    });

    test(`${host.name}: a missing binary says how to install it`, () => {
      const w = world(host.root, null);
      expect(run(setup(), w).stdout.trim()).toBe(`DESIGN_NOT_AVAILABLE: ${w.install}/design/dist/design is not installed. Fix: cd ${w.install} && ./setup`);
    });
  }

  test('claude: without timeout, gtimeout or perl the launch is not attempted unbounded', () => {
    const w = world(HOSTS[0].root, 'exit 0');
    const bin = path.join(w.home, 'minbin');
    fs.mkdirSync(bin);
    for (const tool of ['ls', 'awk', 'stat', 'cat', 'git', 'bash', 'sh', 'env']) {
      const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', timeout: 5_000 }).stdout.trim();
      if (found) fs.symlinkSync(found, path.join(bin, tool));
    }
    const r = run(fenceAfter(path.join(HOSTS[0].dir('design-review'), 'SKILL.md'), '## DESIGN SETUP'), w, bin);
    expect(r.stdout.trim()).toBe(`DESIGN_NOT_AVAILABLE: no timeout/gtimeout/perl to bound ${w.install}/design/dist/design`);
    expect(w.launches()).toBe(0);
  });

  test('claude: a binary that hangs times out after 10 seconds', async () => {
    const w = world(HOSTS[0].root, 'sleep 60');
    const script = fenceAfter(path.join(HOSTS[0].dir('design-review'), 'SKILL.md'), '## DESIGN SETUP');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('env', ['-i', `HOME=${w.home}`, 'PATH=/usr/bin:/bin', 'bash', '-c', script], { cwd: w.cwd, timeout: 30_000 });
      let text = '';
      child.stdout.on('data', d => { text += d; });
      child.on('error', reject);
      child.on('close', () => resolve(text));
    });
    expect(stdout.trim()).toBe(`DESIGN_NOT_AVAILABLE: ${w.install}/design/dist/design --version timed out after 10s`);
  }, 30_000);

  test('office-hours visual exploration uses the same probe', () => {
    const w = world(HOSTS[0].root, 'kill -9 $$');
    const r = run(fenceAfter(path.join(HOSTS[0].dir('office-hours'), 'SKILL.md'), '## Visual Design Exploration'), w);
    expect(r.stdout.trim()).toStartWith('DESIGN_NOT_AVAILABLE: ');
    expect(r.stdout).toContain('exited 137 (killed at launch');
  });
});

describe('F3: the taste profile loads, and a failed slug lookup is not "no profile"', () => {
  for (const skill of ['design-shotgun', 'design-consultation']) {
    for (const host of HOSTS) {
      test(`${host.name} ${skill}`, () => {
        const w = world(host.root, 'exit 0');
        const fence = fenceAfter(path.join(host.dir(skill), 'SKILL.md'), "Read this project's taste profile:");
        fs.mkdirSync(path.join(w.state, 'projects', 'acme'), { recursive: true });
        fs.writeFileSync(path.join(w.state, 'projects', 'acme', 'taste-profile.json'), '{"dimensions":{}}');
        fs.writeFileSync(path.join(w.install, 'bin', 'gstack-slug'), '#!/bin/sh\necho acme\n', { mode: 0o755 });
        const found = run(fence, w);
        expect(found.stdout, found.stderr).toContain('TASTE_PROFILE_FOUND');
        expect(found.stdout).toContain('{"dimensions":{}}');

        fs.writeFileSync(path.join(w.install, 'bin', 'gstack-slug'), '#!/bin/sh\necho "gstack-slug: cannot read state" >&2\nexit 1\n');
        const failed = run(fence, w);
        expect(failed.stdout.trim()).toBe('TASTE_PROFILE_UNAVAILABLE: could not resolve the project slug (gstack-slug failed). Fix: run ./setup.');
        expect(failed.stderr).toContain('gstack-slug: cannot read state');
      });
    }
  }
});
