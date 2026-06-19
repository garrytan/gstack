/**
 * gstack-statusline script: skill extraction + display modes.
 *
 * Verifies the statusLine command picks the last skill the session invoked
 * (slash command or Skill tool, never a Read), excludes meta-commands, falls
 * back to the analytics log, and honors the full/skill display modes (full =
 * additive baseline dir/branch/model + skill; skill = skill only).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-statusline');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sl-script-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Run the statusline script with a stdin payload, return ANSI-stripped stdout. */
function run(
  payload: object,
  args: string[] = [],
  env: Record<string, string> = {},
): string {
  // Point the analytics fallback at an empty home unless a test overrides it.
  const out = execFileSync('bash', [SCRIPT, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, GSTACK_HOME: path.join(tmpDir, 'empty-home'), ...env },
    timeout: 10000,
  });
  return stripAnsi(out);
}

/** Write a transcript that invokes /review (slash), then /ship (Skill tool). */
function transcriptWithShip(): string {
  const p = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(
    p,
    [
      `{"type":"user","message":{"role":"user","content":"<command-message>review</command-message>\\n<command-name>/review</command-name>"}}`,
      `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"ship"}}]}}`,
      `{"type":"user","message":{"role":"user","content":"<command-message>config</command-message>\\n<command-name>/config</command-name>"}}`,
    ].join('\n') + '\n',
  );
  return p;
}

describe('skill extraction', () => {
  test('picks the last real skill and excludes meta-commands', () => {
    const out = run({ transcript_path: transcriptWithShip(), cwd: tmpDir }, ['--skill']);
    expect(out).toContain('/ship'); // last Skill tool use
    expect(out).not.toContain('/config'); // meta-command, excluded
    expect(out).not.toContain('/review'); // earlier than /ship
  });

  test('falls back to the analytics log when there is no transcript', () => {
    const home = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(home, 'analytics'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'analytics', 'skill-usage.jsonl'),
      `{"skill":"office-hours","ts":"t"}\n{"skill":"qa","ts":"t"}\n`,
    );
    const out = run({ cwd: tmpDir }, ['--skill'], { GSTACK_HOME: home });
    expect(out).toContain('/qa');
  });

  test('prints nothing in skill mode with no skill anywhere', () => {
    const out = run({ cwd: tmpDir }, ['--skill']);
    expect(out.trim()).toBe('');
  });
});

describe('display modes', () => {
  test('full mode shows dir + model and appends the skill', () => {
    const out = run(
      {
        transcript_path: transcriptWithShip(),
        workspace: { current_dir: tmpDir },
        model: { display_name: 'Opus 4.8' },
      },
      ['--full'],
    );
    expect(out).toContain(path.basename(tmpDir)); // dir baseline
    expect(out).toContain('Opus 4.8'); // model baseline
    expect(out).toContain('/ship'); // appended skill
  });

  test('full mode shows the baseline even with no skill yet', () => {
    const out = run(
      { workspace: { current_dir: tmpDir }, model: { display_name: 'Opus 4.8' } },
      ['--full'],
    );
    expect(out).toContain(path.basename(tmpDir));
    expect(out).toContain('Opus 4.8');
    expect(out).not.toContain('/');
  });

  test('skill mode omits the dir/model baseline', () => {
    const out = run(
      {
        transcript_path: transcriptWithShip(),
        workspace: { current_dir: tmpDir },
        model: { display_name: 'Opus 4.8' },
      },
      ['--skill'],
    );
    expect(out).not.toContain('Opus 4.8');
    expect(out).not.toContain(path.basename(tmpDir));
    expect(out).toContain('/ship');
  });

  test('full mode derives the git branch (not in the payload)', () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    execSync('git init -q && git checkout -q -b feature/x', { cwd: repo });
    const out = run({ workspace: { current_dir: repo }, model: { display_name: 'Opus' } }, ['--full']);
    expect(out).toContain('(feature/x)');
  });

  test('GSTACK_STATUSLINE_MODE=skill overrides the full default', () => {
    const out = run(
      { transcript_path: transcriptWithShip(), workspace: { current_dir: tmpDir }, model: { display_name: 'Opus' } },
      [],
      { GSTACK_STATUSLINE_MODE: 'skill' },
    );
    expect(out).not.toContain('Opus');
    expect(out).toContain('/ship');
  });

  test('defaults to full mode when no flag or env is given', () => {
    const out = run({ workspace: { current_dir: tmpDir }, model: { display_name: 'Opus' } });
    expect(out).toContain(path.basename(tmpDir));
    expect(out).toContain('Opus');
  });
});
