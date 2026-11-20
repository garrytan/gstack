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

  test('an unattended session outside Capy still sends nothing, whatever the preferences file or machine tier says', () => {
    run(`${BIN}/gstack-config set telemetry anonymous`, { GSTACK_SESSION_KIND: 'interactive' });
    skillEnd({ GSTACK_CAPY: '' });
    expect(sent()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'analytics', 'skill-usage.jsonl'))).toBe(false);
    expect(skillEnd({ GSTACK_CAPY: '' })).toContain('ARTIFACTS_SYNC: skipped (unattended session)');
  });

  test('outside an unattended session the label is still capy under GSTACK_CAPY=1', () => {
    run(`${BIN}/gstack-config set telemetry anonymous`, { GSTACK_SESSION_KIND: 'interactive' });
    run(`${BIN}/gstack-telemetry-log --skill qa --outcome success --session-id 9-capy`, { GSTACK_PREFERENCES_FILE: '' });
    expect(sent().map(e => e.source)).toEqual(['capy']);
  });
});
