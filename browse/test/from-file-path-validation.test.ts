/**
 * Source-level guardrail for the --from-file shortcut flags.
 *
 * Context: both `load-html <file>` (write-commands.ts) and `pdf <url>`
 * (meta-commands.ts) support a `--from-file <payload.json>` shortcut that
 * reads a JSON payload with the inline content (HTML body / PDF options).
 * The DIRECT `load-html <file>` path runs every caller-supplied file path
 * through `validateReadPath()` so reads are confined to SAFE_DIRECTORIES.
 * The `--from-file` paths historically skipped this validation, opening a
 * parity gap: an MCP caller that can pick the payload path could route
 * reads through --from-file to bypass the safe-dirs policy.
 *
 * This test inspects the source to make sure both --from-file sites call
 * validateReadPath before fs.readFileSync. Pattern mirrors
 * postgres-engine.test.ts and pglite-search-timeout.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', 'src');
const WRITE_SRC = readFileSync(join(ROOT, 'write-commands.ts'), 'utf-8');
const META_SRC  = readFileSync(join(ROOT, 'meta-commands.ts'), 'utf-8');

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('--from-file path validation parity', () => {
  test('load-html --from-file validates payload path before reading', () => {
    const stripped = stripComments(WRITE_SRC);
    // Grab the --from-file branch body.
    const idx = stripped.indexOf("'--from-file'");
    expect(idx).toBeGreaterThan(-1);
    const fromFileBranch = stripped.slice(idx, idx + 1200);

    // validateReadPath must appear BEFORE the readFileSync in the branch.
    const vIdx = fromFileBranch.indexOf('validateReadPath');
    const rIdx = fromFileBranch.indexOf('readFileSync');
    expect(vIdx).toBeGreaterThan(-1);
    expect(rIdx).toBeGreaterThan(-1);
    expect(vIdx).toBeLessThan(rIdx);
  });

  test('pdf --from-file validates payload path before reading', () => {
    const stripped = stripComments(META_SRC);
    const idx = stripped.indexOf('function parsePdfFromFile');
    expect(idx).toBeGreaterThan(-1);
    const fnBody = stripped.slice(idx, idx + 1200);

    const vIdx = fnBody.indexOf('validateReadPath');
    const rIdx = fnBody.indexOf('readFileSync');
    expect(vIdx).toBeGreaterThan(-1);
    expect(rIdx).toBeGreaterThan(-1);
    expect(vIdx).toBeLessThan(rIdx);
  });

  test('both sites reference SAFE_DIRECTORIES in the error message', () => {
    // Error shape parity so ops teams / agents see a consistent message.
    const write = stripComments(WRITE_SRC);
    const meta = stripComments(META_SRC);
    // load-html --from-file error
    expect(write).toMatch(/load-html: --from-file [\s\S]{0,80}SAFE_DIRECTORIES/);
    // pdf --from-file error
    expect(meta).toMatch(/pdf: --from-file [\s\S]{0,80}SAFE_DIRECTORIES/);
  });
});
