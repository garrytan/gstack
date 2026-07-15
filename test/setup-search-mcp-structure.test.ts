import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = fs.readFileSync(path.join(ROOT, 'setup-search-mcp', 'SKILL.md.tmpl'), 'utf-8');

describe('setup-search-mcp structural contract', () => {
  test('defaults to free no-auth setup', () => {
    expect(TMPL).toContain('free web search for agents');
    expect(TMPL).toContain('no account, no API key');
    expect(TMPL).toContain('no OAuth');
    expect(TMPL).toContain('Authentication: none by default');
    expect(TMPL).not.toContain('Authorization: Bearer');
  });

  test('uses exact supported host commands', () => {
    expect(TMPL).toContain('claude mcp add --scope user --transport http "Parallel-Search-MCP" https://search.parallel.ai/mcp');
    expect(TMPL).toContain('codex mcp add parallel-search --url https://search.parallel.ai/mcp');
    expect(TMPL).toContain('claude mcp list');
    expect(TMPL).toContain('codex mcp list --json');
  });

  test('does not guess unknown host config files', () => {
    expect(TMPL).toContain('Do not install into a different client just because its CLI exists');
    expect(TMPL).toContain('do not guess at the config file');
    expect(TMPL).toContain('Expected tools after restart: `web_search`, `web_fetch`');
  });

  test('keeps auth and browser automation boundaries explicit', () => {
    expect(TMPL).toContain('AskUserQuestion');
    expect(TMPL).toContain('API-key auth or OAuth');
    expect(TMPL).toContain('This is not browser automation');
    expect(TMPL).toContain('/browse');
    expect(TMPL).toContain('/open-gstack-browser');
  });

  test('does not depend on the removed verifier helper', () => {
    expect(TMPL).not.toContain('gstack-search-mcp-verify');
  });
});
