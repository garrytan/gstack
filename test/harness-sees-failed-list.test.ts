/**
 * #4412: a harness list command that fails (OpenClaw's AGENT_SELECTION_REQUIRED
 * with several agents) is an unknown visibility with its error, never a list of
 * every registered skill as missing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TARGETS, harnessSees } from '../lib/harness-register';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fakeOpenclaw(script: string): Record<string, string> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-harness-sees-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'openclaw'), '#!/bin/sh\n' + script, { mode: 0o755 });
  return { PATH: d + path.delimiter + process.env.PATH, OPENCLAW_STATE_DIR: path.join(d, 'oc') };
}

describe.skipIf(process.platform === 'win32')('harnessSees with a failing list command (#4412)', () => {
  const dest = (env: Record<string, string>) => path.join(env.OPENCLAW_STATE_DIR, 'skills');

  test('a failed list is unknown, keeps the command and its first error line, and lists nothing missing', () => {
    const env = fakeOpenclaw('echo "Multiple agents are configured, but the skills command has no explicit owner. Pass --agent <id>." >&2\nexit 1\n');
    const seen = harnessSees(TARGETS.openclaw, dest(env), env, ['gstack', 'review', 'ship']);
    expect(seen.visible).toBe('unknown');
    expect(seen.checked).toBe('openclaw skills list --json');
    expect(seen.error).toContain('Pass --agent <id>');
    expect(seen.missing).toBeUndefined();
  });

  test('a list that completes still reports what is missing', () => {
    const env = fakeOpenclaw('echo \'{"skills":[{"name": "gstack"},{"name": "review"}]}\'\n');
    const seen = harnessSees(TARGETS.openclaw, dest(env), env, ['gstack', 'review', 'ship']);
    expect(seen.visible).toBe('no');
    expect(seen.missing).toEqual(['ship']);
    expect(seen.error).toBeUndefined();
  });
});
