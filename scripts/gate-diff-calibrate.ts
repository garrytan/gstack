/**
 * gate-diff calibration — free, unshipped-to-skills tool inventory for the
 * gate-edit detector (W1 of docs/designs/HONEST_WORK_GATE_INTEGRITY.md).
 *
 *   bun scripts/gate-diff-calibrate.ts [--ref origin/main] [--count 50] [--repo <path>] [--markdown]
 *
 * Runs the pure core (lib/gate-diff) over the first-parent delta of the last
 * N commits on <ref>'s first-parent line (one per landed PR: a merge commit
 * or a squash merge), exactly what `gstack-gate-diff --commit <sha>` scans. Prints one row per
 * commit: listed, eligible, read, unread, tags by id, unmatched, unsupported.
 *
 * What this measures: the TOOL's inventory (how much it lists, how often each
 * tag fires, how often the read cap bites). It does NOT measure agent findings,
 * kept/restored/open dispositions or reviewer value; those are collected after
 * ship from the persisted review records. The hand read of tagged hunks is a
 * human step this script only supports (--markdown gives the table to annotate).
 * No artifact is written: calibration never touches the state root.
 */
import * as path from 'node:path';
import { EMPTY_PROJECT_CONFIG, parseGateIntegrityBlock, scanCandidate, specDirectoryHoldsSpecs, type ScanResult } from '../lib/gate-diff/index';
import { commitInfo, diffCommit, firstParent, readClaudeMd, repoRoot, runGit, treePaths } from '../lib/gate-diff/git';
import { COVERAGE_TAGS } from '../lib/gate-diff/tags';

interface Args {
  ref: string;
  count: number;
  repo: string;
  markdown: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { ref: 'origin/main', count: 50, repo: process.cwd(), markdown: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--ref') a.ref = argv[++i] ?? a.ref;
    else if (x === '--count') a.count = Number(argv[++i] ?? a.count);
    else if (x === '--repo') a.repo = argv[++i] ?? a.repo;
    else if (x === '--markdown') a.markdown = true;
    else if (x === '--help' || x === '-h') {
      console.log('usage: bun scripts/gate-diff-calibrate.ts [--ref origin/main] [--count 50] [--repo <path>] [--markdown]');
      process.exit(0);
    } else throw new Error(`unknown argument ${x}`);
  }
  if (!Number.isFinite(a.count) || a.count <= 0) throw new Error('--count must be a positive integer');
  return a;
}

/** The last N commits on <ref>'s first-parent line: merge commits and squash merges alike, one per landed PR. */
function firstParentCommits(ref: string, count: number, cwd: string): string[] {
  const r = runGit(['log', '--first-parent', '--format=%H', '-n', String(count), ref, '--'], cwd);
  if (r.status !== 0) throw new Error(`git log ${ref} failed: ${r.stderr.trim()}`);
  return r.stdout.toString('utf-8').split('\n').filter(Boolean);
}

interface Row {
  sha: string;
  subject: string;
  result?: ScanResult;
  error?: string;
}

function scanOne(sha: string, root: string, project: ReturnType<typeof parseGateIntegrityBlock>): Row {
  const info = commitInfo(sha, root);
  const subject = (info?.message.split('\n')[0] ?? '').slice(0, 72);
  if (!firstParent(sha, root)) return { sha, subject, error: 'parent missing (shallow history: git fetch --deepen)' };
  try {
    const files = diffCommit(sha, root);
    const result = scanCandidate({
      files, commits: info ? [info] : [], project, specIsTestPath: specDirectoryHoldsSpecs(treePaths(root, sha)),
      candidate: sha.slice(0, 12), artifact: '(calibration: not written)',
    });
    return { sha, subject, result };
  } catch (e: any) {
    return { sha, subject, error: String(e?.message ?? e) };
  }
}

function tagCell(tagged: Record<string, number>): string {
  const keys = Object.keys(tagged).sort((a, b) => Number.parseInt(a.slice(3), 10) - Number.parseInt(b.slice(3), 10) || a.localeCompare(b));
  return keys.length ? keys.map((k) => `${k}:${tagged[k]}`).join(' ') : '-';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot(path.resolve(args.repo));
  if (!root) throw new Error(`${args.repo} is not inside a git repository`);
  const shas = firstParentCommits(args.ref, args.count, root);
  const project = parseGateIntegrityBlock(readClaudeMd(root));
  const rows = shas.map((sha) => scanOne(sha, root, project));

  const ok = rows.filter((r) => r.result).map((r) => r.result as ScanResult);
  const totals: Record<string, number> = {};
  const commitsWithTag: Record<string, number> = {};
  for (const r of ok) {
    for (const [k, v] of Object.entries(r.summary.tagged)) {
      totals[k] = (totals[k] ?? 0) + v;
      commitsWithTag[k] = (commitsWithTag[k] ?? 0) + 1;
    }
  }
  const listed = ok.map((r) => r.summary.listed);
  const eligible = ok.map((r) => r.summary.eligible);
  const partial = ok.filter((r) => r.summary.unread > 0).length;

  const sep = args.markdown ? ' | ' : '\t';
  const line = (cells: string[]) => (args.markdown ? `| ${cells.join(' | ')} |` : cells.join(sep));
  const out: string[] = [];
  out.push(line(['commit', 'subject', 'listed', 'eligible', 'read', 'unread', 'unmatched', 'unsupported', 'tags']));
  if (args.markdown) out.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of rows) {
    if (!r.result) {
      out.push(line([r.sha.slice(0, 12), r.subject.replace(/\|/g, '\\|'), '-', '-', '-', '-', '-', '-', `ERROR: ${r.error}`]));
      continue;
    }
    const s = r.result.summary;
    out.push(line([
      r.sha.slice(0, 12), r.subject.replace(/\|/g, '\\|'), String(s.listed), String(s.eligible), String(s.inspected), String(s.unread),
      String(s.unmatched), String(r.result.unsupportedPaths.length), tagCell(s.tagged),
    ]));
  }
  out.push('');
  out.push(`${args.markdown ? '**Scanned:**' : 'Scanned:'} ${ok.length} of ${rows.length} first-parent commits on ${args.ref}; ${rows.length - ok.length} errored.`);
  out.push(`${args.markdown ? '**Listed per commit:**' : 'Listed per commit:'} median ${median(listed)}, p75 ${percentile(listed, 75)}, max ${Math.max(0, ...listed)}; eligible median ${median(eligible)}, p75 ${percentile(eligible, 75)}, max ${Math.max(0, ...eligible)}; partial (read cap hit) in ${partial} commit(s).`);
  const tagLines = [...COVERAGE_TAGS, 'RH-3?', 'RH-15?'].filter((t) => totals[t]).map((t) => `${t}: ${totals[t]} hunk(s) in ${commitsWithTag[t]} commit(s)`);
  out.push(`${args.markdown ? '**Tags:**' : 'Tags:'} ${tagLines.length ? tagLines.join('; ') : 'none fired'}.`);
  console.log(out.join('\n'));
  return 0;
}

try {
  process.exitCode = main();
} catch (e: any) {
  console.error(`gate-diff-calibrate: ${e?.message ?? e}`);
  process.exitCode = 1;
}
