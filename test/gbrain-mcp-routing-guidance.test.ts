import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { generateBrainSyncBlock } from '../scripts/resolvers/preamble/generate-brain-sync-block';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

describe('GBrain MCP routing guidance', () => {
  test('skill preamble detects MCP before telling the agent how to query', () => {
    const block = generateBrainSyncBlock({
      skillName: 'sync-gbrain',
      tmplPath: 'sync-gbrain/SKILL.md.tmpl',
      host: 'codex',
      paths: HOST_PATHS.codex,
    });

    expect(block).toContain('mcp__gbrain__search/query');
    expect(block).toContain('Do not run the local gbrain CLI while the MCP server owns PGLite.');
    expect(block).toContain('$HOME/.codex/config.toml');
    expect(block.indexOf('_GBRAIN_MCP_MODE="none"')).toBeLessThan(
      block.indexOf('GBrain MCP is configured.'),
    );
  });

  test('setup and sync templates make MCP primary and CLI a lock-safe fallback', () => {
    for (const template of ['setup-gbrain/SKILL.md.tmpl', 'sync-gbrain/SKILL.md.tmpl']) {
      const content = fs.readFileSync(path.join(ROOT, template), 'utf8');
      expect(content).toContain('`mcp__gbrain__*` tools');
      expect(content).toContain('do not run the corresponding `gbrain` CLI query');
      expect(content).toContain('no live GBrain server owns PGLite');
    }
  });
});
