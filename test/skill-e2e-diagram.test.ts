/**
 * /diagram skill E2E (paid, claude -p).
 *
 * gstack renders local HTML through `bin/gstack-render.ts`: the Aside browser
 * when it is running, otherwise gstack's own browse daemon. The /diagram skill
 * runs ONE gstack-render call per triplet (staged bundle, three --eval/--out
 * pairs) and never picks the engine itself — so the test needs SOME browser:
 * Aside on a Mac, or a browse binary (evals.yml's `bun run build` compiles one
 * and PLAYWRIGHT_BROWSERS_PATH survives the hermetic env). With neither, the
 * whole file self-skips — never fails.
 *
 * Two tests with deliberately different tiers (eng-review D5, CLAUDE.md rules):
 *
 *   diagram-triplet (gate) — deterministic functional contract: from an
 *   English ask, the agent following the skill emits a parseable triplet
 *   (.mmd source, .excalidraw scene with elements, SVG markup, PNG bytes) and
 *   did it through gstack-render (a Bash tool call names it). No quality
 *   judgment; either the artifacts exist and parse or they don't.
 *
 *   diagram-authoring-quality (periodic) — LLM-judged benchmark of the
 *   authored mermaid itself (faithfulness to the ask, label quality, readable
 *   size). Non-deterministic by nature → never blocks merge.
 *
 * Per the extract-don't-copy fixture rule, the prompt embeds only the skill's
 * working section (from "# /diagram" onward), not the full generated SKILL.md
 * with its preamble.
 */
import { expect } from 'bun:test';
import { CAPTURE_MS } from './helpers/eval-budgets';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runSkillTest, type SkillTestResult } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost,
} from './helpers/e2e-helpers';
import { asideAvailable } from './helpers/aside-available';
import { resolveBrowseBin } from '../lib/aside-render';
import { callJudge } from './helpers/llm-judge';

// --- Whole-file gate: a browser gstack-render can drive. Skip, never fail. ---

const browserOk = asideAvailable() || resolveBrowseBin() !== null;
if (process.env.EVALS && !browserOk) {
  process.stderr.write('\nskill-e2e-diagram: SKIPPED — no browser: Aside is not running and no browse binary resolves (bun run build)\n');
}

/** describeIfSelected, forced to describe.skip when no browser is available. */
const describeDiagram = (name: string, keys: string[], fn: () => void) =>
  describeIfSelected(name, keys, fn, browserOk ? undefined : []);

const BUNDLE = path.join(ROOT, 'lib', 'diagram-render', 'dist', 'diagram-render.html');
const RENDER = path.join(ROOT, 'bin', 'gstack-render.ts');

/** Extract the working section of the generated skill doc (post-preamble). */
function skillExtract(): string {
  const full = fs.readFileSync(path.join(ROOT, 'diagram', 'SKILL.md'), 'utf-8');
  const start = full.indexOf('# /diagram');
  if (start < 0) throw new Error('diagram/SKILL.md missing "# /diagram" section — regenerate skill docs');
  if (!full.includes('gstack-render')) throw new Error('diagram/SKILL.md does not render through gstack-render (stale generated doc) — run `bun run gen:skill-docs`');
  return full.slice(start);
}

function setupDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'diagram-skill.md'), skillExtract());
  // Pre-stage the bundle so the test is hermetic (no global install needed);
  // gstack-render serves this directory on loopback for the render.
  fs.copyFileSync(BUNDLE, path.join(dir, 'diagram-render.html'));
  fs.mkdirSync(path.join(dir, 'out'));
  return dir;
}

function basePrompt(dir: string, ask: string): string {
  return `You have the /diagram skill instructions at ./diagram-skill.md — read them and follow Steps 1-4.

Environment notes (already set up — skip Step 2's bundle discovery and staging):
- gstack-render picks the browser itself (its first output line is ENGINE=aside or ENGINE=browse); either is fine. Do not probe for or start a browser yourself.
- The render bundle is ALREADY staged at ${dir}/diagram-render.html — use that path wherever the skill says <staged>.
- gstack-render lives at ${RENDER}; run it as \`bun run ${RENDER}\` instead of the ~/.claude/skills/gstack/bin/gstack-render.ts path the skill shows.
- Write all four artifacts into ./out/ with the slug "flow" (out/flow.mmd, out/flow.excalidraw, out/flow.svg, out/flow.png).
- Do not open any other applications. Do not use the Read tool on the PNG (no inline display needed here).

The diagram to create: ${ask}`;
}

/** The skill's render contract: at least one Bash tool call ran gstack-render. */
function expectRenderedViaGstackRender(result: SkillTestResult): void {
  const ran = result.toolCalls.some((c) => c.tool === 'Bash' && JSON.stringify(c.input ?? {}).includes('gstack-render'));
  expect(ran).toBe(true);
}

describeDiagram('/diagram skill E2E', ['diagram-triplet', 'diagram-authoring-quality'], () => {
  testConcurrentIfSelected('diagram-triplet', async () => {
    const dir = setupDir('diagram-triplet-');
    try {
      const result = await runSkillTest({
        prompt: basePrompt(
          dir,
          'a flowchart (graph LR) of a 4-stage pipeline: markdown → prepass → browser render → PDF.',
        ),
        workingDirectory: dir,
        maxTurns: 25,
        allowedTools: ['Bash', 'Read', 'Write'],
        timeout: CAPTURE_MS,
        testName: 'diagram-triplet',
        runId,
      });
      logCost('diagram triplet', result);
      expect(result.exitReason).toBe('success');
      expectRenderedViaGstackRender(result);

      // The deterministic contract: all four artifacts exist and parse.
      const mmd = fs.readFileSync(path.join(dir, 'out', 'flow.mmd'), 'utf-8');
      expect(mmd).toMatch(/graph\s+(LR|TD)/);

      const scene = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'flow.excalidraw'), 'utf-8'));
      expect(scene.type).toBe('excalidraw');
      expect(Array.isArray(scene.elements)).toBe(true);
      expect(scene.elements.length).toBeGreaterThan(3);

      const svg = fs.readFileSync(path.join(dir, 'out', 'flow.svg'), 'utf-8');
      expect(svg).toMatch(/<svg/i);

      const png = fs.readFileSync(path.join(dir, 'out', 'flow.png'));
      expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(png.length).toBeGreaterThan(5_000);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, CAPTURE_MS);

  testConcurrentIfSelected('diagram-authoring-quality', async () => {
    const dir = setupDir('diagram-quality-');
    try {
      const result = await runSkillTest({
        prompt: basePrompt(
          dir,
          'how gstack renders diagrams in PDFs: markdown containing mermaid fences goes through a pre-pass that extracts the fences, renders them in a browser (Aside, or gstack\'s own headless fallback) using an offline bundle, substitutes the SVG back in, inlines local images, and prints the PDF through the same browser. Failures become visible diagnostic blocks.',
        ),
        workingDirectory: dir,
        maxTurns: 25,
        allowedTools: ['Bash', 'Read', 'Write'],
        timeout: CAPTURE_MS,
        testName: 'diagram-authoring-quality',
        runId,
      });
      logCost('diagram authoring quality', result);
      expect(result.exitReason).toBe('success');
      expectRenderedViaGstackRender(result);

      const mmd = fs.readFileSync(path.join(dir, 'out', 'flow.mmd'), 'utf-8');
      const svg = fs.readFileSync(path.join(dir, 'out', 'flow.svg'), 'utf-8');
      expect(svg).toMatch(/<svg/i);

      const verdict = await callJudge<{ score: number; reasoning: string }>(
        `You are judging the quality of an agent-authored mermaid diagram.

THE ASK: a diagram of gstack's PDF diagram-rendering flow — mermaid fences are
extracted by a pre-pass, rendered in a browser (Aside, or gstack's own headless
fallback) via an offline bundle, substituted back as SVG, images inlined,
printed to PDF through the same browser, with render failures becoming visible
diagnostic blocks.

THE AUTHORED MERMAID:
\`\`\`mermaid
${mmd}
\`\`\`

Score 1-10 on: faithfulness to the ask (are the named stages present and
correctly ordered?), label quality (short node labels, detail on edges),
and readable size (5-15 nodes, not a wall). A diagram that misses the
failure/diagnostic path entirely caps at 5 — that path is an explicitly
named requirement, so omitting it must fail the run.

Respond with JSON: {"score": N, "reasoning": "..."}`,
      );
      // eslint-disable-next-line no-console
      console.log(`[diagram-quality] score=${verdict.score} — ${verdict.reasoning}`);
      expect(verdict.score).toBeGreaterThanOrEqual(6);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, CAPTURE_MS);
});
