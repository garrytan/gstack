/**
 * GSTA-208 Phase 0 probe (draft PR only, never shipped): records how
 * windows-latest's Git Bash, native Bun, Python and Git behave with MSYS path
 * conversion on and off. It fails on purpose so its findings land in the log.
 */
import { describe, test } from 'bun:test';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveWindowsBash } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..').replace(/\\/g, '/');
const short = (s: string | null | undefined) => (s ?? '').trim().split('\n').slice(0, 4).join(' | ').slice(0, 400);

describe.skipIf(process.platform !== 'win32')('GSTA-208 windows probe', () => {
  test('probe', () => {
    const res = resolveWindowsBash();
    const out: Record<string, unknown> = { bash: res.ok ? res.bash : res.message, bun: process.execPath, bunVersion: Bun.version };
    if (!res.ok) throw new Error('PROBE ' + JSON.stringify(out));
    const sh = (cmd: string, extra: Record<string, string> = {}) => {
      const r = spawnSync(res.bash, ['-c', cmd], { cwd: ROOT, env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 60_000 });
      return { rc: r.status, out: short(r.stdout), err: short(r.stderr), error: r.error?.message };
    };
    out.python = sh('command -v python3; command -v python; python3 -c "import sys,locale;print(sys.version.split()[0], sys.stdout.encoding, locale.getpreferredencoding())"');
    out.pythonRedirect = sh('python3 -c "import sys;print(sys.stdout.encoding)" > "$TMPDIR/pyenc.txt" 2>&1; cat "$TMPDIR/pyenc.txt"; python3 -c "print(1)" | od -c | head -2');
    for (const [mode, extra] of [['conv', {}], ['noconv', { MSYS_NO_PATHCONV: '1' }]] as const) {
      out[mode + '.argv'] = sh('bun -e "console.log(JSON.stringify(process.argv.slice(2)))" -- /dev/null /tmp/x', extra);
      out[mode + '.cfgDevNull'] = sh('bun --no-env-file --config=/dev/null -e "console.log(1)"', extra);
      out[mode + '.cfgNUL'] = sh('bun --no-env-file --config=NUL -e "console.log(1)"', extra);
      out[mode + '.shebangBin'] = sh('"' + ROOT + '/bin/gstack-gate-diff" --help >/dev/null; echo rc=$?', extra);
      out[mode + '.gitTmpIndex'] = sh('T=$(mktemp "${TMPDIR:-/tmp}/gsta208-XXXXXX"); echo "$T"; GIT_INDEX_FILE="$T" git read-tree HEAD; echo rc=$?; rm -f "$T"', extra);
      out[mode + '.envS'] = sh('printf "%s\n" "#!/usr/bin/env -S bun --no-env-file --config=/dev/null" "console.log(42)" > "$TMPDIR/sb.ts"; chmod +x "$TMPDIR/sb.ts"; "$TMPDIR/sb.ts"; echo rc=$?', extra);
    }
    for (const c of ['/dev/null', 'NUL', 'nul', '\\\\.\\NUL', '//./NUL', '/dev/null/', 'C:/dev/null']) {
      const r = spawnSync(process.execPath, ['--no-env-file', '--config=' + c, '-e', 'console.log(1)'], { encoding: 'utf8', timeout: 30_000 });
      out['native.' + c] = { rc: r.status, out: short(r.stdout), err: short(r.stderr) };
    }
    throw new Error('PROBE ' + JSON.stringify(out));
  }, 300_000);
});
