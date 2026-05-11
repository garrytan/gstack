/**
 * Source-level guardrail: callers MUST use the resolved path returned by
 * validateReadPath / validateOutputPath for subsequent I/O operations.
 *
 * Context: validateReadPath and validateOutputPath resolve symlinks at check
 * time and return the safe resolved path. If callers ignore the return value
 * and use the original user-supplied path for readFileSync / writeFileSync,
 * a TOCTOU race allows an attacker to swap a symlink between check and use.
 *
 * This test inspects source to verify that every call site captures the
 * return value and uses it for the actual I/O operation.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', 'src');
const READ_SRC = readFileSync(join(ROOT, 'read-commands.ts'), 'utf-8');
const WRITE_SRC = readFileSync(join(ROOT, 'write-commands.ts'), 'utf-8');
const META_SRC = readFileSync(join(ROOT, 'meta-commands.ts'), 'utf-8');
const PATH_SEC_SRC = readFileSync(join(ROOT, 'path-security.ts'), 'utf-8');
const URL_VAL_SRC = readFileSync(join(ROOT, 'url-validation.ts'), 'utf-8');

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('TOCTOU defense: validateReadPath return value used', () => {
  test('path-security.ts validateReadPath returns string (not void)', () => {
    // The function signature must return string
    expect(PATH_SEC_SRC).toMatch(/export function validateReadPath\([^)]*\):\s*string/);
  });

  test('path-security.ts validateOutputPath returns string (not void)', () => {
    expect(PATH_SEC_SRC).toMatch(/export function validateOutputPath\([^)]*\):\s*string/);
  });

  test('eval command uses returned safe path for readFileSync', () => {
    const stripped = stripComments(READ_SRC);
    const evalBlock = stripped.slice(
      stripped.indexOf("case 'eval'"),
      stripped.indexOf("case 'eval'") + 600
    );
    // Must capture return value
    expect(evalBlock).toMatch(/=\s*validateReadPath\(/);
    // Must use the captured variable (safePath) in readFileSync, not the original filePath
    const safeVarMatch = evalBlock.match(/const\s+(\w+)\s*=\s*validateReadPath\(/);
    expect(safeVarMatch).not.toBeNull();
    const safeVar = safeVarMatch![1];
    expect(evalBlock).toContain(`readFileSync(${safeVar}`);
  });

  test('download command uses returned safe path for writeFileSync', () => {
    const stripped = stripComments(WRITE_SRC);
    const dlBlock = stripped.slice(
      stripped.indexOf("case 'download'"),
      stripped.indexOf("case 'download'") + 9000
    );
    expect(dlBlock).toMatch(/=\s*validateOutputPath\(/);
    const safeVarMatch = dlBlock.match(/const\s+(\w+)\s*=\s*validateOutputPath\(/);
    expect(safeVarMatch).not.toBeNull();
    const safeVar = safeVarMatch![1];
    expect(dlBlock).toContain(`writeFileSync(${safeVar}`);
  });

  test('archive command uses returned safe path for writeFileSync', () => {
    const stripped = stripComments(WRITE_SRC);
    const archiveBlock = stripped.slice(
      stripped.indexOf("case 'archive'"),
      stripped.indexOf("case 'archive'") + 800
    );
    expect(archiveBlock).toMatch(/=\s*validateOutputPath\(/);
    const safeVarMatch = archiveBlock.match(/const\s+(\w+)\s*=\s*validateOutputPath\(/);
    expect(safeVarMatch).not.toBeNull();
    const safeVar = safeVarMatch![1];
    expect(archiveBlock).toContain(`writeFileSync(${safeVar}`);
  });

  test('meta-commands screenshot uses returned safe path', () => {
    const stripped = stripComments(META_SRC);
    // Find the screenshot case in meta-commands
    const ssBlock = stripped.slice(
      stripped.indexOf("case 'screenshot'"),
      stripped.indexOf("case 'pdf'")
    );
    expect(ssBlock).toMatch(/=\s*validateOutputPath\(/);
    const safeVarMatch = ssBlock.match(/const\s+(\w+)\s*=\s*validateOutputPath\(/);
    expect(safeVarMatch).not.toBeNull();
    const safeVar = safeVarMatch![1];
    // The safe variable must be used in page.screenshot path
    expect(ssBlock).toContain(`path: ${safeVar}`);
  });

  test('meta-commands pdf uses returned safe path', () => {
    const stripped = stripComments(META_SRC);
    const pdfBlock = stripped.slice(
      stripped.indexOf("case 'pdf'"),
      stripped.indexOf("case 'pdf'") + 1200
    );
    expect(pdfBlock).toMatch(/=\s*validateOutputPath\(/);
    const safeVarMatch = pdfBlock.match(/const\s+(\w+)\s*=\s*validateOutputPath\(/);
    expect(safeVarMatch).not.toBeNull();
    const safeVar = safeVarMatch![1];
    expect(pdfBlock).toContain(`opts.path = ${safeVar}`);
  });

  test('url-validation file:// uses returned safe path for pathToFileURL', () => {
    const stripped = stripComments(URL_VAL_SRC);
    // Find the file:// handling block
    const fileBlock = stripped.slice(
      stripped.indexOf("parsed.protocol === 'file:'"),
      stripped.indexOf("parsed.protocol !== 'http:'")
    );
    // Must capture validateReadPath return value
    expect(fileBlock).toMatch(/=\s*validateReadPath\(/);
    const safeVarMatch = fileBlock.match(/const\s+(\w+)\s*=\s*validateReadPath\(/);
    expect(safeVarMatch).not.toBeNull();
    const safeVar = safeVarMatch![1];
    // Must use the safe variable in pathToFileURL, not fsPath
    expect(fileBlock).toContain(`pathToFileURL(${safeVar})`);
  });
});
