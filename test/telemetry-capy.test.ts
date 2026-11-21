/** Capy's own gstack use (GST-3311): an unattended Capy session sends
 * telemetry only when the owner's preferences file opts it in, always at the
 * anonymous tier and labelled source=capy unless an eval or CI label wins.
 * Network is stubbed; nothing leaves the box. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
let tmp: string;
let prefs: string;

function run(cmd: string, extra: Record<string, string> = {}): string {
  return execSync(`{ ${cmd}\n} | cat; exit "\${PIPESTATUS[0]}"`, {
    shell: '/bin/bash',
    cwd: tmp,
    env: {
      ...process.env as Record<string, string>,
      HOME: path.join(tmp, 'home'), GSTACK_HOME: tmp, GSTACK_STATE_ROOT: tmp, GSTACK_STATE_DIR: tmp,
      GSTACK_DIR: ROOT, GSTACK_SUPABASE_URL: 'https://telemetry.fixture.invalid', GSTACK_SUPABASE_ANON_KEY: 'fixture',
      GSTACK_TEST_CAPTURE: path.join(tmp, 'sent'),
      GSTACK_SESSION_KIND: 'unattended', GSTACK_CAPY: '1', GSTACK_PREFERENCES_FILE: prefs,
      CI: '', GSTACK_TELEMETRY_SOURCE: '', EVALS_RUN_ID: '', GSTACK_EVAL_DIR: '',
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
      ...extra,
    },
    encoding: 'utf-8',
    timeout: 20_000,
  }).trim();
}
function skillEnd(extra: Record<string, string> = {}) {
  return run(`${BIN}/gstack-skill-end --skill review --outcome success --session-id 123-capy --tel-start 1`, extra);
}
function sent(): any[] {
  const f = path.join(tmp, 'sent');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).flatMap(b => JSON.parse(b));
}
function writePrefs(text: string) { fs.writeFileSync(prefs, text); }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-capytel-'));
  prefs = path.join(tmp, 'preferences.yaml');
  fs.mkdirSync(path.join(tmp, 'home'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.mkdirSync(path.join(tmp, 'analytics'));
  fs.writeFileSync(path.join(tmp, 'bin', 'curl'), `#!/bin/sh
out=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    @*) cat "\${1#@}" >> "$GSTACK_TEST_CAPTURE"; printf '\\n' >> "$GSTACK_TEST_CAPTURE" ;;
  esac
  shift
done
[ -z "$out" ] || printf '{"inserted":1}' > "$out"
printf 200
`, { mode: 0o755 });
  writePrefs('agent_model: opus\ntelemetry_capy: anonymous   # GST-3311\n');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('Capy telemetry opt-in', () => {
  test('an opted-in Capy session sends exactly one anonymous row labelled capy, even on a community machine', () => {
    run(`${BIN}/gstack-config set telemetry community`, { GSTACK_SESSION_KIND: 'interactive' });
    skillEnd();
    const rows = sent();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skill: 'review', outcome: 'success', source: 'capy' });
    expect(rows[0]).not.toHaveProperty('installation_id');
    expect(fs.existsSync(path.join(tmp, 'installation-id'))).toBe(false);
  });

  test('without exactly one telemetry_capy: anonymous line a Capy session sends nothing', () => {
    skillEnd();
    expect(sent()).toHaveLength(1);
    for (const text of ['agent_model: opus\n', 'telemetry_capy: off\n', 'telemetry_capy: community\n', 'telemetry_capy: yes\n',
      'telemetry_capy: anonymous\ntelemetry_capy: anonymous\n', '  telemetry_capy: anonymous\n']) {
      fs.rmSync(path.join(tmp, 'sent'), { force: true });
      fs.rmSync(path.join(tmp, 'analytics'), { recursive: true, force: true }); fs.mkdirSync(path.join(tmp, 'analytics'));
      writePrefs(text);
      skillEnd();
      expect([text, sent()]).toEqual([text, []]);
    }
    fs.rmSync(prefs);
    skillEnd();
    expect(sent()).toEqual([]);
  });

  test('an eval run and CI keep their own labels on Capy', () => {
    skillEnd({ EVALS_RUN_ID: 'r1', CI: 'true' });
    expect(sent().map(e => e.source)).toEqual(['eval']);
    fs.rmSync(path.join(tmp, 'sent'));
    fs.rmSync(path.join(tmp, 'analytics'), { recursive: true, force: true }); fs.mkdirSync(path.join(tmp, 'analytics'));
    skillEnd({ CI: 'true' });
    expect(sent().map(e => e.source)).toEqual(['ci']);
  });

  test('telemetry_capy_source: gt labels the row gt; eval and CI still win over it', () => {
    writePrefs('telemetry_capy: anonymous\ntelemetry_capy_source: gt\n');
    skillEnd();
    expect(sent().map(e => [e.source, e.installation_id])).toEqual([['gt', undefined]]);
    for (const [extra, label] of [[{ EVALS_RUN_ID: 'r1' }, 'eval'], [{ GSTACK_EVAL_DIR: tmp }, 'eval'], [{ CI: 'true' }, 'ci']] as const) {
      fs.rmSync(path.join(tmp, 'sent'));
      fs.rmSync(path.join(tmp, 'analytics'), { recursive: true, force: true }); fs.mkdirSync(path.join(tmp, 'analytics'));
      skillEnd(extra);
      expect(sent().map(e => e.source)).toEqual([label]);
    }
  });

  test('the label is a fixed-list pick: anything but one gt line falls back to capy', () => {
    for (const label of ['live', 'GT', 'gt-x', 'other', '', 'gt\ntelemetry_capy_source: gt']) {
      fs.rmSync(path.join(tmp, 'sent'), { force: true });
      fs.rmSync(path.join(tmp, 'analytics'), { recursive: true, force: true }); fs.mkdirSync(path.join(tmp, 'analytics'));
      writePrefs(`telemetry_capy: anonymous\ntelemetry_capy_source: ${label}\n`);
      skillEnd();
      expect([label, sent().map(e => e.source)]).toEqual([label, ['capy']]);
    }
  });

  test('an unattended session outside Capy still sends nothing, whatever the preferences file or machine tier says', () => {
    run(`${BIN}/gstack-config set telemetry anonymous`, { GSTACK_SESSION_KIND: 'interactive' });
    skillEnd({ GSTACK_CAPY: '' });
    expect(sent()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'analytics', 'skill-usage.jsonl'))).toBe(false);
    expect(skillEnd({ GSTACK_CAPY: '' })).toContain('ARTIFACTS_SYNC: skipped (unattended session)');
  });

  test('a shell on a Capy install that never sourced the launch file (a reader subagent) sends nothing, whatever the machine tier', () => {
    const install = path.join(tmp, 'install');
    fs.mkdirSync(install);
    execSync('git init -q', { cwd: install, timeout: 20_000 });
    fs.symlinkSync(BIN, path.join(install, 'bin'));
    fs.copyFileSync(path.join(ROOT, 'VERSION'), path.join(install, 'VERSION'));
    run(`${BIN}/gstack-config set telemetry community`, { GSTACK_SESSION_KIND: 'interactive' });
    const reader = { GSTACK_DIR: install, GSTACK_SESSION_KIND: 'interactive', GSTACK_CAPY: '' };
    const end = () => run(`${install}/bin/gstack-skill-end --skill plan-ceo-review --outcome success --session-id 123-reader --tel-start 1`, reader);
    end();
    expect(sent().filter(e => e.v === 1).map(e => e.source)).toEqual(['live']);
    fs.rmSync(path.join(tmp, 'sent'));
    fs.rmSync(path.join(tmp, 'analytics'), { recursive: true, force: true }); fs.mkdirSync(path.join(tmp, 'analytics'));
    fs.writeFileSync(path.join(install, '.git', 'gstack-capy-install.state'), 'fixture\n');
    end();
    expect(sent()).toEqual([]);
    expect(run(`${install}/bin/gstack-telemetry-tier`, reader)).toBe('off');
    expect(run(`${install}/bin/gstack-telemetry-tier`, { GSTACK_DIR: install })).toBe('anonymous');
  });

  test('a host directory that links only bin/ to a Capy install (Codex) still sees the install and sends nothing', () => {
    const install = path.join(tmp, 'install');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    execSync('git init -q', { cwd: install, timeout: 20_000 });
    for (const f of fs.readdirSync(BIN)) fs.symlinkSync(path.join(BIN, f), path.join(install, 'bin', f));
    fs.writeFileSync(path.join(install, '.git', 'gstack-capy-install.state'), 'fixture\n');
    const host = path.join(tmp, 'codex-skill');
    fs.mkdirSync(host);
    fs.symlinkSync(path.join(install, 'bin'), path.join(host, 'bin'));
    run(`${BIN}/gstack-config set telemetry community`, { GSTACK_SESSION_KIND: 'interactive' });
    expect(run(`${host}/bin/gstack-telemetry-tier`, { GSTACK_SESSION_KIND: 'interactive', GSTACK_CAPY: '' })).toBe('off');
  });

  test('gstack-telemetry-tier prints the Capy opt-in alone with --capy, else the machine setting', () => {
    const tier = (args = '', extra: Record<string, string> = {}) => run(`${path.join(BIN, 'gstack-telemetry-tier')} ${args}`, extra);
    run(`${BIN}/gstack-config set telemetry community`, { GSTACK_SESSION_KIND: 'interactive' });
    expect([tier('--capy'), tier()]).toEqual(['anonymous', 'anonymous']);
    expect([tier('--capy', { GSTACK_CAPY: '' }), tier('', { GSTACK_CAPY: '' })]).toEqual(['off', 'community']);
    writePrefs('telemetry_capy: "anonymous"\r\n');
    expect(tier('--capy')).toBe('anonymous');
    writePrefs('telemetry_capy: anonymous\n' + '#'.repeat(4096));
    expect([tier('--capy'), tier()]).toEqual(['off', 'community']);
  });

  test('outside an unattended session the label is still capy under GSTACK_CAPY=1', () => {
    run(`${BIN}/gstack-config set telemetry anonymous`, { GSTACK_SESSION_KIND: 'interactive' });
    run(`${BIN}/gstack-telemetry-log --skill qa --outcome success --session-id 9-capy`, { GSTACK_PREFERENCES_FILE: '' });
    expect(sent().map(e => e.source)).toEqual(['capy']);
  });
});
