#!/usr/bin/env bun
/**
 * CLI for capturing a parity baseline snapshot.
 *
 * Usage:
 *   bun run scripts/capture-baseline.ts                            # default path
 *   bun run scripts/capture-baseline.ts --tag v1.44.1              # tag the snapshot
 *   bun run scripts/capture-baseline.ts --out path/to/baseline.json
 *
 * The default output path is test/fixtures/parity-baseline-<tag>.json,
 * or test/fixtures/parity-baseline-current.json when no tag is given.
 */

import * as fs from 'fs';
import * as path from 'path';
import { captureBaseline } from '../test/helpers/capture-parity-baseline';

const ROOT = path.resolve(import.meta.dir, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

const tag = arg('--tag');
const outOverride = arg('--out');
const defaultOut = path.join(
  ROOT,
  'test',
  'fixtures',
  `parity-baseline-${tag ?? 'current'}.json`,
);
const outPath = outOverride ? path.resolve(outOverride) : defaultOut;

const baseline = captureBaseline({ repoRoot: ROOT, tag });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n');

const totalKB = Math.round(baseline.totalCorpusBytes / 1024);
const top3 = baseline.topHeaviest.slice(0, 3);
console.log(`Parity baseline captured: ${outPath}`);
console.log(`  tag:           ${baseline.tag}`);
console.log(`  commit:        ${baseline.capturedFromCommit}`);
console.log(`  branch:        ${baseline.capturedFromBranch}`);
console.log(`  skills:        ${baseline.totalSkills}`);
console.log(`  total corpus:  ${totalKB} KB`);
console.log(`  catalog tokens: ~${baseline.estTotalCatalogTokens}`);
console.log(`  top 3 heaviest:`);
for (const s of top3) {
  const kb = Math.round(s.skillMdBytes / 1024);
  console.log(`    ${s.skill.padEnd(28)} ${kb} KB (${s.skillMdLines} lines, ~${s.estTokens} tokens)`);
}
