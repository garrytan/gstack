/**
 * /office-hours Phase 4 alternatives gate regression (periodic, paid, SDK-based).
 *
 * Reproduces the bug seen in production: agent in builder mode reaches Phase 4,
 * presents 3 architectural alternatives (A/B/C), writes "Recommendation: C" in
 * chat prose, and starts editing the design doc immediately — never calls
 * AskUserQuestion. The fix is the STOP gate added to office-hours/SKILL.md.tmpl
 * Phase 4 footer.
 *
 * Test approach: SDK + captureInstruction (same proven pattern as
 * skill-e2e-plan-format.test.ts). Pre-seed builder mode + "skip Phase 1/2/3,
 * I have already accepted all premises" so the agent reaches Phase 4 directly.
 * captureInstruction tells the agent to dump the verbatim Phase 4 AskUserQuestion
 * to a file. We then assert on the captured text (regex + Haiku judge) rather
 * than on tool-call observability — the captured file IS the Phase 4 question.
 *
 * Why periodic (not gate): Phase 4 requires the agent to invent 2-3 distinct
 * architectures, which is more open-ended than the 4 plan-format cases. Closer
 * to a quality benchmark than a deterministic format check. Reclassify if the
 * test turns out stable.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { judgeRecommendation } from './helpers/llm-judge';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-office-hours-phase4');

// Format predicates — same shape as skill-e2e-plan-format.test.ts.
const RECOMMENDATION_RE = /[Rr]ecommendation:[*\s]*Choose/;
const BECAUSE_RE = /\bbecause\b/i;
// At least 2 numbered/lettered options (A/B or 1/2). Office-hours Phase 4 says
// "2-3 distinct alternatives," so 2+ is the minimum bar.
const TWO_OPTIONS_RE = /\b[AB]\)|\b1\)|\b2\)/;
// Phase-4-specific: at least one of these tokens should appear in the captured
// question. Without this, a captured AUQ from an earlier phase would false-pass.
const PHASE4_VOCAB_RE = /approach|alternative|architecture|implementation/i;

function setupOfficeHoursDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-office-hours-phase4-'));
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);

  // Seed a tiny project context so the skill has something to reason about.
  fs.writeFileSync(path.join(dir, 'README.md'), `# gbrain-retrieval

We're building a retrieval surface for gbrain so cross-skill memory works
end-to-end. There are three architectural shapes worth considering: server-side
(gbrain ships the smarts), client-side (gstack ships the smarts), and a hybrid
that ships V1 client-side and promotes to gbrain in V1.5.
`);
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'seed']);

  // Drop in office-hours/SKILL.md so the agent can read it inside the tmpdir.
  fs.mkdirSync(path.join(dir, 'office-hours'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'office-hours', 'SKILL.md'),
    path.join(dir, 'office-hours', 'SKILL.md'),
  );

  return dir;
}

function captureInstruction(outFile: string): string {
  return `Write the verbatim text of the Phase 4 (Alternatives Generation) AskUserQuestion you would have made to ${outFile} (full text including all option labels, recommendation line with because-clause, and net-line). Do NOT call any tool to ask the user. Do NOT paraphrase — include the exact prose you would have shown. This is a format-capture test, not an interactive session.`;
}

describeIfSelected('Office Hours Phase 4 — Architectural fork must surface AskUserQuestion', ['office-hours-phase4-fork'], () => {
  let workDir: string;
  let outFile: string;

  beforeAll(() => {
    workDir = setupOfficeHoursDir();
    outFile = path.join(workDir, 'phase4-capture.md');
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('office-hours-phase4-fork', async () => {
    const result = await runSkillTest({
      prompt: `Read office-hours/SKILL.md for the workflow.

Context: this is BUILDER MODE (Path B). The project is gbrain-retrieval — see README.md. I have a fully-formed plan and have already accepted all your Phase 3 premises. Skip Phase 1, Phase 2, and Phase 3 entirely.

Proceed directly to Phase 4 (Alternatives Generation). Generate 2-3 distinct architectural approaches that differ in KIND (not in coverage). Realistic shapes for this project:
  A) Server-side: gbrain ships the retrieval smarts as new MCP tools (e.g. get_recent_salience, find_anomalies).
  B) Client-side: gstack ships a helper (bin/gstack-brain-context-load) that composes salience client-side from existing MCP tools.
  C) Hybrid: V1 client-side in gstack; V1.5 promotes to gbrain server-side once the salience signal is validated.

Do not skip Phase 4 — the test depends on you reaching it.

${captureInstruction(outFile)}

After writing the file with that ONE Phase 4 question, stop. Do not continue to Phase 4.5 or Phase 5.`,
      workingDirectory: workDir,
      maxTurns: 12,
      timeout: 300_000,
      testName: 'office-hours-phase4-fork',
      runId,
      model: 'claude-opus-4-7',
    });

    logCost('/office-hours Phase 4 fork', result);
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    expect(fs.existsSync(outFile)).toBe(true);
    const captured = fs.readFileSync(outFile, 'utf-8');
    expect(captured.length).toBeGreaterThan(100);

    // Format-spec compliance.
    expect(captured).toMatch(RECOMMENDATION_RE);
    expect(captured).toMatch(BECAUSE_RE);
    expect(captured).toMatch(TWO_OPTIONS_RE);
    // Phase-4 specificity: prevents a stray earlier-phase AUQ from false-passing.
    expect(captured).toMatch(PHASE4_VOCAB_RE);

    // Recommendation-quality judge: same threshold as plan-format tests.
    const recScore = await judgeRecommendation(captured);
    recordE2E(evalCollector, '/office-hours-phase4-fork', 'Office Hours Phase 4 — Architectural fork must surface AskUserQuestion', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
      judge_scores: {
        rec_present: recScore.present ? 1 : 0,
        rec_commits: recScore.commits ? 1 : 0,
        rec_has_because: recScore.has_because ? 1 : 0,
        rec_substance: recScore.reason_substance,
      },
      judge_reasoning: `${recScore.reasoning} | reason: "${recScore.reason_text}"`,
    });
    expect(recScore.present, recScore.reasoning).toBe(true);
    expect(recScore.commits, recScore.reasoning).toBe(true);
    expect(recScore.has_because, recScore.reasoning).toBe(true);
    expect(
      recScore.reason_substance,
      `${recScore.reasoning}\n  reason: "${recScore.reason_text}"`,
    ).toBeGreaterThanOrEqual(4);
  }, 360_000);
});

afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
