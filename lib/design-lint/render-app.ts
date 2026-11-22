/**
 * The app profile's scheduler (gstack-design-lint --scope app): render-only,
 * one page load per state, one measurement per viewport, confined to the
 * --within section. Separate from render.ts on purpose: the page and
 * component profiles' plan, probes and output do not change.
 *
 * The verdict is the machine signal, never the tier: clean when every
 * planned state x viewport was measured and no app finding is open, open when
 * coverage is complete and one is, incomplete (exit 4) when any state x
 * viewport was not measured, whatever else it found. docs/design-lint.md
 * "App profile (--scope app)" is the contract.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickEngine, render, renderWithBrowse, type EngineChoice, type RenderStep } from '../aside-render';
import { DEFAULT_VIEWPORTS, redactText, redactUrl, viewportLabel, type AppWaiver, type Viewport } from './app-input';
import { appInstallScript, appProbeScript, composedWaitExpression, type AppProbeFinding, type AppProbeResult, type AppSetupReport } from './render-probe-app';
import type { Runner } from './render';
import { finalize, oneLine, summarize, type Finding, type Summary } from './report';
import { ruleMeta } from './rules/ids';

export const APP_CODES = ['NO_BROWSER', 'UNREACHABLE', 'TIMEOUT', 'NOT_READY', 'STATE_MISMATCH', 'WITHIN_NO_MATCH', 'CLOSED_SHADOW', 'PROBE_ERROR', 'ASSET_MISSING'] as const;
export type AppCode = typeof APP_CODES[number];

/** One line each: what to do about a state that was not measured. Anchors: docs/design-lint.md#app-code-<code in lower case>. */
export const APP_CODE_FIX: Record<AppCode, string> = {
  NO_BROWSER: 'gstack-browser-ensure, then rerun',
  UNREACHABLE: 'start the server or fix the URL, then rerun',
  TIMEOUT: 'the page took longer than the render budget; make it load faster or measure fewer viewports, then rerun',
  NOT_READY: 'pass --wait-for <selector> that appears once the section has its data, or make the data load',
  STATE_MISMATCH: "make the URL load the state it names, or fix the state's expect selector",
  WITHIN_NO_MATCH: "pass the custom element's tag or a selector inside the light DOM",
  CLOSED_SHADOW: 'attach the shadow root with mode "open" in development, or pass a --within outside it',
  PROBE_ERROR: 'read the trace file; a page script that redefines DOM APIs breaks the probes',
  ASSET_MISSING: 'fix the stylesheet path or wait for the server to serve it, then rerun',
};

export const appCodeAnchor = (code: AppCode): string => `docs/design-lint.md#app-code-${code.toLowerCase()}`;

export interface AppState { name: string; url: string; expect?: string; within?: string }

export interface AppOptions {
  states: AppState[];
  within: string;
  viewports?: Viewport[];
  /** An explicit --wait-for: the readiness selector, and no list is required before measuring. */
  waitFor?: string;
  waivers?: AppWaiver[];
  engine?: () => EngineChoice;
  run?: Runner;
  /** Replaces the reachability check (tests inject one); null means reachable. */
  reach?: (url: string) => Promise<string | null>;
  traceDir?: string;
  /** How long the probe waits for a list after the section matched; 5000 by default. */
  readyMs?: number;
  /** How long the engine waits for the section (or --wait-for) to match; 15000 by default. */
  sectionWaitMs?: number;
}

export interface AppCoverage { name: string; url: string; viewport: string; status: 'measured' | 'incomplete'; code: AppCode | 'OK'; matched: number; detail?: string; trace?: string }

export interface AppVerdict {
  verdict: 'clean' | 'open' | 'incomplete';
  code: string;
  codes: AppCode[];
  within: string;
  matched: number;
  viewports: string[];
  states: AppCoverage[];
  open: number;
  waived: number;
  notes: string[];
}

export interface AppResult { findings: Finding[]; summary: Summary; app: AppVerdict; exitCode: 0 | 1 | 4; stderr: string[] }

const SECTION_WAIT_MS = 15_000;
const READY_MS = 5_000;
const RENDER_TIMEOUT_MS = 120_000;
const MAX_LOCATOR = 1000;

export const defaultTraceDir = (): string => path.join(os.tmpdir(), 'gstack-design-lint-traces');

function writeTrace(dir: string, rec: { probe: string; state: string; viewport: string; stack: string; url: string }): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `trace-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function reachable(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    return res.ok || res.status === 304 ? null : `HTTP ${res.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

const codeOfRunError = (e: string): AppCode => (/^no browser available/i.test(e) ? 'NO_BROWSER' : /waitFor/.test(e) ? 'NOT_READY' : /timed? ?out|timeout/i.test(e) ? 'TIMEOUT' : 'UNREACHABLE');

const INCOMPLETE_FROM_PROBE = new Set<string>(['NOT_READY', 'STATE_MISMATCH', 'WITHIN_NO_MATCH', 'CLOSED_SHADOW']);

type Parsed = { value: unknown } | { error: string; stack?: string };

function parseEval(text: string | undefined): Parsed {
  if (text === undefined) return { error: 'no result came back' };
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && 'error' in v && typeof (v as { error: unknown }).error === 'string') {
      const e = v as { error: string; stack?: unknown };
      return { error: e.error, ...(typeof e.stack === 'string' ? { stack: e.stack } : {}) };
    }
    return v === null ? { error: 'empty result' } : { value: v };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const isFinding = (f: unknown): f is AppProbeFinding => {
  if (!f || typeof f !== 'object') return false;
  const x = f as Record<string, unknown>;
  return typeof x.rule === 'string' && !!ruleMeta(x.rule)?.app && typeof x.sentence === 'string' && x.sentence.length <= 400
    && typeof x.locator === 'string' && x.locator.length <= MAX_LOCATOR && typeof x.measured === 'number' && Number.isFinite(x.measured) && typeof x.threshold === 'number';
};

/** A probe answer of the shape glAppMeasure returns, or why not. */
function probeShape(v: unknown): { ok: AppProbeResult } | { bad: string } {
  if (!v || typeof v !== 'object') return { bad: 'the answer is not an object' };
  const r = v as AppProbeResult;
  if (r.status !== 'measured' && r.status !== 'incomplete') return { bad: 'the answer has no status' };
  if (typeof r.matched !== 'number' || !Array.isArray(r.findings)) return { bad: 'the answer has no match count or finding list' };
  if (r.status === 'incomplete' && !INCOMPLETE_FROM_PROBE.has(String(r.code))) return { bad: `the answer names an unknown code (${String(r.code).slice(0, 40)})` };
  if (!r.findings.every(isFinding)) return { bad: 'the page handed back a measurement the lint does not know; its scripts may be tampering with the probes' };
  return { ok: r };
}

const field = (s: string): string => oneLine(redactText(s)).replace(/ \| fix: /g, ' / fix: ');

interface StateRun { coverage: AppCoverage[]; findings: Finding[]; notes: string[]; stderr: string[] }

/** One state: reachability, one render with the install, setup and one measurement per viewport, then each answer settled. */
async function lintState(state: AppState, opts: AppOptions, run: Runner, viewports: Viewport[]): Promise<StateRun> {
  const out: StateRun = { coverage: [], findings: [], notes: [], stderr: [] };
  const shown = redactUrl(state.url);
  const within = state.within ?? opts.within;
  const all = (code: AppCode, detail: string, trace?: string) => {
    for (const v of viewports) out.coverage.push({ name: state.name, url: shown, viewport: viewportLabel(v), status: 'incomplete', code, matched: 0, detail: field(detail), ...(trace ? { trace } : {}) });
  };
  const trace = (probe: string, viewport: string, stack: string): string | undefined => {
    let file: string;
    try { file = writeTrace(opts.traceDir ?? defaultTraceDir(), { probe, state: state.name, viewport, stack: redactText(stack), url: shown }); } catch (e) {
      out.stderr.push(`gstack-design-lint: PROBE_ERROR: the ${probe} probe threw at ${state.name} ${viewport}; no trace written (${field((e as Error).message)})`);
      return undefined;
    }
    out.stderr.push(`gstack-design-lint: PROBE_ERROR: the ${probe} probe threw at ${state.name} ${viewport}; trace ${file}`);
    return file;
  };
  if (/^https?:\/\//.test(state.url)) {
    const err = await (opts.reach ?? reachable)(state.url);
    if (err) { all('UNREACHABLE', `could not reach ${shown}: ${err}`); return out; }
  }
  const first = viewports[0];
  const sized = (expression: string, v: Viewport, maxInline = 400_000): RenderStep => ({ kind: 'eval', expression, width: v.width, height: v.height, deviceScaleFactor: 1, mobile: false, maxInline });
  const args = (v: Viewport) => JSON.stringify({ within, expect: state.expect ?? null, explicitWait: !!opts.waitFor, readyMs: opts.readyMs ?? READY_MS });
  const steps: RenderStep[] = [sized(appInstallScript(), first, 10), sized(appProbeScript('P.setup(P)'), first), ...viewports.map((v) => sized(appProbeScript(`P.measure(P, ${args(v)})`), v))];
  const sectionWait = opts.sectionWaitMs ?? SECTION_WAIT_MS;
  const waitFor = { expression: composedWaitExpression(opts.waitFor ?? within, opts.waitFor ? null : sectionWait), timeoutMs: sectionWait + (opts.waitFor ? 0 : 1_000) };
  const res = await run({ file: state.url, waitFor, steps, timeoutMs: RENDER_TIMEOUT_MS });
  if (!res.ok) {
    const err = res.error ?? 'unknown error';
    const code = codeOfRunError(err);
    all(code, code === 'NOT_READY' ? `${opts.waitFor ? `the --wait-for selector ${opts.waitFor}` : `the section ${within}`} did not match within ${sectionWait / 1000}s` : `the page did not render: ${err.slice(0, 300)}`);
    return out;
  }
  const setup = parseEval(res.evals[1]);
  if ('error' in setup) { all('PROBE_ERROR', `the setup probe failed: ${setup.error}`, trace('setup', viewportLabel(first), setup.stack ?? setup.error)); return out; }
  const report = setup.value as AppSetupReport;
  if (!Array.isArray(report?.lostSheets) || !Array.isArray(report?.lostFonts)) { all('PROBE_ERROR', 'the setup answer has no list of lost assets'); return out; }
  if (report.lostFonts.length) out.notes.push(field(`${state.name}: fonts did not load (${report.lostFonts.slice(0, 3).join(', ')}); measured with a fallback face`));
  if (report.lostSheets.length) { all('ASSET_MISSING', `stylesheets did not load: ${report.lostSheets.slice(0, 3).join(', ')}`); return out; }
  viewports.forEach((v, i) => {
    const label = viewportLabel(v);
    const cov: AppCoverage = { name: state.name, url: shown, viewport: label, status: 'incomplete', code: 'PROBE_ERROR', matched: 0 };
    out.coverage.push(cov);
    const p = parseEval(res.evals[2 + i]);
    if ('error' in p) { cov.detail = field(`the measure probe failed: ${p.error}`); cov.trace = trace('measure', label, p.stack ?? p.error); return; }
    const shape = probeShape(p.value);
    if ('bad' in shape) { cov.detail = field(shape.bad); return; }
    const r = shape.ok;
    cov.matched = r.matched;
    if (r.status === 'incomplete') { cov.code = r.code as AppCode; cov.detail = field(r.detail ?? ''); return; }
    cov.status = 'measured';
    cov.code = 'OK';
    for (const f of r.findings) {
      const meta = ruleMeta(f.rule)!;
      const locator = field(f.locator);
      out.findings.push({ rule: f.rule, tier: meta.tier, grade: meta.tier, file: oneLine(shown), line: 1, evidence: field(`[${state.name} ${v.width}px] ${f.sentence} at ${locator}`), fix: meta.fix, source: 'render',
        app: { state: state.name, viewport: label, locator, measured: f.measured, threshold: f.threshold } });
    }
  });
  return out;
}

/** Waivers by rule and locator substring: a match prints at waived with its reason; a waiver that matched nothing is a waiver finding. */
function applyAppWaivers(findings: Finding[], waivers: AppWaiver[]): Finding[] {
  const used = new Set<number>();
  const out = findings.map((f) => {
    const i = waivers.findIndex((w) => w.rule === f.rule && !!f.app && f.app.locator.includes(w.locator));
    if (i < 0) return f;
    used.add(i);
    return { ...f, grade: 'waived' as const, waiver: oneLine(waivers[i].reason) };
  });
  waivers.forEach((w, i) => {
    if (used.has(i)) return;
    out.push({ rule: 'waiver', tier: 'ask', grade: 'ask', file: '--waivers', line: i + 1, evidence: field(`waiver on ${w.rule} at "${w.locator}" matched no finding (unused)`), fix: 'remove the waiver, or correct its locator to part of the finding\'s', source: 'render' });
  });
  return out;
}

export async function lintApp(opts: AppOptions): Promise<AppResult> {
  const viewports = opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS;
  let run = opts.run;
  let status = 'ran';
  const runs: StateRun[] = [];
  if (!run) {
    const choice = (opts.engine ?? pickEngine)();
    if (choice.engine) run = (spec) => (choice.engine === 'browse' ? renderWithBrowse(spec, choice.bin) : render(spec));
    else {
      status = `skipped: ${choice.error}`;
      runs.push({ findings: [], notes: [], stderr: [], coverage: opts.states.flatMap((s) => viewports.map((v): AppCoverage => ({ name: s.name, url: redactUrl(s.url), viewport: viewportLabel(v), status: 'incomplete', code: 'NO_BROWSER', matched: 0, detail: field(choice.error) }))) });
    }
  }
  if (run) for (const s of opts.states) runs.push(await lintState(s, opts, run, viewports));
  const coverage = runs.flatMap((r) => r.coverage);
  const findings = finalize(applyAppWaivers(runs.flatMap((r) => r.findings), opts.waivers ?? []));
  const codes = APP_CODES.filter((c) => coverage.some((x) => x.code === c));
  const open = findings.filter((f) => ruleMeta(f.rule)?.app && f.grade !== 'waived').length;
  const waived = findings.filter((f) => ruleMeta(f.rule)?.app && f.grade === 'waived').length;
  const verdict: AppVerdict['verdict'] = codes.length || !coverage.length ? 'incomplete' : open ? 'open' : 'clean';
  const app: AppVerdict = {
    verdict, code: verdict === 'incomplete' ? codes[0] ?? 'NO_BROWSER' : verdict === 'open' ? 'OPEN' : 'OK', codes,
    within: opts.within, matched: coverage.length ? Math.min(...coverage.map((c) => c.matched)) : 0,
    viewports: viewports.map(viewportLabel), states: coverage, open, waived, notes: runs.flatMap((r) => r.notes),
  };
  return { findings, summary: summarize(findings, status), app, exitCode: verdict === 'clean' ? 0 : verdict === 'open' ? 1 : 4, stderr: runs.flatMap((r) => r.stderr) };
}

/** The LINT line's companions under --scope app: one LINT_APP_STATE line per state x viewport before LINT_SUMMARY, the LINT_APP verdict after it. */
export function formatAppLines(app: AppVerdict): { states: string[]; verdict: string } {
  const states = app.states.map((c) => oneLine(`LINT_APP_STATE: state=${c.name} viewport=${c.viewport} status=${c.status} code=${c.code} matched=${c.matched}`
    + (c.status === 'incomplete' ? ` ${c.detail ?? ''}${c.trace ? ` (trace: ${c.trace})` : ''} | fix: ${APP_CODE_FIX[c.code as AppCode]} (${appCodeAnchor(c.code as AppCode)})` : '')));
  const names = [...new Set(app.states.map((c) => c.name))];
  const measured = names.filter((n) => app.states.every((c) => c.name !== n || c.status === 'measured')).length;
  const verdict = oneLine(`LINT_APP: verdict=${app.verdict} code=${app.code} states=${measured}/${names.length} viewports=${app.viewports.join(',')} within=${app.within} matched=${app.matched} open=${app.open} waived=${app.waived}`);
  return { states, verdict };
}
