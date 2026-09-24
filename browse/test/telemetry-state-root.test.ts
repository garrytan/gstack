import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const TELEMETRY = resolve(import.meta.dir, '../src/telemetry.ts');
let fixture: string;
let home: string;
let roots: Record<string, string>;

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'gstack-telemetry-roots-')));
  home = join(fixture, 'isolated home');
  roots = {
    root: join(fixture, 'state root'),
    gstack: join(fixture, 'gstack home'),
    legacy: join(fixture, 'legacy state'),
    plugin: join(fixture, 'plugin data'),
    default: join(home, '.gstack'),
  };
  for (const root of Object.values(roots)) mkdirSync(root, { recursive: true });
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

const cases = [
  { name: 'default HOME', selected: 'default', keys: [] },
  { name: 'GSTACK_HOME', selected: 'gstack', keys: ['GSTACK_HOME'] },
  { name: 'GSTACK_STATE_ROOT alone', selected: 'root', keys: ['GSTACK_STATE_ROOT'] },
  { name: 'legacy GSTACK_STATE_DIR', selected: 'legacy', keys: ['GSTACK_STATE_DIR'] },
  { name: 'gstack plugin', selected: 'plugin', keys: ['CLAUDE_PLUGIN_DATA'] },
  { name: 'foreign plugin is ignored', selected: 'default', keys: ['CLAUDE_PLUGIN_DATA'], foreign: true },
  { name: 'STATE_ROOT wins over all roots', selected: 'root', keys: ['GSTACK_STATE_ROOT', 'GSTACK_HOME', 'GSTACK_STATE_DIR', 'CLAUDE_PLUGIN_DATA'] },
  { name: 'GSTACK_HOME wins over legacy and plugin', selected: 'gstack', keys: ['GSTACK_HOME', 'GSTACK_STATE_DIR', 'CLAUDE_PLUGIN_DATA'] },
  { name: 'legacy wins over plugin', selected: 'legacy', keys: ['GSTACK_STATE_DIR', 'CLAUDE_PLUGIN_DATA'] },
];

describe('browse telemetry reads consent and writes events in the same root', () => {
  for (const entry of cases) {
    for (const tier of ['community', 'off', 'malformed', 'missing']) {
      test(`${entry.name}: ${tier}`, () => {
        const selected = roots[entry.selected];
        for (const root of Object.values(roots)) {
          if (root === selected && tier === 'missing') continue;
          const value = root === selected ? tier : tier === 'community' ? 'off' : 'community';
          writeFileSync(join(root, 'config.yaml'), `telemetry: ${value}\n`);
        }
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
        const overrides: Record<string, string> = {
          GSTACK_STATE_ROOT: roots.root,
          GSTACK_HOME: roots.gstack,
          GSTACK_STATE_DIR: roots.legacy,
          CLAUDE_PLUGIN_DATA: roots.plugin,
        };
        for (const key of entry.keys) env[key] = overrides[key];
        if (env.CLAUDE_PLUGIN_DATA) env.CLAUDE_PLUGIN_ROOT = entry.foreign ? '/plugins/unrelated' : '/plugins/gstack';
        const script = `
import { homedir } from 'os';
if (homedir() !== process.env.HOME) throw new Error('fixture HOME is not isolated');
const { isTelemetryDisabled, logTelemetry } = await import(${JSON.stringify(TELEMETRY)});
await logTelemetry({ event: 'owned_probe' });
console.log(JSON.stringify({ home: homedir(), disabled: isTelemetryDisabled() }));
`;
        const result = spawnSync(process.execPath, ['-e', script], {
          cwd: fixture, env, encoding: 'utf-8', timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ home, disabled: tier !== 'community' });
        for (const root of Object.values(roots)) {
          const output = join(root, 'analytics/browse-telemetry.jsonl');
          if (root === selected && tier === 'community') {
            expect(existsSync(output)).toBe(true);
            const events = readFileSync(output, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
            expect(events).toHaveLength(1);
            expect(events[0].event).toBe('owned_probe');
            expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          } else {
            expect(existsSync(output)).toBe(false);
          }
        }
      });
    }
  }
});
