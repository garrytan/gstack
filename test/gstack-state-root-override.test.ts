/**
 * GSTACK_STATE_ROOT override — verifies the 3 plan-tune bins honor
 * GSTACK_STATE_ROOT as a higher-priority override over GSTACK_HOME.
 *
 * Surfaced by plan-tune cathedral D16 (Codex outside voice): tests can't
 * isolate from real ~/.gstack today because the bins ignore STATE_ROOT.
 * Without this override, the cathedral's E2E + integration tests would
 * silently pollute the user's real profile.
 *
 * Contract:
 *   - GSTACK_STATE_ROOT set → bins write under STATE_ROOT (HOME ignored).
 *   - Only GSTACK_HOME set → bins write under HOME (existing behavior).
 *   - Neither set → falls back to $HOME/.gstack (existing behavior).
 *   - Both set → STATE_ROOT wins.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_LOG = path.join(ROOT, 'bin', 'gstack-question-log');
const BIN_PREF = path.join(ROOT, 'bin', 'gstack-question-preference');
const BIN_DEV = path.join(ROOT, 'bin', 'gstack-developer-profile');

let stateRoot: string;
let homeRoot: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-state-'));
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-'));
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

function runBin(
  bin: string,
  args: string[],
  env: Record<string, string | undefined>,
): { stdout: string; stderr: string; status: number } {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) cleaned[k] = v;
  }
  // Strip these from process.env so the override matrix is clean.
  if (env.GSTACK_STATE_ROOT === undefined) delete cleaned.GSTACK_STATE_ROOT;
  if (env.GSTACK_HOME === undefined) delete cleaned.GSTACK_HOME;
  const res = spawnSync(bin, args, {
    env: cleaned,
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

const SAMPLE_LOG = {
  skill: 'plan-tune',
  question_id: 'state-root-test',
  question_summary: 'Test STATE_ROOT honoring',
  category: 'clarification',
  door_type: 'two-way',
  options_count: 2,
  user_choice: 'a',
  recommended: 'a',
  session_id: 'state-root-test-session',
};

describe('gstack-question-log honors GSTACK_STATE_ROOT', () => {
  test('STATE_ROOT set, HOME unset → writes under STATE_ROOT', () => {
    const r = runBin(BIN_LOG, [JSON.stringify(SAMPLE_LOG)], {
      GSTACK_STATE_ROOT: stateRoot,
      GSTACK_HOME: undefined,
    });
    expect(r.status).toBe(0);
    // The slug is derived from cwd; just check at least one log file exists.
    const projectDirs = fs.readdirSync(path.join(stateRoot, 'projects'));
    expect(projectDirs.length).toBeGreaterThanOrEqual(1);
    const logPath = path.join(stateRoot, 'projects', projectDirs[0], 'question-log.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
  });

  test('STATE_ROOT wins over HOME when both set', () => {
    const r = runBin(BIN_LOG, [JSON.stringify(SAMPLE_LOG)], {
      GSTACK_STATE_ROOT: stateRoot,
      GSTACK_HOME: homeRoot,
    });
    expect(r.status).toBe(0);
    // STATE_ROOT must have the file.
    const stateProjects = fs.readdirSync(path.join(stateRoot, 'projects'));
    expect(stateProjects.length).toBeGreaterThanOrEqual(1);
    // HOME must NOT have a projects dir (or it must be empty).
    const homeProjectsPath = path.join(homeRoot, 'projects');
    if (fs.existsSync(homeProjectsPath)) {
      const homeProjects = fs.readdirSync(homeProjectsPath);
      expect(homeProjects.length).toBe(0);
    }
  });

  test('only HOME set → preserves existing behavior (writes under HOME)', () => {
    const r = runBin(BIN_LOG, [JSON.stringify(SAMPLE_LOG)], {
      GSTACK_STATE_ROOT: undefined,
      GSTACK_HOME: homeRoot,
    });
    expect(r.status).toBe(0);
    const homeProjects = fs.readdirSync(path.join(homeRoot, 'projects'));
    expect(homeProjects.length).toBeGreaterThanOrEqual(1);
    // STATE_ROOT must NOT have anything.
    const stateProjectsPath = path.join(stateRoot, 'projects');
    if (fs.existsSync(stateProjectsPath)) {
      expect(fs.readdirSync(stateProjectsPath).length).toBe(0);
    }
  });
});

describe('gstack-question-preference honors GSTACK_STATE_ROOT', () => {
  test('STATE_ROOT set → preferences file lives under STATE_ROOT', () => {
    const write = runBin(
      BIN_PREF,
      [
        '--write',
        JSON.stringify({
          question_id: 'state-root-pref-test',
          preference: 'never-ask',
          source: 'plan-tune',
        }),
      ],
      { GSTACK_STATE_ROOT: stateRoot, GSTACK_HOME: undefined },
    );
    expect(write.status).toBe(0);
    const projectDirs = fs.readdirSync(path.join(stateRoot, 'projects'));
    expect(projectDirs.length).toBeGreaterThanOrEqual(1);
    const prefPath = path.join(stateRoot, 'projects', projectDirs[0], 'question-preferences.json');
    expect(fs.existsSync(prefPath)).toBe(true);
    const prefs = JSON.parse(fs.readFileSync(prefPath, 'utf-8'));
    expect(prefs['state-root-pref-test']).toBe('never-ask');
  });
});

describe('gstack-developer-profile honors GSTACK_STATE_ROOT', () => {
  test('STATE_ROOT set → profile file lives under STATE_ROOT, not HOME', () => {
    // --read creates a stub profile if missing.
    const r = runBin(BIN_DEV, ['--read'], {
      GSTACK_STATE_ROOT: stateRoot,
      GSTACK_HOME: homeRoot,
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(stateRoot, 'developer-profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(homeRoot, 'developer-profile.json'))).toBe(false);
  });
});
