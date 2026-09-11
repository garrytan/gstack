import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const roots: string[] = [];
function renderedUnion(skill: string): string {
  const root = path.join(ROOT, skill);
  const files = [path.join(root, 'SKILL.md')];
  const sections = path.join(root, 'sections');
  if (fs.existsSync(sections)) {
    files.push(...fs.readdirSync(sections)
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join(sections, name)));
  }
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}
function codexPreflight(relative: string): string {
  const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const marker = '# Codex preflight: one block';
  const markerAt = content.indexOf(marker);
  expect(markerAt).toBeGreaterThan(-1);
  const fenceAt = content.lastIndexOf('```bash\n', markerAt);
  const fenceEnd = content.indexOf('\n```', markerAt);
  expect(fenceAt).toBeGreaterThan(-1);
  expect(fenceEnd).toBeGreaterThan(markerAt);
  return content.slice(fenceAt + '```bash\n'.length, fenceEnd);
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('governed default effects', () => {
  test('paid validator adapter spawns nothing without a trusted profile and exact lane grant', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-paid-spy-')); roots.push(home);
    const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
    const marker = path.join(home, 'codex-spawned');
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/bin/sh\nprintf spawned > "$ECPE_SPAWN_MARKER"\nprintf "validator complete\\n"\n', { mode: 0o700 });
    const argv = [process.execPath, path.join(ROOT, 'bin/gstack-effect-scope'), 'ensure-paid-validator',
      '--skill', 'review', '--validator-id', 'codex.adversarial.v1', '--json'];
    const baseEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ECPE_SPAWN_MARKER: marker };

    const denied = Bun.spawnSync(argv, { timeout: 30_000, cwd: home, env: baseEnv, stdout: 'pipe', stderr: 'pipe' });
    expect(denied.exitCode).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);

    const envOnly = Bun.spawnSync(argv, { timeout: 30_000,
      cwd: home,
      env: { ...baseEnv, ECPE_PAID_MODEL_AUTHORIZED: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(envOnly.exitCode).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('generated default review and ship keep paid passes disabled until granted', () => {
    for (const relative of ['review/sections/adversarial.md', 'ship/sections/adversarial.md']) {
      const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      expect(content).toContain('codex_reviews 2>/dev/null || echo disabled');
      expect(content).toContain('gstack-effect-scope ensure-paid-validator');
      expect(content).toContain('ECPE_PAID_MODEL_AUTHORIZED');
      expect(content).toContain('--lane "PLAN_LANE"');
      expect(content).toContain('Replace `PLAN_LANE` with the exact `lane` returned by the initial fused');
    }
  });

  test('explicitly enabled review and ship preflight spawn no paid probe without a grant', () => {
    for (const relative of ['review/sections/adversarial.md', 'ship/sections/adversarial.md']) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-preflight-spy-')); roots.push(home);
      const gstackRoot = path.join(home, '.claude/skills/gstack');
      const gstackBin = path.join(gstackRoot, 'bin');
      const fakeBin = path.join(home, 'bin');
      const marker = path.join(home, 'codex-spawned');
      fs.mkdirSync(gstackBin, { recursive: true });
      fs.mkdirSync(fakeBin);
      fs.mkdirSync(path.join(home, '.codex'));
      fs.mkdirSync(path.join(home, '.gstack'));
      fs.copyFileSync(path.join(ROOT, 'bin/gstack-config'), path.join(gstackBin, 'gstack-config'));
      fs.copyFileSync(path.join(ROOT, 'bin/gstack-codex-probe'), path.join(gstackBin, 'gstack-codex-probe'));
      fs.chmodSync(path.join(gstackBin, 'gstack-config'), 0o700);
      fs.chmodSync(path.join(gstackBin, 'gstack-codex-probe'), 0o700);
      fs.writeFileSync(path.join(home, '.codex/auth.json'), '{}');
      fs.writeFileSync(path.join(home, '.gstack/config.yaml'), 'codex_reviews: enabled\ntelemetry: off\n');
      fs.writeFileSync(
        path.join(fakeBin, 'codex'),
        '#!/bin/sh\nprintf spawned > "$ECPE_SPAWN_MARKER"\nprintf "OK\\n"\n',
        { mode: 0o700 },
      );

      const result = Bun.spawnSync(['bash', '-c', codexPreflight(relative)], { timeout: 30_000,
        cwd: home,
        env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`, ECPE_SPAWN_MARKER: marker },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('CODEX_MODE: grant_required');
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(path.join(home, '.gstack/.codex-model-probe'))).toBe(false);
    }
  });

  test('default workflows contain no hidden telemetry, hook, marker, or deploy-report writes', () => {
    const ship = [
      fs.readFileSync(path.join(ROOT, 'ship/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'ship/sections/pr-body.md'), 'utf8'),
    ].join('\n');
    const land = fs.readFileSync(path.join(ROOT, 'land-and-deploy/SKILL.md'), 'utf8');
    for (const forbidden of ['gstack-decision-log', 'install-prepush-hook', 'redact_prepush_hook', '.plan-tune-nudge-shown']) {
      expect(ship).not.toContain(forbidden);
    }
    for (const forbidden of ['.gstack/deploy-reports/post-deploy.png', 'mkdir -p .gstack/deploy-reports', 'Save report to `.gstack/deploy-reports/', 'Write a JSONL entry with timing data']) {
      expect(land).not.toContain(forbidden);
    }
  });

  test('ship and rollback mutations are routed through closed effect adapters', () => {
    const ship = renderedUnion('ship');
    const land = renderedUnion('land-and-deploy');
    expect(ship).toContain('gstack-effect-scope git-stage-commit');
    expect(ship).toContain('gstack-effect-scope git-push');
    expect(ship).toContain('gstack-effect-scope provider-pr');
    expect(ship).not.toMatch(/\bgit (?:add|commit|push|revert)\b/);
    expect(ship).not.toMatch(/\b(?:gh (?:pr (?:create|edit)|issue create)|glab (?:mr (?:create|edit)|issue create))\b/);
    expect(land).toContain('gstack-effect-scope rollback');
    expect(land).not.toMatch(/\bgit (?:add|commit|push|revert)\b/);
    expect(land).not.toMatch(/\b(?:gh (?:pr (?:create|edit)|issue create)|glab (?:mr (?:create|edit)|issue create))\b/);
  });
});
