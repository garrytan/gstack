#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * review-dispatch-compare — how many reviewers a /ship run and an /autoplan run dispatch under the
 * legacy policy and under docs/review-policy.md#review-depth, on fixed fixture diffs, with an input
 * plus output token estimate per run. The proof-of-saving table in the GSTA-131 PR comes from here.
 *
 *   bun scripts/review-dispatch-compare.ts [--fixture <file>]... [--tokens <measured.json>] [--json]
 *   bun scripts/review-dispatch-compare.ts --capture <sha> --name <name> --out <file>
 *
 * --capture writes a fixture from one commit (its diff against its first parent) through
 * gstack-review-plan --json. --tokens takes the live per-dispatch output-token medians by role and
 * effort ({ "specialist": { "full": n, "light": n }, ... }); without it the script uses the shipped
 * defaults below and says so. Counts are exact for the modelled scenarios; tokens are estimates.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';
import { planReview, specialistsFor, type DiffClass, type History, type NumbersResult, type PathLines } from '../lib/review-depth';

const ROOT = path.resolve(import.meta.dir, '..');
const BYTES_PER_TOKEN = 4;
const FIXED_AUDITS = ['coverage-audit', 'plan-completion', 'docs-audit'];
const RANGE_FRACTION = 0.15;
const FIX_CHECK_FRACTION = 0.1;
/** Output plus reasoning tokens per dispatch when no live measurement is given (labelled DEFAULT in the output). */
const DEFAULT_OUT: Record<string, { full: number; light: number }> = {
  specialist: { full: 6000, light: 3000 }, 'red-team': { full: 8000, light: 4000 }, 'adversarial-native': { full: 8000, light: 4000 },
  'outside-voice': { full: 6000, light: 6000 }, 'fix-check': { full: 4000, light: 2000 }, audit: { full: 5000, light: 2500 }, 'autoplan-voice': { full: 9000, light: 4500 },
};

/** per_path and registry_outputs (captured since GSTA-147) feed the runtime-line count; an older fixture counts every code-class line as runtime. */
export interface Fixture { name: string; commit: string; paths: string[]; deleted: string[]; stamp_only?: string[]; scope: Record<string, string>; gate_tagged: number | null; diff_lines: number; diff_bytes: number; numbers: NumbersResult; per_path?: PathLines[]; registry_outputs?: string[] }
/** clean: pass 1 finds nothing; nits: pass 1 fixes below-floor findings; blocker: pass 1 fixes a blocker; adversarial-fix: Step 11 finds a should that is fixed; fix-regression: a pass-1 fix introduces a blocker the next step finds. */
type Scenario = 'clean' | 'nits' | 'blocker' | 'adversarial-fix' | 'fix-regression';
const SCENARIOS: Scenario[] = ['clean', 'nits', 'blocker', 'adversarial-fix', 'fix-regression'];
interface Call { role: string; name?: string; effort: 'full' | 'light' | 'host'; diffBytes: number }

const fileBytes = (rel: string) => { try { return fs.statSync(path.join(ROOT, rel)).size; } catch { return 0; } };
function promptBytes(role: string, name: string): number {
  if (role === 'specialist') return fileBytes(`review/specialists/${name}.md`) + fileBytes('review/checklist.md') / 4;
  if (role === 'red-team') return fileBytes('review/specialists/red-team.md');
  if (role === 'adversarial-native' || role === 'outside-voice') return fileBytes('ship/sections/adversarial.md') / 2;
  if (role === 'fix-check') return fileBytes('review/checklist.md') / 2;
  return 20_000;
}

function legacyShip(f: Fixture, sc: Scenario): Call[] {
  const calls: Call[] = [];
  const passes = sc === 'clean' ? 1 : sc === 'fix-regression' ? 3 : 2;
  const step11Runs = sc === 'adversarial-fix' ? 2 : 1;
  const legacySpecialists = specialistsFor('code', { ...base(f), history: { fullPasses: 0, last: 'none' } });
  for (let p = 1; p <= passes; p++) {
    const diffBytes = p === 1 ? f.diff_bytes : f.diff_bytes * RANGE_FRACTION;
    for (const name of legacySpecialists) calls.push({ role: 'specialist', name, effort: 'full', diffBytes });
    const critical = (sc === 'blocker' && p === 1) || (sc === 'fix-regression' && p === 2);
    if (f.diff_lines > 200 || critical) calls.push({ role: 'red-team', effort: 'full', diffBytes });
  }
  for (let s = 0; s < step11Runs; s++) calls.push({ role: 'adversarial-native', effort: 'full', diffBytes: f.diff_bytes }, { role: 'outside-voice', effort: 'host', diffBytes: f.diff_bytes });
  for (const a of FIXED_AUDITS) calls.push({ role: 'audit', effort: 'full', diffBytes: f.diff_bytes / 2 });
  return calls;
}

function base(f: Fixture) {
  return { paths: f.paths, deleted: f.deleted, stampOnly: f.stamp_only ?? [], scope: f.scope, gateTagged: f.gate_tagged, diffLines: f.diff_lines, numbers: f.numbers, perPath: f.per_path, registry: f.registry_outputs ? { sha: null, outputs: f.registry_outputs } : undefined };
}

/** The new policy, step by step through lib/review-depth's own transition table. */
function newShip(f: Fixture, sc: Scenario): { calls: Call[]; ending: string } {
  const calls: Call[] = [];
  const outcomes: Record<Scenario, Array<Partial<History>>> = {
    clean: [{}],
    nits: [{ fixedBelow: true }, {}],
    blocker: [{ fixedBlocking: true }, {}],
    'adversarial-fix': [{ fixedBelow: true }, {}],
    'fix-regression': [{ fixedBelow: true }, { blockingOpen: true }],
  };
  let h: History = { fullPasses: 0, last: 'none' };
  let ending = 'done';
  let adversarialRan = false;
  for (let i = 0; i < 6; i++) {
    const plan = planReview({ ...base(f), history: h, criticalFound: sc === 'blocker' && i === 0, adversarialRan });
    if (plan.next.step === 'done' || plan.next.step === 'stop') { ending = plan.next.step; break; }
    const diffBytes = plan.next.step === 'fix-check' ? f.diff_bytes * FIX_CHECK_FRACTION : h.fullPasses === 0 ? f.diff_bytes : f.diff_bytes * RANGE_FRACTION;
    for (const d of plan.dispatches) calls.push({ role: d.role, name: d.name, effort: d.effort, diffBytes: d.role === 'outside-voice' ? f.diff_bytes : diffBytes });
    adversarialRan ||= plan.dispatches.some(d => d.role === 'adversarial-native');
    const o = outcomes[sc][Math.min(i, outcomes[sc].length - 1)] ?? {};
    const last = plan.next.step === 'scoped' ? 'full' : plan.next.step;
    h = { fullPasses: h.fullPasses + (last === 'full' ? 1 : 0), last, ...o };
  }
  for (const a of FIXED_AUDITS) calls.push({ role: 'audit', effort: 'light', diffBytes: f.diff_bytes / 2 });
  return { calls, ending };
}

function tokens(calls: Call[], out: typeof DEFAULT_OUT): number {
  return Math.round(calls.reduce((n, c) => {
    const o = out[c.role] ?? out.audit!;
    return n + (promptBytes(c.role, c.name ?? '') + c.diffBytes) / BYTES_PER_TOKEN + (c.effort === 'light' ? o.light : o.full);
  }, 0));
}

/** /autoplan: phases x voices x rounds. Legacy reopens every touched phase on any accepted change, up to 3 rounds. */
function autoplanRuns(docsOnly: boolean): Array<{ scenario: string; legacy: number; next: number }> {
  const phases = ['ceo', 'eng'];
  const legacyRounds = { 'no change': 1, 'medium-only change': 2, 'high change': 2, 'high twice': 3 } as Record<string, number>;
  const newRounds = { 'no change': 1, 'medium-only change': 1, 'high change': 2, 'high twice': 2 } as Record<string, number>;
  return Object.keys(legacyRounds).map(s => ({
    scenario: s,
    legacy: phases.length * 2 * legacyRounds[s]!,
    next: (docsOnly ? 3 : phases.length * 2) * newRounds[s]!,
  }));
}

function capture(sha: string, name: string, out: string): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-compare-'));
  const captureBase = `review-compare-base-${process.pid}-${sha.slice(0, 8)}`;
  const git = (args: string[], cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  try {
    if (git(['worktree', 'add', '-q', '--detach', dir, sha]).status !== 0) throw new Error(`cannot check out ${sha}`);
    git(['branch', '-f', captureBase, `${sha}^`], dir);
    const r = runScriptSync(path.join(ROOT, 'bin', 'gstack-review-plan'), ['--base', captureBase, '--json'], { cwd: dir, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`gstack-review-plan failed: ${r.stderr}`);
    const plan = JSON.parse(r.stdout);
    const diffBytes = Buffer.byteLength(git(['diff', `${sha}^`, sha], dir).stdout ?? '');
    const fixture: Fixture = { name, commit: sha, paths: plan.paths, deleted: plan.deleted, stamp_only: plan.stamp_only, scope: plan.scope, gate_tagged: plan.gate_tagged, diff_lines: plan.diff_lines, diff_bytes: diffBytes, numbers: plan.numbers, per_path: plan.per_path, registry_outputs: plan.registry.outputs };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    process.stdout.write(`CAPTURED: ${name} ${sha} class=${plan.class} depth=${plan.depth} runtime=${plan.runtime_lines} paths=${plan.paths.length} lines=${plan.diff_lines} -> ${out}\n`);
    return 0;
  } finally {
    git(['worktree', 'remove', '--force', dir]);
    git(['branch', '-D', captureBase]);
  }
}

export function compare(fixtures: Fixture[], out: typeof DEFAULT_OUT) {
  const rows: Array<Record<string, string | number>> = [];
  for (const f of fixtures) {
    const first = planReview({ ...base(f), history: { fullPasses: 0, last: 'none' } });
    const cls: DiffClass = first.class;
    for (const sc of SCENARIOS) {
      const legacy = legacyShip(f, sc);
      const next = newShip(f, sc);
      const lt = tokens(legacy, out); const nt = tokens(next.calls, out);
      rows.push({ fixture: f.name, class: cls, depth: first.depth, runtime_lines: first.runtimeLines, scenario: sc, legacy_dispatches: legacy.length, new_dispatches: next.calls.length, legacy_tokens: lt, new_tokens: nt, ratio: Math.round((nt / lt) * 100) / 100, ending: next.ending });
    }
  }
  return rows;
}

function main(argv: string[]): number {
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const cap = flag('--capture');
  if (cap) return capture(cap, flag('--name') ?? cap, flag('--out') ?? path.join(ROOT, 'test/fixtures/review-depth', `${flag('--name') ?? cap}.json`));
  const files = argv.flatMap((a, i) => (a === '--fixture' ? [argv[i + 1]!] : []));
  const fixtureFiles = files.length ? files : fs.readdirSync(path.join(ROOT, 'test/fixtures/review-depth')).filter(f => f.endsWith('.json')).map(f => path.join(ROOT, 'test/fixtures/review-depth', f));
  const fixtures = fixtureFiles.map(f => JSON.parse(fs.readFileSync(f, 'utf8')) as Fixture);
  const tokFile = flag('--tokens');
  const out = tokFile ? { ...DEFAULT_OUT, ...JSON.parse(fs.readFileSync(tokFile, 'utf8')) } : DEFAULT_OUT;
  const rows = compare(fixtures, out);
  const ap = fixtures.map(f => ({ fixture: f.name, runs: autoplanRuns(planReview({ ...base(f), history: { fullPasses: 0, last: 'none' } }).class === 'docs') }));
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify({ tokens_source: tokFile ?? 'DEFAULT', ship: rows, autoplan: ap }) + '\n'); return 0; }
  const lines = [`TOKENS: ${tokFile ? `measured (${tokFile})` : 'DEFAULT estimates (pass --tokens for measured output)'}`, '', '| fixture | class | depth (runtime lines) | scenario | /ship dispatches legacy → new | est. tokens legacy → new | ratio | ending |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.fixture} | ${r.class} | ${r.depth} (${r.runtime_lines}) | ${r.scenario} | ${r.legacy_dispatches} → ${r.new_dispatches} | ${r.legacy_tokens} → ${r.new_tokens} | ${r.ratio} | ${r.ending} |`);
  lines.push('', '| fixture | /autoplan scenario | voice dispatches legacy → new |', '|---|---|---|');
  for (const a of ap) for (const r of a.runs) lines.push(`| ${a.fixture} | ${r.scenario} | ${r.legacy} → ${r.next} |`);
  const median = (v: number[]) => { const m = Math.floor(v.length / 2); return v.length % 2 ? v[m]! : Math.round(((v[m - 1]! + v[m]!) / 2) * 100) / 100; };
  const ratios = rows.map(r => Number(r.ratio)).sort((a, b) => a - b);
  lines.push('', `SHIP_TOKEN_RATIO: median=${median(ratios)} min=${ratios[0]} max=${ratios[ratios.length - 1]} (n=${ratios.length})`);
  const byClass = new Map<string, number[]>();
  for (const r of rows) byClass.set(String(r.class), [...(byClass.get(String(r.class)) ?? []), Number(r.ratio)].sort((x, y) => x - y));
  lines.push(`SHIP_TOKEN_RATIO_BY_CLASS: ${[...byClass].map(([c, v]) => `${c} median=${median(v)} (n=${v.length})`).join('; ')}`);
  const byDepth = new Map<string, number[]>();
  for (const r of rows) byDepth.set(String(r.depth), [...(byDepth.get(String(r.depth)) ?? []), Number(r.ratio)].sort((x, y) => x - y));
  lines.push(`SHIP_TOKEN_RATIO_BY_DEPTH: ${[...byDepth].map(([d, v]) => `${d} median=${median(v)} (n=${v.length})`).join('; ')}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
