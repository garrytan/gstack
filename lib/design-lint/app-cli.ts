/**
 * The --scope app half of bin/gstack-design-lint: validates every input before
 * a browser starts (exit 3 with a code and a fix line), runs the app
 * scheduler and prints its contract. Kept apart from the bin so the contract
 * tests can inject a runner instead of a browser.
 */
import * as fs from 'node:fs';
import { AppUsageError, checkSelector, parseStateFile, parseViewport, parseWaiverFile, redactUrl, stateNameOf, type Viewport } from './app-input';
import { formatAppLines, lintApp, type AppOptions, type AppState } from './render-app';
import { formatFinding, formatSummary } from './report';
import { ruleMeta } from './rules/ids';

export interface AppCliArgs {
  paths: string[];
  urls: string[];
  within?: string;
  viewports: string[];
  waitFor?: string;
  waivers?: string;
  stateFile?: string;
  verbose: boolean;
  json: boolean;
}

export interface Io { out: (s: string) => void; err: (s: string) => void }

export type AppDeps = Pick<AppOptions, 'engine' | 'run' | 'reach' | 'traceDir' | 'readyMs' | 'sectionWaitMs'>;

export const usageLine = (e: AppUsageError): string => `gstack-design-lint: ${e.code}: ${e.message} | fix: ${e.fix}`;

/** The stderr line for a run that was asked to measure URLs and measured nothing because no browser was available; null otherwise. */
export function renderUnavailable(urls: string[], status: string): string | null {
  if (!urls.length || !/^skipped: no browser available/.test(status)) return null;
  return `gstack-design-lint: RENDER_UNAVAILABLE: nothing was measured at ${urls.map(redactUrl).join(', ')} (${status.slice('skipped: '.length)}) | fix: gstack-browser-ensure, then rerun`;
}

const read = (flag: string, file: string, code: string): string => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { throw new AppUsageError(code, `${flag} ${file} could not be read: ${(e as Error).message}`, `pass a readable JSON file to ${flag}`); }
};

/** Every input settled before work: states, within, viewports, wait-for and waivers. */
export function planApp(a: AppCliArgs): { states: AppState[]; notes: string[]; within: string; viewports: Viewport[]; waivers: AppOptions['waivers'] } {
  if (a.paths.length) throw new AppUsageError('APP_PATHS', `--scope app measures URLs, not files (got ${a.paths[0]})`, 'pass --url <http://…> or --state-file <states.json>, or lint files without --scope app');
  if (!a.within) throw new AppUsageError('NO_WITHIN', '--scope app needs --within <selector>', 'pass --within with the selector of the section you are building');
  checkSelector('--within', a.within);
  if (a.waitFor !== undefined) checkSelector('--wait-for', a.waitFor);
  if (a.urls.length && a.stateFile) throw new AppUsageError('BOTH_TARGETS', '--url and --state-file are two ways to name the states; pass one', 'put every URL in the state file, or drop it');
  if (!a.urls.length && !a.stateFile) throw new AppUsageError('NO_TARGET', '--scope app needs --url <url> or --state-file <states.json>', 'pass the URL of each state to measure');
  const bad = a.urls.find((u) => !/^https?:\/\/[^/]/.test(u));
  if (bad) throw new AppUsageError('BAD_URL', `--url ${redactUrl(bad)} is not an http or https address`, 'pass the dev server URL, like http://127.0.0.1:5300/p');
  const viewports = a.viewports.map(parseViewport);
  const twice = a.urls.find((u, i) => a.urls.indexOf(u) !== i);
  if (twice) throw new AppUsageError('DUPLICATE_STATE', `--url ${redactUrl(twice)} is given twice`, 'measure each URL once');
  const used = new Set<string>();
  const parsed = a.stateFile ? parseStateFile(read('--state-file', a.stateFile, 'BAD_STATE_FILE')) : {
    states: a.urls.map((url) => { const base = stateNameOf(url); let name = base; for (let n = 2; used.has(name); n++) name = `${base}~${n}`; used.add(name); return { name, url }; }),
    notes: [],
  };
  const waivers = a.waivers ? parseWaiverFile(read('--waivers', a.waivers, 'BAD_WAIVERS'), (id) => !!ruleMeta(id)?.app) : [];
  return { states: parsed.states, notes: parsed.notes, within: a.within, viewports, waivers };
}

export async function appMain(a: AppCliArgs, io: Io, deps: AppDeps = {}): Promise<number> {
  let plan: ReturnType<typeof planApp>;
  try { plan = planApp(a); } catch (e) {
    if (!(e instanceof AppUsageError)) throw e;
    io.err(usageLine(e));
    return 3;
  }
  const r = await lintApp({ states: plan.states, within: plan.within, viewports: plan.viewports, waitFor: a.waitFor, waivers: plan.waivers, ...deps });
  r.app.notes.unshift(...plan.notes);
  for (const line of r.stderr) io.err(line);
  if (a.verbose) for (const c of r.app.states) if (c.trace) { try { io.err(`gstack-design-lint: trace ${c.trace}:\n${fs.readFileSync(c.trace, 'utf8')}`); } catch (e) { io.err(`gstack-design-lint: trace ${c.trace} could not be read: ${(e as Error).message}`); } }
  const missing = renderUnavailable(plan.states.map((s) => s.url), r.summary.render);
  if (missing) io.err(missing);
  if (a.json) { io.out(JSON.stringify({ summary: r.summary, files: 0, findings: r.findings, app: r.app }, null, 2)); return r.exitCode; }
  const lines = formatAppLines(r.app);
  io.out([...r.findings.map(formatFinding), ...r.app.notes.map((n) => `LINT_APP_NOTE: ${n}`), ...lines.states, formatSummary(r.summary), lines.verdict].join('\n'));
  return r.exitCode;
}
