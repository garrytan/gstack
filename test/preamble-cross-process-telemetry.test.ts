import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generatePreambleBash } from '../scripts/resolvers/preamble/generate-preamble-bash';
import { generateCompletionStatus } from '../scripts/resolvers/preamble/generate-completion-status';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';

// Regression coverage for: shared `_TEL_START` / `_SESSION_ID` / `_TEL` do not
// survive when a skill's preamble bash and its "Telemetry (run last)" bash run
// as two SEPARATE processes sharing a common parent — exactly what happens
// when an agent host (observed: Claude Code) executes each fenced bash block
// in a SKILL.md as its own tool call. Prior to the fix, an empty `_TEL_START`
// in `_TEL_DUR=$(( _TEL_END - _TEL_START ))` evaluates to `_TEL_END` (a raw
// current epoch, not near-zero), `_SESSION_ID` mismatches between the
// "started" and "completed" timeline events, and — the highest-severity part
// — an empty `_TEL` makes `[ "$_TEL" != "off" ]` true even when the user
// configured `telemetry: off`, so analytics fire anyway.

function extractBashFence(markdown: string, occurrence = 0): string {
  const fences = [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)];
  expect(fences.length).toBeGreaterThan(occurrence);
  return fences[occurrence][1];
}

function baseCtx(): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test-skill/SKILL.md.tmpl',
    host: 'claude',
    paths: HOST_PATHS['claude'],
    preambleTier: 2,
  };
}

function run(script: string, home: string) {
  return spawnSync('bash', ['-c', script], {
    env: { ...process.env, HOME: home, PATH: process.env.PATH },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('preamble/completion telemetry survive separate processes', () => {
  test('recovered _TEL_START is a real recent epoch, not the unset-as-zero bug', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-tel-'));
    try {
      const preambleBash = extractBashFence(generatePreambleBash(baseCtx()));
      const completionBash = extractBashFence(generateCompletionStatus(baseCtx()), 1); // 0 = learnings-log fence, 1 = Telemetry fence

      const before = Math.floor(Date.now() / 1000);
      const preambleResult = run(preambleBash, home);
      expect(preambleResult.status).toBe(0);

      // Completion runs in a SEPARATE process with none of the preamble's vars
      // exported — this is the actual failure condition, not a simulation of it.
      const completionScript = `unset _TEL_START _SESSION_ID _TEL\n${completionBash.replace(
        'SKILL_NAME',
        'test-skill'
      ).replace('OUTCOME', 'success').replace(/USED_BROWSE/g, 'false')}\necho "RESULT _TEL_DUR=$_TEL_DUR _SESSION_ID=$_SESSION_ID"`;
      const completionResult = run(completionScript, home);
      expect(completionResult.status).toBe(0);

      const match = completionResult.stdout.match(/RESULT _TEL_DUR=(-?\d+) _SESSION_ID=(\S+)/);
      expect(match).not.toBeNull();
      const dur = Number(match![1]);
      const sessionId = match![2];

      // Pre-fix bug: an unset _TEL_START in `$(( _TEL_END - _TEL_START ))`
      // arithmetic evaluates to 0, so _TEL_DUR == _TEL_END (a ~1.7-billion
      // second "duration"). Post-fix, duration must be small and non-negative.
      expect(dur).toBeGreaterThanOrEqual(0);
      expect(dur).toBeLessThan(60); // both processes run back-to-back in this test

      // Pre-fix bug: _SESSION_ID built from "$$" in the preamble process can
      // never be reconstructed in a different process, so recovery falls back
      // to an empty or ad-hoc value. Post-fix it's keyed on $PPID, which is
      // shared by both subprocesses here (same spawning test process).
      expect(sessionId).toMatch(/^\d+-\d+$/);

      // Sanity: the recovered epoch used to build _SESSION_ID/_TEL_DUR is
      // plausible (within this test's own execution window), not a stale or
      // garbage value.
      const dashIdx = sessionId.indexOf('-');
      const recoveredEpoch = Number(sessionId.slice(dashIdx + 1));
      const now = Math.floor(Date.now() / 1000);
      expect(recoveredEpoch).toBeGreaterThanOrEqual(before - 2);
      expect(recoveredEpoch).toBeLessThanOrEqual(now + 2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('telemetry: off is honored even when the completion block runs in a separate process (opt-out, not just metrics accuracy)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-tel-off-'));
    try {
      fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), 'telemetry: off\n');

      const preambleBash = extractBashFence(generatePreambleBash(baseCtx()));
      const completionBash = extractBashFence(generateCompletionStatus(baseCtx()), 1);

      const preambleResult = run(preambleBash, home);
      expect(preambleResult.status).toBe(0);

      const analyticsFile = path.join(home, '.gstack', 'analytics', 'skill-usage.jsonl');
      const before = fs.existsSync(analyticsFile) ? fs.readFileSync(analyticsFile, 'utf-8') : '';

      const completionScript = `unset _TEL_START _SESSION_ID _TEL\n${completionBash
        .replace('SKILL_NAME', 'test-skill')
        .replace('OUTCOME', 'success')
        .replace(/USED_BROWSE/g, 'false')}`;
      const completionResult = run(completionScript, home);
      expect(completionResult.status).toBe(0);

      const after = fs.existsSync(analyticsFile) ? fs.readFileSync(analyticsFile, 'utf-8') : '';

      // Pre-fix bug: _TEL recovers to "" in the separate completion process,
      // and `[ "" != "off" ]` is true, so the local-analytics append (and the
      // remote gstack-telemetry-log call, gated the same way) fire even
      // though the user set telemetry: off. Post-fix, _TEL must recover from
      // the real persisted config and stay "off".
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
