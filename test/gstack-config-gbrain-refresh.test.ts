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
// A Python that cannot open() the state path but reads stdin, like native
// Windows Python handed an MSYS path. Bun stands in for its JSON parse, and
// each call appends the name it ran under to $HOME/python-calls.
const parsingPython = (name: string) => fs.writeFileSync(path.join(binDir, name), `#!/usr/bin/env bash
echo ${name} >> "$HOME/python-calls"
case "$2" in *"open("*) echo "FileNotFoundError: [Errno 2] No such file or directory" >&2; exit 1 ;; esac
exec ${JSON.stringify(process.execPath)} -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(process.argv[1].includes("gbrain_version") ? (d.gbrain_version || "unknown") : (d.gbrain_local_status || "unknown"))' "$2"
`, { mode: 0o755 });
// The Microsoft Store's App Installer alias, which Windows keeps on PATH as
// python3 (and often python) even next to a python.org install: it runs no
// Python, prints its hint on stderr and exits 49.
const storeAlias = (name: string) => fs.writeFileSync(path.join(binDir, name), `#!/usr/bin/env bash
echo "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases." >&2
exit 49
`, { mode: 0o755 });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-refresh-'));
  binDir = path.join(tmp, 'bin');
  home = path.join(tmp, 'home');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['gstack-config', 'gstack-state-root.sh', 'gstack-render-claude.sh', 'gstack-lock.sh']) {
    fs.copyFileSync(path.join(ROOT, 'bin', f), path.join(binDir, f));
    fs.chmodSync(path.join(binDir, f), 0o755);
  }
  writeDetect('no-config');
  parsingPython('python3');
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

describe('gstack-config gbrain-refresh with the Windows Store python3 alias', () => {
  test('falls back to grep when neither python3 nor python runs', () => {
    storeAlias('python3');
    storeAlias('python');
    writeDetect('ok');
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Detected gbrain v0.35.8.0 (local-status: ok).');
    expect(r.stdout).not.toContain('local-status: unknown');
    expect(r.stdout).not.toContain('brain-aware blocks will be suppressed');
    expect(r.stderr).not.toContain('Python was not found');
  });

  // The fallback record written when detection fails has no gbrain_version,
  // so grep finds nothing; under set -o pipefail that must not end the run.
  test('the grep fallback reports a failed detection as no-cli and exits 0', () => {
    storeAlias('python3');
    storeAlias('python');
    fs.writeFileSync(path.join(binDir, 'gstack-gbrain-detect'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('gbrain not detected (local-status: no-cli)');
  });

  test('uses python when python3 is the alias, before the grep fallback', () => {
    storeAlias('python3');
    parsingPython('python');
    writeDetect('ok');
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Detected gbrain v0.35.8.0 (local-status: ok).');
    expect(fs.readFileSync(path.join(home, 'python-calls'), 'utf8').trim().split('\n')).toEqual(['python', 'python']);
  });

  test('keeps an existing brain-aware render instead of deleting it as "not detected"', () => {
    storeAlias('python3');
    storeAlias('python');
    writeDetect('ok');
    const install = path.join(home, '.claude', 'skills', 'gstack');
    fs.mkdirSync(install, { recursive: true });
    fs.writeFileSync(path.join(install, 'VERSION'), '1.0.0.0\n');
    fs.writeFileSync(path.join(install, 'package.json'), '{}\n');
    const rendered = path.join(home, 'render', 'claude', 'review', 'SKILL.md');
    fs.mkdirSync(path.dirname(rendered), { recursive: true });
    fs.writeFileSync(rendered, 'brain-aware render\n');
    // Only the render itself fails, so the healthy path ends on its
    // "previous render left in place" branch without touching the render.
    fs.writeFileSync(path.join(binDir, 'bun'), `#!/usr/bin/env bash
case "$*" in *gen:skill-docs*) echo 'render failed (fixture)' >&2; exit 7 ;; esac
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o755 });
    const r = refresh();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Warning: render failed — previous render (if any) left in place, links stay valid.');
    expect(r.stdout).not.toContain('Removed the brain-aware render');
    expect(fs.readFileSync(rendered, 'utf8')).toBe('brain-aware render\n');
  });
});
