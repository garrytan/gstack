/**
 * Preamble script-consolidation A/B: inline-bash render vs script render —
 * gate during token-reduction Phases 1-3 (demote to periodic after Phase 3,
 * plan OV7), paid, SDK capture.
 *
 * Phase 1 moved ~13KB of inline preamble bash per skill into
 * bin/gstack-skill-start. Layer 0 (test/gstack-skill-start.test.ts) proves the
 * script emits the same STATUS lines deterministically; THIS proves the model
 * driven by the slim render still runs the preamble and produces an
 * equal-quality decision brief on the same prompt.
 *
 * Arms (precedent: skill-e2e-auq-verbose-vs-carved-ab.test.ts):
 *   - INLINE : pre-Phase-1 plan-ceo-review/SKILL.md read from git
 *              (29785978 = the v1.69.1.0 bump, the last inline-bash render).
 *   - SCRIPT : this worktree's render, with the fence's install-root bin path
 *              rewritten to THIS WORKTREE's bin/ (plan EOV2: hermetic evals
 *              resolve $HOME/.claude/skills/gstack/bin to the operator
 *              install, which would silently exercise the degraded path;
 *              the rewrite makes the branch's script the subject under test).
 *
 * Both arms pin GSTACK_HOME to the fixture dir (EOV7: onboarding state is
 * hermetic now that the script honors GSTACK_HOME).
 */
import { test, expect } from 'bun:test';
import { describeE2ETier } from './helpers/e2e-gate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  setupPlanCeoDir,
  captureModeSelectionAuq,
  scoreAuqFormat,
  carvedSkill,
} from './helpers/auq-sdk-capture';

const describeE2E = describeE2ETier('periodic');
const runId = `preamble-ab-${process.env.EVALS_RUN_ID ?? 'local'}`;
const ROOT = path.resolve(import.meta.dir, '..');
const INLINE_REF = '29785978'; // last pre-Phase-1 commit (v1.69.1.0 bump)

function inlineSkill(): string {
  return execSync(`git show ${INLINE_REF}:plan-ceo-review/SKILL.md`, {
    // LIVE-REPO CWD: git show needs this repo's history to read the
    // pre-Phase-1 SKILL.md render at INLINE_REF.
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** EOV2 redirection: point the fence at the worktree's bin. */
function scriptSkillWorktreeBin(): string {
  const current = carvedSkill();
  const rewritten = current.skillMd.replaceAll(
    '$HOME/.claude/skills/gstack/bin/gstack-skill-start',
    path.join(ROOT, 'bin', 'gstack-skill-start'),
  );
  if (!rewritten.includes(path.join(ROOT, 'bin', 'gstack-skill-start'))) {
    throw new Error('binDir rewrite matched nothing — fence shape changed; update the A/B redirection');
  }
  return rewritten;
}

async function grade(label: string, dir: string) {
  const text = await captureModeSelectionAuq({ planDir: dir, testName: `preamble-ab-${label}`, runId });
  const fmt = scoreAuqFormat(text);
  // eslint-disable-next-line no-console
  console.log(`[PREAMBLE-AB ${label}] captured=${text.length}B format=${fmt.present}/${fmt.total} missing=[${fmt.missing.join(',')}]`);
  return { text, fmt };
}

describeE2E('Preamble consolidation no-degradation: inline bash vs script (gate)', () => {
  test(
    'script-render plan-ceo-review AUQ is not worse than the inline-bash render on the same prompt',
    async () => {
      const sections = carvedSkill().sectionsFrom;
      const scriptDir = setupPlanCeoDir({
        skillMd: scriptSkillWorktreeBin(),
        sectionsFrom: sections,
        tmpPrefix: 'preamble-ab-script-',
      });
      const inlineDir = setupPlanCeoDir({
        skillMd: inlineSkill(),
        sectionsFrom: sections,
        tmpPrefix: 'preamble-ab-inline-',
      });

      let s, i;
      try {
        s = await grade('SCRIPT', scriptDir);
        i = await grade('INLINE', inlineDir);
      } finally {
        fs.rmSync(scriptDir, { recursive: true, force: true });
        fs.rmSync(inlineDir, { recursive: true, force: true });
      }

      // Both arms must produce a capture at all (an empty script-arm capture
      // means the preamble derailed the workflow — exactly the regression this
      // guards against).
      expect(s.text.length).toBeGreaterThan(100);
      expect(i.text.length).toBeGreaterThan(100);
      // Relative parity: the script render is NOT WORSE on decision-brief
      // format elements (absolute compliance is auq-format-gate's job).
      expect(s.fmt.present).toBeGreaterThanOrEqual(i.fmt.present);
    },
    20 * 60 * 1000,
  );
});
