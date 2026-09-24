import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSnapshot, prepareMethodology } from '../bin/gstack-autoplan-snapshot';

const ROOT = resolve(import.meta.dir, '..');
const owned: string[] = [];
const phases = ['ceo', 'design', 'dx', 'eng'];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(phase: string, layout: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-method-names-'));
  owned.push(dir);
  const skill = `plan-${phase === 'dx' ? 'devex' : phase}-review`;
  if (layout === 'inlineCodex') {
    const home = join(dir, 'home');
    mkdirSync(home);
    const generated = spawnSync(process.execPath, ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', dir], {
      cwd: ROOT, env: { PATH: process.env.PATH, HOME: home, GSTACK_HOME: join(home, '.gstack') }, encoding: 'utf8', timeout: 30_000,
    });
    expect(generated.status, generated.stderr).toBe(0);
  }
  const source = layout === 'inlineCodex' ? join(dir, '.agents/skills', `gstack-${skill}`) : join(ROOT, skill);
  const target = join(dir, skill);
  mkdirSync(target);
  cpSync(join(source, 'SKILL.md'), join(target, 'SKILL.md'));
  if (layout !== 'inlineCodex') cpSync(join(source, 'sections'), join(target, 'sections'), { recursive: true });
  if (layout === 'patchedClaude') {
    const result = spawnSync('bash', [join(ROOT, 'bin/gstack-patch-names'), dir, 'true'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain(`name: gstack-${skill}\n`);
  }
  const active = join(dir, 'plan.md');
  const restore = join(dir, 'restore.md');
  writeFileSync(active, '## Implementation plan\nBuild the widget.\n## Review record\n');
  writeFileSync(restore, 'Restore point.\n');
  return { dir, file: join(target, 'SKILL.md'), active, restore, skill };
}

describe('installed methodology identities', () => {
  for (const phase of phases) for (const layout of ['flatClaude', 'patchedClaude', 'inlineCodex']) {
    test(`${phase}: ${layout} prepares and consumes exact installed bytes`, () => {
      const f = fixture(phase, layout);
      const bundle = prepareMethodology(phase, f.file, f.restore);
      expect(bundle.sources).toHaveLength(layout === 'inlineCodex' ? 1 : 2);
      const bytes = readFileSync(bundle.methodologyPath);
      for (const source of bundle.sources) expect(bytes.subarray(source.startByte, source.endByte)).toEqual(readFileSync(source.path));
      expect(readFileSync(createSnapshot(phase, f.active, f.restore, bundle.methodologyPath).snapshotPath, 'utf8')).toBe('Build the widget.\n');
    });
  }

  for (const phase of phases) {
    test(`${phase}: wrong-phase and near-match aliases remain invalid`, () => {
      const f = fixture(phase, 'flatClaude');
      const source = readFileSync(f.file, 'utf8');
      const other = phase === 'ceo' ? 'eng' : 'ceo';
      for (const name of [`plan-${other}-review`, `gstack-plan-${other}-review`, `x-${f.skill}`, `gstack-${f.skill}-extra`, `gstack-gstack-${f.skill}`]) {
        writeFileSync(f.file, source.replace(`name: ${f.skill}\n`, `name: ${name}\n`));
        expect(() => prepareMethodology(phase, f.file, f.restore)).toThrow('identity does not match');
      }
    });

    test(`${phase}: duplicate methodology identities remain invalid`, () => {
      const f = fixture(phase, 'flatClaude');
      const source = readFileSync(f.file, 'utf8');
      const other = phase === 'ceo' ? 'eng' : 'ceo';
      for (const names of [
        `name: ${f.skill}\nname: plan-${other}-review\n`,
        `name: gstack-${f.skill}\nname: gstack-plan-${other}-review\n`,
        `name: plan-${other}-review\nname: ${f.skill}\n`,
        `name: ${f.skill}\nname: gstack-${f.skill}\n`,
      ]) {
        writeFileSync(f.file, source.replace(`name: ${f.skill}\n`, names));
        expect(() => prepareMethodology(phase, f.file, f.restore)).toThrow('identity does not match');
      }
    });

    test(`${phase}: invalid UTF-8 and changed installed source stay rejected`, () => {
      const f = fixture(phase, 'flatClaude');
      const source = readFileSync(f.file);
      writeFileSync(f.file, Buffer.concat([source, Buffer.from([0xff])]));
      expect(() => prepareMethodology(phase, f.file, f.restore)).toThrow('valid UTF-8');
      writeFileSync(f.file, source);
      const bundle = prepareMethodology(phase, f.file, f.restore);
      writeFileSync(f.file, Buffer.concat([source, Buffer.from('\nChanged source.\n')]));
      expect(() => createSnapshot(phase, f.active, f.restore, bundle.methodologyPath)).toThrow('source or artifact changed');
      writeFileSync(f.file, source);
      chmodSync(bundle.methodologyPath, 0o644);
      writeFileSync(bundle.methodologyPath, 'Tampered bundle.\n');
      chmodSync(bundle.methodologyPath, 0o444);
      expect(() => createSnapshot(phase, f.active, f.restore, bundle.methodologyPath)).toThrow('source or artifact changed');
    });
  }
});
