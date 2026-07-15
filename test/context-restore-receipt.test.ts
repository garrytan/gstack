import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('context-restore Universal Save receipt contract', () => {
  const sources = [
    'context-restore/SKILL.md.tmpl',
    'context-restore/SKILL.md',
    '.agents/skills/gstack-context-restore/SKILL.md',
  ];

  for (const relative of sources) {
    test(`${relative} reads four-layer receipts without mutation`, () => {
      const content = fs.readFileSync(path.join(ROOT, relative), 'utf-8');
      expect(content).toContain('RECEIPT_FILE="${CHOSEN_FILE%.md}.receipt.json"');
      expect(content).toContain('receipt_schema_version');
      expect(content).toContain('Codex Brain');
      expect(content).toContain('Obsidian');
      expect(content).toContain('QMD');
      expect(content).toContain('Never mutate a receipt');
      expect(content).toContain('ВОССТАНОВЛЕНИЕ КОНТЕКСТА');
    });
  }
});
