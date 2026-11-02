/**
 * Shared fixture for the #1694 host-render prune tests (test/host-renders-prune*.test.ts):
 * a real `--host all` legacy render, the backup listing and a setup run that must pass.
 */
import { expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGeneration } from '../../scripts/gen-skill-docs';
import { runSetup, type Fixture } from './install-fixture';

export const ROOT = path.resolve(import.meta.dir, '../..');
export const OTHER_DIRS = ['.agents', '.factory', '.kiro', '.opencode', '.cursor', '.copilot', '.agy', '.gemini-cli', '.slate', '.openclaw', '.hermes', '.gbrain'];

export const skillFiles = (dir: string): string[] => !fs.existsSync(dir) ? []
  : (fs.readdirSync(dir, { recursive: true }) as string[]).filter(rel => path.basename(rel) === 'SKILL.md' && fs.statSync(path.join(dir, rel)).isFile());

export async function legacyRender(src: string): Promise<void> {
  const result = await runGeneration({ host: 'all', outputRoot: src });
  if (result.exitCode !== 0) throw new Error('legacy render failed');
}

export function backups(f: Fixture): string[] {
  const dir = path.join(f.home, '.gstack/backups/host-renders');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(d => path.join(dir, d)) : [];
}

export function setupOk(f: Fixture, src: string, args: string[] = []) {
  const r = runSetup(f, path.join(src, 'setup'), args);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r;
}
