/**
 * memorable_recall — gstack's own consent gate for the Memorable
 * UserPromptSubmit bridge (bin/gstack-memorable, hosts/claude/hooks/
 * memorable-user-prompt-hook). `on` lets a hook hand every prompt to a
 * third-party binary, so the key follows the codex_reviews rule: an invalid
 * value is REJECTED and the stored value left alone. A consent key that
 * coerces a typo into a default is a consent key that lies in one direction
 * or the other.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const CONFIG_BIN = path.join(ROOT, 'bin', 'gstack-config');
let state: string;

function cfg(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('bash', [CONFIG_BIN, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_HOME: state },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

beforeEach(() => { state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cfg-memo-')); });
afterEach(() => { fs.rmSync(state, { recursive: true, force: true }); });

describe('memorable_recall config key', () => {
  test('defaults to off and exits 0 (a fresh install can never recall)', () => {
    const r = cfg(['get', 'memorable_recall']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('off');
  });

  test('set on / set off round-trip', () => {
    expect(cfg(['set', 'memorable_recall', 'on']).code).toBe(0);
    expect(cfg(['get', 'memorable_recall']).out).toBe('on');
    expect(cfg(['set', 'memorable_recall', 'off']).code).toBe(0);
    expect(cfg(['get', 'memorable_recall']).out).toBe('off');
  });

  test('an invalid value is REJECTED (exit 1) and the stored value is preserved, in both directions', () => {
    let r = cfg(['set', 'memorable_recall', 'yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Existing value left unchanged');
    expect(cfg(['get', 'memorable_recall']).out).toBe('off');   // never coerced to on
    cfg(['set', 'memorable_recall', 'on']);
    r = cfg(['set', 'memorable_recall', 'maybe']);
    expect(r.code).toBe(1);
    expect(cfg(['get', 'memorable_recall']).out).toBe('on');    // never coerced to off either
  });

  test('appears in `list` and `defaults` (the two hand-synced enumerations)', () => {
    expect(cfg(['list']).out).toMatch(/memorable_recall:\s+off \(default\)/);
    expect(cfg(['defaults']).out).toMatch(/memorable_recall:\s+off/);
  });

  test('the annotated header documents the key next to the other consent keys', () => {
    cfg(['set', 'telemetry', 'off']);   // first set writes the header
    const yaml = fs.readFileSync(path.join(state, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('memorable_recall: off');
    expect(yaml).toContain('gstack never sets it');
  });
});
