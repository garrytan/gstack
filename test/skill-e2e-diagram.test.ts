/**
 * /diagram skill E2E (paid, claude -p).
 *
 * Two tests with deliberately different tiers (eng-review D5):
 *
 *   diagram-triplet (gate) — deterministic functional contract: from an
 *   English ask, the agent following the skill emits a parseable triplet —
 *   .mmd source, .excalidraw scene with elements, SVG markup, PNG bytes.
 *   No quality judgment; either the artifacts exist and parse or they don't.
 *
 *   diagram-authoring-quality (periodic) — LLM-judged benchmark of the
 *   authored mermaid itself (faithfulness to the ask, label quality,
 *   readable size). Non-deterministic by nature → never blocks merge.
 *
 * Per the extract-don't-copy fixture rule, the prompt embeds only the skill's
 * working section (from "# /diagram" onward), not the full generated SKILL.md
 * with its preamble.
 */
import { describe, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost,
} from './helpers/e2e-helpers';
import { callJudge } from './helpers/llm-judge';

const BUNDLE = path.join(ROOT, 'lib', 'diagram-render', 'dist', 'diagram-render.html');

/** Extract the working section of the generated skill doc (post-preamble). */
function skillExtract(): string {
  const full = fs.readFileSync(path.join(ROOT, 'diagram', 'SKILL.md'), 'utf-8');
  const start = full.indexOf('# /diagram');
  if (start < 0) throw new Error('diagram/SKILL.md missing "# /diagram" section — regenerate skill docs');
  return full.slice(start);
}

function setupDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'diagram-skill.md'), skillExtract());
  // Pre-stage the bundle so the test is hermetic (no global install needed in
  // CI); the prompt tells the agent discovery is already done.
  fs.copyFileSync(BUNDLE, path.join(dir, 'diagram-render.html'));
  fs.mkdirSync(path.join(dir, 'out'));
  return dir;
}

function basePrompt(dir: string, ask: string): string {
  return `You have the /diagram skill instructions at ./diagram-skill.md — read them and follow Steps 1-4.

Environment notes (already set up — skip Step 2's bundle discovery):
- The browse binary is at ${browseBin} — use it wherever the skill says $B.
- The render bundle is ALREADY staged at ./diagram-render.html in this directory; load it with: ${browseBin} load-html ./diagram-render.html
- Write all four artifacts into ./out/ with the slug "flow" (out/flow.mmd, out/flow.excalidraw, out/flow.svg, out/flow.png).
- Do not open any other applications. Do not use the Read tool on the PNG (no inline display needed here).

The diagram to create: ${ask}`;
}

describeIfSelected('/diagram skill E2E', ['diagram-triplet', 'diagram-authoring-quality'], () => {
  testConcurrentIfSelected('diagram-triplet', async () => {
    const dir = setupDir('diagram-triplet-');
    try {
      const result = await runSkillTest({
        prompt: basePrompt(
          dir,
          'a flowchart (graph LR) of a 4-stage pipeline: markdown → prepass → Chromium → PDF.',
        ),
        workingDirectory: dir,
        maxTurns: 25,
        allowedTools: ['Bash', 'Read', 'Write'],
        timeout: 240_000,
        testName: 'diagram-triplet',
        runId,
      });
      logCost('diagram triplet', result);
      expect(result.exitReason).toBe('success');

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
  }, 300_000);

  testConcurrentIfSelected('diagram-authoring-quality', async () => {
    const dir = setupDir('diagram-quality-');
    try {
      const result = await runSkillTest({
        prompt: basePrompt(
          dir,
          'how gstack renders diagrams in PDFs: markdown containing mermaid fences goes through a pre-pass that extracts the fences, renders them in a browse daemon tab using an offline bundle, substitutes the SVG back in, inlines local images, and prints via Chromium. Failures become visible diagnostic blocks.',
        ),
        workingDirectory: dir,
        maxTurns: 25,
        allowedTools: ['Bash', 'Read', 'Write'],
        timeout: 240_000,
        testName: 'diagram-authoring-quality',
        runId,
      });
      logCost('diagram authoring quality', result);
      expect(result.exitReason).toBe('success');

      const mmd = fs.readFileSync(path.join(dir, 'out', 'flow.mmd'), 'utf-8');
      const svg = fs.readFileSync(path.join(dir, 'out', 'flow.svg'), 'utf-8');
      expect(svg).toMatch(/<svg/i);

      const verdict = await callJudge<{ score: number; reasoning: string }>(
        `You are judging the quality of an agent-authored mermaid diagram.

THE ASK: a diagram of gstack's PDF diagram-rendering flow — mermaid fences are
extracted by a pre-pass, rendered in a browse tab via an offline bundle,
substituted back as SVG, images inlined, printed by Chromium, with render
failures becoming visible diagnostic blocks.

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
  }, 300_000);
});
