import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin/gstack-grok-probe');

function runProbe(opts: {
  snippet: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    _TEL: 'off',
  };
  if (opts.home) env.HOME = opts.home;
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  const script = `set +e\nsource "${PROBE}"\n${opts.snippet}\n`;
  const result = spawnSync('bash', ['-c', script], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    status: result.status ?? -1,
  };
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-grok-probe-home-'));
}

describe('gstack-grok-probe: auth probe', () => {
  test('XAI_API_KEY set → AUTH_OK', () => {
    const home = tempHome();
    try {
      const r = runProbe({ snippet: '_gstack_grok_auth_probe', env: { XAI_API_KEY: 'xai-test' }, home });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('GROK_API_KEY set → AUTH_OK', () => {
    const home = tempHome();
    try {
      const r = runProbe({ snippet: '_gstack_grok_auth_probe', env: { GROK_API_KEY: 'grok-test' }, home });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('${GROK_HOME:-~/.grok}/auth.json exists → AUTH_OK', () => {
    const home = tempHome();
    try {
      fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
      fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{}');
      const r = runProbe({ snippet: '_gstack_grok_auth_probe', home });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('no env + no file → AUTH_FAILED with exit 1', () => {
    const home = tempHome();
    try {
      const r = runProbe({ snippet: '_gstack_grok_auth_probe', home });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('whitespace-only env vars + no file → AUTH_FAILED', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: '_gstack_grok_auth_probe',
        env: { XAI_API_KEY: '   ', GROK_API_KEY: '\t\n' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('alternate $GROK_HOME → checks the alternate path', () => {
    const home = tempHome();
    const altGrok = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alt-grok-'));
    try {
      fs.writeFileSync(path.join(altGrok, 'auth.json'), '{}');
      const r = runProbe({
        snippet: '_gstack_grok_auth_probe',
        env: { GROK_HOME: altGrok },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(altGrok, { recursive: true, force: true });
    }
  });
});

describe('gstack-grok-probe: namespace hygiene + telemetry', () => {
  test('bin/gstack-grok-probe is syntactically valid bash (bash -n)', () => {
    const result = spawnSync('bash', ['-n', PROBE], { timeout: 5000 });
    expect(result.status).toBe(0);
  });

  test('_gstack_grok_log_event payload never leaks env secrets', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: `_gstack_grok_log_event "grok_test_event" "1"; cat "$HOME/.gstack/analytics/skill-usage.jsonl"`,
        env: { _TEL: 'community', XAI_API_KEY: 'SECRET_SHOULD_NOT_LEAK' },
        home,
      });
      expect(r.stdout).not.toContain('SECRET_SHOULD_NOT_LEAK');
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
      expect(Object.keys(parsed).sort()).toEqual(['duration_s', 'event', 'skill', 'ts']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

function extractGrokInvocations(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf('## Grok invocation contract');
  expect(startIdx).toBeGreaterThan(-1);
  return content.slice(startIdx);
}

for (const relPath of ['grok/SKILL.md.tmpl']) {
  describe(`${relPath}: read-only invocation contract`, () => {
    test('every grok headless invocation uses --permission-mode plan', () => {
      const section = extractGrokInvocations(path.join(ROOT, relPath));
      const invokeLines = section
        .split('\n')
        .filter((l) => /_gstack_grok_timeout_wrapper\s+\d+\s+grok\b/.test(l));
      expect(invokeLines.length).toBeGreaterThan(0);
      for (const line of invokeLines) {
        expect(line).toContain('--permission-mode plan');
      }
    });

    test('never passes --reasoning-effort flag in shell invocations', () => {
      const section = extractGrokInvocations(path.join(ROOT, relPath));
      const invokeLines = section
        .split('\n')
        .filter((l) => /_gstack_grok_timeout_wrapper\s+\d+\s+grok\b/.test(l));
      for (const line of invokeLines) {
        expect(line).not.toMatch(/--reasoning-effort\b/);
      }
    });

    test('every grok headless invocation defaults to -m grok-4.5', () => {
      const section = extractGrokInvocations(path.join(ROOT, relPath));
      const invokeLines = section
        .split('\n')
        .filter((l) => /_gstack_grok_timeout_wrapper\s+\d+\s+grok\b/.test(l));
      expect(invokeLines.length).toBeGreaterThan(0);
      for (const line of invokeLines) {
        expect(line).toMatch(/-m\s+grok-4\.5\b/);
      }
    });
  });
}