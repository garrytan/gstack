import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSnapshot, prepareMethodology } from '../bin/gstack-autoplan-snapshot';
import { writePrompts } from '../lib/autoplan-prompts';
import { DX_ERROR_COMPACT, DX_ERROR_CONTRACT, DX_ERROR_ITEMS, DX_ERROR_RUBRIC } from '../lib/dx-error-contract';

const ROOT = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('agent-ready error contract reaches every DX reviewer', () => {
  test('the contract names all eight items, both caps and the failure-class rule', () => {
    for (const item of DX_ERROR_ITEMS) {
      expect(DX_ERROR_CONTRACT).toContain(`**${item}**`);
      expect(DX_ERROR_COMPACT).toContain(`${item} (`);
    }
    for (const text of [DX_ERROR_CONTRACT, DX_ERROR_COMPACT]) {
      expect(text).toContain('CAP4:<path>:<item>');
      expect(text).toContain('CAP6:<path>:<item>');
      expect(text).toContain('CAP4:<path>:<item> <what fails>');
      expect(text).toContain('CAP6:<path>:<item> <what fails>');
      expect(text).toContain('4/10');
      expect(text).toContain('6/10');
      expect(text).toMatch(/[Uu]sage (and|or) validation error/);
      expect(text).toMatch(/unexpected failures only/i);
    }
  });

  test('the snapshot literal equals the compact form, and the built native DX prompt carries it', () => {
    const snapshotSource = read('bin/gstack-autoplan-snapshot.ts');
    expect(snapshotSource).toContain(`3. Error handling: ${DX_ERROR_COMPACT}`);
    const dir = mkdtempSync(join(tmpdir(), 'gstack-dx-contract-')); owned.push(dir);
    const active = join(dir, 'active.md');
    const restore = join(dir, 'restore.md');
    writeFileSync(active, '# Plan\n\n## Implementation plan\nShip a CLI.\n## Review record\n');
    writeFileSync(restore, 'Ship a CLI.\n');
    const method = prepareMethodology('dx', join(ROOT, 'plan-devex-review/SKILL.md'), restore);
    const methodology = readFileSync(method.methodologyPath, 'utf8');
    expect(methodology).toContain(DX_ERROR_COMPACT);
    const snapshot = createSnapshot('dx', active, restore, method.methodologyPath);
    expect(snapshot.nativePrompt).toContain(DX_ERROR_COMPACT);
    const prompts = writePrompts({ phase: 'dx', snapshot, outDir: dir, priorConsensus: [] });
    expect(readFileSync(prompts.native, 'utf8')).toContain(DX_ERROR_COMPACT);
    expect(readFileSync(prompts.outside, 'utf8')).toContain(DX_ERROR_COMPACT);
  });

  test('rendered skills carry the contract where each consumer reads it', () => {
    expect(read('plan-devex-review/sections/review-sections.md').includes(DX_ERROR_COMPACT)).toBe(true);
    expect(read('plan-devex-review/dx-hall-of-fame.md').includes(DX_ERROR_CONTRACT)).toBe(true);
    expect(read('autoplan/sections/dx-phase.md')).toContain('2. Errors, agent-ready (what, fix, recovery, code, context, trace, redaction, channel)');
    const devex = read('devex-review/SKILL.md');
    expect(devex).toContain(DX_ERROR_ITEMS.join(', '));
    expect(devex).toContain('plan-devex-review/dx-hall-of-fame.md');
    expect(devex).toContain('gstack-error-capture');
    expect(devex).toContain('secret_findings');
    expect(read('plan-devex-review/sections/checklist.md')).toContain('CAP4');
  });

  test('the public doc is generated from the contract', () => {
    const body = DX_ERROR_CONTRACT.slice(DX_ERROR_CONTRACT.indexOf('| Item |'));
    expect(read('docs/agent-ready-errors.md')).toContain(body);
  });

  test('review-log rows record the rubric version', () => {
    for (const path of ['plan-devex-review/sections/review-sections.md', 'devex-review/SKILL.md']) {
      const text = read(path);
      expect(text.includes(`"dx_rubric":"${DX_ERROR_RUBRIC}"`), path).toBe(true);
      expect(text.includes('"dimension_scores":{"getting_started":N'), path).toBe(true);
      expect(text.includes('rubric changed, not comparable'), path).toBe(true);
    }
    expect(read('autoplan/SKILL.md').includes(`"unresolved":N,"dx_rubric":"${DX_ERROR_RUBRIC}","via":"autoplan"`)).toBe(true);
  });

  test('no DX consumer keeps the old error formula', () => {
    const consumers = [
      'scripts/resolvers/dx.ts', 'bin/gstack-autoplan-snapshot.ts', 'lib/autoplan-prompts.ts', 'autoplan/sections/dx-phase.md',
      'plan-devex-review/SKILL.md', 'plan-devex-review/sections/review-sections.md',
      'plan-devex-review/sections/checklist.md', 'plan-devex-review/dx-hall-of-fame.md', 'devex-review/SKILL.md',
    ];
    for (const path of consumers) {
      const text = read(path);
      for (const old of ['problem + cause + fix', 'What happened + Why + How to fix', 'three-tier model', 'explain the cause, show the fix']) {
        expect(text.includes(old), `${path} still says "${old}"`).toBe(false);
      }
    }
  });
});
