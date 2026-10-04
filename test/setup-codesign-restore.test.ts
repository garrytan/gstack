import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// B4 (#1254, setup half): the Apple Silicon re-sign loop backs each binary up,
// restores it as built when codesign fails, and reports design unavailable when
// the design binary is SIGKILLed at launch (exit 137). The real block runs on
// any OS with uname/codesign/otool stubbed on PATH.
const setup = fs.readFileSync(path.resolve(import.meta.dir, '../setup'), 'utf8');
const start = setup.indexOf('  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then\n    # CSO artifacts');
const end = setup.indexOf('\n  fi\n', setup.indexOf('    done', start));
const block = setup.slice(start, end + 5);
const BINS = ['browse/dist/browse', 'browse/dist/find-browse', 'design/dist/design', 'make-pdf/dist/pdf', 'bin/gstack-global-discover'];

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true }); });

function fixture(opts: { sign: 'ok' | 'fail'; killed?: string[] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-resign-'));
  tmps.push(tmp);
  const src = path.join(tmp, 'gstack');
  for (const rel of BINS) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), `#!/bin/sh\nexit ${opts.killed?.includes(rel) ? 137 : 0}\n`, { mode: 0o755 });
  }
  const stubs = path.join(tmp, 'stubs');
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'otool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'stat'), '#!/bin/sh\nwc -c < "$2" | tr -d " "\n', { mode: 0o755 }); // BSD stat -f%z
  // --remove-signature mutates the file, as the real one does; signing then succeeds or fails.
  fs.writeFileSync(path.join(stubs, 'codesign'), `#!/bin/sh
case "$1" in
  --remove-signature) printf '# stripped\\n' >> "$2" ;;
  -s) exit ${opts.sign === 'ok' ? 0 : 1} ;;
esac
`, { mode: 0o755 });
  return { tmp, src, stubs };
}

function run(fx: ReturnType<typeof fixture>) {
  return runBashScript(['set -e', 'log() { echo "$@"; }', `SOURCE_GSTACK_DIR="${fx.src}"`, block].join('\n'), {
    env: { ...process.env, PATH: `${fx.stubs}:${process.env.PATH}` }, timeout: 30_000,
  });
}

const leftovers = (src: string) => BINS.flatMap(rel => fs.readdirSync(path.dirname(path.join(src, rel))).filter(n => n.includes('.gstack-presign.')));

describe.skipIf(process.platform === 'win32')('setup: Apple Silicon re-sign keeps a backup (B4)', () => {
  test('the extracted block is the re-sign loop', () => {
    expect(block).toContain('codesign -s - -f "$_bin_path"');
    expect(block.trimEnd().endsWith('fi')).toBe(true);
  });

  test('a failed re-sign restores every binary byte-for-byte as built', () => {
    const fx = fixture({ sign: 'fail' });
    const before = BINS.map(rel => fs.readFileSync(path.join(fx.src, rel), 'utf8'));
    const r = run(fx);
    expect(r.status, r.stderr).toBe(0);
    expect(BINS.map(rel => fs.readFileSync(path.join(fx.src, rel), 'utf8'))).toEqual(before);
    expect(leftovers(fx.src)).toEqual([]);
    expect(r.stdout).toContain('codesign could not re-sign design/dist/design; restored it as built');
  });

  test('a design binary killed at launch after re-signing is reported unavailable with the fix', () => {
    const fx = fixture({ sign: 'ok', killed: ['design/dist/design'] });
    const r = run(fx);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`design unavailable: ${fx.src}/design/dist/design is killed at launch (exit 137)`);
    expect(r.stderr).toContain(`Fix: cd ${fx.src} && ./setup`);
    expect(leftovers(fx.src)).toEqual([]);
  });

  test('a clean re-sign is silent and leaves no backups', () => {
    const fx = fixture({ sign: 'ok' });
    const r = run(fx);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(leftovers(fx.src)).toEqual([]);
  });

  test('another binary SIGKILLed after a failed re-sign keeps its warning', () => {
    const fx = fixture({ sign: 'fail', killed: ['browse/dist/browse'] });
    expect(run(fx).stdout).toContain('warning: codesign failed for browse/dist/browse and it is SIGKILL\'d on exec (exit 137)');
  });
});
