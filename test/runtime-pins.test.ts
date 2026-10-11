/**
 * lib/runtime-pins.ts: the doctor's `project pins` row. Pins come from
 * package.json, .tool-versions, .nvmrc, .bun-version and CI workflows with
 * their file:line; a range and an exact pin are told apart; a CI pin keeps
 * its platform lane and never fails another platform; an unevaluable value is
 * reported, not dropped. The bin prints PINS_VERDICT last and exits 1 on fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classify, collectPins, evaluatePins, renderPinLines, satisfies } from '../lib/runtime-pins';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-pins-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const WORKFLOW = [
  'name: ci', 'on: push', 'jobs:',
  '  linux:', '    runs-on: ubuntu-latest', '    steps:',
  '      - uses: oven-sh/setup-bun@v2', '        with:', '          bun-version: 1.4.2',
  '  windows:', '    runs-on: windows-latest', '    steps:',
  '      - uses: oven-sh/setup-bun@v2', '        with:', "          bun-version: '1.4.2'",
  '      - uses: actions/setup-node@v7', '        with:', '          node-version: 24.18.0',
  '  matrix:', '    runs-on: ${{ matrix.os }}', '    steps:',
  '      - uses: oven-sh/setup-bun@v2', '        with:', '          bun-version: ${{ matrix.bun }}',
  '',
].join('\n');

describe('satisfies and classify', () => {
  test('ranges, exact pins, partial versions, wildcards and alternatives', () => {
    expect(satisfies('1.3.14', '>=1.4.2')).toBe(false);
    expect(satisfies('1.4.2', '>=1.4.2')).toBe(true);
    expect(satisfies('1.4.5', '1.4.2')).toBe(false);
    expect(satisfies('1.4.2', '1.4.2')).toBe(true);
    expect(satisfies('24.18.0', '24')).toBe(true);
    expect(satisfies('25.0.0', '24')).toBe(false);
    expect(satisfies('24.18.0', '24.x')).toBe(true);
    expect(satisfies('24.18.0', '^24.1.0')).toBe(true);
    expect(satisfies('24.18.0', '~24.17.0')).toBe(false);
    expect(satisfies('20.0.0', '>=18 <21')).toBe(true);
    expect(satisfies('22.0.0', '>=18 <21 || >=22')).toBe(true);
    expect(satisfies('1.0.0', '*')).toBe(true);
    expect(satisfies('24.18.0', 'lts/*')).toBeNull();
    expect(satisfies('24.18.0', '${{ matrix.node }}')).toBeNull();
    expect(satisfies('garbage', '>=1')).toBeNull();
  });

  test('classify tells a range from an exact pin and names the unevaluable', () => {
    expect(classify('>=1.4.2')).toBe('range');
    expect(classify('1.4.2')).toBe('exact');
    expect(classify('v1.4.2')).toBe('exact');
    expect(classify('24')).toBe('range');
    expect(classify('24.x')).toBe('range');
    expect(classify('lts/*')).toBe('unevaluable');
  });
});

describe('collectPins and evaluatePins', () => {
  test('every source is read with file:line, CI pins carry their lane', () => {
    const dir = project({
      'package.json': '{\n  "name": "x",\n  "packageManager": "bun@1.4.2",\n  "engines": {\n    "bun": ">=1.4.2",\n    "node": ">=22"\n  }\n}\n',
      '.tool-versions': 'nodejs 24.18.0\nbun 1.4.2\n',
      '.nvmrc': 'lts/*\n',
      '.bun-version': '1.4.2\n',
      '.github/workflows/ci.yml': WORKFLOW,
    });
    const pins = collectPins(dir);
    expect(pins.map(p => [p.tool, p.constraint, p.kind, p.source, p.field, p.lane])).toEqual([
      ['bun', '1.4.2', 'exact', 'package.json:3', 'packageManager', 'any'],
      ['bun', '>=1.4.2', 'range', 'package.json:5', 'engines.bun', 'any'],
      ['node', '>=22', 'range', 'package.json:6', 'engines.node', 'any'],
      ['node', '24.18.0', 'exact', '.tool-versions:1', '.tool-versions', 'any'],
      ['bun', '1.4.2', 'exact', '.tool-versions:2', '.tool-versions', 'any'],
      ['node', 'lts/*', 'unevaluable', '.nvmrc:1', '.nvmrc', 'any'],
      ['bun', '1.4.2', 'exact', '.bun-version:1', '.bun-version', 'any'],
      ['bun', '1.4.2', 'exact', '.github/workflows/ci.yml:9', 'CI', 'linux'],
      ['bun', '1.4.2', 'exact', '.github/workflows/ci.yml:15', 'CI', 'windows'],
      ['node', '24.18.0', 'exact', '.github/workflows/ci.yml:18', 'CI', 'windows'],
      ['bun', '${{ matrix.bun }}', 'unevaluable', '.github/workflows/ci.yml:24', 'CI', 'any'],
    ]);
  });

  test('a mismatch fails with the first source and the CI context; a Windows pin never blocks Linux', () => {
    const dir = project({
      'package.json': '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n',
      '.github/workflows/ci.yml': WORKFLOW,
    });
    const linux = evaluatePins(collectPins(dir), { bun: '1.3.14', node: '22.0.0' }, 'linux');
    expect(linux.verdict).toBe('fail');
    expect(linux.failures).toEqual(['bun 1.3.14 outside engines.bun >=1.4.2 (package.json:3; CI linux lane, ci.yml:9 pins 1.4.2)']);
    expect(linux.skipped).toEqual(['bun ${{ matrix.bun }} (.github/workflows/ci.yml:24) not evaluated']);
    // node 22 differs from the Windows job's 24.18.0 pin, which does not apply on Linux.
    expect(linux.failures.some(f => f.startsWith('node'))).toBe(false);

    const windows = evaluatePins(collectPins(dir), { bun: '1.4.2', node: '22.0.0' }, 'win32');
    expect(windows.verdict).toBe('fail');
    expect(windows.failures).toEqual(['node 22.0.0 outside CI 24.18.0 (.github/workflows/ci.yml:18)']);

    const ok = evaluatePins(collectPins(dir), { bun: '1.4.2', node: '24.18.0' }, 'linux');
    expect(ok.verdict).toBe('pass');
    expect(ok.failures).toEqual([]);
    expect(ok.summary).toEqual([
      'bun >=1.4.2 (engines.bun, package.json:3)',
      'bun 1.4.2 (CI linux lane, ci.yml:9)',
      'bun 1.4.2 (CI windows lane, ci.yml:15)',
      'node 24.18.0 (CI windows lane, ci.yml:18)',
      'bun ${{ matrix.bun }} (CI, ci.yml:24)',
    ]);
  });

  test('no pins is none, a missing runtime is skipped with a reason, and the wire lines end with the verdict', () => {
    expect(evaluatePins(collectPins(project({ 'README.md': 'x' })), { bun: '1.4.2' }).verdict).toBe('none');
    const dir = project({ '.nvmrc': '24\n' });
    const report = evaluatePins(collectPins(dir), { bun: '1.4.2' }, 'linux');
    expect(report.verdict).toBe('none');
    expect(report.skipped).toEqual(['node 24 (.nvmrc:1): node not found on PATH']);
    const lines = renderPinLines(report, 'linux');
    expect(lines[0]).toBe('PIN: node 24 range .nvmrc:1 lane=any');
    expect(lines.at(-1)).toBe('PINS_VERDICT: none');
  });

  test('a malformed package.json contributes no pins and does not throw', () => {
    expect(collectPins(project({ 'package.json': '{ not json' }))).toEqual([]);
  });
});

describe('bin/gstack-runtime-pins.ts', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'bin/gstack-runtime-pins.ts'), ...args], { encoding: 'utf8', timeout: 30_000 });

  test('prints PINS_VERDICT last, exits 1 on fail and 0 on pass, --json carries the same report', () => {
    const dir = project({ 'package.json': '{\n  "engines": {\n    "bun": ">=1.4.2"\n  }\n}\n' });
    const fail = run(['--project', dir, '--bun', '1.3.14', '--platform', 'linux']);
    expect(fail.status).toBe(1);
    expect(fail.stdout.trim().split('\n').at(-1)).toBe('PINS_VERDICT: fail');
    expect(fail.stdout).toContain('PIN_FAIL: bun 1.3.14 outside engines.bun >=1.4.2 (package.json:3)');
    const pass = run(['--project', dir, '--bun', '1.4.2', '--json']);
    expect(pass.status).toBe(0);
    const json = JSON.parse(pass.stdout);
    expect(json.schema_version).toBe(1);
    expect(json.verdict).toBe('pass');
    expect(json.pins).toHaveLength(1);
  });

  test('usage errors exit 2', () => {
    expect(run([]).status).toBe(2);
    expect(run(['--project', path.join(os.tmpdir(), 'no-such-dir-for-pins')]).status).toBe(2);
  });
});
