/**
 * deck-template-sync: verify deck/SKILL.md.tmpl and deck/SKILL.md stay in sync.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

describe('/deck template/generated sync', () => {
  test('isolated regeneration produces byte-identical Claude output', () => {
    const generatedPath = path.join(ROOT, 'deck', 'SKILL.md');
    const before = fs.readFileSync(generatedPath);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-deck-claude-'));
    try {
      const result = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--host', 'claude', '--out-dir', outDir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 },
      );
      expect(result.status).toBe(0);
      const isolated = fs.readFileSync(path.join(outDir, 'deck', 'SKILL.md'));
      expect(isolated.equals(before)).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 130_000);

  test('generated deck skill carries the source warning', () => {
    const generated = fs.readFileSync(path.join(ROOT, 'deck', 'SKILL.md'), 'utf8');
    expect(generated).toMatch(/AUTO-GENERATED|do not edit directly/i);
  });

  test('isolated Codex generation emits the prefixed wrapper with the same deck contract', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-deck-codex-'));
    try {
      const result = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', outDir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 },
      );
      expect(result.status).toBe(0);

      const generated = fs.readFileSync(
        path.join(outDir, '.agents', 'skills', 'gstack-deck', 'SKILL.md'),
        'utf8',
      );
      expect(generated).toMatch(/^name: deck$/m);
      expect(generated).toContain('# /deck — Story → Interactive Deck → Proof');
      expect(generated).toContain('## Step 0: Inspect before deciding');
      expect(generated).toContain('one consolidated primary intake round with');
      expect(generated).toMatch(/one Source-material follow-up\s+round with at most two questions/);
      expect(generated).toContain('Do not assume JavaScript, TypeScript, React, Node');
      expect(generated).toContain('headline-only story test');
      expect(generated).toContain('`deck_revision`');
      expect(generated).not.toMatch(/\{\{[A-Z_]+(?::[^}]*)?\}\}/);

      const metadata = fs.readFileSync(
        path.join(outDir, '.agents', 'skills', 'gstack-deck', 'agents', 'openai.yaml'),
        'utf8',
      );
      expect(metadata).toContain('display_name: "gstack-deck"');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 130_000);
});
