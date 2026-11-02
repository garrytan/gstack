/**
 * review-risk — the risk signals behind /ship's review depth (R51, docs/review-policy.md#review-depth) and the
 * targeted pass (lib/review-targeted.ts). A leaf module: callers pass only code-class paths with their added
 * and deleted lines, so it imports neither the depth nor the targeted module.
 *
 * money, auth and secret are the targeted pass's matchers (GST-257). security is a trust-boundary path or line
 * (a redaction, sanitizer, consent or trust module; a shell, eval or raw HTML sink; outbound URL handling; archive
 * extraction and path traversal; Node exec through any import spelling); data is user data (a path naming personal or
 * stored data, or a line that drops or bulk-deletes it). Path and identifier signals are token-bounded: costume never
 * names cost, and a CLI's usage text never names money.
 */
import { createHash } from 'node:crypto';

export const RISK_CLASSES = ['money', 'auth', 'secret', 'security', 'data'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Metering and charge words (GST-850: gbrain-evals #289 changed a metering proxy and billing clients with none of the older tokens); they also count on a line. */
export const MONEY_LINE_TOKENS = ['meter', 'meters', 'metering', 'metered', 'charge', 'charges', 'charged', 'billable', 'billed', 'credits'];
export const MONEY_PATH_TOKENS = ['cost', 'costs', 'spend', 'spending', 'budget', 'budgets', 'ledger', 'billing', 'price', 'prices', 'pricing', 'fee', 'fees', 'invoice', 'invoices', ...MONEY_LINE_TOKENS];
/** Words that name money only beside another in the same path or line: token usage, a billing proxy, a cost or charge client. */
export const MONEY_PAIRS: readonly (readonly [string, readonly string[]])[] = [
  ['usage', ['token', 'tokens', 'cost', 'costs', 'spend', 'billing', 'price', 'pricing', 'budget']], ['proxy', ['billing', 'bill']], ['client', ['cost', 'costs', 'charge', 'charges', 'billing', 'price', 'pricing', 'spend']],
];
/** Identifiers ending in _usd, Usd or cap_usd, any spend_cap spelling, and paid-provider call sites (the providers lib/pricing.ts prices). */
export const MONEY_LINE = [
  /\b[A-Za-z0-9_]*_usd\b/i, /\b[a-z][A-Za-z0-9]*Usd\b/, /\bspend[_-]?cap\b/i,
  /\bapi\.(?:anthropic|openai|voyageai)\.com\b/, /\bgenerativelanguage\.googleapis\.com\b/, /\bopenrouter\.ai\b/,
  /\bnew\s+(?:Anthropic|OpenAI|AnthropicBedrock|AnthropicVertex)\s*\(/, /\.(?:messages|chat\.completions|responses|embeddings)\.create\s*\(/,
];
export const AUTH_PATH_TOKENS = ['auth', 'authn', 'authz', 'oauth', 'oauth2', 'jwt', 'session', 'sessions', 'permission', 'permissions', 'role', 'roles'];
export const AUTH_PATH_PREFIXES = ['authenticat', 'authoriz'];
export const SECRET_PATH = /(^|\/)(secrets?|credentials?|keychain|token[s]?)([._/-]|$)/i;
/** An environment name whose underscore-separated segments include a key word: OPENAI_API_KEY, GH_TOKEN; never MAX_TOKENS. */
export const KEY_NAME = String.raw`(?:[A-Z0-9]+_)*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(?:_[A-Z0-9]+)*\b`;
export const SECRET_LINE = [
  new RegExp(String.raw`\b(?:process\.env|Bun\.env|import\.meta\.env)(?:\.|\[\s*['"\x60])${KEY_NAME}`),
  new RegExp(String.raw`\b(?:os\.environ(?:\.get\(|\[)|os\.getenv\(|ENV(?:\.fetch\(|\[))\s*['"]${KEY_NAME}`),
  new RegExp(String.raw`\$\{?${KEY_NAME}`),
  /\b(?:keychain|keytar|find-generic-password|find-internet-password|secret-tool|git-credential|credential\.helper)\b/i, /\bgh auth token\b/, /(?:^|[\s'"/])\.netrc\b/,
];

const SECURITY_PATH_TOKENS = ['trust', 'redact', 'redaction', 'redactor', 'sanitize', 'sanitizer', 'neutralize', 'neutralizer', 'consent', 'escape'];
/** An argument that is one plain string literal: outbound calls and URL building on anything else are input-driven. */
const NOT_LITERAL = String.raw`\s*\(\s*(?![rbu]?['"][^'"\\]*['"]\s*[,)])`;
const CHILD_PROCESS = String.raw`['"](?:node:)?child_process['"]`;
const SECURITY_LINE = [
  /\bshell\s*:\s*true\b/, /\bshell\s*=\s*True\b/, /(?<![.\w$])exec(?:Sync)?\s*\(/, /\b(?:child_process|childProcess|cp)\.exec(?:Sync)?\s*\(/, /\bos\.system\s*\(/,
  new RegExp(String.raw`^(?=.*${CHILD_PROCESS})(?=.*\b(?:exec|execSync|spawn)\b)\s*(?:import|const|let|var)\b(?!\s+type\b)`),
  new RegExp(String.raw`\bimport\s+(?:\*\s+as\s+)?[\w$]+\s*(?:,\s*\{[^}]*\}\s*)?from\s*${CHILD_PROCESS}`), new RegExp(String.raw`(?<!\}\s*=\s*(?:await\s+)?)\b(?:require|import)\s*\(\s*${CHILD_PROCESS}`),
  new RegExp(String.raw`(?:(?<![.\w$])|\b(?:globalThis|window|self)\.)fetch${NOT_LITERAL}`), new RegExp(String.raw`\bhttps?\.(?:request|get)${NOT_LITERAL}`),
  new RegExp(String.raw`\baxios(?:\.(?:get|post|put|patch|delete|head|options|request))?${NOT_LITERAL}`), new RegExp(String.raw`(?<![.\w$])got(?:\.(?:get|post|put|patch|delete|head|stream))?${NOT_LITERAL}`),
  new RegExp(String.raw`\b(?:requests|httpx)\.(?:get|post|put|patch|delete|head|request)${NOT_LITERAL}`), new RegExp(String.raw`\burlopen${NOT_LITERAL}`), new RegExp(String.raw`\bnew\s+URL\s*\(\s*(?!['"][^'"\\]*['"]\s*\)|import\.meta\.url\s*\))`),
  /\b(?:from\s+|require\s*\(\s*)['"]undici['"]|\bundici\.(?:request|fetch|stream)\s*\(|\burllib3\b|\b(?:urljoin|url\.resolve)\s*\(/,
  /\bredirect\s*:\s*['"](?:follow|manual)['"]|\b(?:maxRedirects|followRedirects?|follow_redirects|allow_redirects)\s*[:=]/,
  /\b(?:HTTPS?_PROXY|NO_PROXY|ALL_PROXY|https?_proxy|no_proxy)\b|\b(?:Https?)?ProxyAgent\b|\bproxy\s*(?::|=(?![=>]))/, /\b(?:allowed|trusted|blocked|denied)[_-]?(?:hosts?|domains?|origins?|urls?)|\b(?:hosts?|domains?|origins?|urls?)[_-]?(?:allow|deny|block)[_-]?list/i,
  /\btar\.(?:x|extract)\s*\(|\.(?:extractall|extractAllTo|extractEntryTo)\s*\(|\b(?:tar|tf|zf|zip|archive)\.extract\s*\(|\bshutil\.unpack_archive\s*\(|\b(?:adm-zip|AdmZip|yauzl|extract-zip|unzipper|node-stream-zip)\b/,
  /\btar\s+(?:-[A-Za-z]*x|x[A-Za-z]*\s|--extract)|\bunzip\s+[-\w"'$]/,
  /\bpath\.(?:join|resolve)\s*\([^)]*(?:\b(?:req|request|params|query|argv|headers?|filename|fileName|entryName|member|upload|untrusted|userInput)\b|\bentry\.(?:path|name|fileName)\b)/,
  /\b(?:includes|startsWith|endsWith|indexOf)\s*\(\s*['"`]\.\.[/\\]{0,2}['"`]|[!=]==?\s*['"`]\.\.['"`]|['"`]\.\.['"`]\s*[!=]==?|\\\.\\\./,
  /(?<![.\w])eval\s*\(/, /(?:^|[;&|])\s*eval\s+["'$]/, /\bnew\s+Function\s*\(/,
  /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"](?:\/bin\/)?(?:ba|z)?sh['"]/, /\bBun\.spawn(?:Sync)?\s*\(\s*\[\s*['"](?:\/bin\/)?(?:ba|z)?sh['"]/,
  /\brmSync\s*\([^)]*recursive\s*:\s*true/, /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/,
  /\b(?:innerHTML|outerHTML)\s*\+?=/, /\bdangerouslySetInnerHTML\b/, /\bv-html\b/, /\{@html\b/, /\binsertAdjacentHTML\s*\(/, /\bdocument\.write\s*\(/,
];
const DATA_PATH_TOKENS = ['pii', 'gdpr', 'ccpa', 'privacy', 'personal', 'account', 'accounts', 'customer', 'customers', 'cookie', 'cookies', 'persistence', 'storage', 'database'];
const DATA_LINE = [
  /\bDELETE\s+FROM\b/, /\b(?:drop\s+(?:table|column|database|schema)|truncate\s+table)\b/i, /\bdelete\s+from\s+[\w."`]+\s*(?:where\b|;|$|["'`)])/i,
  /\.(?:deleteMany|destroyAll|bulkDelete)\s*\(/, /\b(?:destroy_all|delete_all)\b/,
];

/** A named import split over lines (`import {\n  exec,\n} from 'node:child_process'`): read over a path's joined added or deleted lines. */
const SECURITY_TEXT = new RegExp(String.raw`\bimport\s*\{([^}]*)\}\s*from\s*${CHILD_PROCESS}`, 'g');
const EXEC_NAME = /(?:^|[\s,{])(?:exec|execSync|spawn)(?:\s+as\s+[\w$]+)?\s*(?:,|$)/;
/** Whether a path or line's tokens name money: a metering or charge word (a cost word too, for a path), or a pair. */
const namesMoney = (t: readonly string[], words: readonly string[]) => t.some(x => words.includes(x)) || MONEY_PAIRS.some(([w, beside]) => t.includes(w) && t.some(x => beside.includes(x)));

/** A hash of the patterns that decide the risk classes, not of this file's bytes; lib/review-depth.ts folds it into DEPTH_RULES. */
export const RISK_RULES = createHash('sha256').update(JSON.stringify({
  RISK_CLASSES, MONEY_PATH_TOKENS, AUTH_PATH_TOKENS, AUTH_PATH_PREFIXES, KEY_NAME, SECURITY_PATH_TOKENS, DATA_PATH_TOKENS,
  MONEY_LINE_TOKENS, MONEY_PAIRS,
  patterns: Object.entries({ MONEY_LINE, SECRET_LINE, SECRET_PATH: [SECRET_PATH], SECURITY_LINE, SECURITY_TEXT: [SECURITY_TEXT], DATA_LINE }).map(([k, v]) => [k, v.map(r => '/' + r.source + '/' + r.flags)]),
})).digest('hex').slice(0, 16);

export const tokens = (p: string) => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export interface RiskInput {
  /** Code-class paths only: the caller drops docs, tests and data its own classifier set aside. */
  codePaths: readonly string[];
  added?: Record<string, readonly string[]>;
  removed?: Record<string, readonly string[]>;
  /** gstack-diff-scope's SCOPE_AUTH: the auth class needs it and an auth token in the path. */
  scopeAuth: boolean;
}

/** The risk classes the code paths touch, the first reason per class, in RISK_CLASSES order. Nothing fails closed here: input errors are the caller's. */
export function matchRisk(i: RiskInput): Map<RiskClass, string> {
  const why = new Map<RiskClass, string>();
  const hit = (c: RiskClass, reason: string) => { if (!why.has(c)) why.set(c, reason); };
  for (const p of i.codePaths) {
    const t = tokens(p);
    if (i.scopeAuth && t.some(x => AUTH_PATH_TOKENS.includes(x) || AUTH_PATH_PREFIXES.some(a => x.startsWith(a)))) hit('auth', 'auth path: ' + p);
    if (SECRET_PATH.test(p)) hit('secret', 'secret path: ' + p);
    if (namesMoney(t, MONEY_PATH_TOKENS)) hit('money', 'money path: ' + p);
    if (t.some(x => SECURITY_PATH_TOKENS.includes(x))) hit('security', 'security path: ' + p);
    if (t.some(x => DATA_PATH_TOKENS.includes(x))) hit('data', 'data path: ' + p);
    for (const side of [i.added?.[p], i.removed?.[p]]) {
      if (!why.has('security') && side?.length && [...side.join('\n').matchAll(SECURITY_TEXT)].some(m => EXEC_NAME.test(m[1]!.trim()) && !/^\s*type\b/.test(m[1]!))) hit('security', 'security import: ' + p);
    }
    for (const line of [...(i.added?.[p] ?? []), ...(i.removed?.[p] ?? [])]) {
      if (!why.has('money') && (MONEY_LINE.some(r => r.test(line)) || namesMoney(tokens(line), MONEY_LINE_TOKENS))) hit('money', 'money line: ' + p);
      if (!why.has('secret') && SECRET_LINE.some(r => r.test(line))) hit('secret', 'secret line: ' + p);
      if (!why.has('security') && SECURITY_LINE.some(r => r.test(line))) hit('security', 'security line: ' + p);
      if (!why.has('data') && DATA_LINE.some(r => r.test(line))) hit('data', 'data line: ' + p);
    }
  }
  return new Map(RISK_CLASSES.filter(c => why.has(c)).map(c => [c, why.get(c)!]));
}
