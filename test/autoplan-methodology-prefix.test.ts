import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot, prepareMethodology } from '../bin/gstack-autoplan-snapshot';

// Regression coverage for garrytan/gstack#2921, reported by josimarguilbaud.
const phases = ['ceo', 'design', 'dx', 'eng'];
const skillName = (phase: string) => `plan-${phase === 'dx' ? 'devex' : phase}-review`;
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(name: string, split = false, newline = '\n') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gstack-methodology-prefix-')));
  owned.push(dir);
  const skillDir = join(dir, 'installed');
  mkdirSync(skillDir);
  const skillFile = join(skillDir, 'SKILL.md');
  const restore = join(dir, 'restore.md');
  const body = split
    ? '## Section index\n- `sections/review-sections.md`\n'
    : '## Review Sections\n### Scope\nPreserve café and 日本語.\n';
  writeFileSync(skillFile, `---\nname: ${name}\ndescription: Test fixture\n---\n${body}`.replaceAll('\n', newline));
  writeFileSync(restore, 'Original plan.\n');
  if (split) {
    mkdirSync(join(skillDir, 'sections'));
    writeFileSync(join(skillDir, 'sections/review-sections.md'),
      '## Review Sections\n### Scope\nPreserve café and 日本語.\n'.replaceAll('\n', newline));
  }
  return { dir, skillFile, restore };
}

describe('autoplan methodology accepts supported installed skill names', () => {
  for (const phase of phases) for (const prefix of ['', 'gstack-']) {
    for (const split of [false, true]) for (const newline of ['\n', '\r\n']) {
      test(`${prefix || 'bare:'}${skillName(phase)}; ${split ? 'split' : 'inline'}; ${newline === '\n' ? 'LF' : 'CRLF'}`, () => {
        const f = fixture(prefix + skillName(phase), split, newline);
        const original = readFileSync(f.skillFile);
        const restoreBefore = readFileSync(f.restore);
        const manifest = prepareMethodology(phase, f.skillFile, f.restore);
        const content = readFileSync(manifest.methodologyPath);
        expect(manifest.phase).toBe(phase);
        expect(manifest.sources.length).toBe(split ? 2 : 1);
        expect(manifest.sha256).toBe(createHash('sha256').update(content).digest('hex'));
        expect(manifest.bytes).toBe(content.length);
        for (const source of manifest.sources) {
          const bytes = readFileSync(source.path);
          expect(content.subarray(source.startByte, source.endByte).equals(bytes)).toBe(true);
          expect(source.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        }
        expect(readFileSync(f.skillFile).equals(original)).toBe(true);
        expect(readFileSync(f.restore).equals(restoreBefore)).toBe(true);
      });
    }
  }

  for (const phase of phases) test(`${phase} still rejects wrong phases and unsupported names`, () => {
    const wrongNames = phases.filter(other => other !== phase)
      .flatMap(other => [skillName(other), `gstack-${skillName(other)}`]);
    wrongNames.push(`other-${skillName(phase)}`, `gstack-gstack-${skillName(phase)}`, `gstack-${skillName(phase)}-extra`);
    for (const name of wrongNames) {
      const f = fixture(name);
      const before = readdirSync(f.dir).sort();
      expect(() => prepareMethodology(phase, f.skillFile, f.restore))
        .toThrow('Methodology skill identity does not match this phase');
      expect(readdirSync(f.dir).sort()).toEqual(before);
    }
  });

  for (const phase of phases) test(`${phase} accepts the actual prefix helper output and its unprefix round trip`, () => {
    const f = fixture(skillName(phase), true);
    const original = readFileSync(f.skillFile);
    for (const prefixed of [true, false]) {
      const result = spawnSync('bash', [join(import.meta.dir, '../bin/gstack-patch-names'), f.dir, String(prefixed)], { encoding: 'utf8', timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(f.skillFile, 'utf8')).toContain(`name: ${prefixed ? 'gstack-' : ''}${skillName(phase)}\n`);
      const manifest = prepareMethodology(phase, f.skillFile, f.restore);
      expect(manifest.phase).toBe(phase);
      expect(manifest.sources).toHaveLength(2);
    }
    expect(readFileSync(f.skillFile).equals(original)).toBe(true);
  });

  for (const phase of phases) for (const initialPrefix of ['', 'gstack-']) {
    test(`${phase} rejects a stale bundle after ${initialPrefix || 'bare'} name changes to the other supported spelling`, () => {
      const from = initialPrefix + skillName(phase);
      const to = (initialPrefix ? '' : 'gstack-') + skillName(phase);
      const f = fixture(from);
      const active = join(f.dir, 'active.md');
      writeFileSync(active, '# Plan\n\n## Implementation plan\nDo the work.\n\n## Review record\n');
      const manifest = prepareMethodology(phase, f.skillFile, f.restore);
      writeFileSync(f.skillFile, readFileSync(f.skillFile, 'utf8').replace(`name: ${from}\n`, `name: ${to}\n`));
      expect(() => createSnapshot(phase, active, f.restore, manifest.methodologyPath))
        .toThrow('Methodology source or artifact changed; prepare and Read a fresh bundle');
    });
  }
});
