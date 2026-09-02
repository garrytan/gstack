import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = path.join(ROOT, 'setup-gbrain', 'SKILL.md.tmpl');
const INSTALL = path.join(ROOT, 'bin', 'gstack-gbrain-install');

const tmpl = fs.readFileSync(TMPL, 'utf-8');
const installer = fs.readFileSync(INSTALL, 'utf-8');

describe('setup-gbrain Windows MSYS quirks from issue #1271', () => {
  test('local stdio registration uses gbrain.exe fallback on MSYS/Windows', () => {
    const localStdio = tmpl.match(/### Paths 1, 2a, 2b, 3 \(Local stdio\)[\s\S]*?### Both paths/)?.[0] ?? '';

    expect(localStdio).toContain('MINGW*|MSYS*|CYGWIN*|Windows_NT');
    expect(localStdio).toContain('$HOME/.bun/bin/gbrain.exe');
    expect(localStdio).toContain('GBRAIN_BIN="$HOME/.bun/bin/gbrain.exe"');
    expect(localStdio).toMatch(/Claude Code on Windows does\s+not apply PATHEXT/);
  });

  test('local stdio registration warns that PGLite lock contention can make claude mcp list look disconnected', () => {
    const localStdio = tmpl.match(/### Paths 1, 2a, 2b, 3 \(Local stdio\)[\s\S]*?### Both paths/)?.[0] ?? '';

    expect(localStdio).toContain('PGLite');
    expect(localStdio).toContain('single-writer lock');
    expect(localStdio).toContain('Failed to connect');
    expect(localStdio).toContain('mcp__gbrain__');
  });

  test('local smoke test uses gbrain put --content, never stdin pipe', () => {
    const smoke = tmpl.match(/### Paths 1, 2a, 2b, 3 \(Local stdio\)[\s\S]*?Confirms the round trip/)?.[0] ?? '';

    expect(smoke).toContain('gbrain put "$SLUG" --content');
    expect(smoke).not.toContain('| gbrain put "$SLUG"');
  });

  test('installer documents and preserves the MSYS bun install --ignore-scripts mitigation', () => {
    expect(installer).toContain('MINGW*|MSYS*|CYGWIN*|Windows_NT');
    expect(installer).toContain('bun install --silent --ignore-scripts');
    expect(tmpl).toMatch(/On Windows MSYS\/Git Bash, the installer uses\s+`bun install --ignore-scripts`/);
  });
});
