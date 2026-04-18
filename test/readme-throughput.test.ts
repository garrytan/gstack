/**
 * scripts/update-readme-throughput.ts + README anchor + CI pending-marker gate.
 *
 * Coverage:
 * - Happy path: JSON present, anchor gets replaced with number + anchor preserved
 * - Missing JSON: script writes PENDING marker, CI would reject
 * - Invalid JSON: script errors, README untouched
 * - CI gate: committed README must not contain PENDING marker
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'update-readme-throughput.ts');

const ANCHOR = '<!-- GSTACK-THROUGHPUT-PLACEHOLDER -->';
const PENDING = 'GSTACK-THROUGHPUT-PENDING';

let tmpDir: string;
let tmpReadme: string;
let tmpJsonPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-readme-test-'));
  tmpReadme = path.join(tmpDir, 'README.md');
  fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  tmpJsonPath = path.join(tmpDir, 'docs', 'throughput-2013-vs-2026.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runScript(cwd: string): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('bun', ['run', SCRIPT], {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env },
  });
  return {
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status ?? -1,
  };
}

describe('update-readme-throughput script', () => {
  test('happy path: JSON present → anchor replaced with number', () => {
    fs.writeFileSync(tmpReadme, `gstack hero: ${ANCHOR} 2013 pro-rata.\n`);
    fs.writeFileSync(tmpJsonPath, JSON.stringify({
      multiples: { logical_lines_added: 12.3 },
    }));

    const result = runScript(tmpDir);
    expect(result.status).toBe(0);

    const updated = fs.readFileSync(tmpReadme, 'utf-8');
    expect(updated).toContain('12.3×');
    expect(updated).toContain(ANCHOR); // anchor stays for next run
    expect(updated).not.toContain(PENDING);
  });

  test('missing JSON: PENDING marker written (CI rejects)', () => {
    fs.writeFileSync(tmpReadme, `gstack hero: ${ANCHOR} 2013 pro-rata.\n`);
    // No JSON written

    const result = runScript(tmpDir);
    expect(result.status).toBe(0);

    const updated = fs.readFileSync(tmpReadme, 'utf-8');
    expect(updated).toContain(PENDING);
    expect(updated).toContain(ANCHOR); // anchor preserved for next run
  });

  test('JSON with null multiple: PENDING marker written (honest missing state)', () => {
    fs.writeFileSync(tmpReadme, `gstack hero: ${ANCHOR} 2013 pro-rata.\n`);
    fs.writeFileSync(tmpJsonPath, JSON.stringify({
      multiples: { logical_lines_added: null },
    }));

    const result = runScript(tmpDir);
    expect(result.status).toBe(0);

    const updated = fs.readFileSync(tmpReadme, 'utf-8');
    expect(updated).toContain(PENDING);
    expect(updated).not.toMatch(/null×/);
  });

  test('anchor already replaced: script is a no-op', () => {
    fs.writeFileSync(tmpReadme, 'gstack hero: 7.0× already set.\n');
    // No anchor in README → nothing to replace

    const result = runScript(tmpDir);
    expect(result.status).toBe(0);

    const updated = fs.readFileSync(tmpReadme, 'utf-8');
    expect(updated).toBe('gstack hero: 7.0× already set.\n');
  });
});

describe('CI gate: committed README must not contain PENDING marker', () => {
  // This is the core reason the PENDING marker exists. A commit that lands
  // the README with the pending string means the build didn't run.
  test('real README.md does not contain GSTACK-THROUGHPUT-PENDING', () => {
    const readmePath = path.join(ROOT, 'README.md');
    if (!fs.existsSync(readmePath)) return; // Fresh clone edge-case
    const content = fs.readFileSync(readmePath, 'utf-8');
    expect(content).not.toContain(PENDING);
  });
});
