/**
 * Deprecated codex web-search flag tripwire (#2525).
 *
 * codex >=0.144 deprecates `--enable web_search_cached` (its `--enable
 * <FEATURE>` surface now means `-c features.<name>=true`); the replacement
 * is `-c 'web_search="cached"'`, owned by ONE constant:
 * CODEX_WEB_SEARCH_FLAG in scripts/resolvers/constants.ts. Resolvers
 * interpolate it; templates reference {{CODEX_WEB_SEARCH_FLAG}}.
 *
 * These tests fail CI if the deprecated spelling re-enters any source
 * (resolver, template, helper) or any rendered SKILL.md / section / golden.
 */
import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CODEX_WEB_SEARCH_FLAG } from '../scripts/resolvers/constants';

const ROOT = path.join(import.meta.dir, '..');
const DEPRECATED = '--enable web_search_cached';

function grepRepo(pattern: string, includes: string[]): string[] {
  const includeArgs = includes.map((i) => `--include='${i}'`).join(' ');
  const out = execSync(
    `grep -rln ${includeArgs} -e '${pattern}' "${ROOT}" || true`,
    { encoding: 'utf-8' },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.includes('node_modules'))
    // The workspace-local .claude/ install is not generated output and can
    // carry dangling symlinks from unrelated sessions.
    .filter((f) => !f.includes('/.claude/'))
    .filter((f) => !f.endsWith('test/codex-web-search-flag.test.ts'));
}

describe('deprecated codex web-search flag is gone (#2525)', () => {
  test('the replacement flag has exactly the documented shape', () => {
    expect(CODEX_WEB_SEARCH_FLAG).toBe(`-c 'web_search="cached"'`);
  });

  test('no rendered SKILL.md or section carries the deprecated flag', () => {
    const hits = grepRepo(DEPRECATED, ['SKILL.md', '*.md']);
    expect(hits).toEqual([]);
  });

  test('no source file (resolver, template, helper) carries the deprecated flag', () => {
    const hits = grepRepo(DEPRECATED, ['*.ts', '*.tmpl']);
    expect(hits).toEqual([]);
  });

  test('rendered codex skill actually resolves the token to the live flag', () => {
    const rendered = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(rendered).toContain(CODEX_WEB_SEARCH_FLAG);
    expect(rendered).not.toContain('{{CODEX_WEB_SEARCH_FLAG}}');
  });

  test('rendered autoplan skill resolves the token at every inline site', () => {
    const rendered = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf-8');
    const count = rendered.split(CODEX_WEB_SEARCH_FLAG).length - 1;
    expect(count).toBeGreaterThanOrEqual(4);
    expect(rendered).not.toContain('{{CODEX_WEB_SEARCH_FLAG}}');
  });
});
