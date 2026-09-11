import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareContentProjection } from '../lib/content-projection';

const roots: string[] = [];
function git(cwd: string, args: string[]): string { const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
function fixture(): { cwd: string; before: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'projection-')); roots.push(cwd); git(cwd, ['init', '-b', 'main']); git(cwd, ['config', 'user.name', 'Test']); git(cwd, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'bun test' } }, null, 2) + '\n'); writeFileSync(join(cwd, 'VERSION'), '1.0.0\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'base']); return { cwd, before: git(cwd, ['rev-parse', 'HEAD^{tree}']) };
}
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('content projection', () => {
  test('allows only the selected JSON pointer and rejects any other field change', () => {
    const { cwd, before } = fixture(); writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.1', scripts: { test: 'bun test' } }, null, 2) + '\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'version']); const versionOnly = git(cwd, ['rev-parse', 'HEAD^{tree}']);
    expect(compareContentProjection(cwd, before, versionOnly, [{ path: 'package.json', format: 'json', selector: '/version' }])).toEqual({ matches: true, reasons: [] });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.2', scripts: { test: 'vitest' } }, null, 2) + '\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'script']); const changed = git(cwd, ['rev-parse', 'HEAD^{tree}']);
    expect(compareContentProjection(cwd, versionOnly, changed, [{ path: 'package.json', format: 'json', selector: '/version' }])).toEqual({ matches: false, reasons: ['projection_mismatch'] });
  });
  test('allows VERSION whole-file but fails closed on missing or malformed JSON objects', () => {
    const { cwd, before } = fixture(); writeFileSync(join(cwd, 'VERSION'), '1.0.1\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'version']); const after = git(cwd, ['rev-parse', 'HEAD^{tree}']);
    expect(compareContentProjection(cwd, before, after, [{ path: 'VERSION', format: 'plain_text', selector: 'whole_file' }]).matches).toBe(true);
    expect(compareContentProjection(cwd, 'f'.repeat(40), after, [{ path: 'VERSION', format: 'plain_text', selector: 'whole_file' }])).toEqual({ matches: false, reasons: ['malformed'] });
    writeFileSync(join(cwd, 'package.json'), '{bad\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'bad']); const bad = git(cwd, ['rev-parse', 'HEAD^{tree}']);
    expect(compareContentProjection(cwd, after, bad, [{ path: 'package.json', format: 'json', selector: '/version' }])).toEqual({ matches: false, reasons: ['malformed'] });
  });
});
