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
  test('recovery does not depend on preamble-local runtime path vars (env-var hosts)', () => {
    // Adversarial review finding #1: an earlier version of this fix recovered
    // `_TEL` via `${ctx.paths.binDir}/gstack-config`, which resolves to
    // `$GSTACK_BIN`/`$GSTACK_ROOT` for env-var hosts (Codex, Factory, ...).
    // Those vars are themselves only set by the SAME preamble-local
    // `runtimeRoot` block this whole fix exists to work around, so recovery
    // would silently fall back to "off" for opted-in users on those hosts
    // whenever the completion block runs in a separate process.
    //
    // Design-comparison pass: duration/session-id recovery moved to a single
    // marker-file READ (the preamble writes real content into the
    // already-shipped `~/.gstack/sessions/"$PPID"` file instead of just
    // touching it) — no binary, no config path, no host-specific path at all.
    //
    // Adversarial review finding #2 (on the marker-content design itself):
    // trusting the MARKER for `_TEL` specifically is fail-OPEN under a PPID
    // mismatch (e.g. reparenting to init, confirmed to happen on real
    // machines — `~/.gstack/sessions/1` was found to exist here): a
    // completion process could read an unrelated/stale session's marker and
    // inherit ITS `_TEL` value (e.g. "community") even though the CURRENT
    // session's config is "off". So `_TEL` is deliberately NOT stored in or
    // recovered from the marker at all — it's recovered by re-reading the
    // live config.yaml directly (host-independent state dir), same as
    // duration/session-id's fallback-of-last-resort, but for `_TEL`
    // specifically this is the ONLY recovery path, never the marker.
    const envVarCtx: TemplateContext = {
      skillName: 'test-skill',
      tmplPath: 'test-skill/SKILL.md.tmpl',
      host: 'codex',
      paths: HOST_PATHS['codex'],
      preambleTier: 2,
    };
    const completionBash = extractBashFence(generateCompletionStatus(envVarCtx), 1);
    const recoveryBlock = completionBash.slice(
      completionBash.indexOf('_TEL_END=$(date +%s)'),
      completionBash.indexOf('rm -f ~/.gstack/analytics/.pending-')
    );
    expect(recoveryBlock).not.toContain('GSTACK_BIN');
    expect(recoveryBlock).not.toContain('GSTACK_ROOT');
    expect(recoveryBlock).toContain('~/.gstack/sessions/');
    expect(recoveryBlock).toContain('GSTACK_STATE_ROOT');
    // The _TEL recovery clause must never read from the marker file — only
    // from the live config. Isolate just that clause and assert it has no
    // reference to the marker/read-from-marker variables at all.
    const telClause = recoveryBlock.slice(recoveryBlock.indexOf('if [ -z "$_TEL" ]'));
    expect(telClause).not.toContain('_M_START');
    expect(telClause).not.toContain('_M_SESSION');
    expect(telClause).not.toContain('sessions/');
    expect(telClause).toContain('config.yaml');
  });


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

  test('a foreign/stale marker cannot leak a different session\'s telemetry opt-in (opt-out survives PID reuse/reparenting)', () => {
    // Behavioral reproduction of the adversarial review's finding #2: real
    // machines have observed a Bash-tool subprocess reparented to init before
    // it read $PPID (a marker literally named `1` was found in
    // ~/.gstack/sessions/ during development of this fix). If a completion
    // process ever ran under a $PPID that collides with an unrelated, older
    // session's marker, and that marker's format ever carried a telemetry
    // value (a plausible legacy/foreign format, not this fix's own write
    // path), a design that recovered `_TEL` FROM the marker would adopt the
    // foreign session's opt-in — leaking analytics for a user who currently
    // has telemetry: off. This test plants exactly that adversarial marker
    // and asserts current telemetry: off still wins.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-tel-foreign-'));
    try {
      fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), 'telemetry: off\n');

      // `$PPID` is read-only in bash (confirmed: `bash -c 'PPID=1'` errors
      // "PPID: переменная только для чтения" / readonly variable) — it can't
      // be spoofed to simulate a PID collision. Instead, discover the REAL
      // $PPID our spawned bash children will share (same pattern as the
      // other tests: two separate spawnSync calls from this same Node
      // process share one parent, hence one $PPID), and plant a foreign
      // 3-field marker AT THAT REAL PATH before the completion block runs.
      // This exercises the identical code path a genuine collision/stale-
      // format marker would (the completion block cannot tell "foreign
      // content under my real PID" from "this PID belongs to someone else
      // right now" — both are just "unexpected content already at this
      // path"), without needing to fake process identity.
      const ppidProbe = spawnSync('bash', ['-c', 'echo $PPID'], { encoding: 'utf-8' });
      const realPpid = ppidProbe.stdout.trim();
      expect(realPpid).toMatch(/^\d+$/);

      fs.mkdirSync(path.join(home, '.gstack', 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.gstack', 'sessions', realPpid),
        `1700000000 ${realPpid}-1700000000 community\n`
      );

      const completionBash = extractBashFence(generateCompletionStatus(baseCtx()), 1);
      const analyticsFile = path.join(home, '.gstack', 'analytics', 'skill-usage.jsonl');
      const before = fs.existsSync(analyticsFile) ? fs.readFileSync(analyticsFile, 'utf-8') : '';

      const completionScript = `unset _TEL_START _SESSION_ID _TEL\n${completionBash
        .replace('SKILL_NAME', 'test-skill')
        .replace('OUTCOME', 'success')
        .replace(/USED_BROWSE/g, 'false')}\necho "RESULT _TEL=$_TEL"`;
      const result = spawnSync('bash', ['-c', completionScript], {
        env: { ...process.env, HOME: home, PATH: process.env.PATH },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      expect(result.status).toBe(0);

      const match = result.stdout.match(/RESULT _TEL=(\S*)/);
      expect(match).not.toBeNull();
      // The foreign marker's third field ("community") must NOT win, even
      // though it exists at the exact path this $PPID resolves to.
      expect(match![1]).toBe('off');

      const after = fs.existsSync(analyticsFile) ? fs.readFileSync(analyticsFile, 'utf-8') : '';
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
