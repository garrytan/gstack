/**
 * The receipt behind `/design-review --build` (bin/gstack-design-build). The
 * skill's loop edits and looks; this module decides what the run proved, so
 * "never clean on skipped or partial coverage" lives in code, not prose:
 *
 * - `plan` turns the state inventory into the lint's --state-file, the exact
 *   lint command and one screenshot path per state and viewport.
 * - `preflight` checks the browser first, then that every target is loopback
 *   (or granted by name), then that each URL answers, before any round.
 * - `verify-start` records the measured tree identity right before the
 *   read-only final pass; `receipt` refuses evidence older than it or a tree
 *   that moved since, and reads the verdict from the lint's JSON, never its
 *   exit status.
 * - `check` recomputes the tree identity so a later edit invalidates the
 *   receipt.
 *
 * Nothing here writes to the repository: no commit, stash, checkout or reset.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchBrowse, pickEngine, type EngineChoice } from './aside-render';
import { sandboxFailure } from '../browse/src/chromium-sandbox';
import { DEFAULT_VIEWPORTS, parseViewport, redactText, redactUrl, viewportLabel } from './design-lint/app-input';

export const MAX_ROUNDS = 3;
export const RECEIPT_VERSION = 1;
const DOC = 'docs/howto-preview-a-frontend.md';
const PREVIEW_PROBE = '/api/__gstack-preview';

export class BuildUsageError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
  }
}

export interface InventoryState { name: string; url?: string; mode: 'url' | 'screenshot'; expect?: string; within?: string; scenario?: string; steps?: string }
export interface Inventory { version: 1; within: string; viewports: string[]; fixtures?: string; touched: string[]; states: InventoryState[] }

export type Outcome = 'clean' | 'waived' | 'open' | 'incomplete' | 'unrendered' | 'stale';

/** Every code the build line can carry, with the one fix the loop is allowed to try. */
export const BUILD_FIXES: Record<string, string> = {
  INSTALL: "run install.sh --for design-review from the lane's repo, then launch with its GSTACK_LAUNCH line",
  NO_BROWSER: 'gstack-browser-ensure, then rerun /design-review --build',
  BROWSER_SANDBOX: 'allow unprivileged user namespaces, or set GSTACK_CHROMIUM_NO_SANDBOX=1 only if every page in the run is trusted, then rerun /design-review --build',
  NO_PREVIEW: `start the preview (${DOC}), then rerun`,
  UNAUTHORIZED_TARGET: 'serve the app on 127.0.0.1 with the preview template, or rerun with --grant-remote <host> written by the person who owns it',
  TREE_CHANGED: 'the tree moved after the final pass began; rerun the final verification pass only',
  STALE_EVIDENCE: 'a lint result or screenshot predates the final pass; rerun the final verification pass only',
  LINT_MISSING: 'run the LINT_CMD line from plan, then rerun receipt',
  VIEWPORTS: 'run the LINT_CMD line from plan unchanged; it measures every planned viewport',
  NOT_LINTED: 'a URL state is missing from the lint result; run the LINT_CMD line from plan unchanged',
  PREVIEW_UNHANDLED: `add the named route to the scenario's fixture file (${DOC}#fixtures), restart the preview, then start a fresh run from preflight`,
  PREVIEW_UNKNOWN_SCENARIO: `add or fix the scenario's fixture file (${DOC}#fixtures), restart the preview, then start a fresh run from preflight`,
  PREVIEW_NO_SCENARIO: 'give the state URL an ?as=<scenario> query, restart the preview, then start a fresh run from preflight',
  NOT_SHOT: 'take the SHOT lines from plan for the named states, then rerun receipt',
  LINT_VERDICT: 'the lint result has no verdict; run the LINT_CMD line from plan unchanged',
  INVENTORY_CHANGED: 'the inventory changed after verify-start; rerun the final verification pass from plan',
  PREVIEW_UNRECORDED: 'start the preview template with --state <dir> (or give the plugin a stateDir), then start a fresh run from preflight',
  PREVIEW_LIVE_PROXY: `serve the route under the API prefix from a fixture (${DOC}#fixtures), restart the preview, then start a fresh run from preflight`,
};

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const isLoopbackHost = (h: string): boolean => h === 'localhost' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);
const relSafe = (p: unknown): boolean => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');

export function parseInventory(text: string): Inventory {
  const bad = (m: string): never => { throw new BuildUsageError('BAD_INVENTORY', m, `fix the inventory file; its format is in ${DOC}#inventory`); };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch (e) { return bad(`the inventory is not JSON (${(e as Error).message})`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('the inventory is not a JSON object');
  const unknown = Object.keys(raw).filter((k) => !['version', 'within', 'viewports', 'fixtures', 'touched', 'states'].includes(k));
  if (unknown.length) bad(`unknown inventory key ${unknown[0]}`);
  if (raw.version !== 1) bad('inventory version must be 1');
  if (typeof raw.within !== 'string' || !raw.within.trim()) bad('the inventory needs within: the section selector');
  const viewports = raw.viewports === undefined ? DEFAULT_VIEWPORTS.map(viewportLabel) : raw.viewports;
  if (!Array.isArray(viewports) || !viewports.length) return bad('viewports must be a non-empty list like ["1440x900","375x812"]');
  for (const v of viewports) parseViewport(String(v));
  const touched = raw.touched ?? [];
  if (!Array.isArray(touched) || !touched.every(relSafe)) bad('touched must list repo-relative paths');
  if (raw.fixtures !== undefined && !relSafe(raw.fixtures)) bad('fixtures must be a repo-relative directory');
  if (!Array.isArray(raw.states) || !raw.states.length) return bad('the inventory lists no states');
  const seen = new Set<string>();
  const states = (raw.states as Array<Record<string, unknown>>).map((s, i): InventoryState => {
    if (!s || typeof s !== 'object') bad(`state ${i + 1} is not an object`);
    const extra = Object.keys(s).filter((k) => !['name', 'url', 'mode', 'expect', 'within', 'scenario', 'steps'].includes(k));
    if (extra.length) bad(`state ${i + 1} has unknown key ${extra[0]}`);
    for (const k of ['name', 'expect', 'within', 'scenario', 'url', 'steps', 'mode']) if (s[k] !== undefined && typeof s[k] !== 'string') bad(`state ${i + 1} ${k} must be a string`);
    const name = s.name as string;
    if (!name || !NAME.test(name)) bad(`state ${i + 1} needs a name of letters, digits, dot, dash or underscore`);
    if (seen.has(name)) bad(`state ${name} is listed twice`);
    seen.add(name);
    const mode = (s.mode ?? 'url') as string;
    if (mode !== 'url' && mode !== 'screenshot') bad(`state ${name} mode must be url or screenshot`);
    if (mode === 'url' && !/^https?:\/\//.test((s.url as string) ?? '')) bad(`state ${name} needs an http(s) url`);
    if (mode === 'screenshot' && !s.steps) bad(`screenshot-only state ${name} needs steps: how to reach it by hand`);
    const out: InventoryState = { name, mode: mode as InventoryState['mode'] };
    for (const k of ['url', 'expect', 'within', 'scenario', 'steps'] as const) if (s[k] !== undefined) out[k] = s[k] as string;
    return out;
  });
  if (!states.some((s) => s.mode === 'url')) bad('the inventory needs at least one url state: screenshot-only states are never linted, so a run of only those proves nothing');
  return { version: 1, within: raw.within as string, viewports: viewports.map(String), ...(raw.fixtures ? { fixtures: raw.fixtures as string } : {}), touched: touched as string[], states };
}

/** The scenario a state's API calls carry: its own `scenario`, else its URL's ?as=, else none (''). */
export function scenarioOf(s: InventoryState): string {
  if (s.scenario !== undefined) return s.scenario;
  try { return new URL(s.url ?? '').searchParams.get('as') ?? ''; } catch { return ''; }
}

export const shotPath = (runDir: string, state: string, viewport: string): string => path.join(runDir, 'shots', `${state}-${viewport}.png`);

const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The lint --state-file, the exact lint command and every screenshot path, written once per run. */
export function plan(inv: Inventory, runDir: string, waivers?: string): string[] {
  fs.mkdirSync(path.join(runDir, 'shots'), { recursive: true, mode: 0o700 });
  const urlStates = inv.states.filter((s) => s.mode === 'url');
  const stateFile = path.join(runDir, 'states.json');
  const lintStates = urlStates.map((s) => ({ name: s.name, url: s.url, ...(s.expect ? { expect: s.expect } : {}), ...(s.within ? { within: s.within } : {}) }));
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, states: lintStates }, null, 2) + '\n', { mode: 0o600 });
  const lint = [quote(path.resolve(import.meta.dir, '..', 'bin', 'gstack-design-lint')), '--scope', 'app', '--state-file', quote(stateFile), '--within', quote(inv.within), ...inv.viewports.flatMap((v) => ['--viewport', v]), ...(waivers ? ['--waivers', quote(waivers)] : []), '--json', '>', quote(path.join(runDir, 'lint.json'))];
  return [
    `DESIGN_BUILD_PLAN: states=${inv.states.length} url=${urlStates.length} screenshot_only=${inv.states.length - urlStates.length} viewports=${inv.viewports.join(',')} run=${runDir}`,
    ...(urlStates.length ? [`LINT_CMD: ${lint.join(' ')}`] : []),
    ...inv.states.flatMap((s) => inv.viewports.map((v) => `SHOT: ${s.name} ${v} ${s.mode === 'url' ? redactUrl(s.url!) : 'screenshot-only: ' + s.steps} -> ${shotPath(runDir, s.name, v)}`)),
  ];
}

const git = (repo: string, args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });

function filesUnder(repo: string, rel: string): string[] {
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(repo, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
}

/** The measured dirty-tree identity: HEAD, every tracked diff, the untracked files the loop touched and the fixture content. */
export function treeIdentity(repo: string, inv: Pick<Inventory, 'touched' | 'fixtures'>): string {
  const h = createHash('sha256');
  h.update('head\0' + git(repo, ['rev-parse', 'HEAD']).trim() + '\0');
  h.update('diff\0' + git(repo, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv']) + '\0');
  const files = [...new Set([...inv.touched.flatMap((t) => filesUnder(repo, t)), ...(inv.fixtures ? filesUnder(repo, inv.fixtures) : [])])].sort();
  for (const rel of files) {
    const abs = path.join(repo, rel);
    h.update('file\0' + rel + '\0');
    h.update(fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs) : Buffer.from('\0missing'));
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Right before the read-only final pass: record the tree it measures. The
 * pass began at verify.json's own mtime, so evidence is compared on the
 * filesystem's clock, not the process's.
 */
const inventoryHash = (inv: Inventory): string => createHash('sha256').update(JSON.stringify(inv)).digest('hex');

export function verifyStart(repo: string, inv: Inventory, runDir: string): string {
  const tree = treeIdentity(repo, inv);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runDir, 'verify.json'), JSON.stringify({ tree, inventory: inventoryHash(inv) }) + '\n', { mode: 0o600 });
  return `VERIFY: tree=${tree.slice(0, 12)} run=${runDir}`;
}

/** Each loopback state origin where a preview answered the probe, with the state directory it names; state is null when it keeps no record. */
export async function servedStates(inv: Inventory): Promise<Array<{ origin: string; state: string | null }>> {
  const origins = [...new Set(inv.states.filter((s) => s.url && isLoopbackHost(new URL(s.url).hostname)).map((s) => new URL(s.url!).origin))];
  const out: Array<{ origin: string; state: string | null }> = [];
  for (const origin of origins) {
    try {
      const res = await fetch(new URL(PREVIEW_PROBE, origin), { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      if (res.status === 204 && res.headers.get('x-gstack-preview') === 'ready') out.push({ origin, state: decodeURIComponent(res.headers.get('x-gstack-preview-state') ?? '') || null });
    } catch {}
  }
  return out;
}

export interface PreflightDeps { engine?: () => EngineChoice; launch?: (engine: Exclude<EngineChoice, { engine: null }>) => Promise<string | null>; reach?: (url: string) => Promise<string | null>; preview?: (url: string) => Promise<boolean> }

/** Start the engine preflight found. Choosing Aside already ran a script in it (probeAside), so only gstack's own browser needs a launch here. */
const launchEngine = async (e: Exclude<EngineChoice, { engine: null }>): Promise<string | null> => (e.engine === 'browse' ? launchBrowse(e.bin) : null);

/** The preview template answers its probe route with 204 and x-gstack-preview: ready; a redirect, a marker in the HTML or any other answer is not the preview. */
async function previewAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL(PREVIEW_PROBE, url), { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    return res.status === 204 && res.headers.get('x-gstack-preview') === 'ready';
  } catch {
    return false;
  }
}

async function reachable(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    return res.status >= 500 ? `answered ${res.status}` : null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Before any round: the browser engine first, started for real, then target
 * authorization (a non-loopback target needs a grant naming its host, else the
 * run stops incomplete before any page opens), then each URL state answers.
 */
export async function preflight(inv: Inventory, grants: string[], deps: PreflightDeps = {}): Promise<{ lines: string[]; exit: number }> {
  const engine = (deps.engine ?? (() => pickEngine()))();
  if (!engine.engine) return { lines: [buildLine({ outcome: 'unrendered', code: 'NO_BROWSER', detail: redactText(engine.error) })], exit: 4 };
  const failed = await (deps.launch ?? launchEngine)(engine);
  if (failed) {
    const sandbox = sandboxFailure(failed);
    return { lines: [buildLine({ outcome: 'unrendered', code: sandbox ? 'BROWSER_SANDBOX' : 'NO_BROWSER', detail: redactText(sandbox ?? failed) })], exit: 4 };
  }
  const withUrl = inv.states.filter((s) => s.url);
  const remote = withUrl.filter((s) => { const h = new URL(s.url!).hostname; return !isLoopbackHost(h) && !grants.includes(h); });
  if (remote.length) return { lines: [buildLine({ outcome: 'incomplete', code: 'UNAUTHORIZED_TARGET', detail: `${remote.map((s) => `${s.name} at ${redactUrl(s.url!)}`).join(', ')} is not on loopback and has no grant; no page was opened and no action ran` })], exit: 4 };
  const down: string[] = [];
  for (const s of withUrl) {
    const err = await (deps.reach ?? reachable)(s.url!);
    if (err) down.push(`${s.name} (${redactUrl(s.url!)}: ${redactText(err)})`);
  }
  if (down.length) return { lines: [buildLine({ outcome: 'unrendered', code: 'NO_PREVIEW', detail: `no answer from ${down.join(', ')}` })], exit: 4 };
  const granted = withUrl.some((s) => !isLoopbackHost(new URL(s.url!).hostname));
  const local = withUrl.filter((s) => isLoopbackHost(new URL(s.url!).hostname));
  const previewed = (await Promise.all(local.map((s) => (deps.preview ?? previewAnswers)(s.url!)))).every(Boolean);
  return { lines: [`PREFLIGHT: ok engine=${engine.engine} states=${inv.states.length} targets=${granted ? 'loopback+granted' : 'loopback'} mutations=${!previewed ? 'unknown' : granted ? 'fixtures+granted' : 'fixtures-only'}`], exit: 0 };
}

/** Map a gstack-skill-start transcript: a refused start is the build's INSTALL outcome. */
export function admit(startOutput: string): { lines: string[]; exit: number } {
  if (!/^GSTACK_RESULT: skill=design-review status=refused\b/m.test(startOutput)) return { lines: ['ADMIT: ok'], exit: 0 };
  const row = /^INSTALL: .*$/m.exec(startOutput)?.[0] ?? 'the preamble refused this workflow';
  return { lines: [buildLine({ outcome: 'unrendered', code: 'INSTALL', detail: redactText(row) })], exit: 4 };
}

export interface Counts { planned: number; url: number; linted: number; shot: number; screenshotOnly: number; open: number; waived: number }
export interface LineInput { outcome: Outcome; code: string; detail?: string; counts?: Counts; rounds?: number; viewports?: string[]; tree?: string; receipt?: string }

/** The one DESIGN_BUILD line a READY pastes; every outcome and code prints through here. */
export function buildLine(i: LineInput): string {
  const c = i.counts;
  const parts = [`DESIGN_BUILD: ${i.outcome}`, `code=${i.code}`];
  if (c) parts.push(`linted=${c.linted}/${c.url}`, `shot=${c.shot}/${c.planned}`, `screenshot_only=${c.screenshotOnly}`, `open=${c.open}`, `waived=${c.waived}`);
  if (i.rounds !== undefined) parts.push(`rounds=${i.rounds}`);
  if (i.viewports) parts.push(`viewports=${i.viewports.join(',')}`);
  if (i.tree) parts.push(`tree=${i.tree.slice(0, 12)}`);
  if (i.receipt) parts.push(`receipt=${i.receipt}`);
  const fix = BUILD_FIXES[i.code];
  return parts.join(' ') + (i.detail ? ` (${i.detail.replace(/\s+/g, ' ').replace(/ \| fix: /g, ' / fix: ')})` : '') + (fix ? ` | fix: ${fix}` : '');
}

export interface UnhandledHit { scenario: string; method: string; path: string; code: string }

/** The preview template's record of API calls it could not answer (unhandled.jsonl in its state directory). */
export function readUnhandled(previewDir: string): UnhandledHit[] {
  const file = path.join(previewDir, 'unhandled.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as UnhandledHit);
}

interface LintFinding { rule: string; tier: string; grade: string; evidence?: string; waiver?: string; app?: { state: string; viewport: string; locator: string; measured: number; threshold: number } }
interface LintCoverage { name: string; viewport: string; status: string; code: string }
interface LintJson { findings?: LintFinding[]; app?: { verdict?: string; code?: string; codes?: string[]; viewports?: string[]; states?: LintCoverage[] } }

export interface ReceiptInput { repo: string; inv: Inventory; runDir: string; rounds: number; previewDir?: string; served?: Array<{ origin: string; state: string | null }>; waivers?: string; outRoot: string; now?: () => Date }

const mtime = (f: string): number => fs.statSync(f).mtimeMs;

function readLint(runDir: string, verifyAt: number, add: (code: string, detail: string) => void): LintJson | null {
  const file = path.join(runDir, 'lint.json');
  if (!fs.existsSync(file)) { add('LINT_MISSING', 'no lint.json'); return null; }
  if (mtime(file) < verifyAt) add('STALE_EVIDENCE', 'lint.json predates the final pass');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as LintJson; } catch { add('LINT_MISSING', 'lint.json is not JSON'); return null; }
}

/** Decide the outcome from the evidence on disk, write the versioned receipt and return its one line. */
export function receipt(r: ReceiptInput): { line: string; file: string; exit: number; receipt: Record<string, unknown> & { states: Array<Record<string, unknown>>; open: unknown[]; waived: unknown[] } } {
  if (!Number.isInteger(r.rounds) || r.rounds < 0 || r.rounds > MAX_ROUNDS) throw new BuildUsageError('ROUNDS', `--rounds ${r.rounds} is outside 0 to ${MAX_ROUNDS}`, `the loop stops editing after round ${MAX_ROUNDS}; report the open list instead of a fourth round`);
  const verifyFile = path.join(r.runDir, 'verify.json');
  if (!fs.existsSync(verifyFile)) throw new BuildUsageError('NO_VERIFY', `${verifyFile} is missing`, 'run verify-start right before the final verification pass');
  const verify = { ...(JSON.parse(fs.readFileSync(verifyFile, 'utf8')) as { tree: string; inventory?: string }), at: mtime(verifyFile) };
  const tree = treeIdentity(r.repo, r.inv);
  const codes: string[] = [];
  const details: string[] = [];
  const add = (code: string, detail: string): void => { if (!codes.includes(code)) codes.push(code); details.push(detail); };
  if (tree !== verify.tree) add('TREE_CHANGED', 'the tree changed after verify-start');
  if (verify.inventory !== inventoryHash(r.inv)) add('INVENTORY_CHANGED', 'the inventory is not the one verify-start recorded');

  const urlStates = r.inv.states.filter((s) => s.mode === 'url');
  const lint = urlStates.length ? readLint(r.runDir, verify.at, add) : null;
  const verdict = lint?.app?.verdict;
  if (lint && !['clean', 'open', 'incomplete'].includes(verdict ?? '')) add('LINT_VERDICT', 'lint.json carries no app verdict');
  if (lint && (lint.app?.viewports ?? []).join(',') !== r.inv.viewports.join(',')) add('VIEWPORTS', `linted ${(lint.app?.viewports ?? []).join(',') || 'none'}, planned ${r.inv.viewports.join(',')}`);

  const served = r.served ?? [];
  if (!r.previewDir && served.some((s) => s.state === null)) add('PREVIEW_UNRECORDED', 'a preview answered at a state origin but keeps no record of unanswered calls');
  const answered = new Set(served.map((s) => s.origin));
  const unanswered = urlStates.map((s) => new URL(s.url!)).filter((u) => isLoopbackHost(u.hostname) && !answered.has(u.origin));
  const previewDirs = [...new Set([...(r.previewDir ? [r.previewDir] : []), ...served.flatMap((s) => (s.state ? [s.state] : [])), ...unanswered.map((u) => path.join(os.tmpdir(), `gstack-preview-${u.port || 80}`))])];
  const hits = previewDirs.flatMap(readUnhandled);
  const states = r.inv.states.map((s) => {
    const cov = (lint?.app?.states ?? []).filter((c) => c.name === s.name);
    const linted = s.mode === 'url' && r.inv.viewports.every((v) => cov.some((c) => c.viewport === v && c.status === 'measured'));
    const shots = r.inv.viewports.map((v) => shotPath(r.runDir, s.name, v)).filter((f) => fs.existsSync(f));
    const scenario = scenarioOf(s);
    const unhandled = s.mode === 'url' ? hits.filter((h) => h.scenario === scenario || !h.scenario) : [];
    if (s.mode === 'url' && lint && !linted) {
      const bad = cov.find((c) => c.status !== 'measured');
      add(bad?.code ?? 'NOT_LINTED', `${s.name} not linted at every viewport${bad ? ` (${bad.code})` : ''}`);
    }
    if (shots.length < r.inv.viewports.length) add('NOT_SHOT', `${s.name} has ${shots.length}/${r.inv.viewports.length} screenshots`);
    if (shots.some((f) => mtime(f) < verify.at)) add('STALE_EVIDENCE', `a screenshot of ${s.name} predates the final pass`);
    for (const h of unhandled) add(h.code, `${s.name}: ${h.method} ${redactText(h.path)} (scenario ${h.scenario || 'none'})`);
    const expectPassed = s.mode === 'url' && lint ? cov.length > 0 && !cov.some((c) => c.code === 'STATE_MISMATCH') && cov.some((c) => c.status === 'measured') : null;
    return {
      name: s.name, mode: s.mode, ...(s.url ? { url: redactUrl(s.url) } : {}), ...(s.steps ? { steps: s.steps } : {}), scenario, linted,
      viewports: cov.map((c) => ({ viewport: c.viewport, status: c.status, code: c.code })),
      expect: s.expect ? { selector: s.expect, passed: expectPassed } : null,
      shots: shots.map((f) => path.relative(r.runDir, f)), unhandled,
    };
  });
  const appFindings = (lint?.findings ?? []).filter((f) => f.app);
  const open = appFindings.filter((f) => f.grade !== 'waived');
  const waived = appFindings.filter((f) => f.grade === 'waived');
  const counts: Counts = { planned: states.length, url: urlStates.length, linted: states.filter((s) => s.linted).length, shot: states.filter((s) => s.shots.length === r.inv.viewports.length).length, screenshotOnly: states.length - urlStates.length, open: open.length, waived: waived.length };

  let outcome: Outcome;
  if (codes.length) outcome = 'incomplete';
  else if (urlStates.length && verdict === 'open') outcome = 'open';
  else if (urlStates.length && verdict !== 'clean') outcome = 'incomplete';
  else outcome = waived.length ? 'waived' : 'clean';
  const code = outcome === 'incomplete' ? (codes[0] ?? 'LINT_VERDICT') : outcome === 'open' ? 'OPEN' : 'OK';

  const head = git(r.repo, ['rev-parse', 'HEAD']).trim();
  const dir = path.join(r.outRoot, `design-build-${head.slice(0, 12)}-${tree.slice(0, 12)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'receipt.json');
  const waivers = r.waivers ? { path: r.waivers, sha256: createHash('sha256').update(fs.readFileSync(r.waivers)).digest('hex') } : null;
  const line = buildLine({ outcome, code, detail: outcome === 'incomplete' ? details.slice(0, 6).join('; ') : undefined, counts, rounds: r.rounds, viewports: r.inv.viewports, tree, receipt: file });
  const rec = {
    version: RECEIPT_VERSION, outcome, code, codes, head, tree, measured_tree: verify.tree, inventory: inventoryHash(r.inv), rounds: r.rounds, viewports: r.inv.viewports, within: r.inv.within,
    counts, states, lint: lint ? { verdict: verdict ?? null, code: lint.app?.code ?? null, codes: lint.app?.codes ?? [] } : null,
    open: open.map((f) => ({ rule: f.rule, evidence: redactText(f.evidence ?? ''), ...f.app })),
    waived: waived.map((f) => ({ rule: f.rule, reason: f.waiver ?? '', ...f.app })),
    waivers, touched: r.inv.touched, fixtures: r.inv.fixtures ?? null, created_at: (r.now ?? (() => new Date()))().toISOString(), line,
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  return { line, file, exit: outcome === 'clean' || outcome === 'waived' ? 0 : outcome === 'open' ? 1 : 4, receipt: rec };
}

/** A receipt stays good only while the tree it measured is the tree on disk. */
export function check(repo: string, inv: Inventory, receiptFile: string): { line: string; exit: number } {
  const rec = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as { tree: string; inventory: string; line: string; outcome: Outcome; version: number };
  if (rec.version !== RECEIPT_VERSION) return { line: buildLine({ outcome: 'stale', code: 'TREE_CHANGED', detail: `receipt version ${rec.version} is not ${RECEIPT_VERSION}` }), exit: 4 };
  const now = treeIdentity(repo, inv);
  if (rec.inventory !== inventoryHash(inv)) return { line: buildLine({ outcome: 'stale', code: 'INVENTORY_CHANGED', detail: 'the inventory is not the one the receipt measured', receipt: receiptFile }), exit: 4 };
  if (now !== rec.tree) return { line: buildLine({ outcome: 'stale', code: 'TREE_CHANGED', detail: `measured ${rec.tree.slice(0, 12)}, tree is now ${now.slice(0, 12)}`, tree: now, receipt: receiptFile }), exit: 4 };
  return { line: rec.line, exit: rec.outcome === 'clean' || rec.outcome === 'waived' ? 0 : rec.outcome === 'open' ? 1 : 4 };
}
