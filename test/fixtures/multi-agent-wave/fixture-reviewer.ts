#!/usr/bin/env bun
/**
 * Fixture reviewer for the unattended runner tests: reads a prompt file the way
 * a subagent would, honors the RESULT FORMAT contract (INPUT receipt, canonical
 * findings fence) and writes the result where the prompt says. Findings come
 * from FIXTURE_FINDINGS (JSON array) or a small default set; FIXTURE_BREAK
 * selects a deliberately bad result: `receipt` (wrong hash), `fence` (no
 * findings block), `row` (malformed row).
 *
 *   bun fixture-reviewer.ts <prompt-file> [--out <file>]
 */
import * as fs from 'node:fs';

const [prompt, ...rest] = process.argv.slice(2);
if (!prompt) { console.error('usage: fixture-reviewer.ts <prompt-file> [--out <file>]'); process.exit(2); }
const text = fs.readFileSync(prompt, 'utf8');
const receipt = /INPUT: ([a-z]+) ([0-9a-f]{64})/.exec(text);
const target = /Write the whole result to this file: (\S+)/.exec(text);
if (!receipt || !target) { console.error('prompt lacks the RESULT FORMAT contract'); process.exit(1); }
const out = rest.includes('--out') ? rest[rest.indexOf('--out') + 1]! : target[1]!;
const broken = process.env.FIXTURE_BREAK;
const voice = /outside-prompt\.md$/.test(prompt) ? 'outside' : 'native';
const defaults = voice === 'native'
  ? [{ id: 'F1', severity: 'High', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 12, fix: 'print PASS/FAIL per component' },
     { id: 'F2', severity: 'Medium', title: 'Spend ledger admission is an estimate', file: 'lib/spend-ledger.ts', line: 40, fix: 'show worst case' },
     { id: 'F3', severity: 'Low', title: 'Docs link the quickstart', user_challenge: true }]
  : [{ id: 'O1', severity: 'Critical', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 14, fix: 'exit non-zero on any FAIL' },
     { id: 'O2', severity: 'High', title: 'Gate reuse on tree equality alone is unsound', file: 'lib/tree-receipt.ts', line: 3, fix: 'bind runtime pins' },
     { id: 'O3', severity: 'Low', title: 'Docs link the quickstart page', user_challenge: true }];
const findings = process.env.FIXTURE_FINDINGS ? JSON.parse(process.env.FIXTURE_FINDINGS) : defaults;
const sha = broken === 'receipt' ? '0'.repeat(64) : receipt[2];
const rows = findings.map((f: unknown) => JSON.stringify(f));
if (broken === 'row') rows.push('{"severity":"High"');
const fence = broken === 'fence' ? '' : `\n\`\`\`gstack-findings\n${rows.join('\n')}\n\`\`\`\n`;
const body = `INPUT: ${receipt[1]} ${sha}\n\n## ${voice} ${receipt[1]} review (fixture)\n\nRead ${text.split('\n').length} lines. ${findings.length} findings.\n\nRecommendation: revise because the fixture says so.\n${fence}`;
fs.mkdirSync(require('node:path').dirname(out), { recursive: true });
fs.writeFileSync(out, body);
console.log(`REVIEWED: ${voice} ${receipt[1]} -> ${out}`);
