/**
 * gbrain's config home, resolved two ways (#4325, GST-2625): bin/gstack-gbrain-home.sh for
 * shell helpers and gbrainConfigDir() in lib/gbrain-exec.ts for TypeScript. Both follow
 * gbrain's configDir() (src/core/config.ts in garrytan/gbrain): GBRAIN_HOME trimmed with
 * JavaScript trim(), unset or blank means ~/.gbrain, and a relative value or one with a ".."
 * segment is refused with no ~/.gbrain fallback. One table drives both resolvers so they
 * cannot drift, and lib/checks.ts health selection is checked against two distinct homes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGbrainEnv, gbrainConfigDir } from '../lib/gbrain-exec';
import { healthDimensions } from '../lib/checks';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-gbrain-home.sh');
const HOME = '/home/fixture';
const DEFAULT = `${HOME}/.gbrain/config.json`;

// Every code point JavaScript trim() removes, read from the runtime rather than listed by hand.
const TRIM_SET: string[] = [];
for (let c = 0; c <= 0x10ffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  if (String.fromCodePoint(c).trim() === '') TRIM_SET.push(String.fromCodePoint(c));
}
const hex = (s: string) => [...s].map(ch => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');

const TABLE: Array<[string, string | undefined, string | null]> = [
  ['unset', undefined, DEFAULT],
  ['empty', '', DEFAULT],
  ['ASCII blank', ' \t\n\r\v\f ', DEFAULT],
  ['NBSP only', '\u00a0', DEFAULT],
  ['BOM only', '\ufeff', DEFAULT],
  ['mixed Unicode blank', '\u00a0\ufeff\u2003\u3000\u2028 ', DEFAULT],
  ...TRIM_SET.map((ch): [string, string, string] => [`trim() blank ${hex(ch)}`, ch, DEFAULT]),
  ['NEL is not trim() whitespace', '\u0085', null],
  ['zero-width space is not trim() whitespace', '\u200b', null],
  ['ordinary', '/srv/brain', '/srv/brain/.gbrain/config.json'],
  ['ASCII padded', '  /srv/brain \t', '/srv/brain/.gbrain/config.json'],
  ['Unicode padded', '\u00a0\ufeff/srv/brain\u3000\u00a0', '/srv/brain/.gbrain/config.json'],
  ['trailing slash', '/srv/brain/', '/srv/brain/.gbrain/config.json'],
  ['trailing slashes', '/srv/brain///', '/srv/brain/.gbrain/config.json'],
  ['root', '/', '/.gbrain/config.json'],
  ['relative', 'relative/home', null],
  ['dot relative', './brain', null],
  ['tilde is not expanded', '~/brain', null],
  ['padded relative', '\u00a0relative/home ', null],
  ['parent segment', '/srv/../brain', null],
  ['trailing parent segment', '/srv/brain/..', null],
  ['bare parent', '..', null],
  ['backslash parent segment', '/srv\\..\\brain', null],
  ['drive path off Windows', 'C:\\brain', null],
];

function shellResolve(gbrainHome: string | undefined): string | null {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME, LC_ALL: 'C.UTF-8' };
  if (gbrainHome !== undefined) env.GBRAIN_HOME = gbrainHome;
  const r = spawnSync('bash', ['-c', '. "$1" && gstack_gbrain_config_path', 'helper', HELPER], { env, encoding: 'utf8', timeout: 10_000 });
  if (r.status === 1 && r.stdout === '') return null;
  expect(r.status).toBe(0);
  // The shell helper does not collapse repeated separators; they name the same file.
  return path.posix.normalize(r.stdout.replace(/\n$/, ''));
}

function tsResolve(gbrainHome: string | undefined): string | null {
  const env: NodeJS.ProcessEnv = { HOME };
  if (gbrainHome !== undefined) env.GBRAIN_HOME = gbrainHome;
  const dir = gbrainConfigDir(env);
  return dir && path.join(dir, 'config.json');
}

// The expected paths are POSIX paths, and the shell helper is sourced through bash.
describe.skipIf(process.platform === 'win32')('GBRAIN_HOME parity: shell and TypeScript resolvers', () => {
  test('the runtime trim() set includes NBSP and the BOM', () => {
    expect(TRIM_SET).toContain('\u00a0');
    expect(TRIM_SET).toContain('\ufeff');
  });

  for (const [name, value, expected] of TABLE) {
    test(`${name}`, () => {
      expect({ ts: tsResolve(value), shell: shellResolve(value) }).toEqual({ ts: expected, shell: expected });
    });
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-home-parity-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const stubs = path.join(tmp, 'stubs');
fs.mkdirSync(stubs);
fs.writeFileSync(path.join(stubs, 'gbrain'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(stubs, 'gbrain'), 0o755);
function home(name: string, config?: object): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.gbrain'), { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
  return dir;
}
const named = home('named', { database_url: 'postgresql://postgres:postgres@localhost:5432/named' });
const fallback = home('default', { database_url: 'postgresql://postgres:postgres@localhost:5432/default' });
const bare = home('bare');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);

// The gbrain stub is an extensionless #!/bin/sh file, which windows-latest cannot launch.
describe.skipIf(process.platform === 'win32')('lib/checks.ts health selection follows GBRAIN_HOME', () => {
  const gbrain = (env: NodeJS.ProcessEnv) => {
    const d = healthDimensions(repo, { PATH: stubs, ...env });
    return { check: d.checks.find(c => c.dimension === 'gbrain'), missing: d.missing.find(m => m.dimension === 'gbrain')?.reason };
  };

  test('GBRAIN_HOME names the brain that has a config, the default home has none: selected', () => {
    expect(gbrain({ HOME: bare, GBRAIN_HOME: named }).check).toEqual({
      dimension: 'gbrain', command: 'timeout 5s gbrain doctor --json', source: 'PATH, $GBRAIN_HOME/.gbrain/config.json',
    });
  });

  test('GBRAIN_HOME names a brain with no config while the default home has one: not selected', () => {
    expect(gbrain({ HOME: fallback, GBRAIN_HOME: bare })).toEqual({
      check: undefined, missing: 'gbrain is not on PATH or $GBRAIN_HOME/.gbrain/config.json is absent',
    });
  });

  test('a GBRAIN_HOME gbrain refuses selects nothing, with no ~/.gbrain fallback', () => {
    expect(gbrain({ HOME: fallback, GBRAIN_HOME: 'relative/home' })).toEqual({
      check: undefined, missing: 'GBRAIN_HOME is relative or has a ".." segment, which gbrain refuses',
    });
  });

  test('a Unicode-blank GBRAIN_HOME means the default home', () => {
    expect(gbrain({ HOME: fallback, GBRAIN_HOME: '\u00a0\ufeff' }).check?.source).toBe('PATH, ~/.gbrain/config.json');
  });

  test('negative control: GBRAIN_HOME unset keeps the ~/.gbrain selection and wording', () => {
    expect(gbrain({ HOME: fallback }).check).toEqual({ dimension: 'gbrain', command: 'timeout 5s gbrain doctor --json', source: 'PATH, ~/.gbrain/config.json' });
    expect(gbrain({ HOME: named }).check?.source).toBe('PATH, ~/.gbrain/config.json');
    expect(gbrain({ HOME: bare })).toEqual({ check: undefined, missing: 'gbrain is not on PATH or ~/.gbrain/config.json is absent' });
  });
});

describe('buildGbrainEnv follows the same GBRAIN_HOME rule', () => {
  const url = (env: NodeJS.ProcessEnv) => buildGbrainEnv({ baseEnv: env }).DATABASE_URL;

  test('GBRAIN_HOME selects its own brain over the default one', () => {
    expect(url({ HOME: fallback, GBRAIN_HOME: named })).toBe('postgresql://postgres:postgres@localhost:5432/named');
  });

  test('a Unicode-blank GBRAIN_HOME means the default brain', () => {
    expect(url({ HOME: fallback, GBRAIN_HOME: '\u00a0' })).toBe('postgresql://postgres:postgres@localhost:5432/default');
  });

  test('a refused GBRAIN_HOME seeds nothing, with no ~/.gbrain fallback', () => {
    for (const refused of [path.relative(process.cwd(), named), `${named}/../named`, ` ${path.relative(process.cwd(), named)} `]) {
      expect(url({ HOME: fallback, GBRAIN_HOME: refused })).toBeUndefined();
    }
  });

  test('negative control: GBRAIN_HOME unset seeds the default brain', () => {
    expect(url({ HOME: fallback })).toBe('postgresql://postgres:postgres@localhost:5432/default');
  });
});
