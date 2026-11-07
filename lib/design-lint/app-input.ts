/**
 * What `gstack-design-lint --scope app` reads before any page opens: the
 * viewports, the --within selector, a --state-file and a --waivers file, plus
 * the one redaction every URL goes through on its way to a person (text,
 * JSON, stderr, traces). Every input error is an AppUsageError: exit 3, a
 * code, and a fix line, raised before a browser starts.
 */

export class AppUsageError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
  }
}

export interface Viewport { width: number; height: number }

export const DEFAULT_VIEWPORTS: Viewport[] = [{ width: 1440, height: 900 }, { width: 375, height: 812 }];

export const viewportLabel = (v: Viewport): string => `${v.width}x${v.height}`;

export function parseViewport(spec: string): Viewport {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(spec);
  const width = m ? Number(m[1]) : NaN;
  const height = m ? Number(m[2]) : NaN;
  if (!m || width < 320 || width > 3840 || height < 480 || height > 2400) {
    throw new AppUsageError('BAD_VIEWPORT', `--viewport ${JSON.stringify(spec)} is not <width>x<height> with width 320 to 3840 and height 480 to 2400`, 'pass a size like 1440x900 or 375x812');
  }
  return { width, height };
}

const SECRET_PARAM = /token|key|secret|auth|session|sig|signature|password|pass|code|jwt|bearer/i;

/** Parameters with every secret-looking value replaced with REDACTED, or null when none looks secret. */
function redactParams(text: string): string | null {
  const params = new URLSearchParams(text);
  if (![...params.keys()].some((k) => SECRET_PARAM.test(k))) return null;
  return new URLSearchParams([...params.entries()].map(([k, v]) => [k, SECRET_PARAM.test(k) ? 'REDACTED' : v])).toString();
}

/** A URL fit to print: userinfo dropped, secret-looking query and fragment parameter values replaced with REDACTED. Navigation always uses the real URL. */
export function redactUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw.replace(/\/\/[^/@\s]*@/, '//'); }
  u.username = '';
  u.password = '';
  const search = redactParams(u.search.slice(1));
  if (search !== null) u.search = search;
  const hash = u.hash.includes('=') ? redactParams(u.hash.slice(1)) : null;
  if (hash !== null) u.hash = hash;
  return u.toString();
}

/** Every http(s) URL inside free text (an error message, a stack) redacted. */
export const redactText = (s: string): string => s.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => redactUrl(u));

/** A state's name when only its URL is given: its path and query, redacted. */
export function stateNameOf(url: string): string {
  try {
    const u = new URL(redactUrl(url));
    return u.pathname + u.search;
  } catch {
    return redactUrl(url);
  }
}

const QUOTED = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

/**
 * Why a selector is malformed, or null, without a browser: balanced brackets,
 * parentheses and quotes, a name after every . # and :, and a compound on
 * both sides of every combinator and comma. Conservative: it can accept a
 * selector the browser refuses (the probe then reports PROBE_ERROR), never
 * the other way round.
 */
export function selectorError(sel: string): string | null {
  const s = sel.trim();
  if (!s) return 'the selector is empty';
  if (s.length > 1000) return 'the selector is over 1000 characters';
  if (/[{};]/.test(s.replace(QUOTED, ''))) return 'braces and semicolons belong to CSS rules, not a selector';
  const stack: string[] = [];
  let compound = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; compound = true; continue; }
    if (c === '"' || c === "'") {
      if (!stack.length) return `a quote outside [] or () at ${i + 1}`;
      let end = i + 1;
      while (end < s.length && s[end] !== c) end += s[end] === '\\' ? 2 : 1;
      if (end >= s.length) return 'an unclosed quote';
      i = end;
      continue;
    }
    if (c === '[' || c === '(') { stack.push(c); compound = true; continue; }
    if (c === ']' || c === ')') {
      if (stack.pop() !== (c === ']' ? '[' : '(')) return `an unbalanced ${c} at ${i + 1}`;
      continue;
    }
    if (stack.length || /\s/.test(c)) continue;
    if (c === ',' || c === '>' || c === '+' || c === '~') {
      if (!compound) return `nothing before ${c} at ${i + 1}`;
      compound = false;
      continue;
    }
    if (!/[\w\-.#:*|\u00a0-\uffff]/.test(c)) return `${c} cannot appear in a selector (at ${i + 1})`;
    if ((c === '.' || c === '#') && !/[\w\-\\\u00a0-\uffff]/.test(s[i + 1] ?? '')) return `a ${c} with no name after it (at ${i + 1})`;
    if (c === ':' && !/[\w\-:]/.test(s[i + 1] ?? '')) return `a : with no pseudo-class after it (at ${i + 1})`;
    compound = true;
  }
  if (stack.length) return `an unclosed ${stack[stack.length - 1]}`;
  if (!compound) return 'the selector ends in a combinator or a comma';
  return null;
}

export function checkSelector(flag: string, sel: string): void {
  const why = selectorError(sel);
  if (why) throw new AppUsageError('BAD_SELECTOR', `${flag} ${JSON.stringify(sel)} is not a valid selector: ${why}`, "pass a CSS selector the page's querySelectorAll accepts, like main .access or my-panel");
}

export interface AppStateInput {
  name: string;
  url: string;
  expect?: string;
  within?: string;
}

const isLoopback = (url: string): boolean => {
  try { return /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(new URL(url).hostname); } catch { return false; }
};

const STATE_KEYS = new Set(['name', 'url', 'expect', 'within']);

type Bad = (why: string) => AppUsageError;

/** The versioned top level shared by --state-file and --waivers: an object with exactly version 1 and one list. */
function versioned(text: string, list: string, bad: Bad): unknown[] {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) { throw bad(`not JSON (${(e as Error).message})`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('the top level is not an object');
  const top = doc as Record<string, unknown>;
  const extra = Object.keys(top).find((k) => k !== 'version' && k !== list);
  if (extra) throw bad(`unknown key ${extra}`);
  if (top.version !== 1) throw bad('version must be 1');
  if (!Array.isArray(top[list])) throw bad(`${list} must be a list`);
  return top[list] as unknown[];
}

function entry(raw: unknown, where: string, keys: Set<string>, bad: Bad): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(`${where} is not an object`);
  const unknown = Object.keys(raw).find((k) => !keys.has(k));
  if (unknown) throw bad(`${where} has unknown key ${unknown}`);
  return raw as Record<string, unknown>;
}

/** A --state-file: `{"version":1,"states":[{"name","url","expect"?,"within"?}]}`. Returns the states and notes (a non-loopback URL is allowed, and noted). */
export function parseStateFile(text: string): { states: AppStateInput[]; notes: string[] } {
  const bad: Bad = (why) => new AppUsageError('BAD_STATE_FILE', `--state-file: ${why}`, 'write {"version":1,"states":[{"name":"owner","url":"http://127.0.0.1:5300/p?as=owner","expect":"<selector that proves the state>"}]}');
  const list = versioned(text, 'states', bad);
  if (!list.length) throw bad('states is empty');
  const notes: string[] = [];
  const names = new Set<string>();
  const states = list.map((raw, i): AppStateInput => {
    const st = entry(raw, `states[${i}]`, STATE_KEYS, bad);
    if (typeof st.url !== 'string' || !st.url) throw bad(`states[${i}] has no url`);
    if (!/^https?:\/\/[^/]/.test(st.url)) throw bad(`states[${i}].url is not an http or https address`);
    for (const k of ['name', 'expect', 'within']) if (st[k] !== undefined && (typeof st[k] !== 'string' || !st[k])) throw bad(`states[${i}].${k} must be a non-empty string`);
    const name = typeof st.name === 'string' ? st.name : stateNameOf(st.url);
    if (names.has(name)) throw bad(`two states are named ${name}`);
    names.add(name);
    if (typeof st.expect === 'string') checkSelector(`states[${i}].expect`, st.expect);
    if (typeof st.within === 'string') checkSelector(`states[${i}].within`, st.within);
    if (!isLoopback(st.url)) notes.push(`state ${name} is not on a loopback address (${redactUrl(st.url)})`);
    return { name, url: st.url, ...(typeof st.expect === 'string' ? { expect: st.expect } : {}), ...(typeof st.within === 'string' ? { within: st.within } : {}) };
  });
  return { states, notes };
}

export interface AppWaiver { rule: string; locator: string; reason: string }

export const APP_WAIVER_MIN_REASON = 8;

const WAIVER_KEYS = new Set(['rule', 'locator', 'reason']);

/** A --waivers file: `{"version":1,"waivers":[{"rule","locator","reason"}]}`; the rule must be an app rule, the locator a non-empty substring to match, the reason 8 characters or more. */
export function parseWaiverFile(text: string, isAppRule: (id: string) => boolean): AppWaiver[] {
  const bad: Bad = (why) => new AppUsageError('BAD_WAIVERS', `--waivers: ${why}`, 'write {"version":1,"waivers":[{"rule":"small-hit-area","locator":"<part of the finding\'s locator>","reason":"<why, about this page>"}]}');
  return versioned(text, 'waivers', bad).map((raw, i): AppWaiver => {
    const w = entry(raw, `waivers[${i}]`, WAIVER_KEYS, bad);
    if (typeof w.rule !== 'string' || !isAppRule(w.rule)) throw bad(`waivers[${i}].rule ${JSON.stringify(w.rule)} is not an app rule`);
    if (typeof w.locator !== 'string' || !w.locator.trim()) throw bad(`waivers[${i}].locator must be a non-empty string`);
    if (typeof w.reason !== 'string' || w.reason.trim().length < APP_WAIVER_MIN_REASON) throw bad(`waivers[${i}].reason must say why, about this page, in ${APP_WAIVER_MIN_REASON} characters or more`);
    return { rule: w.rule, locator: w.locator, reason: w.reason.trim() };
  });
}
