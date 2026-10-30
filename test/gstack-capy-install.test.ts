/**
 * bin/gstack-capy-install: the repo-owned Capy installer. Pinned on the order
 * of operations (preflight before ./setup), exit codes (3 before anything is
 * installed), the setup argv it passes (--no-browser unless --with-browser),
 * the lazy-browser SKIP line, the GSTACK_LAUNCH line, the trailer as the
 * last line with the `(requested <ref>; ...)` note, and the Bun recipe (exact
 * archive, SHA-256 verified, only when gstack and the project agree). ./setup,
 * gstack-doctor, gstack-browser-ensure, bun, curl and node are stubs that log
 * their argv; git, jq, unzip and sha256sum are real.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verdictProblem } from '../lib/install-verdict';

const REPO = path.resolve(import.meta.dir, '..');
const BUN_DEFAULT = fs.readFileSync(path.join(REPO, 'bin/gstack-bun-version.sh'), 'utf8').match(/^GSTACK_BUN_DEFAULT="([^"]+)"$/m)![1];
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};
const script = (file: string, lines: string[]) => write(file, ['#!/usr/bin/env bash', ...lines].join('\n') + '\n', 0o755);
const sh = (cmd: string, cwd?: string) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30_000 });

/** PATH without any directory that holds bun, node, curl or jq-less shims; real git/jq/unzip/sha256sum stay reachable. */
function hostPath(base: string, hide: string[]): string {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir, i) => {
    if (!hide.some(n => fs.existsSync(path.join(dir, n)))) return dir;
    const shim = path.join(base, `host-${i}`);
    fs.mkdirSync(shim, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (hide.includes(name)) continue;
      try { fs.symlinkSync(path.join(dir, name), path.join(shim, name)); } catch { /* unreadable */ }
    }
    return shim;
  }).join(path.delimiter);
}

function fixture(opts: { bun?: string; jq?: boolean } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capy-install-')));
  bases.push(base);
  const root = path.join(base, 'gstack');
  const home = path.join(base, 'home');
  const stub = path.join(base, 'stub');
  const log = path.join(base, 'calls.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stub, { recursive: true });
  for (const rel of ['bin/gstack-capy-install', 'bin/gstack-bun-version.sh', 'bin/gstack-doctor-components.sh', 'bin/gstack-install-verdict.sh', 'bin/gstack-node-runtime.sh']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    fs.chmodSync(path.join(root, rel), fs.statSync(path.join(REPO, rel)).mode);
  }
  write(path.join(root, 'VERSION'), '1.2.3\n');
  script(path.join(root, 'setup'), ['echo "setup $*" >> "$CAPY_LOG"', 'echo "gstack ready ($2)"', 'echo "env GSTACK_SKIP_PLAYWRIGHT=${GSTACK_SKIP_PLAYWRIGHT:-} GSTACK_SKIP_FONTS=${GSTACK_SKIP_FONTS:-} bun=$(bun --version)" >> "$CAPY_LOG"', 'exit "${STUB_SETUP_EXIT:-0}"']);
  script(path.join(root, 'bin/gstack-doctor'), [
    'echo "doctor $* GSTACK_EPHEMERAL=${GSTACK_EPHEMERAL:-}" >> "$CAPY_LOG"', 'echo "doctor-cwd $(pwd -P)" >> "$CAPY_LOG"', 'echo "doctor-node $(node --version 2>/dev/null)" >> "$CAPY_LOG"',
    'echo "required: ${STUB_REQUIRED:-claude codex patch}"', 'echo "PASS claude ok"', 'echo "SKIP browser (lazy)"', '[ -n "${STUB_PINS_SKIP:-}" ] && echo "SKIP pins ($STUB_PINS_SKIP)"', '[ -n "${STUB_DOCTOR_EXTRA:-}" ] && echo "$STUB_DOCTOR_EXTRA"',
    '[ "${STUB_DOCTOR_FAIL:-}" = 1 ] && { echo "FAIL codex — missing; fix: x (COMPONENT_MISSING; d)"; echo "gstack: fail codex"; exit 1; }',
    '[ -n "${GSTACK_DOCTOR_RUNTIME_DRIFT:-}" ] && { echo "FAIL runtime — bun resolution drifted: $GSTACK_DOCTOR_RUNTIME_DRIFT; fix: $GSTACK_DOCTOR_RUNTIME_DRIFT_FIX (BUN_RESOLUTION_DRIFT; d)"; echo "gstack: fail runtime"; exit 1; }',
    'echo "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan"',
  ]);
  script(path.join(root, 'bin/gstack-paths'), ['[ "$1" = --get ] && { echo "${GSTACK_HOME}"; exit 0; }', 'exit 1']);
  script(path.join(root, 'bin/gstack-browser-ensure'), ['echo "browser-ensure $*" >> "$CAPY_LOG"', 'echo "BROWSER_OK node 141.0.1"']);
  sh(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init`, root);
  script(path.join(stub, 'bun'), [`[ "$1" = --version ] && { echo "${opts.bun ?? '1.4.2'}"; exit 0; }`, 'exit 0']);
  script(path.join(stub, 'node'), ['[ "$1" = --version ] && { echo v24.18.0; exit 0; }', 'exit 0']);
  script(path.join(stub, 'curl'), ['echo "curl $*" >> "$CAPY_LOG"', 'out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*|file:*) url="$1" ;; esac; shift; done', '[ -n "${STUB_CURL_DIR:-}" ] && [ -f "$STUB_CURL_DIR/${url##*/}" ] && cp "$STUB_CURL_DIR/${url##*/}" "$out" && exit 0', '[ -n "${STUB_CURL_ZIP:-}" ] && cp "$STUB_CURL_ZIP" "$out" && exit 0', 'exit 22']);
  if (opts.jq !== false) {
    const real = sh('command -v jq').stdout.trim();
    if (real) fs.symlinkSync(real, path.join(stub, 'jq'));
  }
  const env: Record<string, string> = {
    PATH: `${stub}${path.delimiter}${hostPath(base, ['bun', 'node', 'curl', 'jq'])}`,
    HOME: home, GSTACK_HOME: path.join(home, '.gstack-state'), TMPDIR: base, CAPY_LOG: log, BUN_INSTALL: path.join(home, '.bun'),
  };
  const run = (args: string[] = [], extra: Record<string, string> = {}, cwd = home) =>
    spawnSync('bash', [path.join(root, 'bin/gstack-capy-install'), ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra }, timeout: 120_000 });
  return { base, root, home, stub, env, run, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

const lastLine = (s: string) => s.trim().split('\n').at(-1);
const store = (f: { home: string }, version: string) => path.join(f.home, '.gstack-state/runtimes/bun', version);
/** Point VERSION's verified checksum for TARGET in the fixture's gstack-bun-version.sh at ZIP. */
function trustZip(root: string, version: string, target: string, zip: string) {
  const sha = sh(`sha256sum "${zip}" | cut -d' ' -f1`).stdout.trim();
  const versions = path.join(root, 'bin/gstack-bun-version.sh');
  const re = new RegExp(`(${version.replace(/\./g, '\\.')}\\) case "\\$1" in[\\s\\S]*?\\s${target}\\) echo )[0-9a-f]{64}`);
  const text = fs.readFileSync(versions, 'utf8');
  expect(re.test(text)).toBe(true);
  fs.writeFileSync(versions, text.replace(re, `$1${sha}`));
}

describe('gstack-capy-install', () => {
  test('default install: preflight, both host setups with --no-browser, lazy browser SKIP, launch line, trailer last, exit 0', () => {
    const f = fixture();
    const r = run(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toEqual([
      'setup --host claude --no-prefix --no-browser',
      'setup --host codex --model gpt-6-astra --no-browser',
    ]);
    expect(f.calls().filter(l => l.startsWith('env '))).toEqual(Array(2).fill('env GSTACK_SKIP_PLAYWRIGHT= GSTACK_SKIP_FONTS= bun=1.4.2'));
    expect(f.calls().some(l => l.startsWith('browser-ensure'))).toBe(false);
    expect(f.calls().filter(l => l.startsWith('doctor '))).toEqual(['doctor --check --require claude,codex,patch GSTACK_EPHEMERAL=1']);
    expect(f.calls().filter(l => l.startsWith('doctor-cwd '))).toEqual([`doctor-cwd ${f.home}`]);
    expect(r.stdout).toContain('SKIP browser (lazy; gstack-browser-ensure installs on first use)');
    expect(r.stdout).toMatch(/planning-only install: \d+s/);
    expect(r.stdout).toContain(`GSTACK_LAUNCH: GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=${path.join(f.home, '.gstack-state')} GSTACK_EPHEMERAL=1`);
    expect(lastLine(r.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    expect(r.stdout).toContain('reusing');
    expect(r.stdout).not.toContain('cloning');
    expect(f.calls().some(l => l.startsWith('curl '))).toBe(false);
  });

  // Integration item 7: setup runs once per host, so each run ends with its
  // own ready line; the installer prints the one line naming both.
  test('after both host setups the last ready line is the installer\'s `gstack ready (claude, codex)`; a skipped setup prints none', () => {
    const f = fixture();
    const r = f.run(['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const ready = r.stdout.split('\n').filter(l => l.startsWith('gstack ready'));
    expect(ready).toEqual(['gstack ready (claude)', 'gstack ready (codex)', 'gstack ready (claude, codex)']);
    expect(f.run(['--for', 'autoplan']).stdout).not.toContain('gstack ready');
  });

  test('--for names the workflow; --with-browser drops --no-browser, runs gstack-browser-ensure and times it separately', () => {
    const f = fixture();
    const r = run(f, ['--for', 'qa', '--with-browser']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toEqual(['setup --host claude --no-prefix', 'setup --host codex --model gpt-6-astra']);
    expect(f.calls().filter(l => l.startsWith('browser-ensure'))).toEqual(['browser-ensure ']);
    expect(f.calls().filter(l => l.startsWith('doctor '))).toEqual(['doctor --check --for qa GSTACK_EPHEMERAL=1']);
    expect(r.stdout).toMatch(/browser bootstrap: \d+s/);
    expect(r.stdout).not.toContain('SKIP browser (lazy; gstack-browser-ensure');
    const g = fixture();
    const req = run(g, ['--with-browser']);
    expect(req.status).toBe(0);
    expect(g.calls().filter(l => l.startsWith('doctor '))).toEqual(['doctor --check --require claude,codex,patch,browse-bundle,browser GSTACK_EPHEMERAL=1']);
  });

  test('a FAIL from the doctor is exit 1 with its trailer last and no launch file; usage errors exit 2', () => {
    const f = fixture();
    const r = run(f, [], { STUB_DOCTOR_FAIL: '1' });
    expect(r.stdout).not.toMatch(/^GSTACK_LAUNCH_FILE:/m);
    expect(fs.readdirSync(path.join(f.home, '.gstack-state/install-verdicts'), { recursive: true }).some(n => String(n).endsWith('.env'))).toBe(false);
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe('gstack: fail codex');
    expect(r.stdout).toContain('FAIL codex');
    expect(run(f, ['--bogus']).status).toBe(2);
    expect(run(f, ['--for', 'qa', '--require', 'claude']).status).toBe(2);
    expect(run(f, ['--revision']).status).toBe(2);
  });

  test('preflight: a missing tool stops with exit 3 and INSTALL_PREFLIGHT_FAILED before ./setup runs', () => {
    const f = fixture({ jq: false });
    const r = run(f);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('preflight: jq not found');
    expect(r.stderr).toContain('(INSTALL_PREFLIGHT_FAILED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-install-preflight-failed)');
    expect(f.calls().some(l => l.startsWith('setup '))).toBe(false);
  });

  test('Bun pin conflict: an exact project pin below the minimum stops with both constraints and installs nothing', () => {
    const f = fixture({ bun: '1.3.14' });
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{ "engines": { "bun": "1.3.14" } }\n');
    sh('git init -q', project);
    const r = run(f, [], {}, project);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('Bun conflict: gstack needs >=1.4.2');
    expect(r.stderr).toContain(`${project}/package.json pins exactly 1.3.14`);
    expect(r.stderr).toContain('(RUNTIME_PIN_CONFLICT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-install-runtime-conflict)');
    expect(f.calls().some(l => l.startsWith('curl ') || l.startsWith('setup '))).toBe(false);
    // --project overrides the cwd's repository; a range the minimum satisfies agrees.
    write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=1.4.0" } }\n');
    const agree = run(fixture(), ['--project', project]);
    expect(agree.status, agree.stdout + agree.stderr).toBe(0);
    expect(agree.stdout).toContain('project pin >=1.4.0');
    const conflictRange = run(fixture({ bun: '1.4.2' }), ['--project', (write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=2.0.0" } }\n'), project)]);
    expect(conflictRange.status).toBe(3);
    expect(conflictRange.stderr).toContain('pins >=2.0.0');
  });

  test('an exact project pin above the minimum with a verified archive is the Bun installed; an unverified one stops naming the verified versions', () => {
    const f = fixture({ bun: '1.3.14' });
    const project = path.join(f.base, 'project');
    write(path.join(project, '.bun-version'), '1.4.3\n');
    sh('git init -q', project);
    const zip = path.join(f.base, 'bad.zip');
    fs.mkdirSync(path.join(f.base, 'z/bun-linux-x64'), { recursive: true });
    script(path.join(f.base, 'z/bun-linux-x64/bun'), ['echo 1.4.3']);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-linux-x64`).status).toBe(0);
    const adopted = run(f, ['--project', project], { STUB_CURL_ZIP: zip });
    expect(adopted.stdout).toContain('installing bun 1.4.3 from its release archive');
    expect(adopted.stdout).not.toContain("gstack's minimum 1.4.3");
    expect(f.calls().filter(l => l.startsWith('curl '))).toEqual([expect.stringContaining('https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux')]);
    expect(adopted.status).toBe(3);
    expect(adopted.stderr).toContain('SHA-256 mismatch');
    const g = fixture({ bun: '1.3.14' });
    write(path.join(project, '.bun-version'), '1.4.9\n');
    const unverified = run(g, ['--project', project]);
    expect(unverified.status).toBe(3);
    expect(unverified.stderr).toContain(`${project}/.bun-version pins exactly 1.4.9`);
    expect(unverified.stderr).toContain('verified archives: 1.4.2 1.4.3 1.4.4');
    expect(unverified.stderr).toContain('(RUNTIME_PIN_CONFLICT; ');
    expect(g.calls().some(l => l.startsWith('curl ') || l.startsWith('setup '))).toBe(false);
  });

  test('Bun below the minimum: the install default\'s exact release archive is downloaded and SHA-256 verified; a mismatch installs nothing', () => {
    const f = fixture({ bun: '1.3.14' });
    const zip = path.join(f.base, 'bad.zip');
    fs.mkdirSync(path.join(f.base, 'z/bun-linux-x64'), { recursive: true });
    script(path.join(f.base, 'z/bun-linux-x64/bun'), [`echo ${BUN_DEFAULT}`]);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-linux-x64`).status).toBe(0);
    const r = run(f, [], { STUB_CURL_ZIP: zip });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('SHA-256 mismatch');
    expect(r.stderr).toContain('nothing installed');
    expect(f.calls().filter(l => l.startsWith('curl '))).toHaveLength(1);
    expect(f.calls()[0]).toContain(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN_DEFAULT}/bun-linux-x64`);
    expect(fs.existsSync(path.join(f.home, '.bun/bin/bun'))).toBe(false);
    expect(fs.existsSync(store(f, BUN_DEFAULT))).toBe(false);
    expect(fs.readdirSync(path.dirname(store(f, BUN_DEFAULT)))).toEqual([]);
    expect(f.calls().some(l => l.startsWith('setup '))).toBe(false);
  });

  test.skipIf(process.platform !== 'linux')('Bun below the minimum: a verified archive is published in the runtime store (never ~/.bun/bin) and ./setup runs on it', () => {
    const f = fixture({ bun: '1.3.14' });
    const target = sh('grep -q avx2 /proc/cpuinfo && echo linux-x64 || echo linux-x64-baseline').stdout.trim();
    const zip = path.join(f.base, 'good.zip');
    fs.mkdirSync(path.join(f.base, `z/bun-${target}`), { recursive: true });
    script(path.join(f.base, `z/bun-${target}/bun`), [`echo ${BUN_DEFAULT}`]);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-${target}`).status).toBe(0);
    trustZip(f.root, BUN_DEFAULT, target, zip);
    const r = run(f, ['--for', 'autoplan'], { STUB_CURL_ZIP: zip });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`installing bun ${BUN_DEFAULT} from its release archive`);
    expect(r.stdout).toContain(`bun ${BUN_DEFAULT} installed at ${store(f, BUN_DEFAULT)}/bun`);
    expect(r.stdout).toContain(`bun ${BUN_DEFAULT} at ${store(f, BUN_DEFAULT)}/bun (gstack's install default, from gstack's runtime store;`);
    expect(fs.existsSync(path.join(f.home, '.bun/bin/bun'))).toBe(false);
    expect(f.calls().filter(l => l.startsWith('env '))).toEqual(Array(2).fill(`env GSTACK_SKIP_PLAYWRIGHT= GSTACK_SKIP_FONTS= bun=${BUN_DEFAULT}`));
    expect(lastLine(r.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
  });

  test('--revision: an existing checkout at another revision is reused, never pulled, and the trailer says so', () => {
    const f = fixture();
    const before = sh('git rev-parse HEAD', f.root).stdout.trim();
    const r = run(f, ['--revision', 'v9.9.9.9']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe(`gstack: ok 1.2.3 for=autoplan (requested: v9.9.9.9 (run ${f.root}/bin/gstack-upgrade to move))`);
    expect(sh('git rev-parse HEAD', f.root).stdout.trim()).toBe(before);
    expect(run(f, ['--revision', '1.2.3']).stdout).not.toContain('requested');
    expect(lastLine(run(f, ['--revision', before]).stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
  });

  test('trailer grammar: notes ride only on ok, in the fixed order requested, pins, latest; a stale FETCH_HEAD without the wrapper\'s env adds no latest note', () => {
    const f = fixture();
    const all = run(f, ['--revision', 'v9.9.9.9'], { STUB_PINS_SKIP: 'planning-only; repo pins differ: x', GSTACK_CAPY_REMOTE_VERSION: '1.10.0' });
    expect(all.status, all.stdout + all.stderr).toBe(0);
    expect(lastLine(all.stdout)).toBe(`gstack: ok 1.2.3 for=autoplan (requested: v9.9.9.9 (run ${f.root}/bin/gstack-upgrade to move); pins: skipped (planning-only); latest: 1.10.0 available)`);
    expect(lastLine(run(f, [], { STUB_PINS_SKIP: 'no project: /x is not inside a git repository; pass --project <path>' }).stdout)).toBe('gstack: ok 1.2.3 for=autoplan (pins: skipped (no project))');
    expect(lastLine(run(f, [], { GSTACK_CAPY_REMOTE_VERSION: '1.2.3' }).stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    expect(lastLine(run(f, [], { GSTACK_CAPY_REMOTE_VERSION: '1.0.9' }).stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    sh(`git update-ref FETCH_HEAD HEAD && printf '%s\\t\\tbranch main\\n' "$(git rev-parse HEAD)" > .git/FETCH_HEAD`, f.root);
    write(path.join(f.root, 'VERSION'), '1.2.3\n');
    expect(lastLine(run(f, ['--check']).stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    const failed = run(f, ['--revision', 'v9.9.9.9'], { STUB_DOCTOR_FAIL: '1', STUB_PINS_SKIP: 'planning-only; x', GSTACK_CAPY_REMOTE_VERSION: '9.0.0' });
    expect(lastLine(failed.stdout)).toBe('gstack: fail codex');
  });

  test('trailer grammar: behind=<n> and its fix replace latest, after requested and pins; never on a fail trailer', () => {
    const f = fixture();
    const behind = { GSTACK_CAPY_BEHIND: '5', GSTACK_CAPY_BEHIND_TO: '1.2.8', GSTACK_CAPY_BEHIND_FIX: 'bash /s/install.sh --for autoplan', GSTACK_CAPY_REMOTE_VERSION: '1.2.8' };
    expect(lastLine(run(f, [], behind).stdout)).toBe('gstack: ok 1.2.3 for=autoplan (behind=5 (latest: 1.2.8); fix: bash /s/install.sh --for autoplan)');
    const all = run(f, ['--revision', 'v9.9.9.9'], { ...behind, STUB_PINS_SKIP: 'planning-only; repo pins differ: x' });
    expect(all.status, all.stdout + all.stderr).toBe(0);
    expect(lastLine(all.stdout)).toBe(`gstack: ok 1.2.3 for=autoplan (requested: v9.9.9.9 (run ${f.root}/bin/gstack-upgrade to move); pins: skipped (planning-only); behind=5 (latest: 1.2.8); fix: bash /s/install.sh --for autoplan)`);
    expect(lastLine(run(f, [], { ...behind, STUB_DOCTOR_FAIL: '1' }).stdout)).toBe('gstack: fail codex');
  });

  test('a skipped session-start upgrade above the minimum is a WARN, never a fail: the trailer stays ok with behind=, the skip reason and the fix, exit 0, and a WARN behind row names the code', () => {
    const f = fixture();
    const busy = { GSTACK_CAPY_BEHIND: '3', GSTACK_CAPY_BEHIND_TO: '1.2.6', GSTACK_CAPY_BEHIND_FIX: `${f.root}/bin/gstack-upgrade`, GSTACK_CAPY_BEHIND_BLOCKED: 'live gstack sessions hold this installation: pid 379 (124m dbus-daemon); fix: wait for those sessions to finish, or re-run with GSTACK_UPGRADE_FORCE=1 when you know they are idle (UPGRADE_BUSY)' };
    const r = run(f, [], busy);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // The trailer's fix is the session's one runnable command; the refusal's own prose (and its GSTACK_UPGRADE_FORCE=1 escape hatch) stays on the WARN row.
    expect(lastLine(r.stdout)).toBe(`gstack: ok 1.2.3 for=autoplan (behind=3 (latest: 1.2.6); upgrade skipped: live gstack sessions hold this installation: pid 379 (124m dbus-daemon) (UPGRADE_BUSY); fix: ${f.root}/bin/gstack-upgrade)`);
    expect(r.stdout).toMatch(/^WARN behind — installed 1\.2\.3 is 3 commits behind origin \(latest 1\.2\.6\) and the session-start upgrade was skipped: live gstack sessions hold this installation: pid 379 \(124m dbus-daemon\); fix: wait for those sessions to finish, or re-run with GSTACK_UPGRADE_FORCE=1 when you know they are idle \(UPGRADE_BUSY; .*#upgrade-busy\)$/m);
    expect(r.stdout).toMatch(/^GSTACK_LAUNCH_FILE: /m);
    const bare = run(f, [], { ...busy, GSTACK_CAPY_BEHIND_BLOCKED: 'gstack-upgrade exit 9' });
    expect(bare.status).toBe(0);
    expect(lastLine(bare.stdout)).toBe(`gstack: ok 1.2.3 for=autoplan (behind=3 (latest: 1.2.6); upgrade skipped: gstack-upgrade exit 9 (UPGRADE_REFUSED); fix: ${f.root}/bin/gstack-upgrade)`);
    // A code the installer does not know collapses to UPGRADE_SKIPPED, whose anchor exists; the reason and fix are kept.
    const other = run(f, [], { ...busy, GSTACK_CAPY_BEHIND_BLOCKED: 'origin unreachable; fix: retry when online (UPGRADE_FETCH_FAILED)' });
    expect(other.status).toBe(0);
    expect(lastLine(other.stdout)).toBe(`gstack: ok 1.2.3 for=autoplan (behind=3 (latest: 1.2.6); upgrade skipped: origin unreachable (UPGRADE_SKIPPED); fix: ${f.root}/bin/gstack-upgrade)`);
    expect(other.stdout).toMatch(/^WARN behind — .*; fix: retry when online \(UPGRADE_SKIPPED; .*#upgrade-skipped\)$/m);
    expect(lastLine(run(f, [], { ...busy, STUB_DOCTOR_FAIL: '1' }).stdout)).toBe('gstack: fail codex');
  });

  test('a WARN floor row from the doctor adds floor=<v> (<file>) and the fast-forwarding fix to an ok trailer; behind keeps one fix note', () => {
    const f = fixture();
    const row = 'WARN floor — installed 1.2.3 is below the floor 1.2.9 that /p/.gstack/ship-policy.json declares (min_gstack_version); fix: bash /s/install.sh --for autoplan (fast-forwards a clean checkout to origin and reinstalls), or /r/bin/gstack-upgrade (PROJECT_FLOOR_UNMET; d)';
    const alone = run(f, ['--for', 'autoplan'], { STUB_DOCTOR_EXTRA: row, GSTACK_CAPY_WRAPPER_PATH: '/s/install.sh' });
    expect(alone.status, alone.stdout + alone.stderr).toBe(0);
    expect(lastLine(alone.stdout)).toBe('gstack: ok 1.2.3 for=autoplan (floor=1.2.9 (/p/.gstack/ship-policy.json); fix: bash /s/install.sh --for autoplan (fast-forwards))');
    const behind = run(f, [], { STUB_DOCTOR_EXTRA: row, GSTACK_CAPY_BEHIND: '5', GSTACK_CAPY_BEHIND_TO: '1.2.9', GSTACK_CAPY_BEHIND_FIX: 'bash /s/install.sh --for autoplan' });
    expect(lastLine(behind.stdout)).toBe('gstack: ok 1.2.3 for=autoplan (behind=5 (latest: 1.2.9); floor=1.2.9 (/p/.gstack/ship-policy.json); fix: bash /s/install.sh --for autoplan)');
    expect(lastLine(run(f, [], { STUB_DOCTOR_EXTRA: row, STUB_DOCTOR_FAIL: '1' }).stdout)).toBe('gstack: fail codex');
  });

  test('--for none certifies nothing and installs nothing: ok not-needed, exit 0, no setup, no verdict, with or without a checkout', () => {
    const f = fixture();
    const r = run(f, ['--for', 'none']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe(`gstack: ok not-needed for=none (checkout 1.2.3 at ${f.root}, not certified; before the first workflow run: test -f "${f.root}/setup" || git clone --quiet --single-branch --depth 1 https://github.com/garrytan/gstack.git "${f.root}" && GSTACK_CAPY_ROOT="${f.root}" bash "${f.root}/capy/skill/gstack/scripts/install.sh" --for <skill>)`);
    expect(f.calls()).toEqual([]);
    expect(fs.existsSync(path.join(f.home, '.gstack-state'))).toBe(false);
    const missing = path.join(f.base, 'absent');
    const none = run(f, ['--check', '--for', 'none', '--root', missing], { GSTACK_CAPY_WRAPPER_PATH: '/s/install.sh', GSTACK_CAPY_BEHIND: '2', GSTACK_CAPY_BEHIND_TO: '1.2.5' });
    expect(none.status).toBe(0);
    expect(lastLine(none.stdout)).toBe(`gstack: ok not-needed for=none (no checkout at ${missing}; behind=2 (latest: 1.2.5); before the first workflow run: bash /s/install.sh --for <skill>)`);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('a review-voice verdict for this HEAD and project is upgraded in place by --for <skill>: the installer says so, runs setup, and the verdict becomes the workflow\'s', () => {
    const f = fixture();
    const project = path.join(f.base, 'proj');
    fs.mkdirSync(project, { recursive: true });
    sh('git init -q', project);
    const voice = run(f, ['--for', 'review-voice', '--project', project]);
    expect(voice.status, voice.stdout + voice.stderr).toBe(0);
    expect(voice.stdout).toContain('review-voice: no ./setup and no host profiles');
    expect(f.calls().some(l => l.startsWith('setup '))).toBe(false);
    const full = run(f, ['--for', 'autoplan', '--project', project]);
    expect(full.status, full.stdout + full.stderr).toBe(0);
    expect(full.stdout).toContain(`gstack-capy-install: upgrading the review-voice install in place to --for autoplan (same checkout at ${f.root}; the project's pins apply, ./setup and both host profiles run now; no second clone)`);
    expect(full.stdout).toContain(`gstack-capy-install: reusing ${f.root} (1.2.3); never reset or pulled`);
    expect(f.calls().filter(l => l.startsWith('setup ')).length).toBe(2);
    const verdict = full.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)/)![1]!;
    expect(JSON.parse(fs.readFileSync(verdict, 'utf8'))).toMatchObject({ for: 'autoplan', ok: true });
    expect(lastLine(full.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    // The message is for the review-voice -> workflow step only: a rerun of the same profile, a --check and a second review-voice install stay silent.
    const upgrading = /upgrading the review-voice install in place/;
    expect(run(f, ['--for', 'autoplan', '--project', project]).stdout).not.toMatch(upgrading);
    expect(run(f, ['--check', '--for', 'autoplan', '--project', project]).stdout).not.toMatch(upgrading);
    expect(run(f, ['--for', 'review-voice', '--project', project]).stdout).not.toMatch(upgrading);
  });

  // #3561: on a shared machine /ship's docs step runs the installer --for document-release, whose
  // narrower verdict replaced the --for ship one, so /ship lost admission mid-run.
  test('--for ship then --for document-release: the verdict keeps both and admits both workflows; another HEAD replaces it', () => {
    const f = fixture();
    const env = { HOME: f.home, GSTACK_HOME: path.join(f.home, '.gstack-state') };
    const admits = (skill: string) => verdictProblem(skill, f.root, env, '', '1.4.2', f.home);
    const ship = run(f, ['--for', 'ship'], { STUB_REQUIRED: 'claude codex patch runtime pins' });
    expect(ship.status, ship.stdout + ship.stderr).toBe(0);
    const file = ship.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)/)![1]!;
    expect(admits('ship')).toBeNull();
    const docs = run(f, ['--for', 'document-release'], { STUB_REQUIRED: 'claude runtime pins' });
    expect(docs.status, docs.stdout + docs.stderr).toBe(0);
    expect(docs.stdout).toContain(`gstack-capy-install: the install verdict at ${file} keeps for=ship and adds document-release (for=ship,document-release)`);
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(v).toMatchObject({ ok: true, for: 'ship,document-release', pins_planning_only: false });
    expect([...v.required].sort()).toEqual(['claude', 'codex', 'patch', 'pins', 'runtime']);
    expect(admits('ship')).toBeNull();
    expect(admits('document-release')).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(v);
    const again = run(f, ['--check', '--for', 'ship'], { STUB_REQUIRED: 'claude codex patch runtime pins' });
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain('keeps for=');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ for: 'ship,document-release' });
    sh('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m next', f.root);
    const moved = run(f, ['--for', 'document-release'], { STUB_REQUIRED: 'claude runtime pins' });
    expect(moved.status, moved.stdout + moved.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ for: 'document-release', required: ['claude', 'runtime', 'pins'] });
    expect(admits('ship')?.detail).toBe('the install verdict certified for=document-release, which does not cover codex that ship needs');
  });

  test('--root clones when the directory is absent and refuses a non-gstack directory', () => {
    const f = fixture();
    const clone = path.join(f.base, 'clone');
    const r = run(f, ['--root', clone], { GSTACK_CAPY_REPO: f.root });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`cloning ${f.root} into ${clone}`);
    expect(r.stdout).toMatch(new RegExp(`^gstack-capy-install: cloned ${f.root} into ${clone} at [0-9a-f]{12} \\(1\\.2\\.3\\)$`, 'm'));
    const handed = run(f, [], { GSTACK_CAPY_CLONED: 'https://github.com/garrytan/gstack.git' });
    expect(handed.stdout).toMatch(new RegExp(`^gstack-capy-install: cloned https://github\\.com/garrytan/gstack\\.git into ${f.root} at [0-9a-f]{12} \\(1\\.2\\.3\\)$`, 'm'));
    expect(handed.stdout).not.toContain('reusing');
    expect(fs.existsSync(path.join(clone, 'setup'))).toBe(true);
    const occupied = path.join(f.base, 'occupied');
    write(path.join(occupied, 'README.md'), 'x');
    const refused = run(f, ['--root', occupied]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('is not a gstack checkout');
  });
});

// Field wave lane A (items 3 and 5): the launch line carries the verified Bun
// the trailer certified, an installed Bun is reused, a project's exact CI pin
// is installed alongside a different PATH Bun, ./setup is skipped when this
// HEAD was already set up, and a verdict file records what was certified.
describe('gstack-capy-install: launch PATH, Bun reuse, CI pins, setup skip, verdict', () => {
  const zipBun = (f: ReturnType<typeof fixture>, version: string, runsTs = false) => {
    const target = sh('grep -q avx2 /proc/cpuinfo && echo linux-x64 || echo linux-x64-baseline').stdout.trim();
    const zip = path.join(f.base, `bun-${version}.zip`);
    fs.mkdirSync(path.join(f.base, `z/bun-${target}`), { recursive: true });
    script(path.join(f.base, `z/bun-${target}/bun`), runsTs
      ? [`[ "$1" = --version ] && { echo ${version}; exit 0; }`, `exec "${process.execPath}" "$@"`]
      : [`echo ${version}`]);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-${target}`).status).toBe(0);
    trustZip(f.root, version, target, zip);
    sh('git add -A && git -c user.email=t@t -c user.name=t commit -qm sha', f.root);
    return zip;
  };
  const verdicts = (f: ReturnType<typeof fixture>) => {
    const dir = path.join(f.home, '.gstack-state/install-verdicts');
    // Verdicts only: the launch file (<verdict>.env, GSTA-104) and the launch directory sit beside them.
    return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap(n => fs.statSync(path.join(dir, n)).isDirectory() ? fs.readdirSync(path.join(dir, n)).map(m => path.join(dir, n, m)) : [path.join(dir, n)]).filter(p => p.endsWith('.json')) : [];
  };

  test.skipIf(process.platform !== 'linux')('after installing Bun the launch line carries its PATH; a second run reuses it (one download) and skips setup on the same HEAD', () => {
    const f = fixture({ bun: '1.3.14' });
    const zip = zipBun(f, BUN_DEFAULT);
    const bunDir = store(f, BUN_DEFAULT);
    const first = run(f, ['--for', 'autoplan'], { STUB_CURL_ZIP: zip });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain(`GSTACK_LAUNCH: PATH=${bunDir}:$PATH GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=${path.join(f.home, '.gstack-state')} GSTACK_EPHEMERAL=1 GSTACK_CAPY=1 GSTACK_INSTALL_VERDICT=`);
    expect(first.stdout).toContain(`GSTACK_LAUNCH_PATH: ${bunDir}`);
    // GSTA-104: the same assignments as a sourceable, mode-0600 file beside the verdict. Sourcing it
    // twice prepends the launch PATH once; nothing in it is printed by sourcing. A caller hands a
    // child this path, never `export $(...)` (an empty substitution leaves a bare `export`, which
    // dumps the environment: that is how GSTA-96's docs-audit child leaked three API keys).
    const launchFile = first.stdout.match(/^GSTACK_LAUNCH_FILE: (.+)$/m)?.[1] ?? '';
    const verdictFile = first.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)/)?.[1] ?? '';
    expect(launchFile).toBe(verdictFile.replace(/\.json$/, '.env'));
    expect(fs.statSync(launchFile).mode & 0o777).toBe(0o600);
    const sourced = sh(`. "${launchFile}" && . "${launchFile}" && printf '%s\\n' "$PATH" "$GSTACK_SESSION_KIND" "$GSTACK_STATE_ROOT" "$GSTACK_EPHEMERAL" "$GSTACK_CAPY" "$GSTACK_INSTALL_VERDICT"`);
    expect(sourced.status, sourced.stderr).toBe(0);
    const [sourcedPath, ...rest] = sourced.stdout.trimEnd().split('\n');
    expect(sourcedPath.split(':').filter(p => p === bunDir)).toHaveLength(1);
    expect(sourcedPath.startsWith(`${bunDir}:`)).toBe(true);
    expect(rest).toEqual(['unattended', path.join(f.home, '.gstack-state'), '1', '1', verdictFile]);
    const second = run(f, ['--for', 'autoplan'], { STUB_CURL_ZIP: zip });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain(`bun ${BUN_DEFAULT} at ${bunDir}/bun`);
    expect(second.stdout).toContain(`GSTACK_LAUNCH: PATH=${bunDir}:$PATH `);
    expect(f.calls().filter(l => l.startsWith('curl '))).toHaveLength(1);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(2);
    expect(second.stdout).toContain('setup skipped');
    expect(lastLine(second.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
  });

  test('setup runs only on the first of two runs on one HEAD; a new HEAD, a failed doctor or --with-browser runs it again', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    expect(run(f).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(2);
    expect(run(f, [], { STUB_DOCTOR_FAIL: '1' }).status).toBe(1);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(4);
    write(path.join(f.root, 'NEW'), 'x\n');
    sh('git add NEW && git -c user.email=t@t -c user.name=t commit -qm next', f.root);
    expect(run(f).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(6);
    expect(run(f, ['--with-browser']).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(8);
  });

  test('a setup that fails once leaves the trailer fail, records ok:false and removes the earlier launch file; the next run sets up again and ends ok', () => {
    const f = fixture();
    const first = run(f);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const launchFile = first.stdout.match(/^GSTACK_LAUNCH_FILE: (.+)$/m)?.[1] ?? '';
    expect(fs.existsSync(launchFile)).toBe(true);
    sh('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m next', f.root);
    const failed = run(f, [], { STUB_SETUP_EXIT: '1' });
    expect(failed.status).toBe(1);
    expect(lastLine(failed.stdout)).toMatch(/^gstack: fail setup/);
    expect(failed.stdout).not.toMatch(/^GSTACK_LAUNCH_FILE:/m);
    expect(fs.existsSync(launchFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(launchFile.replace(/\.env$/, '.json'), 'utf8'))).toMatchObject({ ok: false });
    expect(run(f).status).toBe(0);
    expect(fs.existsSync(launchFile)).toBe(true);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(5);
  });

  test.skipIf(process.platform !== 'linux')('PATH Bun 1.4.3 and a CI pin of 1.4.2: the pinned verified Bun is installed alongside and launched with its PATH', () => {
    const f = fixture({ bun: '1.4.3' });
    script(path.join(f.stub, 'bun'), ['[ "$1" = --version ] && { echo 1.4.3; exit 0; }', `exec "${process.execPath}" "$@"`]);
    for (const rel of ['bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts']) write(path.join(f.root, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755);
    const zip = zipBun(f, '1.4.2', true);
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=1.4.0" } }\n');
    write(path.join(project, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.4.2\n');
    const r = run(f, ['--for', 'review', '--project', project], { STUB_CURL_ZIP: zip });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('curl '))).toHaveLength(1);
    expect(f.calls().find(l => l.startsWith('curl '))).toContain('bun-v1.4.2/bun-');
    expect(fs.existsSync(path.join(store(f, '1.4.2'), 'bun'))).toBe(true);
    expect(fs.existsSync(path.join(f.home, '.bun/bin/bun'))).toBe(false);
    expect(r.stdout).toContain(`GSTACK_LAUNCH: PATH=${store(f, '1.4.2')}:$PATH `);
    const other = fixture({ bun: '1.4.3' });
    script(path.join(other.stub, 'bun'), ['[ "$1" = --version ] && { echo 1.4.3; exit 0; }', `exec "${process.execPath}" "$@"`]);
    for (const rel of ['bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts']) write(path.join(other.root, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755);
    write(path.join(project, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.4.1\n');
    const conflict = run(other, ['--project', project]);
    expect(conflict.status).toBe(3);
    expect(conflict.stderr).toContain('pins exactly 1.4.1');
    expect(conflict.stderr).toContain('(RUNTIME_PIN_CONFLICT; ');
  });

  test('the session GSTACK_PREFERENCES_FILE is written into the launch file, so every gstack command finds the owner preferences; without it no line is written', () => {
    const f = fixture();
    const prefs = '/drive/skills/gstack/preferences.yaml';
    const r = run(f, ['--for', 'autoplan'], { GSTACK_PREFERENCES_FILE: prefs });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const launch = verdicts(f)[0].replace(/\.json$/, '.env');
    expect(fs.readFileSync(launch, 'utf8')).toContain("export GSTACK_PREFERENCES_FILE='" + prefs + "'");
    const plain = run(f, ['--for', 'autoplan']);
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(fs.readFileSync(launch, 'utf8')).not.toContain('GSTACK_PREFERENCES_FILE');
  });

  test('the verdict file records checkout, HEAD, workflow, trailer and the Bun resolution, keyed by checkout and project; --check certifies without setup or downloads', () => {
    const f = fixture();
    const r = run(f, ['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const files = verdicts(f);
    expect(files).toHaveLength(1);
    expect(r.stdout).toContain(`GSTACK_INSTALL_VERDICT=${files[0]}`);
    expect(r.stdout).toContain(`GSTACK_LAUNCH_FILE: ${files[0].replace(/\.json$/, '.env')}`);
    expect(fs.readFileSync(files[0].replace(/\.json$/, '.env'), 'utf8')).toContain(`export GSTACK_INSTALL_VERDICT='${files[0]}'`);
    // /ship Step 7 value card. protects: with the certified Bun first on PATH (no GSTACK_LAUNCH_PATH)
    // the launch file prepends nothing, sources under POSIX sh, and only appends the checkout's bin
    // directory once (GSTA-167: a /ship child that sourced only the launch file got
    // `gstack-ship-budget: command not found`, exit 127); --check rewrites and prints it too.
    // fails_when: the PATH guard is dropped (an empty prepend leaves ":"-led PATH, a second source
    // appends the bin directory twice), the file uses a bashism, the bin directory is not on PATH,
    // or --check stops printing GSTACK_LAUNCH_FILE. why_existing_misses: the PATH-bearing case above
    // is sourced by bash only, and the --check run below asserted only the GSTACK_LAUNCH line. seam=none.
    const sourced = spawnSync('sh', ['-c', '. "$1" && . "$1" && printf "%s\\n" "$PATH" "$GSTACK_SESSION_KIND" "$GSTACK_CAPY" "$GSTACK_INSTALL_VERDICT" "$(command -v gstack-paths)"', '_', files[0].replace(/\.json$/, '.env')],
      { encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin' } });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.stdout.trimEnd().split('\n')).toEqual([`/usr/bin:/bin:${f.root}/bin`, 'unattended', '1', files[0], path.join(f.root, 'bin', 'gstack-paths')]);
    const v = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    expect(v).toMatchObject({ schema_version: 2, checkout: f.root, head: sh('git rev-parse HEAD', f.root).stdout.trim(), for: 'autoplan', ok: true, trailer: 'gstack: ok 1.2.3 for=autoplan',
      project: '', bun_path: path.join(f.stub, 'bun'), bun_version: '1.4.2', bun_rule: 'PATH' });
    const sha = (t: string) => sh(`printf %s '${t}' | sha256sum | cut -d' ' -f1`).stdout.trim();
    expect(files[0]).toBe(path.join(f.home, '.gstack-state/install-verdicts', sha(f.root), `${sha('none')}.json`));
    const setups = f.calls().filter(l => l.startsWith('setup ')).length;
    const c = run(f, ['--check', '--for', 'autoplan']);
    expect(c.status, c.stdout + c.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup ')).length).toBe(setups);
    expect(c.stdout).toContain('GSTACK_LAUNCH: ');
    expect(c.stdout).toContain(`GSTACK_LAUNCH_FILE: ${files[0].replace(/\.json$/, '.env')}`);
    expect(lastLine(c.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    const failed = run(f, ['--check', '--for', 'autoplan'], { STUB_DOCTOR_FAIL: '1' });
    expect(failed.status).toBe(1);
    expect(JSON.parse(fs.readFileSync(files[0], 'utf8'))).toMatchObject({ ok: false, trailer: 'gstack: fail codex' });
    // A failing run announces no launch file and removes the one the passing run left, so nothing
    // sourceable points at a verdict that now says fail.
    expect(failed.stdout).not.toMatch(/^GSTACK_LAUNCH_FILE:/m);
    expect(fs.existsSync(files[0].replace(/\.json$/, '.env'))).toBe(false);
  });

  // /ship Step 7 value card. protects: the launch file is part of the ok verdict. When it cannot be
  // written on a passing run, the run FAILS (exit 1, `gstack: fail launch-file — …` trailer naming
  // the fix), prints no GSTACK_LAUNCH_FILE line (a caller must never be handed an empty path to
  // source, and never be left with only the line and the re-typing path) and leaves no temp file
  // behind. The directory is unwritable here, so the earlier launch file and the earlier ok verdict
  // stay as they were. fails_when: the write failure stops setting RC, the trailer loses its fix, or
  // the temp file is created outside the umask/cleanup path. why_existing_misses: every fixture's
  // state root is writable. seam=none (filesystem permissions). no_claim: root.
  test.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('a launch file that cannot be written fails the run with a launch-file trailer, prints no GSTACK_LAUNCH_FILE line and leaves no temp file', () => {
    const f = fixture();
    const first = run(f, ['--for', 'autoplan']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const launchFile = first.stdout.match(/^GSTACK_LAUNCH_FILE: (.+)$/m)?.[1] ?? '';
    const before = fs.readFileSync(launchFile, 'utf8');
    const dir = path.dirname(launchFile);
    fs.chmodSync(dir, 0o555);
    try {
      const c = run(f, ['--check', '--for', 'autoplan']);
      expect(c.status, c.stdout + c.stderr).toBe(1);
      expect(c.stdout).toContain('GSTACK_LAUNCH: ');
      expect(c.stdout).not.toMatch(/^GSTACK_LAUNCH_FILE:/m);
      expect(lastLine(c.stdout)).toBe(`gstack: fail launch-file — could not write the launch file ${launchFile}; fix: make ${dir} writable, or set GSTACK_STATE_ROOT to a writable directory (LAUNCH_FILE_UNWRITABLE)`);
      expect(fs.readdirSync(dir).filter(n => n.includes('.tmp.'))).toEqual([]);
      expect(fs.readFileSync(launchFile, 'utf8')).toBe(before);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  // protects: a failing profile check (--for review-voice) that keeps a fuller ok verdict for this
  // HEAD leaves that verdict's launch file in place while announcing none of its own; the fail
  // branch's cleanup only removes a file whose verdict it rewrites. fails_when: the cleanup runs
  // before the kept-verdict test (the fuller install's sourceable file vanishes under a failing
  // profile check). why_existing_misses: every other failing run owns its verdict.
  test('a failing profile check keeps the fuller verdict and its launch file', () => {
    const f = fixture();
    const first = run(f, ['--for', 'autoplan']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const launchFile = first.stdout.match(/^GSTACK_LAUNCH_FILE: (.+)$/m)?.[1] ?? '';
    const before = fs.readFileSync(launchFile, 'utf8');
    const c = run(f, ['--check', '--for', 'review-voice'], { STUB_DOCTOR_FAIL: '1' });
    expect(c.status, c.stdout + c.stderr).toBe(1);
    expect(c.stdout).toContain(`gstack-capy-install: kept the install verdict for=autoplan at ${launchFile.replace(/\.env$/, '.json')}`);
    expect(c.stdout).not.toMatch(/^GSTACK_LAUNCH_FILE:/m);
    expect(fs.readFileSync(launchFile, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(launchFile.replace(/\.env$/, '.json'), 'utf8'))).toMatchObject({ ok: true });
  });

  // protects: when the launch file's temp file IS created and the final mv fails, write_launch_file
  // removes its own temp file and nothing else (a sibling temp file from a concurrent run survives),
  // the run fails with the launch-file trailer, prints no GSTACK_LAUNCH_FILE line, removes the
  // earlier launch file (its verdict now says fail) and records ok:false. fails_when: the
  // `|| { rm -f "$tmp"; return 1; }` cleanup goes (the temp file stays), a glob cleanup returns (the
  // sibling disappears), or the fail branch stops removing the stale file. why_existing_misses: the
  // unwritable-directory case above fails at mktemp, before any temp file exists, and cannot delete.
  // seam: an mv shim first on PATH that refuses only the launch-file target.
  test('a launch-file move that fails after the temp file exists removes only that temp file and the stale launch file, and fails the run', () => {
    const f = fixture();
    const first = run(f, ['--for', 'autoplan']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const launchFile = first.stdout.match(/^GSTACK_LAUNCH_FILE: (.+)$/m)?.[1] ?? '';
    const sibling = `${launchFile}.tmp.OTHER1`;
    fs.writeFileSync(sibling, '');
    script(path.join(f.stub, 'mv'), [`for a in "$@"; do [ "$a" = "${launchFile}" ] && exit 1; done`, 'exec /bin/mv "$@"']);
    const c = run(f, ['--check', '--for', 'autoplan']);
    expect(c.status, c.stdout + c.stderr).toBe(1);
    expect(c.stdout).not.toMatch(/^GSTACK_LAUNCH_FILE:/m);
    expect(lastLine(c.stdout)).toMatch(/^gstack: fail launch-file — could not write the launch file .*\(LAUNCH_FILE_UNWRITABLE\)$/);
    expect(fs.readdirSync(path.dirname(launchFile)).filter(n => n.includes('.tmp.'))).toEqual([path.basename(sibling)]);
    expect(fs.existsSync(launchFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(launchFile.replace(/\.env$/, '.json'), 'utf8'))).toMatchObject({ ok: false });
  });
});

// Plan A1/A3/A5/A6/A-f: install and --check resolve through one contract,
// never overwrite ~/.bun/bin or $BUN_INSTALL, record the resolution per
// (checkout, project), and report drift with one converging fix.
describe.skipIf(process.platform !== 'linux')('gstack-capy-install: one resolution contract, runtime store, drift', () => {
  const realBun = (file: string, version: string) => script(file, [`[ "$1" = --version ] && { echo ${version}; exit 0; }`, `exec "${process.execPath}" "$@"`]);
  const withPins = (f: ReturnType<typeof fixture>) => { for (const rel of ['bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts']) write(path.join(f.root, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755); };
  const ciProject = (f: ReturnType<typeof fixture>, name: string, bunPin: string) => {
    const project = path.join(f.base, name);
    write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=1.4.0" } }\n');
    write(path.join(project, '.github/workflows/ci.yml'), `jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: ${bunPin}\n`);
    sh('git init -q', project);
    return project;
  };
  const target = () => sh('grep -q avx2 /proc/cpuinfo && echo linux-x64 || echo linux-x64-baseline').stdout.trim();
  const zipFor = (f: ReturnType<typeof fixture>, version: string) => {
    const t = target();
    const dir = path.join(f.base, `z-${version}`);
    realBun(path.join(dir, `bun-${t}/bun`), version);
    const zip = path.join(f.base, `bun-${version}.zip`);
    expect(sh(`cd "${dir}" && zip -qr "${zip}" bun-${t}`).status).toBe(0);
    trustZip(f.root, version, t, zip);
    return zip;
  };
  const verdictFor = (f: ReturnType<typeof fixture>, r: { stdout: string }) => JSON.parse(fs.readFileSync(r.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)/)![1], 'utf8'));
  /** A Bun outside the store launches through the gstack-owned directory beside the verdict, holding only bun and bunx. */
  const expectLaunch = (r: { stdout: string }, bun: string) => {
    const dir = r.stdout.match(/GSTACK_LAUNCH_PATH: (\S+)/)?.[1] ?? '';
    expect(dir).toBe(r.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)\.json/)![1] + '.launch');
    expect(r.stdout).toContain(`GSTACK_LAUNCH: PATH=${dir}:$PATH `);
    expect(fs.readdirSync(dir).sort()).toEqual(['bun', 'bunx']);
    expect(fs.realpathSync(path.join(dir, 'bun'))).toBe(bun);
  };

  test('GBRA-60: 1.4.2 in $BUN_INSTALL and 1.4.3 in ~/.bun/bin with a CI-lane pin of 1.4.3 — install and --check agree on ~/.bun/bin/bun, nothing is downloaded or overwritten', () => {
    const f = fixture({ bun: '1.3.14' });
    withPins(f);
    const bi = path.join(f.base, 'bun-install');
    realBun(path.join(bi, 'bin/bun'), '1.4.2');
    realBun(path.join(f.home, '.bun/bin/bun'), '1.4.3');
    const project = ciProject(f, 'gbrain', '1.4.3');
    const env = { BUN_INSTALL: bi };
    const r = run(f, ['--for', 'review'], env, project);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`bun 1.4.3 at ${f.home}/.bun/bin/bun (~/.bun/bin; satisfies gstack's supported minimum 1.4.2 and the project pin 1.4.3)`);
    expect(f.calls().some(l => l.startsWith('curl '))).toBe(false);
    expect(sh(`"${bi}/bin/bun" --version`).stdout.trim()).toBe('1.4.2');
    expect(verdictFor(f, r)).toMatchObject({ project, pin: '1.4.3', bun_path: `${f.home}/.bun/bin/bun`, bun_version: '1.4.3', bun_rule: 'home' });
    const c = run(f, ['--check', '--for', 'review'], env, project);
    expect(c.status, c.stdout + c.stderr).toBe(0);
    expectLaunch(c, `${f.home}/.bun/bin/bun`);
    const outside = run(f, ['--check', '--for', 'autoplan'], env, f.base);
    expect(outside.status, outside.stdout + outside.stderr).toBe(0);
    expectLaunch(outside, `${bi}/bin/bun`);
  });

  // Integration item 1: gstack's own CI pins 1.4.2 on every lane and the
  // install default on the install-default job. They are alternatives, so the
  // real checkout as --project certifies with either Bun; a repo whose CI pins
  // only 1.4.3 still refuses 1.4.2.
  test('the real gstack checkout as --project with a separate global install certifies with ~/.bun 1.4.2 and with the install default; nothing is downloaded', () => {
    for (const version of ['1.4.2', BUN_DEFAULT]) {
      const f = fixture({ bun: '1.3.14' });
      withPins(f);
      realBun(path.join(f.home, '.bun/bin/bun'), version);
      const r = run(f, ['--for', 'review', '--project', REPO], {}, f.home);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).not.toContain('RUNTIME_PIN_CONFLICT');
      expect(r.stdout).toContain(`bun ${version} at ${f.home}/.bun/bin/bun ($BUN_INSTALL/bin; satisfies gstack's supported minimum 1.4.2 and the project's CI pins (alternatives: 1.4.2 ${BUN_DEFAULT}))`);
      expect(f.calls().some(l => l.startsWith('curl '))).toBe(false);
      expect(verdictFor(f, r)).toMatchObject({ project: REPO, bun_version: version, bun_rule: 'BUN_INSTALL' });
      expect(run(f, ['--check', '--for', 'review', '--project', REPO], {}, f.home).status).toBe(0);
    }
  });

  test('CI alternatives with nothing installed: the install default is published when it is one of them; a gbrain-like repo (CI 1.4.3 only) refuses ~/.bun 1.4.2 and installs 1.4.3', () => {
    const f = fixture({ bun: '1.3.14' });
    withPins(f);
    const r = run(f, ['--for', 'review', '--project', REPO], { STUB_CURL_ZIP: zipFor(f, BUN_DEFAULT) }, f.home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`bun ${BUN_DEFAULT} at ${store(f, BUN_DEFAULT)}/bun (`);
    const g = fixture({ bun: '1.3.14' });
    withPins(g);
    realBun(path.join(g.home, '.bun/bin/bun'), '1.4.2');
    const project = ciProject(g, 'gbrain', '1.4.3');
    const gr = run(g, ['--for', 'review'], { STUB_CURL_ZIP: zipFor(g, '1.4.3') }, project);
    expect(gr.status, gr.stdout + gr.stderr).toBe(0);
    expect(gr.stdout).toContain(`judged: bun 1.4.2 at ${g.home}/.bun/bin/bun (BUN_INSTALL)`);
    expect(gr.stdout).toContain(`bun 1.4.3 at ${store(g, '1.4.3')}/bun (the project's exact pin`);
  });

  test('GSTA-64: a gbrain-like repo whose CI pins only 1.4.4 refuses ~/.bun 1.4.3 and installs the verified 1.4.4 archive instead of stopping with RUNTIME_PIN_CONFLICT', () => {
    const f = fixture({ bun: '1.3.14' });
    withPins(f);
    realBun(path.join(f.home, '.bun/bin/bun'), '1.4.3');
    const project = ciProject(f, 'gbrain', '1.4.4');
    const r = run(f, ['--for', 'review'], { STUB_CURL_ZIP: zipFor(f, '1.4.4') }, project);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('RUNTIME_PIN_CONFLICT');
    expect(r.stdout).toContain(`judged: bun 1.4.3 at ${f.home}/.bun/bin/bun (BUN_INSTALL)`);
    expect(f.calls().filter(l => l.startsWith('curl '))).toEqual([expect.stringContaining('https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux')]);
    expect(r.stdout).toContain(`bun 1.4.4 at ${store(f, '1.4.4')}/bun (the project's exact pin`);
  });

  test('no installed Bun satisfies the pins: the line names the Bun actually judged, the exact pin is published in the store, and the next --check agrees', () => {
    const f = fixture({ bun: '1.3.14' });
    withPins(f);
    const bi = path.join(f.base, 'bun-install');
    realBun(path.join(bi, 'bin/bun'), '1.4.2');
    const project = ciProject(f, 'gbrain', '1.4.3');
    const env = { BUN_INSTALL: bi, STUB_CURL_ZIP: zipFor(f, '1.4.3') };
    const r = run(f, ['--for', 'review'], env, project);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`no installed Bun satisfies gstack's supported minimum 1.4.2 and the project pins bun >=1.4.0 (engines.bun, package.json:1); bun 1.4.3 (CI linux lane, ci.yml:7) (judged: bun 1.4.2 at ${bi}/bin/bun (BUN_INSTALL), bun 1.3.14 at ${f.stub}/bun (PATH)); installing bun 1.4.3`);
    expect(r.stdout).not.toContain(`bun 1.3.14 at ${f.stub}/bun does not satisfy`);
    expect(r.stdout).toContain(`bun 1.4.3 at ${store(f, '1.4.3')}/bun (the project's exact pin, from gstack's runtime store;`);
    expect(fs.readlinkSync(path.join(store(f, '1.4.3'), 'bunx'))).toBe('bun');
    expect(sh(`"${bi}/bin/bun" --version`).stdout.trim()).toBe('1.4.2');
    const c = run(f, ['--check', '--for', 'review'], { BUN_INSTALL: bi }, project);
    expect(c.status, c.stdout + c.stderr).toBe(0);
  });

  test('a broken store entry is repaired in place: the version directory is never moved aside, bun is renamed over its predecessor and bunx is published', () => {
    const f = fixture({ bun: '1.3.14' });
    withPins(f);
    const dir = store(f, BUN_DEFAULT);
    realBun(path.join(dir, 'bun'), '1.4.0');
    const inode = fs.statSync(dir).ino;
    const r = run(f, ['--for', 'autoplan'], { BUN_INSTALL: '', STUB_CURL_ZIP: zipFor(f, BUN_DEFAULT) }, f.base);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.statSync(dir).ino).toBe(inode);
    expect(sh(`"${dir}/bun" --version`).stdout.trim()).toBe(BUN_DEFAULT);
    expect(fs.readlinkSync(path.join(dir, 'bunx'))).toBe('bun');
    expect(fs.readdirSync(path.dirname(dir)).filter(n => n.startsWith('.tmp'))).toEqual([]);
  });

  test('drift: a deleted recorded Bun fails --check with BUN_RESOLUTION_DRIFT, and following the printed fix makes the next --check pass', () => {
    const f = fixture({ bun: '1.3.14' });
    withPins(f);
    const bi = path.join(f.base, 'bun-install');
    realBun(path.join(bi, 'bin/bun'), '1.4.2');
    realBun(path.join(f.home, '.bun/bin/bun'), '1.4.3');
    const project = ciProject(f, 'gbrain', '1.4.3');
    expect(run(f, ['--for', 'review'], { BUN_INSTALL: bi }, project).status).toBe(0);
    fs.rmSync(path.join(f.home, '.bun/bin/bun'));
    const c = run(f, ['--check', '--for', 'review'], { BUN_INSTALL: bi, GSTACK_CAPY_WRAPPER_PATH: '/drive/install.sh' }, project);
    expect(c.status).toBe(1);
    expect(c.stdout).toContain(`FAIL runtime — bun resolution drifted: recorded bun 1.4.3 at ${f.home}/.bun/bin/bun (home), now no eligible bun; changed: the recorded binary is gone; fix: bash /drive/install.sh --for review (reinstalls bun 1.4.3 into ${path.dirname(store(f, '1.4.3'))})`);
    expect(lastLine(c.stdout)).toBe('gstack: fail runtime');
    expect(verdictFor(f, c)).toMatchObject({ ok: false, bun_path: `${f.home}/.bun/bin/bun` });
    expect(run(f, ['--for', 'review'], { BUN_INSTALL: bi, STUB_CURL_ZIP: zipFor(f, '1.4.3') }, project).status).toBe(0);
    const again = run(f, ['--check', '--for', 'review'], { BUN_INSTALL: bi }, project);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(lastLine(again.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
  });

  // Integration item 5: drift is only the recorded Bun gone, changed or no
  // longer satisfying the pins. A changed BUN_INSTALL or a newly populated
  // store default is a note, and the recorded Bun stays the launch Bun.
  test('drift false positives: a changed BUN_INSTALL or a newer store default only notes; the recorded Bun stays certified and launched', () => {
    const f = fixture({ bun: '1.3.14' });
    const bi = path.join(f.base, 'bun-install');
    realBun(path.join(bi, 'bin/bun'), '1.4.2');
    expect(run(f, ['--for', 'autoplan'], { BUN_INSTALL: bi }).status).toBe(0);
    const unset = run(f, ['--check', '--for', 'autoplan'], { BUN_INSTALL: '' });
    expect(unset.status, unset.stdout + unset.stderr).toBe(0);
    expectLaunch(unset, `${bi}/bin/bun`);
    realBun(path.join(store(f, BUN_DEFAULT), 'bun'), BUN_DEFAULT);
    const newer = run(f, ['--check', '--for', 'autoplan'], { BUN_INSTALL: bi });
    expect(newer.status, newer.stdout + newer.stderr).toBe(0);
    expect(newer.stdout).toContain(`note: the recorded bun 1.4.2 at ${bi}/bin/bun stays certified; bun ${BUN_DEFAULT} at ${store(f, BUN_DEFAULT)}/bun (default) would now resolve first; run ${f.root}/bin/gstack-capy-install --for autoplan to record the current resolution`);
    expectLaunch(newer, `${bi}/bin/bun`);
    expect(newer.stdout).not.toContain('BUN_RESOLUTION_DRIFT');
    expect(run(f, ['--for', 'autoplan'], { BUN_INSTALL: bi }).status).toBe(0);
    const recorded = run(f, ['--check', '--for', 'autoplan'], { BUN_INSTALL: bi });
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).not.toContain('note: the recorded bun');
  });

  test('drift: a recorded Bun that no longer satisfies the project pins fails --check with BUN_RESOLUTION_DRIFT', () => {
    const f = fixture({ bun: '1.3.14' });
    withPins(f);
    realBun(path.join(f.home, '.bun/bin/bun'), '1.4.2');
    const project = ciProject(f, 'p', '1.4.2');
    expect(run(f, ['--for', 'review'], { BUN_INSTALL: '' }, project).status).toBe(0);
    write(path.join(project, '.github/workflows/ci.yml'), fs.readFileSync(path.join(project, '.github/workflows/ci.yml'), 'utf8').replace('1.4.2', '1.4.3'));
    const c = run(f, ['--check', '--for', 'review'], { BUN_INSTALL: '' }, project);
    expect(c.status).toBe(1);
    expect(c.stdout).toContain('changed: bun 1.4.2 no longer satisfies gstack\'s supported minimum 1.4.2 and the project pins');
    expect(lastLine(c.stdout)).toBe('gstack: fail runtime');
  });

  test('GSTACK_BUN_INSTALL_VERSION picks a verified install version and is shown; an unverified one stops before anything is installed', () => {
    const f = fixture({ bun: '1.3.14' });
    const bad = run(f, [], { GSTACK_BUN_INSTALL_VERSION: '1.4.9' });
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain('GSTACK_BUN_INSTALL_VERSION=1.4.9 is not a verified Bun at or above gstack\'s supported minimum 1.4.2 (verified archives: 1.4.2 1.4.3 1.4.4)');
    expect(bad.stderr).toContain('(BUN_INSTALL_VERSION_INVALID; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#bun-install-version-invalid)');
    expect(f.calls().some(l => l.startsWith('curl ') || l.startsWith('setup '))).toBe(false);
    const r = run(f, ['--for', 'autoplan'], { GSTACK_BUN_INSTALL_VERSION: '1.4.2', STUB_CURL_ZIP: zipFor(f, '1.4.2') });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`install version 1.4.2 from GSTACK_BUN_INSTALL_VERSION (default ${BUN_DEFAULT})`);
    expect(r.stdout).toContain(`bun 1.4.2 at ${store(f, '1.4.2')}/bun (gstack's install default, from gstack's runtime store;`);
  });

  test('concurrent installs for two projects each record their own verdict', () => {
    const f = fixture();
    const a = ciProject(f, 'a', '1.4.2'), b = ciProject(f, 'b', '1.4.2');
    const cmd = `bash "${f.root}/bin/gstack-capy-install" --for review --project "${a}" > "${f.base}/a.out" 2>&1 & bash "${f.root}/bin/gstack-capy-install" --for review --project "${b}" > "${f.base}/b.out" 2>&1 & wait`;
    const r = spawnSync('bash', ['-c', cmd], { cwd: f.home, encoding: 'utf8', timeout: 120_000, env: { ...f.env } });
    expect(r.status).toBe(0);
    for (const [p, out] of [[a, 'a.out'], [b, 'b.out']] as const) {
      const text = fs.readFileSync(path.join(f.base, out), 'utf8');
      expect(lastLine(text), text).toBe('gstack: ok 1.2.3 for=autoplan');
      expect(verdictFor(f, { stdout: text })).toMatchObject({ project: p, ok: true });
    }
  });
});

// Plan A4/A-e: on Capy the installer writes marked ~/.local/bin/bun and bunx
// shims that run the Bun recorded for the project around the working
// directory, in a fresh shell with Capy's PATH and no gstack environment.
describe.skipIf(process.platform !== 'linux')('gstack-capy-install: the per-directory bun shim', () => {
  const realBun = (file: string, version: string) => script(file, [`[ "$1" = --version ] && { echo ${version}; exit 0; }`, `exec "${process.execPath}" "$@"`]);
  const repo = (f: ReturnType<typeof fixture>, name: string, pin?: string) => {
    const dir = path.join(f.base, name);
    fs.mkdirSync(dir, { recursive: true });
    if (pin) write(path.join(dir, '.bun-version'), `${pin}\n`);
    sh('git init -q', dir);
    return dir;
  };
  /** A fresh non-login shell: Capy's PATH (~/.local/bin first), HOME, nothing from gstack. */
  const fresh = (f: ReturnType<typeof fixture>, cwd: string, cmd: string, extra: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30_000, env: { HOME: f.home, PATH: `${f.home}/.local/bin:${f.env.PATH}`, ...extra } });

  test('fresh shells alternate between two exact pins, an unpinned project and a directory outside any project; custom state root, no env', () => {
    const f = fixture({ bun: '1.3.14' });
    fs.mkdirSync(path.join(f.home, '.capy/system'), { recursive: true });
    const state = path.join(f.base, 'custom-state');
    const storeDir = path.join(state, 'runtimes/bun');
    realBun(path.join(storeDir, '1.4.2/bun'), '1.4.2');
    realBun(path.join(storeDir, `${BUN_DEFAULT}/bun`), BUN_DEFAULT);
    const a = repo(f, 'a', '1.4.2'), b = repo(f, 'b', BUN_DEFAULT), c = repo(f, 'c');
    for (const dir of [a, b, c]) {
      const r = run(f, ['--for', 'review'], { GSTACK_STATE_ROOT: state }, dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
    const shim = fs.readFileSync(path.join(f.home, '.local/bin/bun'), 'utf8');
    expect(shim.split('\n')[1]).toBe('# gstack-bun-shim: gstack-owned; delete this file to remove it');
    expect(shim).toContain(`store='${storeDir}'`);
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    for (const [dir, want] of [[a, '1.4.2'], [b, BUN_DEFAULT], [a, '1.4.2'], [c, BUN_DEFAULT], [outside, BUN_DEFAULT], [b, BUN_DEFAULT]] as const) {
      const r = fresh(f, dir, 'bun --version');
      expect(r.stdout.trim(), `${dir}\n${r.stderr}`).toBe(want);
      expect(r.stderr).toBe('');
    }
    const explained = fresh(f, path.join(a), 'mkdir -p sub && cd sub && bun --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' });
    expect(explained.stderr).toMatch(new RegExp(`^gstack bun shim: project=${a} record=${state}/install-verdicts/[0-9a-f]{64}/[0-9a-f]{64}\\.json chose=${storeDir}/1\\.4\\.2/bun rule=record\\n$`));
    expect(fresh(f, outside, 'bun --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' }).stderr).toBe(`gstack bun shim: project=none record=none chose=${storeDir}/${BUN_DEFAULT}/bun rule=default\n`);
    const bunx = fresh(f, a, 'bunx --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' });
    expect(bunx.stderr).toContain(`chose=${storeDir}/1.4.2/bun rule=record`);
    const unrecordedPinned = repo(f, 'd', '1.4.2');
    const d = fresh(f, unrecordedPinned, 'bun --version');
    expect([d.stdout.trim(), d.stderr]).toEqual(['1.4.2', '']);
    const unrecorded = repo(f, 'e');
    // Integration item 6: an unrecorded, unpinned repo falls through quietly;
    // only GSTACK_BUN_SHIM_EXPLAIN=1 names the missing record.
    const e = fresh(f, unrecorded, 'bun --version');
    expect([e.stdout.trim(), e.stderr]).toEqual([BUN_DEFAULT, '']);
    expect(fresh(f, unrecorded, 'bun --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' }).stderr).toContain(`gstack bun shim: ${unrecorded} has no recorded Bun and no exact pin; run ${f.root}/bin/gstack-capy-install --check here to record one\n`);
  });

  // Integration item 3: a repo's pin never steers the shim outside the store.
  test('the generated shim rejects a traversal pin, a store entry that is a symlink escape, and a marker-carrying store binary; none of them runs', () => {
    const f = fixture({ bun: '1.3.14' });
    fs.mkdirSync(path.join(f.home, '.capy/system'), { recursive: true });
    const state = path.join(f.base, 'state');
    const storeDir = path.join(state, 'runtimes/bun');
    realBun(path.join(storeDir, `${BUN_DEFAULT}/bun`), BUN_DEFAULT);
    expect(run(f, ['--for', 'autoplan'], { GSTACK_STATE_ROOT: state }, f.base).status).toBe(0);
    const pwned = path.join(f.base, 'pwned');
    const payload = (dir: string) => script(path.join(dir, 'bun'), [`touch "${pwned}"`, 'echo payload']);
    const evilRepo = repo(f, 'repo');
    payload(path.join(evilRepo, 'payload'));
    write(path.join(evilRepo, '.bun-version'), '../../../repo/payload\n');
    expect(fs.existsSync(path.join(storeDir, '../../../repo/payload/bun'))).toBe(true);
    const t = fresh(f, evilRepo, 'bun --version');
    expect(t.stdout.trim()).toBe(BUN_DEFAULT);
    expect(t.stderr).toContain(`${evilRepo} pins bun ../../../repo/payload, which is not in gstack's runtime store`);
    payload(path.join(f.base, 'evil'));
    fs.symlinkSync(path.join(f.base, 'evil'), path.join(storeDir, '1.4.9'));
    const escape = fresh(f, repo(f, 'escape', '1.4.9'), 'bun --version');
    expect(escape.stdout.trim()).toBe(BUN_DEFAULT);
    write(path.join(storeDir, '1.4.8/bun'), '#!/bin/sh\n# gstack-bun-shim: gstack-owned; delete this file to remove it\necho loop\n', 0o755);
    const marked = fresh(f, repo(f, 'marked', '1.4.8'), 'bun --version');
    expect(marked.stdout.trim()).toBe(BUN_DEFAULT);
    expect(fs.existsSync(pwned)).toBe(false);
  });

  // Integration item 4: outside a project and inside the gstack checkout the
  // shim reads the 'none' record, then falls back in the resolver's order.
  test('empty store, Capy-style PATH with the image bun 1.3.14: an install that reused off-PATH ~/.bun/bin 1.4.2 is what a fresh shell runs outside a project and in the checkout; without the record ~/.bun/bin still wins over PATH', () => {
    const f = fixture({ bun: '1.3.14' });
    fs.mkdirSync(path.join(f.home, '.capy/system'), { recursive: true });
    realBun(path.join(f.home, '.bun/bin/bun'), '1.4.2');
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    const r = run(f, ['--for', 'autoplan'], { BUN_INSTALL: '' }, outside);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`bun 1.4.2 at ${f.home}/.bun/bin/bun (~/.bun/bin;`);
    expect(fs.existsSync(path.join(f.home, `.gstack-state/runtimes/bun/${BUN_DEFAULT}`))).toBe(false);
    for (const dir of [outside, f.root]) {
      const e = fresh(f, dir, 'bun --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' });
      expect(e.stdout.trim(), e.stderr).toBe('1.4.2');
      expect(e.stderr).toContain(`chose=${f.home}/.bun/bin/bun rule=record`);
    }
    fs.rmSync(path.join(f.home, '.gstack-state/install-verdicts'), { recursive: true, force: true });
    const home = fresh(f, outside, 'bun --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' });
    expect(home.stdout.trim()).toBe('1.4.2');
    expect(home.stderr).toContain(`record=none chose=${f.home}/.bun/bin/bun rule=home`);
    fs.rmSync(path.join(f.home, '.bun'), { recursive: true, force: true });
    const image = fresh(f, outside, 'bun --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' });
    expect(image.stdout.trim()).toBe('1.3.14');
    expect(image.stderr).toContain(`chose=${f.stub}/bun rule=PATH`);
  });

  test('paths with a single quote are baked safely into both shims', () => {
    const f = fixture({ bun: '1.3.14' });
    fs.mkdirSync(path.join(f.home, '.capy/system'), { recursive: true });
    const state = path.join(f.base, "it's state");
    realBun(path.join(state, `runtimes/bun/${BUN_DEFAULT}/bun`), BUN_DEFAULT);
    const installed = run(f, ['--for', 'autoplan'], { GSTACK_STATE_ROOT: state, GSTACK_EPHEMERAL: '0' }, f.base);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    expect(sh(`sh -n "${f.home}/.local/bin/bun"`).status).toBe(0);
    // /ship Step 7 value card. protects: the launch file single-quotes every path it bakes in, so a
    // state root, launch directory and verdict path holding a quote and a space source under POSIX
    // sh (twice: the PATH prepend stays idempotent) and come back byte-identical, and the file
    // carries the caller's GSTACK_EPHEMERAL rather than a hard-coded 1. fails_when: _sq is replaced
    // by plain interpolation or double quotes, the case pattern loses its quoting, or GSTACK_EPHEMERAL
    // is hard-coded. why_existing_misses: the sourced launch files above live under plain tmp paths
    // with the default GSTACK_EPHEMERAL. seam=none.
    const launchFile = installed.stdout.match(/^GSTACK_LAUNCH_FILE: (.+)$/m)?.[1] ?? '';
    expect(launchFile.startsWith(`${state}/install-verdicts/`), launchFile).toBe(true);
    expect(installed.stdout).toContain(`GSTACK_LAUNCH_PATH: ${state}/runtimes/bun/${BUN_DEFAULT}`);
    const sourced = spawnSync('sh', ['-c', '. "$1" && . "$1" && printf "%s\\n" "$PATH" "$GSTACK_STATE_ROOT" "$GSTACK_EPHEMERAL" "$GSTACK_INSTALL_VERDICT"', '_', launchFile],
      { encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin' } });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.stdout.trimEnd().split('\n')).toEqual([`${state}/runtimes/bun/${BUN_DEFAULT}:/usr/bin:/bin:${f.root}/bin`, state, '0', launchFile.replace(/\.env$/, '.json')]);
    const r = fresh(f, f.base, 'bun --version && bunx --version', { GSTACK_BUN_SHIM_EXPLAIN: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')[0]).toBe(BUN_DEFAULT);
    expect(r.stderr.split(`chose=${state}/runtimes/bun/${BUN_DEFAULT}/bun rule=record`), r.stderr).toHaveLength(3);
  });

  test('a foreign ~/.local/bin/bun or a dangling link is never touched; GSTACK_BUN_SHIM=0 writes nothing; a rerun rewrites only gstack\'s own file', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, '.capy/system'), { recursive: true });
    write(path.join(f.home, '.local/bin/bun'), '#!/bin/sh\necho mine\n', 0o755);
    fs.symlinkSync(path.join(f.base, 'missing'), path.join(f.home, '.local/bin/bunx'));
    const r = run(f, ['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(f.home, '.local/bin/bun'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(fs.readlinkSync(path.join(f.home, '.local/bin/bunx'))).toBe(path.join(f.base, 'missing'));
    expect(r.stdout).toContain(`${f.home}/.local/bin/bun is not gstack's shim (no marker); left untouched, so keep the GSTACK_LAUNCH prefix`);
    const g = fixture();
    fs.mkdirSync(path.join(g.home, '.capy/system'), { recursive: true });
    expect(run(g, [], { GSTACK_BUN_SHIM: '0' }).status).toBe(0);
    expect(fs.existsSync(path.join(g.home, '.local/bin/bun'))).toBe(false);
    expect(run(g).status).toBe(0);
    const first = fs.readFileSync(path.join(g.home, '.local/bin/bun'), 'utf8');
    expect(run(g, [], { GSTACK_STATE_ROOT: path.join(g.base, 'moved') }).status).toBe(0);
    const second = fs.readFileSync(path.join(g.home, '.local/bin/bun'), 'utf8');
    expect(second).not.toBe(first);
    expect(second).toContain(`store='${path.join(g.base, 'moved')}/runtimes/bun'`);
    const plain = fixture();
    expect(run(plain).status).toBe(0);
    expect(fs.existsSync(path.join(plain.home, '.local/bin/bun'))).toBe(false);
  });

  test('the shim adds little over the Bun it runs (fixture timing bound)', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, '.capy/system'), { recursive: true });
    const storeBun = path.join(f.home, `.gstack-state/runtimes/bun/${BUN_DEFAULT}/bun`);
    realBun(storeBun, BUN_DEFAULT);
    expect(run(f).status).toBe(0);
    const time = (cmd: string) => {
      const samples = Array.from({ length: 7 }, () => { const t = performance.now(); fresh(f, f.base, cmd); return performance.now() - t; }).sort((x, y) => x - y);
      return samples[3];
    };
    const overhead = time('bun --version') - time(`"${storeBun}" --version`);
    expect(overhead).toBeLessThan(250);
  });
});

// GBRA-117 / GBRA-122: a project's Node pin resolves and installs like its Bun
// pin, and the launch PATH never puts a shared bin directory (with another
// node in it) in front of PATH.
describe.skipIf(process.platform !== 'linux')('gstack-capy-install: the project Node pin and the launch directory', () => {
  const realBun = (file: string, version: string) => script(file, [`[ "$1" = --version ] && { echo ${version}; exit 0; }`, `exec "${process.execPath}" "$@"`]);
  const fakeNode = (file: string, version: string) => script(file, [`echo v${version}`]);
  const withPins = (f: ReturnType<typeof fixture>) => { for (const rel of ['bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts']) write(path.join(f.root, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755); };
  const nodeProject = (f: ReturnType<typeof fixture>, nodePin: string) => {
    const project = path.join(f.base, 'gbrain');
    write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=1.4.0" } }\n');
    write(path.join(project, '.github/workflows/native-locks.yml'), `jobs:\n  locks:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${nodePin}\n`);
    sh('git init -q', project);
    return project;
  };
  const launchOf = (r: { stdout: string }) => r.stdout.match(/GSTACK_LAUNCH_PATH: (\S+)/)?.[1] ?? '';
  const nodeSeen = (f: ReturnType<typeof fixture>) => f.calls().filter(l => l.startsWith('doctor-node ')).at(-1);
  const nodeTarget = () => (sh('uname -m').stdout.trim() === 'x86_64' ? 'linux-x64' : 'linux-arm64');

  test('Bun resolving into a directory that also holds another node launches through a bun-only directory, so the doctor reads PATH\'s node', () => {
    const f = fixture({ bun: '1.3.14' });
    const bi = path.join(f.base, 'bun-install');
    realBun(path.join(bi, 'bin/bun'), '1.4.2');
    fakeNode(path.join(bi, 'bin/node'), '20.0.0');
    const r = run(f, ['--for', 'autoplan'], { BUN_INSTALL: bi });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const dir = launchOf(r);
    expect(dir).toBe(r.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)\.json/)![1] + '.launch');
    expect(r.stdout).toContain(`GSTACK_LAUNCH: PATH=${dir}:$PATH `);
    expect(r.stdout).not.toContain(`PATH=${bi}/bin:`);
    expect(fs.readdirSync(dir).sort()).toEqual(['bun', 'bunx']);
    expect(fs.realpathSync(path.join(dir, 'bun'))).toBe(path.join(bi, 'bin/bun'));
    expect(nodeSeen(f)).toBe('doctor-node v24.18.0');
  });

  test('gbrain\'s CI Node pin 24.18.0 with node 24.21.0 first on PATH: nvm\'s 24.18.0 is launched and recorded, and --check reuses it', () => {
    const f = fixture();
    withPins(f);
    realBun(path.join(f.stub, 'bun'), '1.4.2');
    fakeNode(path.join(f.stub, 'node'), '24.21.0');
    const nvmNode = path.join(f.home, '.nvm/versions/node/v24.18.0/bin/node');
    fakeNode(nvmNode, '24.18.0');
    const project = nodeProject(f, '24.18.0');
    const r = run(f, ['--for', 'review'], {}, project);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`node 24.18.0 at ${nvmNode} (nvm; satisfies the project's Node pins node 24.18.0 (CI linux lane, native-locks.yml:7))`);
    const dir = launchOf(r);
    expect(fs.readdirSync(dir).sort()).toEqual(['bun', 'bunx', 'node']);
    expect(fs.realpathSync(path.join(dir, 'node'))).toBe(nvmNode);
    expect(fs.realpathSync(path.join(dir, 'bun'))).toBe(path.join(f.stub, 'bun'));
    expect(nodeSeen(f)).toBe('doctor-node v24.18.0');
    expect(f.calls().some(l => l.startsWith('curl '))).toBe(false);
    const verdict = JSON.parse(fs.readFileSync(r.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)/)![1], 'utf8'));
    expect(verdict).toMatchObject({ node_path: nvmNode, node_version: '24.18.0', node_rule: 'nvm', launch_path: dir });
    const c = run(f, ['--check', '--for', 'review'], {}, project);
    expect(c.status, c.stdout + c.stderr).toBe(0);
    expect(launchOf(c)).toBe(dir);
    expect(nodeSeen(f)).toBe('doctor-node v24.18.0');
    fakeNode(path.join(f.stub, 'node'), '24.18.0');
    const kept = run(f, ['--check', '--for', 'review'], {}, project);
    expect(launchOf(kept)).toBe(dir);
    const onPath = run(f, ['--for', 'review'], {}, project);
    expect(onPath.status, onPath.stdout + onPath.stderr).toBe(0);
    expect(onPath.stdout).not.toContain('GSTACK_LAUNCH_PATH');
    expect(JSON.parse(fs.readFileSync(onPath.stdout.match(/GSTACK_INSTALL_VERDICT=(\S+)/)![1], 'utf8'))).toMatchObject({ node_path: path.join(f.stub, 'node'), node_rule: 'PATH', launch_path: '' });
  });

  test('no installed Node satisfies the pin: --check installs nothing; install downloads it into the runtime store checked against SHASUMS256.txt; a mismatch installs nothing', () => {
    const f = fixture();
    withPins(f);
    realBun(path.join(f.stub, 'bun'), '1.4.2');
    fakeNode(path.join(f.stub, 'node'), '24.21.0');
    const project = nodeProject(f, '24.18.0');
    const dist = path.join(f.base, 'dist');
    const name = `node-v24.18.0-${nodeTarget()}`;
    fakeNode(path.join(f.base, 'tree', name, 'bin/node'), '24.18.0');
    fs.mkdirSync(dist, { recursive: true });
    expect(sh(`tar -czf "${dist}/${name}.tar.gz" -C "${f.base}/tree" ${name}`).status).toBe(0);
    const sum = sh(`sha256sum "${dist}/${name}.tar.gz" | cut -d' ' -f1`).stdout.trim();
    write(path.join(dist, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-v24.18.0-other.tar.gz\n${sum}  ${name}.tar.gz\n`);
    const nodeStore = path.join(f.home, '.gstack-state/runtimes/node/24.18.0');

    run(f, ['--check', '--for', 'review'], { STUB_CURL_DIR: dist }, project);
    expect(f.calls().some(l => l.startsWith('curl '))).toBe(false);
    expect(fs.existsSync(nodeStore)).toBe(false);

    write(path.join(dist, 'SHASUMS256.txt'), `${'1'.repeat(64)}  ${name}.tar.gz\n`);
    const bad = run(f, ['--for', 'review'], { STUB_CURL_DIR: dist }, project);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain(`${name}.tar.gz SHA-256 ${sum} does not match SHASUMS256.txt (${'1'.repeat(64)}); nothing installed`);
    expect(bad.stderr).toContain('(INSTALL_PREFLIGHT_FAILED; ');
    expect(fs.existsSync(nodeStore)).toBe(false);

    write(path.join(dist, 'SHASUMS256.txt'), `${sum}  ${name}.tar.gz\n`);
    const r = run(f, ['--for', 'review'], { STUB_CURL_DIR: dist }, project);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('curl ')).slice(-2).map(l => l.split(' ').find(a => a.startsWith('https://')))).toEqual([
      'https://nodejs.org/dist/v24.18.0/SHASUMS256.txt', `https://nodejs.org/dist/v24.18.0/${name}.tar.gz`,
    ]);
    expect(r.stdout).toContain(`node 24.18.0 at ${nodeStore}/bin/node (store; `);
    expect(fs.realpathSync(path.join(launchOf(r), 'node'))).toBe(path.join(nodeStore, 'bin/node'));
    expect(nodeSeen(f)).toBe('doctor-node v24.18.0');
    const calls = f.calls().filter(l => l.startsWith('curl ')).length;
    expect(run(f, ['--for', 'review'], { STUB_CURL_DIR: dist }, project).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('curl ')).length).toBe(calls);
  });
});

function run(f: ReturnType<typeof fixture>, args: string[] = [], extra: Record<string, string> = {}, cwd?: string) {
  return f.run(args, extra, cwd);
}
