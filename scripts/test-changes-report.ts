#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * test-changes-report — what a pull request does to its own tests and gate, for the
 * flag-only Test changes check (.github/workflows/test-changes.yml, docs/ship-policy.md#test-changes).
 *
 *   bun scripts/test-changes-report.ts --base <ref> --head <sha> [--summary-file <path>]
 *   bun scripts/test-changes-report.ts --commit <sha>
 *
 * Runs this checkout's bin/gstack-gate-diff over merge-base(<base>, <sha>)..<sha> (or one commit's
 * first-parent delta) from commit objects only, so a fetched pull request is read as data and never
 * checked out. Prints one line,
 *
 *   TEST_CHANGES: tagged={RH-1:2} tests_added=N tests_removed=N gate_files=N unread=N candidate=<c>
 *
 * and, with --summary-file, appends a Markdown report naming paths, tags and hunk ids only (no PR
 * text). Exit 0 whatever it finds; 1 when gate-diff or git fails, so a broken run is never counted
 * as a quiet pull request.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from '../lib/spawn-sync';
import { TEST_DECLARATION } from '../lib/gate-diff/classify';

const ROOT = path.resolve(import.meta.dir, '..');
const gateDiffBin = path.join(ROOT, 'bin', 'gstack-gate-diff');
const WATCHED = [/^\.github\/workflows\//, /^\.gstack\//, /^package\.json$/, /^bun\.lockb?$/, /^bunfig\.toml$/,
  /^scripts\/test-free-shards\.ts$/, /^scripts\/lib\/shard-engine\.ts$/, /^scripts\/ci-tree-reuse\.ts$/,
  /^lib\/run-evidence\.ts$/, /^test\/land-merged-checks\.txt$/];
const COUNTED = ['RH-1', 'RH-13', 'RH-14', 'RH-15'];
const DATA_FILE = /\.(?:json|jsonl|ndjson|csv|tsv|log|out|md|mdx|txt)(?:\.tmpl)?$/i;

interface Hunk { id: string; path: string; old_path?: string; tags: string[]; old: string[]; new: string[]; unsupported?: string }

function fail(msg: string): never {
  process.stderr.write(`test-changes-report: ${msg}\n`);
  process.stdout.write('TEST_CHANGES: error\n');
  process.exit(1);
}

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: process.cwd(), encoding: 'utf-8', timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) fail(`${args.includes(gateDiffBin) ? 'gstack-gate-diff' : `git ${args[0]}`} failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stdout ?? '').split('\n')[0]} ${(r.stderr ?? '').trim().slice(0, 400)}`);
  return r.stdout;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) fail(`${name} needs a value`);
  return v;
}

const cell = (s: string) => '`' + s.replace(/[^\x20-\x7e]/g, '?').replace(/[`|]/g, '?') + '`';

const argv = process.argv.slice(2);
const base = arg(argv, '--base'), head = arg(argv, '--head'), commit = arg(argv, '--commit'), summaryFile = arg(argv, '--summary-file');
if (commit ? base || head : !base || !head) fail('use --base <ref> --head <sha>, or --commit <sha>');

const out = run(process.execPath, ['--no-env-file', '--config=/dev/null', gateDiffBin, ...(commit ? ['--commit', commit] : [base!, '--head', head!]), '--format', 'jsonl']);
const [first, ...rest] = out.split('\n');
const summary = /^GATE_SUMMARY: .*unread=(\d+) .*candidate=(\S+) /.exec(first);
if (!summary) fail(`gate-diff printed no GATE_SUMMARY line: ${first.slice(0, 200)}`);
const hunks: Hunk[] = rest.filter(Boolean).map((l) => JSON.parse(l));

const range = commit ? [`${commit}^`, commit] : [summary[2].split('..')[0], head!];
const changed = run('git', ['diff', '--name-only', '-z', '--no-renames', range[0], range[1], '--']).split('\0').filter(Boolean);
const gateFiles = changed.filter((p) => WATCHED.some((re) => re.test(p)));

const tagged: Record<string, number> = {};
const flagged = hunks.filter((h) => h.tags.some((t) => COUNTED.includes(t)));
for (const h of flagged) for (const t of h.tags) if (COUNTED.includes(t)) tagged[t] = (tagged[t] ?? 0) + 1;
const declarations = (lines: string[]) => lines.filter((l) => TEST_DECLARATION.test(l)).length;
const code = hunks.filter((h) => !DATA_FILE.test(h.path));
const added = code.reduce((n, h) => n + declarations(h.new), 0);
const removed = code.reduce((n, h) => n + declarations(h.old), 0);
const tagText = COUNTED.filter((t) => tagged[t]).map((t) => `${t}:${tagged[t]}`).join(',');

process.stdout.write(`TEST_CHANGES: tagged={${tagText}} tests_added=${added} tests_removed=${removed} gate_files=${gateFiles.length} unread=${summary[1]} candidate=${summary[2]}\n`);

if (summaryFile) {
  const md = ['## Test changes (flags never fail this check)', '',
    `Tests added: ${added}. Tests removed: ${removed}. Hunks that remove or skip a test (RH-1), add a suppression (RH-13), bypass a gate (RH-14) or relax a gate value (RH-15): ${flagged.length}.`];
  if (+summary[1] > 0) md.push('', `Partial read: ${summary[1]} eligible hunks past the reading cap were not tagged.`);
  const unreadable = hunks.filter((h) => h.unsupported);
  if (unreadable.length) md.push('', `Not read as text, so tests removed in them are not counted: ${unreadable.map((h) => `${cell(h.path)} (${h.unsupported})`).join(', ')}.`);
  if (gateFiles.length) md.push('', '**This pull request edits files that run or define its own checks:**', '', ...gateFiles.map((p) => `- ${cell(p)}`));
  if (flagged.length) md.push('', '| Hunk | Path | Tags |', '|---|---|---|', ...flagged.map((h) => `| ${cell(h.id)} | ${cell(h.path)} | ${h.tags.join(', ')} |`));
  md.push('', 'Each flag needs a reason in the pull request, or a reviewer ruling. See docs/ship-policy.md#test-changes.', '');
  fs.appendFileSync(summaryFile, md.join('\n'));
}
