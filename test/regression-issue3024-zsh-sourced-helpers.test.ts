/**
 * #3024: skill blocks `source` gstack helpers into whatever shell the host
 * runs. On macOS that is zsh (Claude Code's Bash tool included), where
 * BASH_SOURCE is empty and bash-only expansions such as ${!name} are errors.
 * Since v1.91.16.0 every Codex outside pass from zsh reported
 * `CODEX_MODEL: invalid` because the probe resolved its resolver at
 * "/../scripts/...".
 *
 * Class guard: the helper list is derived from the generated skills and
 * resolvers, plus every helper those helpers source in turn (not a hand list).
 * Each helper is sourced under bash and zsh from an unrelated cwd, by absolute
 * path, by relative path followed by `cd`, and by bare name through PATH, with
 * one real call each to the model resolver, the auth probe, the state root and
 * the egress home. Any other shell, or a shell that cannot name the file, gets
 * the helper's own message instead of a guessed path or a syntax error. CI
 * installs zsh (free-tests.yml, Dockerfile.ci), so a missing zsh there fails
 * instead of skipping.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexPreflight } from '../scripts/resolvers/constants';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const PROBE = path.join(BIN, 'gstack-codex-probe');
const EGRESS = path.join(BIN, 'gstack-egress-lib.sh');
const HAS_ZSH = Boolean(Bun.which('zsh'));
const HAS_DASH = Boolean(Bun.which('dash'));
const ZSH_REQUIRED = Boolean(process.env.CI) && process.platform !== 'win32';
const DASH_REQUIRED = Boolean(process.env.CI) && process.platform === 'linux';
const ANCHOR = 'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#sourced-helper-location';
const SELF_LOCATE = /# === gstack self-locate[^\n]*\n[\s\S]*?# === end gstack self-locate ===\n/;

if (!HAS_ZSH && !ZSH_REQUIRED) console.warn('zsh not installed: install zsh to run the sourced-helper guard (CI requires it)');

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

const code = (text: string) => text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

/**
 * Every bin/ helper a generated skill or resolver loads with `source` or `.`,
 * plus every bin/ file those helpers source in turn (for example
 * gstack-state-root.sh, sourced by the codex probe and the egress lib).
 */
function sourcedHelpers(): string[] {
  const files = [
    ...walk(path.join(ROOT, 'scripts', 'resolvers'), f => f.endsWith('.ts')),
    ...fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'test')
      .flatMap(e => walk(path.join(ROOT, e.name), f => /(?:SKILL\.md|\.md\.tmpl)$/.test(f))),
  ];
  const names = new Set<string>();
  const direct = /(?:^|[\s;&|({]|then\s)(?:source|\.)\s+"?[^"\s;)<]*\bbin\/([A-Za-z0-9._-]+)/g;
  const viaVar = /\/(gstack-[A-Za-z0-9._-]+\.sh)"; \[ -r "\$[A-Z_]+" \] && \. "\$[A-Z_]+"/g;
  const nested = /(?:^|[\s;&|({]|then\s)(?:source|\.)\s+"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/([A-Za-z0-9._-]+)/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of [direct, viaVar]) {
      for (const m of text.matchAll(re)) {
        if (fs.existsSync(path.join(BIN, m[1]!))) names.add(m[1]!);
      }
    }
  }
  const queue = [...names];
  while (queue.length) {
    const text = code(fs.readFileSync(path.join(BIN, queue.shift()!), 'utf8'));
    for (const re of [direct, nested]) {
      for (const m of text.matchAll(re)) {
        if (!names.has(m[1]!) && fs.existsSync(path.join(BIN, m[1]!))) { names.add(m[1]!); queue.push(m[1]!); }
      }
    }
  }
  return [...names].sort();
}

function run(shell: string, script: string, env: Record<string, string> = {}, cwd?: string) {
  const dir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-cwd-'));
  const args = shell === 'zsh' ? ['-f', '-c', script] : shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-c', script];
  const r = spawnSync(shell, args, {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (!cwd) fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A HOME whose ~/.claude/skills/gstack is this checkout, a stub codex that answers OK, and Codex credentials. */
function preflightHome(install: string = ROOT) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-preflight-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(install, path.join(home, '.claude', 'skills', 'gstack'));
  fs.mkdirSync(path.join(home, 'stub-bin'));
  fs.writeFileSync(path.join(home, 'stub-bin', 'codex'), '#!/usr/bin/env bash\n[ "$1" = sandbox ] && exit 0\necho OK\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-test-model"\n');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  const env = {
    PATH: `${path.join(home, 'stub-bin')}:${process.env.PATH ?? ''}`,
    CODEX_HOME: path.join(home, '.codex'),
    GSTACK_HOME: path.join(home, '.gstack'),
  };
  return { home, env };
}

const PREFLIGHT = codexPreflight({ disabledBehavior: 'skip-all' }).match(/```bash\n([\s\S]*?)\n```/)![1]!;
const SHELLS = ['bash', 'zsh'] as const;
const skipShell = (shell: string) => shell === 'zsh' && !HAS_ZSH && !ZSH_REQUIRED;
const skipDash = !HAS_DASH && !DASH_REQUIRED;

describe('#3024: sourced helpers work under bash and zsh', () => {
  const helpers = sourcedHelpers();

  test('zsh (and dash on Linux) is present wherever CI runs this suite', () => {
    if (ZSH_REQUIRED) expect(HAS_ZSH).toBe(true);
    if (DASH_REQUIRED) expect(HAS_DASH).toBe(true);
  });

  test('the derived helper list covers the known sourced helpers, including nested sources', () => {
    for (const known of ['gstack-codex-probe', 'gstack-egress-lib.sh', 'gstack-gbrain-lib.sh', 'gstack-state-root.sh']) {
      expect(helpers).toContain(known);
    }
  });

  test('BASH_SOURCE appears only inside the shared self-locate block, byte for byte in every helper', () => {
    const blocks = new Map<string, string>();
    for (const name of helpers) {
      const text = fs.readFileSync(path.join(BIN, name), 'utf8');
      const block = text.match(SELF_LOCATE)?.[0];
      if (block) blocks.set(name, block);
      expect({ name, outside: code(text.replace(SELF_LOCATE, '')).includes('BASH_SOURCE') }).toEqual({ name, outside: false });
    }
    expect([...blocks.keys()]).toEqual(expect.arrayContaining(['gstack-codex-probe', 'gstack-egress-lib.sh']));
    const [first] = [...blocks.values()];
    for (const [name, block] of blocks) expect({ name, block }).toEqual({ name, block: first! });
  });

  test('no sourced helper uses other bash-only constructs', () => {
    const bashOnly: Array<[string, RegExp]> = [
      ['${!name} indirection', /\$\{![A-Za-z_]/],
      ['declare -n', /\bdeclare\s+-[A-Za-z]*n/],
      ['mapfile/readarray', /\b(?:mapfile|readarray)\b/],
      ['BASH_REMATCH', /\bBASH_REMATCH\b/],
      ['[[ =~ ]]', /\[\[[^\]\n]*=~/],
    ];
    for (const name of helpers) {
      const text = code(fs.readFileSync(path.join(BIN, name), 'utf8'));
      const found = bashOnly.filter(([, re]) => re.test(text)).map(([label]) => label);
      expect({ name, found }).toEqual({ name, found: [] });
    }
  });

  for (const shell of SHELLS) {
    test.skipIf(skipShell(shell))(`every sourced helper parses and sources cleanly (${shell})`, () => {
      for (const name of helpers) {
        const file = path.join(BIN, name);
        const r = run(shell, `${shell} -n '${file}' && . '${file}' && echo SOURCED`);
        expect({ name, out: r.out.trim().split('\n').pop() }).toEqual({ name, out: 'SOURCED' });
      }
    });

    test.skipIf(skipShell(shell))(`codex probe resolves its own directory and selects the model (${shell})`, () => {
      const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-codex-'));
      fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-test-model"\n');
      const r = run(shell, `. '${PROBE}' && echo "BIN=$_GSTACK_CODEX_BIN" && _gstack_codex_select_model exec`, { CODEX_HOME: codexHome });
      fs.rmSync(codexHome, { recursive: true, force: true });
      expect(r.out).toContain(`BIN=${BIN}\n`);
      expect(r.out).toContain('CODEX_MODEL: gpt-test-model (exec;');
      expect(r.out).not.toContain('Module not found');
      expect(r.code).toBe(0);
    });

    test.skipIf(skipShell(shell))(`relative-path and bare-name (PATH) sources keep working after cd (${shell})`, () => {
      // realpath: macOS's temp root is a symlink, and `..` walks the physical path.
      const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-rel-')));
      const codexHome = path.join(cwd, 'codex-home');
      fs.mkdirSync(codexHome);
      fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-test-model"\n');
      const env = { CODEX_HOME: codexHome, GSTACK_HOME: path.join(cwd, 'state') };
      const after = `cd / && _gstack_codex_select_model exec && _gstack_egress_home`;
      try {
        for (const [label, load] of [
          ['relative', `. '${path.relative(cwd, PROBE)}' && . '${path.relative(cwd, EGRESS)}'`],
          ['bare name', `PATH='${BIN}':"$PATH" && . gstack-codex-probe && . gstack-egress-lib.sh`],
        ] as const) {
          const r = run(shell, `${load} && ${after}`, env, cwd);
          expect({ label, model: r.out.includes('CODEX_MODEL: gpt-test-model (exec;'), home: r.stdout.trim() === env.GSTACK_HOME, code: r.code })
            .toEqual({ label, model: true, home: true, code: 0 });
        }
      } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    });

    test.skipIf(skipShell(shell))(`a set (unexported) GSTACK_ROOT locates a helper the shell cannot name; nothing else is guessed (${shell})`, () => {
      const located = run(shell, `GSTACK_ROOT='${ROOT}'; eval "$(cat '${PROBE}')" && echo "BIN=$_GSTACK_CODEX_BIN"`);
      expect(located.out).toContain(`BIN=${BIN}\n`);
      const lost = run(shell, `eval "$(cat '${PROBE}')"; echo "after=$?"`);
      expect(lost.out).toContain(`gstack: cannot locate gstack-codex-probe (shell: ${shell}). Source it from bash or zsh, or export GSTACK_ROOT=<install dir>. ${ANCHOR}`);
      expect(lost.out).not.toContain('after=');
      expect(lost.code).toBe(1);
    });

    test.skipIf(skipShell(shell))(`codex auth probe reads a custom provider's env_key (${shell})`, () => {
      const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-auth-'));
      fs.writeFileSync(path.join(codexHome, 'config.toml'), '[model_providers.local]\nenv_key = "LOCAL_PROVIDER_KEY"\n');
      const r = run(shell, `. '${PROBE}' && _gstack_codex_auth_probe`, {
        CODEX_HOME: codexHome,
        LOCAL_PROVIDER_KEY: 'present',
      });
      fs.rmSync(codexHome, { recursive: true, force: true });
      expect(r.out.trim()).toBe('AUTH_OK');
      expect(r.code).toBe(0);
    });

    test.skipIf(skipShell(shell))(`state root and egress home resolve through the helpers, not the caller's cwd (${shell})`, () => {
      const state = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-state-'));
      try {
        const root = run(shell, `. '${path.join(BIN, 'gstack-state-root.sh')}' && gstack_state_root`, { GSTACK_HOME: state });
        expect(root.out.trim()).toBe(state);
        const egress = run(shell, `. '${EGRESS}' && echo "DIR=$_gstack_egress_lib_dir" && _gstack_egress_home`, { GSTACK_HOME: state });
        expect(egress.out).toContain(`DIR=${BIN}\n`);
        expect(egress.stdout).toBe(`DIR=${BIN}\n${state}`);
      } finally { fs.rmSync(state, { recursive: true, force: true }); }
    });

    test.skipIf(skipShell(shell))(`the full generated Codex preflight reaches CODEX_MODE: ready (${shell})`, () => {
      const { home, env } = preflightHome();
      try {
        const r = run(shell, PREFLIGHT, env, home);
        expect(r.out).toContain('CODEX_MODEL: gpt-test-model (exec;');
        expect(r.out).toContain('CODEX_MODE: ready');
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  }

  test.skipIf(skipDash)('dash reaches each helper\'s message, never a syntax error, even with GSTACK_ROOT set', () => {
    for (const name of ['gstack-codex-probe', 'gstack-egress-lib.sh']) {
      for (const env of [{}, { GSTACK_ROOT: ROOT }] as Record<string, string>[]) {
        const r = run('dash', `. '${path.join(BIN, name)}'; echo "rc=$?"`, env);
        expect([r.stderr, r.stdout]).toEqual([`gstack: cannot locate ${name} (shell: dash). Source it from bash or zsh, or export GSTACK_ROOT=<install dir>. ${ANCHOR}\n`, 'rc=1\n']);
      }
    }
  });

  test('an unknown shell (no BASH_VERSION or ZSH_VERSION) fails loudly instead of guessing', () => {
    const r = run('bash', `unset BASH_VERSION; . '${PROBE}'; echo "rc=$? bin=\${_GSTACK_CODEX_BIN:-unset}"`, { GSTACK_ROOT: ROOT });
    expect(r.out).toContain(`gstack: cannot locate gstack-codex-probe (shell: bash). Source it from bash or zsh, or export GSTACK_ROOT=<install dir>. ${ANCHOR}`);
    expect(r.out).toContain('rc=1 bin=unset');
  });

  for (const [label, shell, prefix, expected] of [
    ['dash', 'dash', '', `gstack: cannot locate gstack-codex-probe (shell: dash). Source it from bash or zsh, or export GSTACK_ROOT=<install dir>. ${ANCHOR}`],
    ['an unknown shell', 'bash', 'unset BASH_VERSION\n', `gstack: cannot locate gstack-codex-probe (shell: bash). Source it from bash or zsh, or export GSTACK_ROOT=<install dir>. ${ANCHOR}`],
  ] as const) {
    test.skipIf(shell === 'dash' && skipDash)(`the full generated preflight under ${label} reports helper_unavailable with the helper's line`, () => {
      const { home, env } = preflightHome();
      try {
        const r = run(shell, `${prefix}${PREFLIGHT}`, env, home);
        expect(r.out).toContain(`${expected}\nCODEX_MODE: helper_unavailable\n`);
        expect(r.out).not.toContain('not_authed');
        expect(r.out).not.toMatch(/Syntax error|not found/);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  }

  test('the full generated preflight with the helper missing reports helper_unavailable, not not_authed', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-empty-install-'));
    const { home, env } = preflightHome(empty);
    try {
      const r = run('bash', PREFLIGHT, env, home);
      expect(r.out).toContain(`gstack: cannot load gstack-codex-probe; re-run ./setup. ${ANCHOR}\nCODEX_MODE: helper_unavailable\n`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('CI keeps zsh: the free lane and the eval image install it, and the macOS lane sources the probe from zsh', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/free-tests.yml'), 'utf8')) as any;
    const runs = (job: string) => (workflow.jobs[job].steps as any[]).map(step => String(step.run ?? '')).join('\n');
    expect(runs('free-suite')).toMatch(/apt-get install[^\n]*\bzsh\b/);
    expect(fs.readFileSync(path.join(ROOT, '.github/docker/Dockerfile.ci'), 'utf8')).toMatch(/apt-get install -y --no-install-recommends \\\n[^\n]*\bzsh\b/);
    const mac = workflow.jobs['macos-named-regressions'];
    expect(mac['runs-on']).toMatch(/^macos-/);
    const step = (mac.steps as any[]).find(s => String(s.run ?? '').includes('_gstack_codex_select_model exec'));
    expect(step?.run).toContain(`zsh -c 'source "$GITHUB_WORKSPACE/bin/gstack-codex-probe" && _gstack_codex_select_model exec'`);
    expect(runs('macos-named-regressions')).toContain('test/regression-issue3024-zsh-sourced-helpers.test.ts');
    if (skipShell('zsh')) return;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-helpers-ci-step-'));
    try {
      const r = run('bash', step.run, { GITHUB_WORKSPACE: ROOT, CODEX_HOME: codexHome });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/CODEX_MODEL: \S+ \(exec; source: /);
    } finally { fs.rmSync(codexHome, { recursive: true, force: true }); }
  });
});
