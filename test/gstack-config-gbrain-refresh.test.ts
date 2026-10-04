/**
 * E6 (#1967): under Git Bash on Windows, a native Windows Python first on PATH
 * cannot open an MSYS-style /c/... path, so gbrain-refresh always summarized
 * the detection file as "local-status: unknown". The file is now read by bash
 * and handed to Python on stdin. The stub Python below refuses any path
 * argument, as a native Windows Python does with an MSYS path, and parses stdin.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
let tmp: string;
let binDir: string;
let home: string;
const writeDetect = (status: string) => fs.writeFileSync(path.join(binDir, 'gstack-gbrain-detect'),
  `#!/usr/bin/env bash\nprintf '%s\\n' '{"gbrain_on_path":true,"gbrain_local_status":"${status}","gbrain_version":"0.35.8.0"}'\n`, { mode: 0o755 });
const refresh = () => spawnSync('bash', [path.join(binDir, 'gstack-config'), 'gbrain-refresh'], {
  encoding: 'utf8', timeout: 30_000,
  env: { PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, GSTACK_HOME: home, GSTACK_STATE_ROOT: home },
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-refresh-'));
  binDir = path.join(tmp, 'bin');
  home = path.join(tmp, 'home');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['gstack-config', 'gstack-state-root.sh', 'gstack-render-claude.sh']) {
    fs.copyFileSync(path.join(ROOT, 'bin', f), path.join(binDir, f));
    fs.chmodSync(path.join(binDir, f), 0o755);
  }
  writeDetect('no-config');
  // A Python that cannot open() the state path but reads stdin, like native
  // Windows Python handed an MSYS path. Bun stands in for its JSON parse.
  fs.writeFileSync(path.join(binDir, 'python3'), `#!/usr/bin/env bash
case "$2" in *"open("*) echo "FileNotFoundError: [Errno 2] No such file or directory" >&2; exit 1 ;; esac
exec ${JSON.stringify(process.execPath)} -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(process.argv[1].includes("gbrain_version") ? (d.gbrain_version || "unknown") : (d.gbrain_local_status || "unknown"))' "$2"
`, { mode: 0o755 });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('gstack-config gbrain-refresh (E6)', () => {
  test('reads the detection file through stdin, so the status is not masked as unknown', () => {
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('local-status: no-config');
    expect(r.stdout).not.toContain('local-status: unknown');
  });

  // A2: a network/DNS failure with an intact config is transient, like
  // timeout, so brain-aware blocks are kept rather than stripped.
  test('db-unreachable counts as a configured gbrain, like timeout', () => {
    for (const status of ['timeout', 'db-unreachable']) {
      writeDetect(status);
      const r = refresh();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Detected gbrain v0.35.8.0 (local-status: ${status}).`);
      expect(r.stdout).not.toContain('brain-aware blocks will be suppressed');
    }
  });
});
