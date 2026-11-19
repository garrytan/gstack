/**
 * Load-time injection (GST-3157): Claude Code runs a skill's `!\`cmd\`` lines
 * when the skill loads, and an injected command that exits non-zero or is not
 * allowed aborts the whole load. bin/gstack-skill-load must therefore always
 * exit 0 with one line on failure, and every Claude render that injects it
 * must grant it in allowed-tools (a bare Bash grant does not cover plan mode).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generatePreamble } from '../scripts/resolvers/preamble';
import { generateSkillPreamble } from '../scripts/resolvers/preamble-hoist';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const LOADER = path.join(ROOT, 'bin', 'gstack-skill-load');
const INJECTED = /(?:^|\s)!`/;

function fakeBin(start: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-load-'));
  fs.copyFileSync(LOADER, path.join(dir, 'gstack-skill-load'));
  fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-harness-pid.sh'), path.join(dir, 'gstack-harness-pid.sh'));
  fs.chmodSync(path.join(dir, 'gstack-skill-load'), 0o755);
  if (start !== null) {
    fs.writeFileSync(path.join(dir, 'gstack-skill-start'), `#!/usr/bin/env bash\n${start}\n`);
    fs.chmodSync(path.join(dir, 'gstack-skill-start'), 0o755);
  }
  return dir;
}

function load(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(dir, 'gstack-skill-load'), ...args], { encoding: 'utf-8', timeout: 20_000, env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(process.platform === 'win32')('bin/gstack-skill-load', () => {
  test('start passes the start output through, with the harness pid', () => {
    const dir = fakeBin('echo "SKILL_START_PROTO: 1"; echo "ARGS: $*"');
    try {
      const r = load(dir, ['start', '--skill', 'autoplan', '--model', 'claude']);
      expect(r.status).toBe(0);
      expect(r.stdout).toStartWith('SKILL_START_PROTO: 1\n');
      expect(r.stdout).toMatch(/^ARGS: --skill autoplan --model claude --parent-pid [0-9]+$/m);
      expect(r.stderr).toBe('');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  for (const [label, start, line] of [
    ['a failing start', 'echo partial; echo oops >&2; exit 4', 'SKILL_START: failed at load (exit 4); run the start command below yourself with Bash, then continue.'],
    ['a missing start', null, 'SKILL_START: failed at load (exit 127); run the start command below yourself with Bash, then continue.'],
  ] as const) {
    test(`${label} becomes one line and exit 0`, () => {
      const dir = fakeBin(start);
      try {
        const r = load(dir, ['start', '--skill', 'x']);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(`${line}\n`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('a hung start is stopped at the timeout with everything it started', () => {
    const marker = `gstack-skill-load-test-${process.pid}`;
    const dir = fakeBin(`sleep 47 & bash -c 'exec -a ${marker} sleep 48'; echo never`);
    try {
      const t0 = Date.now();
      const r = load(dir, ['start', '--skill', 'x'], { GSTACK_SKILL_LOAD_TIMEOUT: '1' });
      expect(Date.now() - t0).toBeLessThan(8_000);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('SKILL_START: timed out after 1s at load; run the start command below yourself with Bash, then continue.\n');
      const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf-8', timeout: 5_000 });
      expect(ps.stdout).not.toContain(marker);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('preamble prints the file, and one line when it is missing', () => {
    const dir = fakeBin(null);
    try {
      const file = path.join(dir, 'preamble.md');
      fs.writeFileSync(file, '# gstack shared preamble abc\n\nbody\n');
      expect(load(dir, ['preamble', file])).toEqual({ status: 0, stdout: '# gstack shared preamble abc\n\nbody\n', stderr: '' });
      const missing = load(dir, ['preamble', path.join(dir, 'nope.md')]);
      expect(missing.status).toBe(0);
      expect(missing.stdout.trim().split('\n')).toHaveLength(1);
      expect(missing.stdout).toStartWith('SHARED_PREAMBLE: not loaded (');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('load-time injection in renders', () => {
  const claudeSkills = ['.', ...fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)]
    .filter(dir => fs.existsSync(path.join(ROOT, dir, 'SKILL.md')) && fs.existsSync(path.join(ROOT, dir, 'SKILL.md.tmpl'))
      && fs.readFileSync(path.join(ROOT, dir, 'SKILL.md.tmpl'), 'utf-8').includes('{{PREAMBLE}}'));

  test('every Claude skill with a preamble injects the start (or its preamble, when gated) and grants the helper', () => {
    expect(claudeSkills.length).toBeGreaterThan(40);
    for (const skill of claudeSkills) {
      const text = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      const fm = text.slice(0, text.indexOf('\n---', 3));
      expect(fm, skill).toContain('\n  - Bash(~/.claude/skills/gstack/bin/gstack-skill-load:*)');
      const injected = text.split('\n').filter(l => INJECTED.test(l));
      expect(injected.length, skill).toBeGreaterThan(0);
      for (const l of injected) expect(l, skill).toMatch(/^!`~\/\.claude\/skills\/gstack\/bin\/gstack-skill-load (?:start --skill "[a-z0-9-]+" --model "[a-z0-9.-]+"|preamble ~\/\.claude\/skills\/gstack\/[a-z0-9-]+\/sections\/preamble\.md)`$/);
      const gated = skill === 'plan-design-review' || skill === 'plan-eng-review';
      expect(injected.some(l => l.includes(' start ')), skill).toBe(!gated);
    }
  });

  test('/autoplan loads its start and shared preamble; the plain start command stays as the fallback', () => {
    const text = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf-8');
    expect(text).toContain('!`~/.claude/skills/gstack/bin/gstack-skill-load preamble ~/.claude/skills/gstack/autoplan/sections/preamble.md`');
    expect(text).toContain('!`~/.claude/skills/gstack/bin/gstack-skill-load start --skill "autoplan" --model "claude"`');
    expect(text).toContain('```bash\n~/.claude/skills/gstack/bin/gstack-skill-start --skill "autoplan" --model "claude"\n```');
  });

  test('other hosts keep the instruction text and inject nothing', () => {
    for (const host of ['codex', 'factory', 'gbrain']) {
      for (const tier of [1, 3]) {
        const ctx = { skillName: 'autoplan', tmplPath: 'autoplan/SKILL.md.tmpl', host, paths: HOST_PATHS[host], preambleTier: tier } as TemplateContext;
        const text = tier === 1 ? generatePreamble(ctx) : generateSkillPreamble(ctx);
        expect(text.split('\n').filter(l => INJECTED.test(l)), `${host} tier ${tier}`).toEqual([]);
        expect(text).not.toContain('gstack-skill-load');
        expect(text).toContain('direct tool result of the\n`gstack-skill-start` command you just executed');
      }
    }
  });
});
