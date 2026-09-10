import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runBin } from './run-bin';

describe('runBin', () => {
  test('captures status/stdout/stderr with utf-8 shaping', () => {
    const r = runBin('sh', ['-c', 'printf out; printf err >&2; exit 3']);
    expect(r).toEqual({ status: 3, stdout: 'out', stderr: 'err' });
  });

  test('gstackHome sets both GSTACK_HOME and GSTACK_STATE_DIR (config precedence)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-bin-'));
    try {
      const r = runBin('sh', ['-c', 'printf "%s|%s" "$GSTACK_HOME" "$GSTACK_STATE_DIR"'], { gstackHome: dir });
      expect(r.stdout).toBe(`${dir}|${dir}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('env undefined deletes a key; input feeds stdin; trim shapes output', () => {
    const r = runBin('sh', ['-c', 'cat; printf "  padded  "; test -z "$LANG" && printf noLANG >&2'], {
      env: { LANG: undefined },
      input: 'piped|',
      trim: true,
    });
    // trim shapes the ENDS of the whole stream; interior whitespace stays.
    expect(r.stdout).toBe('piped|  padded');
    expect(r.stderr).toBe('noLANG');
  });

  test('spawn failure yields -1, never a fake success', () => {
    const r = runBin('/definitely/not/a/binary');
    expect(r.status).toBe(-1);
  });
});
