import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runGeneration } from '../scripts/gen-skill-docs';

const root = mkdtempSync(join(tmpdir(), 'skill-positional-'));
const rendered = join(root, 'rendered');
const tenArguments = Array.from({ length: 10 }, (_, n) => `argument${n}`);
const literals = {
  checksum: `actual_sha=$(sha256sum < "$tmpfile" | awk '{print $(1)}')`,
  snoozeVersion: `_SNOOZED_VER=$(awk '{print $(1)}' "$_SNOOZE_FILE")`,
  snoozeLevel: `_CUR_LEVEL=$(awk '{print $(2)}' "$_SNOOZE_FILE")`,
  capture: `printf 'ERROR:typecheck CAPTURE:%s\\n' "\${1}" >&2`,
  preview: `_PORT=$(lsof -i -P -n | grep "$_SERVER_PID" | grep LISTEN | awk '{print $(9)}' | cut -d: -f2 | head -1)`,
  title: '# Bash-side title sanitize. Pass the raw title via TITLE_RAW when running this block.',
  cost: '- A) Enable judge (adds about USD 0.05). Completeness: 10/10.',
};

beforeAll(async () => {
  for (const host of ['claude', 'codex'] as const) {
    expect((await runGeneration({ host, outputRoot: rendered })).exitCode).toBe(0);
  }
}, 120000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function substitute(text: string, args: string[]) {
  const numbered = args.length ? text.replace(/\$(\d+)/g, (_, n) => args[Number(n)] ?? '') : text;
  return numbered.replace(/\$ARGUMENTS\b/g, () => args.join(' '));
}

function run(code: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', code], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: root, ...env },
  });
}

function skill(host: string, name: string) {
  return readFileSync(join(rendered, host === 'claude' ? name : `.agents/skills/${name.startsWith('gstack-') ? name : `gstack-${name}`}`, 'SKILL.md'), 'utf8');
}

for (const host of ['claude', 'codex'] as const) for (const args of [[], tenArguments]) {
  const apply = (s: string) => host === 'claude' ? substitute(s, args) : s;
  const label = `${host}/${args.length} arguments`;
  test(`${label}: exact rendered literals survive host expansion`, () => {
    const setup = skill(host, 'open-gstack-browser');
    const actual = {
      checksum: setup.match(/actual_sha=\$\(sha256sum[^\n]+/)![0],
      snoozeVersion: skill(host, 'gstack-upgrade').match(/_SNOOZED_VER=\$[^\n]+/)![0],
      snoozeLevel: skill(host, 'gstack-upgrade').match(/_CUR_LEVEL=\$\(awk[^\n]+/)![0],
      capture: skill(host, 'health').match(/printf 'ERROR:typecheck[^\n]+/)![0],
      preview: skill(host, 'design-html').match(/_PORT=\$[^\n]+/)![0],
      title: skill(host, 'context-save').match(/# Bash-side title sanitize\.[^\n]+/)![0],
      cost: skill(host, 'benchmark-models').match(/- A\) Enable judge[^\n]+/)![0],
    };
    expect(actual).toEqual(literals);
    expect(Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, apply(value)]))).toEqual(literals);
    for (const name of ['gstack-upgrade', 'health', 'design-html', 'context-save', 'benchmark-models']) {
      const text = skill(host, name);
      expect(text.match(/\$\d+/g), name).toBeNull();
      expect(apply(text)).toBe(text);
    }
    expect(skill(host, 'benchmark-models')).toContain('Adds about USD 0.05/run.');
  });
  for (const backslashPath of [false, true]) test(`${label}: both checksum tools ${backslashPath ? 'handle backslash paths' : 'retain the digest field'}`, () => {
    const file = backslashPath ? join(root, 'checksum\\path', 'install-script') : join(root, 'install-script');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'synthetic installer bytes\n');
    for (const name of ['open-gstack-browser', 'pair-agent', 'setup-browser-cookies']) {
      const lines = apply(skill(host, name)).split('\n').filter(line => line.includes('actual_sha=$('));
      expect(lines.map(line => line.trim())).toEqual([
        literals.checksum,
        `actual_sha=$(shasum -a 256 < "$tmpfile" | awk '{print $(1)}')`,
      ]);
      for (const line of lines) {
        const result = run(`${line}\nprintf '%s' "$actual_sha"`, { tmpfile: file });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(createHash('sha256').update(readFileSync(file)).digest('hex'));
      }
    }
  });
  test(`${label}: upgrade snooze advances the same-version level`, () => {
    mkdirSync(join(root, '.gstack'), { recursive: true });
    writeFileSync(join(root, '.gstack/update-snoozed'), '{new} 1 0\n');
    const block = skill(host, 'gstack-upgrade').match(/```bash\n(_SNOOZE_FILE=[\s\S]*?)```/)![1];
    expect(run(apply(block)).status).toBe(0);
    expect(readFileSync(join(root, '.gstack/update-snoozed'), 'utf8')).toMatch(/^\{new\} 2 \d+\n$/);
  });
  test(`${label}: health error preserves its diagnostic argument`, () => {
    const helper = skill(host, 'health').match(/health_capture_error\(\) \{[\s\S]*?\n  \}/)![0];
    const result = run(apply(helper) + '\nhealth_capture_error log_creation');
    expect(result.status).toBe(125);
    expect(result.stderr).toBe('ERROR:typecheck CAPTURE:log_creation\n');
  });
  test(`${label}: preview port extracts the address column`, () => {
    const line = skill(host, 'design-html').split('\n').find(line => line.startsWith('_PORT=$('))!;
    const result = run(`lsof() { echo 'python3 4242 user 3u IPv4 1 0t0 TCP 127.0.0.1:3456 (LISTEN)'; }\n_SERVER_PID=4242\n${apply(line)}\nprintf '%s' "$_PORT"`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('3456');
  });
}

test('pinned Linux CLI zero-argument observation preserves bare numbered literals', () => {
  expect(substitute('$1 | $2 | $9 | ~$0.05 | $ARGUMENTS', [])).toBe('$1 | $2 | $9 | ~$0.05 | ');
});

test('pinned Linux CLI ten-argument negative control corrupts unsafe literals', () => {
  expect(substitute(`awk '{print $1}' | "$1" | $2 | $9 | ~$0.05`, tenArguments))
    .toBe(`awk '{print argument1}' | "argument1" | argument2 | argument9 | ~argument0.05`);
});

test('intentional placeholders retain zero- and ten-argument expansion', () => {
  expect(substitute('$ARGUMENTS', [])).toBe('');
  expect(substitute('$ARGUMENTS / $0 / $1 / $9', tenArguments))
    .toBe(`${tenArguments.join(' ')} / argument0 / argument1 / argument9`);
});
