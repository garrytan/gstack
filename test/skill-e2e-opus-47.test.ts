/**
 * Opus 4.7 behavior evals.
 *
 * Two cases, both pinned to claude-opus-4-7:
 *
 * 1. Fanout rate — the "Fan out explicitly" overlay nudge should make 4.7
 *    spawn parallel tool calls when the prompt has independent sub-problems.
 *    A/B: SKILL.md regenerated with `--model opus-4-7` (overlay ON) vs
 *    default `--model claude` (overlay OFF). Assert A ≥ B on parallel-call
 *    count in the first assistant turn.
 *
 * 2. Routing precision — the new "when in doubt, invoke the skill" policy
 *    should route ambiguous dev prompts to the right skill WITHOUT routing
 *    casual/non-dev prompts. A handful of positive and negative controls.
 *
 * Both cases require a running Anthropic API key. Gated behind EVALS=1.
 * Classify as `periodic` in touchfiles — behavior measurement, not gate.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import { EvalCollector } from './helpers/eval-store';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const OPUS_47 = 'claude-opus-4-7';

const evalsEnabled = !!process.env.EVALS;
const describeE2E = evalsEnabled ? describe : describe.skip;
const evalCollector = evalsEnabled ? new EvalCollector('e2e-opus-47') : null;
const runId = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);

// --- Helpers ---

/** Skills that must exist as individual .claude/skills/{name}/SKILL.md files
 *  for Claude Code's auto-discovery to treat them as invokable via Skill tool.
 *  Matches the pattern in skill-routing-e2e.test.ts. */
const INSTALLED_SKILLS = [
  'qa', 'qa-only', 'ship', 'review', 'plan-ceo-review', 'plan-eng-review',
  'plan-design-review', 'design-review', 'design-consultation', 'retro',
  'document-release', 'investigate', 'office-hours', 'browse',
];

/** Write a scratch root with:
 *   - Per-skill SKILL.md files under .claude/skills/ (so Skill tool sees them)
 *   - Project CLAUDE.md with explicit routing rules AND (optionally) the
 *     4.7 overlay content directly inlined so `claude -p` sees it
 *   - git init
 *
 *  `includeOverlay` controls whether the opus-4-7 nudges (Fan out, Literal,
 *  etc.) get inlined into CLAUDE.md — this is the A/B axis for the fanout
 *  test. `claude -p` doesn't auto-load SKILL.md content, so CLAUDE.md is
 *  the only way to make the overlay visible to the model in this test
 *  harness.
 */
function mkEvalRoot(suffix: string, includeOverlay: boolean): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `opus47-${suffix}-`));

  // Regenerate at opus-4-7 so the per-skill SKILL.md files reflect that
  // model's overlay. If includeOverlay is false we'll re-regen at default
  // later just for the root SKILL.md copy. For individual skills, opus-4-7
  // content doesn't matter for the routing test (we only need discovery).
  const result = spawnSync(
    'bun',
    ['run', 'scripts/gen-skill-docs.ts', '--model', includeOverlay ? 'opus-4-7' : 'claude'],
    { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8', timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`gen-skill-docs failed: ${result.stderr}`);
  }

  // Install per-skill SKILL.md files for Skill tool discovery.
  const skillsDir = path.join(tmp, '.claude', 'skills');
  for (const skill of INSTALLED_SKILLS) {
    const src = path.join(ROOT, skill, 'SKILL.md');
    if (!fs.existsSync(src)) continue;
    const destDir = path.join(skillsDir, skill);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, 'SKILL.md'));
  }

  // Extract the opus-4-7 model-overlay content from the checked-in file
  // so we can inline it into CLAUDE.md when includeOverlay is true.
  const overlayText = includeOverlay
    ? fs.readFileSync(path.join(ROOT, 'model-overlays', 'opus-4-7.md'), 'utf-8')
        .replace(/\{\{INHERIT:claude\}\}\s*/, '')
        .trim()
    : '';

  // Project CLAUDE.md. Explicit routing rules so the agent reaches for
  // Skill tool on matching prompts, plus the optional overlay.
  const routingBlock = `## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool
as your FIRST action. The skill has multi-step workflows, checklists, and quality
gates that produce better results than an ad-hoc answer. When in doubt, invoke.

- Bugs, errors, "why is this broken", "wtf" → invoke investigate
- Ship, deploy, "send it", create a PR → invoke ship
- QA, test the site, "does this work" → invoke qa
- Code review, check my diff → invoke review
- Product ideas, brainstorming, "is this worth building" → invoke office-hours
- Architecture, "does this design make sense" → invoke plan-eng-review
- Design system, visual polish → invoke design-review
- Weekly retro, what did we ship → invoke retro`;

  const claudeMd = includeOverlay
    ? `# Project\n\n${overlayText}\n\n${routingBlock}\n`
    : `# Project\n\n${routingBlock}\n`;

  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), claudeMd);
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"opus47-eval"}');

  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: tmp, stdio: 'pipe', timeout: 5_000 });
  git(['init']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 'T']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  return tmp;
}

/** Count parallel tool calls in the first assistant turn. */
function firstTurnParallelism(transcript: any[]): number {
  const firstAssistant = transcript.find((e) => e.type === 'assistant');
  if (!firstAssistant) return 0;
  const content = firstAssistant.message?.content ?? [];
  return content.filter((c: any) => c.type === 'tool_use').length;
}

interface RoutingCase {
  name: string;
  prompt: string;
  shouldRoute: boolean;
  expectedSkill?: string;
}

/** Small, intentionally chosen routing cases. Positive cases are ambiguous
 *  phrasings the user actually says, not template text. Negative cases are
 *  casual or off-topic prompts that match routing keywords but shouldn't
 *  trigger a skill. */
const ROUTING_CASES: RoutingCase[] = [
  // Positive — should route
  { name: 'pos-wtf-bug',    prompt: "wtf is this error coming from auth.ts:47 when the cookie expires?",           shouldRoute: true, expectedSkill: 'investigate' },
  { name: 'pos-send-it',    prompt: "ok this is good enough, let's send it.",                                       shouldRoute: true, expectedSkill: 'ship' },
  { name: 'pos-does-it-work', prompt: "I just pushed the login flow changes. Test the deployed site and find any bugs.",                shouldRoute: true, expectedSkill: 'qa' },
  // Negative — should NOT route
  { name: 'neg-syntax-q',   prompt: "wtf does this Python list comprehension syntax even mean, [x for x in y if z]?", shouldRoute: false },
  { name: 'neg-algo-q',     prompt: "does this bubble sort algorithm actually work in O(n log n)?",                   shouldRoute: false },
  { name: 'neg-slack-send', prompt: "can you help me write the slack message? I want to send it to the team.",       shouldRoute: false },
];

// --- Tests ---

describeE2E('Opus 4.7 overlay behavior evals', () => {
  afterAll(() => {
    evalCollector?.finalize();
    // Restore working tree: mkEvalRoot runs `gen-skill-docs` with various
    // --model flags, leaving the in-repo SKILL.md files generated at
    // whichever model ran last. Reset to the default (claude) so the tree
    // matches what would be checked in.
    spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 60_000,
    });
  });

  test(
    'fanout: overlay ON emits >= parallel calls vs overlay OFF on 3-file investigate task',
    async () => {
      const armA = mkEvalRoot('on', true);
      const armB = mkEvalRoot('off', false);

      // Populate three tiny independent files in each arm. The prompt asks
      // the agent to read all three and report. Opus 4.7 (without nudge)
      // tends to serialize; with the nudge it should parallelize.
      for (const dir of [armA, armB]) {
        fs.writeFileSync(path.join(dir, 'alpha.txt'), 'alpha content: 1\n');
        fs.writeFileSync(path.join(dir, 'beta.txt'),  'beta content: 2\n');
        fs.writeFileSync(path.join(dir, 'gamma.txt'), 'gamma content: 3\n');
      }

      const prompt =
        "Read alpha.txt, beta.txt, and gamma.txt in this directory and report what's inside each. These three reads are independent.";

      try {
        const [resA, resB] = await Promise.all([
          runSkillTest({
            prompt,
            workingDirectory: armA,
            maxTurns: 5,
            allowedTools: ['Read', 'Bash', 'Glob', 'Grep'],
            timeout: 90_000,
            testName: 'fanout-arm-overlay-on',
            runId,
            model: OPUS_47,
          }),
          runSkillTest({
            prompt,
            workingDirectory: armB,
            maxTurns: 5,
            allowedTools: ['Read', 'Bash', 'Glob', 'Grep'],
            timeout: 90_000,
            testName: 'fanout-arm-overlay-off',
            runId,
            model: OPUS_47,
          }),
        ]);

        const parA = firstTurnParallelism(resA.transcript);
        const parB = firstTurnParallelism(resB.transcript);

        console.log(
          `[opus-4-7 fanout] arm A (overlay ON): ${parA} parallel tool calls in first turn; ` +
            `arm B (overlay OFF): ${parB}`,
        );
        console.log(`  cost A=$${resA.costEstimate.estimatedCost.toFixed(2)} B=$${resB.costEstimate.estimatedCost.toFixed(2)}`);

        evalCollector?.addTest({
          name: 'fanout-arm-overlay-on',
          suite: 'Opus 4.7 overlay',
          tier: 'e2e',
          passed: parA >= parB,
          duration_ms: resA.duration,
          cost_usd: resA.costEstimate.estimatedCost,
          transcript: resA.transcript,
          output: `parallel=${parA}`,
          turns_used: resA.costEstimate.turnsUsed,
          exit_reason: resA.exitReason,
        });
        evalCollector?.addTest({
          name: 'fanout-arm-overlay-off',
          suite: 'Opus 4.7 overlay',
          tier: 'e2e',
          passed: true, // baseline arm, recorded for comparison
          duration_ms: resB.duration,
          cost_usd: resB.costEstimate.estimatedCost,
          transcript: resB.transcript,
          output: `parallel=${parB}`,
          turns_used: resB.costEstimate.turnsUsed,
          exit_reason: resB.exitReason,
        });

        // Main assertion: overlay arm is at least as parallel as baseline.
        expect(parA, `overlay arm emitted ${parA} parallel calls, baseline ${parB}`).toBeGreaterThanOrEqual(parB);
      } finally {
        fs.rmSync(armA, { recursive: true, force: true });
        fs.rmSync(armB, { recursive: true, force: true });
      }
    },
    240_000,
  );

  test(
    'routing precision: positives route, negatives do not',
    async () => {
      // Single SKILL.md tree shared by all cases. We run claude-opus-4-7 with
      // tool access to Skill; measure whether the first tool call is Skill(..)
      // and if so, which skill.
      const root = mkEvalRoot('routing', true);

      try {
        const results = await Promise.all(
          ROUTING_CASES.map((c) =>
            runSkillTest({
              prompt: c.prompt,
              workingDirectory: root,
              maxTurns: 3,
              allowedTools: ['Skill', 'Read', 'Bash', 'Glob', 'Grep'],
              timeout: 90_000,
              testName: `routing-${c.name}`,
              runId,
              model: OPUS_47,
            }).then((r) => ({ c, r })),
          ),
        );

        let tp = 0, fn = 0, fp = 0, tn = 0;
        const rows: string[] = [];
        let totalCost = 0;

        for (const { c, r } of results) {
          const skillCalls = r.toolCalls.filter((tc) => tc.tool === 'Skill');
          const routed = skillCalls.length > 0;
          const actualSkill = routed ? skillCalls[0]?.input?.skill : undefined;

          const correct = c.shouldRoute
            ? routed && (!c.expectedSkill || actualSkill === c.expectedSkill)
            : !routed;

          if (c.shouldRoute && routed) tp++;
          else if (c.shouldRoute && !routed) fn++;
          else if (!c.shouldRoute && routed) fp++;
          else tn++;

          totalCost += r.costEstimate.estimatedCost;
          rows.push(
            `  ${c.name.padEnd(18)} routed=${String(routed).padEnd(5)} skill=${String(actualSkill).padEnd(16)} ` +
              `expected=${c.shouldRoute ? (c.expectedSkill ?? 'any') : '(none)'} ${correct ? 'OK' : 'MISS'}`,
          );

          evalCollector?.addTest({
            name: `routing-${c.name}`,
            suite: 'Opus 4.7 routing',
            tier: 'e2e',
            passed: correct,
            duration_ms: r.duration,
            cost_usd: r.costEstimate.estimatedCost,
            transcript: r.transcript,
            output: `routed=${routed} actual=${actualSkill ?? '(none)'} expected=${c.shouldRoute ? c.expectedSkill ?? 'any' : '(none)'}`,
            turns_used: r.costEstimate.turnsUsed,
            exit_reason: r.exitReason,
          });
        }

        const posCount = ROUTING_CASES.filter((c) => c.shouldRoute).length;
        const negCount = ROUTING_CASES.length - posCount;
        const tpRate = posCount > 0 ? tp / posCount : 0;
        const fpRate = negCount > 0 ? fp / negCount : 0;

        console.log(`[opus-4-7 routing] total cost $${totalCost.toFixed(2)}`);
        console.log(rows.join('\n'));
        console.log(
          `  TP=${tp}/${posCount} (${(tpRate * 100).toFixed(0)}%)  FN=${fn}  ` +
            `FP=${fp}/${negCount} (${(fpRate * 100).toFixed(0)}%)  TN=${tn}`,
        );

        // Thresholds from the test plan artifact: TP >= 80%, FP <= 30%.
        // With a small N we loosen slightly: TP >= 66% (2 of 3 positive),
        // FP <= 33% (no more than 1 of 3 negatives).
        expect(tpRate, `true-positive rate ${(tpRate * 100).toFixed(0)}% (need >= 66%)`).toBeGreaterThanOrEqual(2 / 3);
        expect(fpRate, `false-positive rate ${(fpRate * 100).toFixed(0)}% (need <= 33%)`).toBeLessThanOrEqual(1 / 3);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    360_000,
  );
});
