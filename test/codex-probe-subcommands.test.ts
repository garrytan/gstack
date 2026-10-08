/**
 * bin/gstack-codex-probe is an executed command: one subcommand per probe,
 * KEY: value lines on stdout, human lines where they went before, nothing set
 * in the caller's shell. Generated skills run it as a command, so the calling
 * shell (bash, zsh, sh) no longer matters. Sourcing still works during the
 * compatibility window and says it is deprecated; executing never does.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROBE_SOURCING_DEPRECATION } from './helpers/codex-probe-sourcing';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin', 'gstack-codex-probe');
const HAS_ZSH = Boolean(Bun.which('zsh'));
const ZSH_REQUIRED = Boolean(process.env.CI) && process.platform !== 'win32';
const SHELLS = ['bash', 'zsh'] as const;
const SUBCOMMANDS = ['select-model', 'check-auth', 'show-sandbox', 'check-sandbox', 'probe-model', 'check-version',
  'show-first-use-notice', 'run-with-timeout', 'log-event', 'log-hang', 'help'];

const STUB = `#!/usr/bin/env bash
if [ "$1" = sandbox ]; then
  [ "\${STUB_SANDBOX:-ok}" = ok ] && exit 0
  echo 'bwrap: No permissions to create new namespace' >&2; exit 1
fi
case "$1" in --version) echo "codex-cli \${STUB_VERSION:-0.160.1}"; exit 0 ;; esac
printf '%s\\n' "$*" >> "$STUB_ARGS_LOG"
case "\${STUB_MODE:-ok}" in
  ok) echo OK; exit 0 ;;
  model400) echo 'ERROR: {"type":"error","status":400,"error":{"message":"The model is not supported when using Codex with a ChatGPT account."}}' >&2; exit 1 ;;
  broken) echo 'Error: spawn /usr/lib/codex/vendor/codex ENOENT' >&2; exit 1 ;;
  quota) echo "ERROR: You've hit your usage limit. Try again at Oct 10th, 2026 2:55 AM." >&2; exit 1 ;;
  ratelimit) echo 'ERROR: {"type":"error","status":429,"error":{"type":"rate_limit_exceeded"}}' >&2; exit 1 ;;
  transient) echo 'stream error: network unreachable' >&2; exit 7 ;;
esac
`;

interface Fixture { home: string; env: Record<string, string>; argsLog: string; state: string }

function fixture(config = 'model = "gpt-test-model"\n', auth = true): Fixture {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-sub-')));
  const stubDir = path.join(home, 'stub-bin');
  const codexHome = path.join(home, '.codex');
  const state = path.join(home, '.gstack');
  fs.mkdirSync(stubDir);
  fs.mkdirSync(codexHome);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(stubDir, 'codex'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
  if (auth) fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  const argsLog = path.join(home, 'args.log');
  const env = {
    PATH: [stubDir, path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
    HOME: home,
    CODEX_HOME: codexHome,
    GSTACK_HOME: state,
    STUB_ARGS_LOG: argsLog,
  };
  return { home, env, argsLog, state };
}

function sh(shell: string, script: string, env: Record<string, string>, input?: string) {
  const args = shell === 'zsh' ? ['-f', '-c', script] : ['--noprofile', '--norc', '-c', script];
  const r = spawnSync(shell, args, { env, input, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function probe(f: Fixture, args: string, extra: Record<string, string> = {}, shell = 'bash', input?: string) {
  return sh(shell, `'${PROBE}' ${args}`, { ...f.env, ...extra }, input);
}

const calls = (f: Fixture) => (fs.existsSync(f.argsLog) ? fs.readFileSync(f.argsLog, 'utf8').trim().split('\n') : []);
const skipZsh = !HAS_ZSH && !ZSH_REQUIRED;

describe('gstack-codex-probe subcommands', () => {
  test('help lists every subcommand; unknown or missing subcommands print usage on stderr and exit 64', () => {
    const f = fixture();
    try {
      const help = probe(f, 'help');
      expect(help.code).toBe(0);
      for (const name of SUBCOMMANDS) expect(help.stdout).toContain(`  ${name}`);
      for (const bad of ['', 'select_model', 'auth', 'select-model bogus', 'select-model exec --model', 'probe-model exec extra',
        'run-with-timeout', 'run-with-timeout 5', 'run-with-timeout soon echo hi', 'show-sandbox extra']) {
        const r = probe(f, bad);
        expect({ bad, code: r.code, stdout: r.stdout, usage: r.stderr.startsWith('Usage: gstack-codex-probe') })
          .toEqual({ bad, code: 64, stdout: '', usage: true });
      }
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  for (const shell of SHELLS) {
    test.skipIf(shell === 'zsh' && skipZsh)(`each subcommand runs once as a command from ${shell}, with its KEY: value contract and no deprecation line`, () => {
      const f = fixture();
      try {
        const results: Record<string, ReturnType<typeof probe>> = {
          'select-model': probe(f, 'select-model exec', {}, shell),
          'check-auth': probe(f, 'check-auth', {}, shell),
          'show-sandbox': probe(f, 'show-sandbox', {}, shell),
          'check-sandbox': probe(f, 'check-sandbox', {}, shell),
          'probe-model': probe(f, 'probe-model exec', {}, shell),
          'check-version': probe(f, 'check-version', {}, shell),
          'show-first-use-notice': probe(f, 'show-first-use-notice', {}, shell),
          'run-with-timeout': probe(f, 'run-with-timeout 5 echo ran', {}, shell),
          'log-event': probe(f, 'log-event codex_timeout 540', {}, shell),
          'log-hang': probe(f, 'log-hang review 0', {}, shell),
          help: probe(f, 'help', {}, shell),
        };
        expect(Object.keys(results).sort()).toEqual([...SUBCOMMANDS].sort());
        for (const [name, r] of Object.entries(results)) {
          expect({ name, code: r.code, deprecated: r.stderr.includes('deprecated') }).toEqual({ name, code: 0, deprecated: false });
        }
        expect(results['select-model']!.stdout).toBe('CODEX_SEL: gpt-test-model\nCODEX_SEL_KIND: exec\nCODEX_SANDBOX: read-only\n');
        expect(results['select-model']!.stderr).toContain('CODEX_MODEL: gpt-test-model (exec; source: ');
        expect(results['check-auth']!.stdout).toBe('AUTH_OK\n');
        expect(results['show-sandbox']!.stdout).toBe('CODEX_SANDBOX: read-only\n');
        expect(results['check-sandbox']!.stdout).toBe('');
        expect(results['probe-model']!.stdout).toBe('MODEL_OK\nCODEX_PROBE_STATE: ok\n');
        expect(results['check-version']!.stdout).toBe('');
        expect(results['show-first-use-notice']!.stdout).toBe('');
        expect(results['show-first-use-notice']!.stderr).toContain('NOTICE: gstack outside reviews send the review prompt and code to Codex');
        expect(results['run-with-timeout']!.stdout).toBe('ran\n');
        expect(results['log-event']!.stdout + results['log-event']!.stderr).toBe('');
        expect(results['log-hang']!.stdout + results['log-hang']!.stderr).toBe('');
        expect(calls(f)).toHaveLength(1);
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    });
  }

  test('nothing crosses into the caller: the selection lives only in the printed lines', () => {
    const f = fixture();
    try {
      const r = sh('bash', `set -u; '${PROBE}' select-model exec >/dev/null 2>&1; echo "sel=\${_GSTACK_CODEX_SEL-unset} sandbox=\${_GSTACK_CODEX_SANDBOX-unset} bin=\${_GSTACK_CODEX_BIN-unset}"`, f.env);
      expect(r.stdout).toBe('sel=unset sandbox=unset bin=unset\n');
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('select-model keeps the precedence: --model, then GSTACK_CODEX_MODEL, then config.toml (review_model for review)', () => {
    const f = fixture('model = "gpt-5.6-terra"\nreview_model = "gpt-5.6-luna"\n');
    try {
      const sel = (args: string, extra: Record<string, string> = {}) => probe(f, `select-model ${args}`, extra).stdout.split('\n')[0];
      expect(sel('exec')).toBe('CODEX_SEL: gpt-5.6-terra');
      expect(sel('review')).toBe('CODEX_SEL: gpt-5.6-luna');
      expect(sel('review', { GSTACK_CODEX_MODEL: 'gpt-6-sol' })).toBe('CODEX_SEL: gpt-6-sol');
      const explicit = probe(f, "select-model exec --model 'gpt-6-luna'", { GSTACK_CODEX_MODEL: 'gpt-6-sol' });
      expect(explicit.stdout.split('\n')[0]).toBe('CODEX_SEL: gpt-6-luna');
      expect(explicit.stderr).toContain('CODEX_MODEL: gpt-6-luna (exec; source: explicit request)');
      const invalid = probe(f, "select-model exec --model 'not a model'");
      expect([invalid.code, invalid.stdout]).toEqual([1, '']);
      expect(invalid.stderr).toContain('CODEX_MODEL: invalid');
      expect(calls(f)).toEqual([]);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('probe-model reports CODEX_PROBE_STATE with the old exit codes, probing exactly the requested model', () => {
    const f = fixture();
    try {
      const cases: Array<[string, number, string]> = [
        ['model400', 1, 'unusable'], ['broken', 2, 'broken_install'], ['quota', 4, 'quota_exhausted'],
        ['ratelimit', 0, 'rate_limited'], ['transient', 0, 'inconclusive'], ['ok', 0, 'ok'],
      ];
      for (const [mode, code, state] of cases) {
        fs.rmSync(path.join(f.state, '.codex-model-probe'), { force: true });
        const r = probe(f, 'probe-model exec', { STUB_MODE: mode });
        expect({ mode, code: r.code, state: r.stdout.match(/^CODEX_PROBE_STATE: (.*)$/m)?.[1] }).toEqual({ mode, code, state });
      }
      fs.rmSync(path.join(f.state, '.codex-model-probe'), { force: true });
      fs.rmSync(f.argsLog, { force: true });
      const named = probe(f, "probe-model review --model 'gpt-6-luna'");
      expect(named.code).toBe(0);
      expect(calls(f)).toHaveLength(1);
      expect(calls(f)[0]).toContain('model="gpt-6-luna"');
      const invalid = probe(f, "probe-model exec --model 'not a model'");
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toContain('MODEL_UNUSABLE\n');
      expect(invalid.stdout).toContain('CODEX_PROBE_STATE: unusable\n');
      expect(calls(f)).toHaveLength(1);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  test('check-sandbox and check-auth report by exit code, reasons on stderr', () => {
    const f = fixture('model = "gpt-test-model"\n', false);
    try {
      if (process.platform === 'linux') {
        const sandbox = probe(f, 'check-sandbox', { STUB_SANDBOX: 'userns' });
        expect([sandbox.code, sandbox.stdout]).toEqual([3, '']);
        expect(sandbox.stderr).toContain("Codex outside review unavailable: Codex's sandbox could not start here (bwrap: No permissions");
      }
      const auth = probe(f, 'check-auth');
      expect([auth.code, auth.stdout]).toEqual([1, 'AUTH_FAILED\n']);
      expect(probe(f, 'check-auth', { CODEX_API_KEY: 'present' }).code).toBe(0);
      const version = probe(f, 'check-version', { STUB_VERSION: '0.120.1' });
      expect([version.code, version.stdout]).toEqual([0, '']);
      expect(version.stderr).toContain('WARN: Codex CLI codex-cli 0.120.1 has known stdin deadlock bugs');
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  for (const native of [false, true]) {
    test(`run-with-timeout supervises with ${native ? 'the bash watchdog' : 'timeout(1)'}: stdin passes through, a deadline exits 124`, () => {
      const f = fixture();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-sub-path-'));
      try {
        for (const tool of native ? ['bash', 'sleep', 'cat'] : []) {
          const target = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
          if (target.startsWith('/')) fs.symlinkSync(target, path.join(dir, tool));
        }
        const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
        const env = native ? { ...f.env, PATH: dir } : f.env;
        const run = (args: string[], input?: string) => {
          const r = spawnSync(bash, [PROBE, 'run-with-timeout', ...args], { env, input, encoding: 'utf8', timeout: 20_000 });
          return { code: r.status, stdout: r.stdout ?? '' };
        };
        expect(run(['5', 'cat'], 'prompt on stdin')).toEqual({ code: 0, stdout: 'prompt on stdin' });
        const started = Date.now();
        expect(run(['1', 'sleep', '30']).code).toBe(124);
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(run(['5', 'bash', '-c', 'exit 7']).code).toBe(7);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(f.home, { recursive: true, force: true });
      }
    });
  }

  test('log-event follows telemetry: the exported _TEL first, else gstack-config; log-hang never prints', () => {
    const f = fixture();
    try {
      const usage = path.join(f.state, 'analytics', 'skill-usage.jsonl');
      const lines = () => (fs.existsSync(usage) ? fs.readFileSync(usage, 'utf8').trim().split('\n') : []);
      expect(probe(f, 'log-event codex_timeout 540').code).toBe(0);
      expect(lines()).toEqual([]);
      fs.writeFileSync(path.join(f.state, 'config.yaml'), 'telemetry: community\n');
      expect(probe(f, 'log-event codex_timeout 540').code).toBe(0);
      expect(lines()).toHaveLength(1);
      expect(JSON.parse(lines()[0]!)).toMatchObject({ skill: 'codex', event: 'codex_timeout', duration_s: '540' });
      expect(probe(f, 'log-event codex_auth_failed', { _TEL: 'off' }).code).toBe(0);
      expect(lines()).toHaveLength(1);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  });

  for (const shell of SHELLS) {
    test.skipIf(shell === 'zsh' && skipZsh)(`sourcing from ${shell} still defines the functions and prints the deprecation line once`, () => {
      const f = fixture();
      try {
        const r = sh(shell, `. '${PROBE}' && _gstack_codex_select_model exec && echo "sel=$_GSTACK_CODEX_SEL"`, f.env);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('sel=gpt-test-model\n');
        expect(r.stderr.startsWith(PROBE_SOURCING_DEPRECATION)).toBe(true);
        expect(r.stderr.split('deprecated').length - 1).toBe(1);
        expect(PROBE_SOURCING_DEPRECATION).toContain('/gstack-upgrade');
      } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
    });
  }
});

describe('generated skills run the probe as a command', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'test') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/(?:SKILL\.md|\.md\.tmpl|\.md)$/.test(entry.name) || (dir.endsWith(path.join('scripts', 'resolvers')) && entry.name.endsWith('.ts'))) out.push(full);
    }
    return out;
  }

  test('no template, resolver or generated skill sources the probe or uses its sourced-only names', () => {
    const offenders: string[] = [];
    const files = [...walk(path.join(ROOT, 'scripts', 'resolvers')), ...fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'test', 'docs', 'scripts'].includes(e.name))
      .flatMap(e => walk(path.join(ROOT, e.name)))];
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (/(?:^|[;&|({]|then\s)[\t ]*(?:source|\.)\s+"?[^"\s;)]*gstack-codex-probe|_gstack_codex_|_GSTACK_CODEX_/m.test(text)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
