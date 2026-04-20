/**
 * Benchmark quality judge — wraps llm-judge.ts for multi-provider scoring.
 *
 * The judge is always Anthropic SDK (claude-sonnet-4-6) for stability. It sees
 * the prompt + N provider outputs and scores each on: correctness, completeness,
 * code quality, edge case handling. 0-10 per dimension; overall = average.
 *
 * Judge adds ~$0.05 per benchmark run. Gated by --judge CLI flag.
 */

import type { BenchmarkReport, BenchmarkEntry } from './benchmark-runner';

export async function judgeEntries(report: BenchmarkReport): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — judge requires Anthropic access.');
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => {
    throw new Error('@anthropic-ai/sdk not installed — run `bun add @anthropic-ai/sdk` if you want the judge.');
  });
  const client = new (Anthropic as unknown as new (opts: { apiKey: string }) => {
    messages: { create: (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
  })({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const successful = report.entries.filter(e => e.available && e.result && !e.result.error);
  if (successful.length === 0) return;

  const judgePrompt = buildJudgePrompt(report.prompt, successful);
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: judgePrompt }],
  });
  const textBlock = msg.content.find(c => c.type === 'text');
  if (!textBlock) return;

  const scores = parseScores(textBlock.text, successful.length);
  for (let i = 0; i < successful.length; i++) {
    const s = scores[i];
    if (!s) continue;
    successful[i].qualityScore = s.overall;
    successful[i].qualityDetails = s.dimensions;
  }
}

function buildJudgePrompt(prompt: string, entries: BenchmarkEntry[]): string {
  const lines: string[] = [
    'You are a strict, fair technical reviewer scoring N model outputs against the same prompt.',
    '',
    '--- PROMPT ---',
    prompt.length > 4000 ? prompt.slice(0, 4000) + '\n[...truncated for judge budget...]' : prompt,
    '',
    '--- OUTPUTS ---',
  ];
  entries.forEach((e, i) => {
    const r = e.result!;
    const out = r.output.length > 3000 ? r.output.slice(0, 3000) + '\n[...truncated...]' : r.output;
    lines.push(`=== Output ${i + 1}: ${r.modelUsed} ===`);
    lines.push(out);
    lines.push('');
  });
  lines.push('');
  lines.push('Score each output on these dimensions (0-10 per dimension):');
  lines.push('  - correctness:   does it solve what the prompt asked?');
  lines.push('  - completeness:  are edge cases and error paths addressed?');
  lines.push('  - code_quality:  naming, structure, explicitness');
  lines.push('  - edge_cases:    handling of nil/empty/invalid input');
  lines.push('');
  lines.push('Return JSON only, in this exact shape:');
  lines.push('{"scores":[');
  lines.push('  {"output":1,"correctness":N,"completeness":N,"code_quality":N,"edge_cases":N,"overall":N,"notes":"..."},');
  lines.push('  ...');
  lines.push(']}');
  lines.push('');
  lines.push('overall = rounded average of the 4 dimensions. No other commentary.');
  return lines.join('\n');
}

interface ParsedScore {
  overall: number;
  dimensions: Record<string, number>;
}

function parseScores(raw: string, expectedCount: number): ParsedScore[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[0]);
    if (!Array.isArray(obj.scores)) return [];
    return obj.scores.slice(0, expectedCount).map((s: Record<string, number>) => ({
      overall: Number(s.overall ?? 0),
      dimensions: {
        correctness: Number(s.correctness ?? 0),
        completeness: Number(s.completeness ?? 0),
        code_quality: Number(s.code_quality ?? 0),
        edge_cases: Number(s.edge_cases ?? 0),
      },
    }));
  } catch {
    return [];
  }
}
