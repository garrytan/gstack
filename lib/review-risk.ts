/**
 * review-risk — the risk signals behind /ship's review depth (R51, docs/review-policy.md#review-depth) and the
 * targeted pass (lib/review-targeted.ts). A leaf module: callers pass only code-class paths with their added
 * and deleted lines, so it imports neither the depth nor the targeted module.
 *
 * money, auth and secret are the targeted pass's matchers (GST-257). security is a trust-boundary path or line
 * (a redaction, sanitizer, consent or trust module; a shell, eval or raw HTML sink; outbound URL handling; archive
 * extraction and path traversal; any line naming the child_process module); data is user data (a path naming personal or
 * stored data, or a line that drops or bulk-deletes it). Path and identifier signals are token-bounded: costume never
 * names cost, and a CLI's usage text never names money. A changed SVG line that can run code (a script or
 * foreignObject element, an event handler, a javascript: URL; character references decoded) is security (GST-911).
 */
import { createHash } from 'node:crypto';
import { scan } from './redact-engine';
import { PATTERNS } from './redact-patterns';

export const RISK_CLASSES = ['money', 'auth', 'secret', 'security', 'data', 'eval', 'policy'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Metering and charge words (GST-850: gbrain-evals #289 changed a metering proxy and billing clients with none of the older tokens); they also count on a line. */
export const MONEY_LINE_TOKENS = ['meter', 'meters', 'metering', 'metered', 'charge', 'charges', 'charged', 'billable', 'billed', 'credits'];
export const MONEY_PATH_TOKENS = ['cost', 'costs', 'spend', 'spending', 'budget', 'budgets', 'ledger', 'billing', 'price', 'prices', 'pricing', 'fee', 'fees', 'invoice', 'invoices', ...MONEY_LINE_TOKENS];
/** Words that name money only beside another in the same path or line: token usage, a billing proxy, a cost or charge client. */
export const MONEY_PAIRS: readonly (readonly [string, readonly string[]])[] = [
  ['usage', ['token', 'tokens', 'cost', 'costs', 'spend', 'billing', 'price', 'pricing', 'budget']], ['proxy', ['billing', 'bill']], ['client', ['cost', 'costs', 'charge', 'charges', 'billing', 'price', 'pricing', 'spend']],
];
/**
 * Spend a run reserves, binds, leases or settles against a ledger, a budget or a cap (GST-1129: gstack-evals#170 bound paid spend
 * with `bindCheck(ledger, …)`): a verb beside a spend word on one changed code line. Prose lines (PROSE_PATH) never count: skill
 * text says "binds" and "ledger" in passing (#3698 and #3798 would have read as money).
 */
const SPEND_BIND = ['reserve', 'reserves', 'reserved', 'reservation', 'reservations', 'bind', 'binds', 'lease', 'leases', 'leased', 'settle', 'settles', 'settled'];
const SPEND_OF = ['ledger', 'ledgers', 'spend', 'budget', 'budgets', 'usd', 'cost', 'costs', 'credits', 'billing', 'cap', 'caps'];
export const SPEND_PAIRS: readonly (readonly [string, readonly string[]])[] = [...SPEND_BIND.map(w => [w, SPEND_OF] as const), ['cap', ['spend', 'usd', 'budget', 'ledger']]];
export const PROSE_PATH = /\.(md|mdx|markdown|txt|rst|adoc|tmpl)$/i;
/** Identifiers ending in _usd or Usd: money unless the line only reads or reports a cost (usdMoney). */
export const MONEY_USD = [/\b[A-Za-z0-9_]*_usd\b/i, /\b[a-z][A-Za-z0-9]*Usd\b/];
const MONEY_USD_ALL = MONEY_USD.map(r => new RegExp(r.source, r.flags + 'g'));
/** The words a reported cost's name is made of (GST-962: gstack-evals#139's per-trial cost_usd); any other word, a reservation, estimate or amount, keeps the name money. */
export const REPORTED_COST_WORDS = ['cost', 'costs', 'total', 'totals', 'usd', 'per', 'trial', 'trials', 'item', 'items', 'mean', 'avg', 'average', 'median', 'sum', 'streamed', 'transcript', 'observed', 'actual', 'reported', 'recorded'];
/** A reported cost is still money on a line naming a cap, limit, budget, price, charge, reservation or estimate. */
export const MONEY_USD_WORDS = ['cap', 'caps', 'limit', 'limits', 'max', 'maximum', 'min', 'budget', 'budgets', 'ceiling', 'allowance', 'threshold', 'spend', 'spent', 'spending', 'price', 'prices', 'pricing', 'fee', 'fees', 'bill', 'billing', 'paid', 'payment', 'charge', 'refund', 'amount', 'invoice', 'reserve', 'reservation', 'estimate'];
/** A reported cost compared with `<` or `>` (never an arrow or a shift), or set to a number. */
export const USD_COMPARE = [/<>|(?<![=\-<>])[<>](?![<>])/, /(?:_usd|Usd)\b["']?\s{0,20}[:=]\s{0,20}-?\d/i];
/** Docs and results trees: an unread data file there names no money by its path or a reported cost (GST-961). */
export const RESULTS_TREE = /(^|\/)(?:docs?|wiki|results|reports)\//i;
/** Any spend_cap spelling and paid-provider call sites (the providers lib/pricing.ts prices). */
export const PAID_MONEY_LINE = [
  /\bspend[_-]?cap\b/i,
  /\bapi\.(?:anthropic|openai|voyageai)\.com\b/, /\bgenerativelanguage\.googleapis\.com\b/, /\bopenrouter\.ai\b/,
  /\bnew\s+(?:Anthropic|OpenAI|AnthropicBedrock|AnthropicVertex)\s*\(/, /\.(?:messages|chat\.completions|responses|embeddings)\.create\s*\(/,
];
export const MONEY_LINE = [...MONEY_USD, ...PAID_MONEY_LINE];
/** A config file's price or rate key (input_price_usd, cost_per_1k_usd): money outside a results or receipts tree (PRICE_KEY_EXEMPT), where #3920's path-only rule otherwise keeps config values out (GST-961+962). */
export const PRICE_KEY_EXEMPT = /(^|\/)(?:docs?|wiki|results|reports|receipts)\//i;
export const PRICE_USD_KEY = /(?:^|[^a-z])(?:price|prices|pricing|rate|rates)_[a-z0-9_]*usd\b|cost_?per|per_?token|per_?1[km]\b/i;
/** A _usd or Usd name is money unless every one on the line is a reported cost the line only reads: no cap word, comparison or number set. */
export const usdMoney = (line: string) => {
  const names = MONEY_USD_ALL.flatMap(r => [...line.matchAll(r)].map(m => m[0]));
  if (!names.length) return false;
  return names.some(n => tokens(n).some(x => !REPORTED_COST_WORDS.includes(x))) || tokens(line).some(x => MONEY_USD_WORDS.includes(x)) || USD_COMPARE.some(r => r.test(line));
};
export const AUTH_PATH_TOKENS = ['auth', 'authn', 'authz', 'oauth', 'oauth2', 'jwt', 'session', 'sessions', 'permission', 'permissions', 'role', 'roles'];
export const AUTH_PATH_PREFIXES = ['authenticat', 'authoriz'];
/** A secret path by name alone: a secrets, credentials or keychain name, a dotenv file (not a template), an SSH private key or a key-store extension. */
export const SECRET_PATH = /(^|\/)(secrets?|credentials?|keychain)([._/-]|$)|(^|\/)(\.env(\.(?!(example|sample|template)$)[^/]+)?|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass|\.htpasswd)$|\.(pem|key|p12|pfx|jks|keystore|ppk)$/i;
/** A token name (design, lexer and LLM tokens as well as auth tokens, GST-1350: founderstar's scripts/ui/token.gd): a secret path by name unless it is a TOKEN_SOURCE file, which its changed lines decide. */
export const TOKEN_PATH = /(^|\/)tokens?([._/-]|$)/i;
/** Style and engine extensions: a token-named file of one of these holds design tokens. Any other token file (code, json, yaml, no extension, binary) stays a secret path by name. */
export const TOKEN_SOURCE = /\.(gd|css|scss|sass|less|styl)$/i;
/** The secret-category patterns of the credential scanner pregate's secrets check runs (lib/redact-engine.ts): RISK_RULES and TARGETED_RULES hash them. */
export const SECRET_SCAN = PATTERNS.filter(r => r.category === 'secret').map(r => [r.id, r.tier, '/' + r.regex.source + '/' + r.regex.flags]);
const secretShaped = (p: string, lines: readonly string[]) => scan(lines.join('\n'), { processEnv: {}, sourcePath: p }).findings.some(f => f.category === 'secret' && f.severity !== 'LOW');
/** Whether a changed path is a secret path: by name, or a token-named style or engine file whose added or deleted lines hold a secret-shaped value or cannot be read (no text lines fails closed). */
export const secretPath = (p: string, lines: readonly string[] = []) => SECRET_PATH.test(p) || (TOKEN_PATH.test(p) && (!TOKEN_SOURCE.test(p) || !lines.length || secretShaped(p, lines)));
/** An environment name whose underscore-separated segments include a key word: OPENAI_API_KEY, GH_TOKEN; never MAX_TOKENS. */
export const KEY_NAME = String.raw`(?:[A-Z0-9]+_)*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(?:_[A-Z0-9]+)*\b`;
export const SECRET_LINE = [
  new RegExp(String.raw`\b(?:process\.env|Bun\.env|import\.meta\.env)(?:\.|\[\s*['"\x60])${KEY_NAME}`),
  new RegExp(String.raw`\b(?:os\.environ(?:\.get\(|\[)|os\.getenv\(|ENV(?:\.fetch\(|\[))\s*['"]${KEY_NAME}`),
  new RegExp(String.raw`\$\{?${KEY_NAME}`),
  /\b(?:keychain|keytar|find-generic-password|find-internet-password|secret-tool|git-credential|credential\.helper)\b/i, /\bgh auth token\b/, /(?:^|[\s'"/])\.netrc\b/,
];

/** Sealed custody (harness-evals#237: scripts/sealed/seal.ts) and egress code are trust boundaries too (GST-1177). */
const SECURITY_PATH_TOKENS = ['trust', 'redact', 'redaction', 'redactor', 'sanitize', 'sanitizer', 'neutralize', 'neutralizer', 'consent', 'escape', 'seal', 'sealed', 'custody', 'egress'];
/** An import of Python's requests or httpx client: security on its own, and it makes the file's client calls count (PY_CLIENT_CALL). */
export const PY_CLIENT_IMPORT = /^\s*(?:import\s{1,20}(?:requests|httpx)\b|from\s{1,20}(?:requests|httpx)(?:\.\w{1,40}){0,5}\s{1,20}import\b)/;
/** Coarse, linear-time rules (GST-850 B+): any changed line naming the child_process module, any outbound HTTP client call; quantifiers bounded. */
export const SECURITY_LINE = [
  /\bshell\s*:\s*true\b/, /\bshell\s*=\s*True\b/, /(?<![.\w$])exec(?:Sync)?\s*\(/, /\b(?:child_process|childProcess|cp)\.exec(?:Sync)?\s*\(/, /\bos\.system\s*\(/,
  /['"`](?:node:)?child_process['"`]/,
  /(?:(?<![.\w$])|\b(?:globalThis|window|self)\.)fetch\s{0,20}\(/, /\bhttps?\.(?:request|get)\s{0,20}\(/, /\baxios\b/, /\bundici\b/,
  /(?<![.\w$])got(?:\.(?:get|post|put|patch|head|delete|stream|paginate|extend))?\s{0,20}\(/, /(?:\bfrom\s{1,20}|\b(?:require|import)\s{0,20}\(\s{0,20})['"]got['"]/,
  PY_CLIENT_IMPORT, /\burllib(?:3|\.request)?\b|\burlopen\s{0,20}\(/, /\bnew\s{1,20}URL\s{0,20}\(\s{0,20}(?!['"][^'"\\]{0,2000}['"]\s{0,20}\)|import\.meta\.url\s{0,20}\))/, /\b(?:urljoin|url\.resolve)\s{0,20}\(/,
  /\bredirect\s*:\s*['"](?:follow|manual)['"]|\b(?:maxRedirects|followRedirects?|follow_redirects|allow_redirects)\s*[:=]/,
  /\b(?:HTTPS?_PROXY|NO_PROXY|ALL_PROXY|https?_proxy|no_proxy)\b|\b(?:Https?)?ProxyAgent\b|\bproxy\s*(?::|=(?![=>]))/, /\b(?:allowed|trusted|blocked|denied)[_-]?(?:hosts?|domains?|origins?|urls?)|\b(?:hosts?|domains?|origins?|urls?)[_-]?(?:allow|deny|block)[_-]?list/i,
  /\btar\.(?:x|extract)\s*\(|\.(?:extractall|extractAllTo|extractEntryTo)\s*\(|\b(?:tar|tf|zf|zip|archive)\.extract\s*\(|\bshutil\.unpack_archive\s*\(|\b(?:adm-zip|AdmZip|yauzl|extract-zip|unzipper|node-stream-zip)\b/,
  /\btar\s+(?:-[A-Za-z]*x|x[A-Za-z]*\s|--extract)|\bunzip\s+[-\w"'$]/,
  /\bpath\.(?:join|resolve)\s*\([^)]{0,300}?(?:\b(?:req|request|params|query|argv|headers?|filename|fileName|entryName|member|upload|untrusted|userInput)\b|\bentry\.(?:path|name|fileName)\b)/,
  /\b(?:includes|startsWith|endsWith|indexOf)\s*\(\s*['"`]\.\.[/\\]{0,2}['"`]|[!=]==?\s*['"`]\.\.['"`]|['"`]\.\.['"`]\s*[!=]==?|\\\.\\\./,
  /(?<![.\w])eval\s*\(/, /(?:^|[;&|])\s*eval\s+["'$]/, /\bnew\s+Function\s*\(/,
  /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"](?:\/bin\/)?(?:ba|z)?sh['"]/, /\bBun\.spawn(?:Sync)?\s*\(\s*\[\s*['"](?:\/bin\/)?(?:ba|z)?sh['"]/,
  /\brmSync\s*\((?:.{0,500}?recursive\s*:\s*true|[^)]{501})/, /\brm\s*\((?:.{0,500}?recursive\s*:\s*true|[^)]{501})/, /\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]*[rf]\b/,
  /\bredact\w{0,40}\s{0,20}\(/, /(?:\b(?:from|import)\s{1,20}|\b(?:require|import)\s{0,20}\(\s{0,20})['"][^'"]{0,300}(?:redact|outside-voice)[^'"]{0,300}['"]/, /\b(?:from|import)\s{1,20}[\w.]{0,200}(?:redact|outside_voice)/,
  /\b[A-Z0-9_]{0,60}(?:SECRET|CREDENTIAL)[A-Z0-9_]{0,60}\s{0,20}=\s{0,20}(?:\[\s{0,20})?(?:\/|new\s{1,20}RegExp\b)/,
  /\b(?:innerHTML|outerHTML)\s*\+?=/, /\bdangerouslySetInnerHTML\b/, /\bv-html\b/, /\{@html\b/, /\binsertAdjacentHTML\s*\(/, /\bdocument\.write\s*\(/,
];
/** A recursive delete split across lines (a formatter puts `recursive: true` on its own line), read over a file's changed lines joined. */
export const SECURITY_JOINED = [/\brm(?:Sync)?\s*\((?:[\s\S]{0,500}?recursive\s*:\s*true|[^)]{501})/];
/** Python's requests and httpx clients (GST-1888: #387's JS `requests.filter(` read as one): a call counts in a Python file, an extensionless script, or a file whose changed lines import the client. */
export const PY_CLIENT_PATH = /\.pyw?$|(^|\/)[^./]+$/i;
export const PY_CLIENT_CALL = /\b(?:requests|httpx)\.[a-z]{1,10}\s{0,20}\(/;
/**
 * Comment syntax by extension (GST-1888: gbrain-evals#387's stub planned security from text): security reads a changed line with its
 * comments removed, since its rules match code shapes the code itself carries. Money still reads comments and strings: a comment can
 * be the only sign that changed code handles billing (gbrain-evals#289). Any other file, and any line whose quotes or regex literal
 * do not close on the line (a multi-line string or template), is read whole.
 */
export const SLASH_COMMENT = /\.(?:[cm]?[jt]sx?|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|scala|dart|php)$/i;
export const HASH_COMMENT = /\.(?:py|pyw|sh|bash|zsh|rb|pl|r|jl|gd|ps1)$/i;
/** JSDoc and Javadoc continuation lines (` * text`); C, Go and Rust are left out, where a line can start with a dereference or an operator. */
export const STAR_COMMENT = /\.(?:[cm]?[jt]sx?|java|kts?|swift|cs|scala|dart|php)$/i;
export const REGEX_LITERAL = /\.[cm]?[jt]sx?$/i;
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new))\s*$/;
/** A canned usage field (GST-1888: a model-API stub's `usage: { output_tokens: 1 }`): a token-named key set to a numeric constant, or to an object left empty once those go, four levels deep; a computed, read or summed count stays money. */
export const CONST_TOKEN_FIELD = [/["']?\b[A-Za-z_]{0,60}tokens?[A-Za-z_]{0,60}["']?\s{0,20}:\s{0,20}-?\d{1,20}(?:\.\d{1,20})?(?=\s{0,20}[,}])/gi, /["']?\b[A-Za-z_]{0,60}tokens?[A-Za-z_]{0,60}["']?\s{0,20}:\s{0,20}\{[\s,]{0,200}\}/gi];
const dropConstTokens = (s: string) => { for (let depth = 0; depth < 4; depth++) for (const r of CONST_TOKEN_FIELD) s = s.replace(r, ''); return s; };

/** A changed line with its comments removed and its strings and regex literals kept whole; the whole line when the language is unknown or a literal does not close on it. */
export function codeOf(p: string, line: string): string {
  const slash = SLASH_COMMENT.test(p), hash = HASH_COMMENT.test(p);
  if (!slash && !hash) return line;
  let rest = line;
  if (STAR_COMMENT.test(p) && /^\s*\*(?:\/|\s|$)/.test(rest)) { const end = rest.indexOf('*/'); if (end < 0) return ''; rest = rest.slice(end + 2); }
  const out: string[] = [];
  let tail = '', seg = 0, i = 0;
  const take = (s: string) => { out.push(s); tail = (tail + s).slice(-24); };
  while (i < rest.length) {
    const c = rest[i]!, n = rest[i + 1];
    const comment = (slash && c === '/' && (n === '/' || n === '*')) || (hash && c === '#' && (i === 0 || /\s/.test(rest[i - 1]!)));
    const regex = !comment && c === '/' && REGEX_LITERAL.test(p) && REGEX_AFTER.test((tail + rest.slice(Math.max(seg, i - 24), i)).slice(-24));
    if (!comment && !regex && c !== '"' && c !== "'" && c !== '`') { i++; continue; }
    take(rest.slice(seg, i));
    if (comment && n === '*' && c === '/') { const end = rest.indexOf('*/', i + 2); if (end < 0) return out.join(''); take(' '); seg = i = end + 2; continue; }
    if (comment) return out.join('');
    let j = i + 1, cls = false;
    for (; j < rest.length; j++) {
      const d = rest[j];
      if (d === '\\') { j++; continue; }
      if (regex && d === '[') cls = true; else if (regex && d === ']') cls = false; else if (d === c && !cls) break;
    }
    if (j >= rest.length) return line;
    take(rest.slice(i, j + 1));
    seg = i = j + 1;
  }
  take(rest.slice(seg));
  return out.join('');
}
export const SVG_PATH = /\.svg$/i;
/** SVG text that can run code, read decoded and again with whitespace removed (java&#9;script: is javascript:); a file's changed lines are read joined, so a split attribute still counts. */
export const SVG_ACTIVE = [/<(?:[\w.-]+:)?(?:script|foreignObject)\b/i, /(?:^|[\s"'/])on[a-z]+\s*=/i, /(?:java|vb)script:|data:text\/html/i];
/** XML character references decoded, leading zeros included (&#106;, &#x6a; and &#0000000106; are j); an out-of-range one decodes to nothing. */
export const decodeCharRefs = (s: string) => s.replace(/&#(?:[xX]0*([0-9a-fA-F]+)|0*(\d+));?/g, (_, hex: string | undefined, dec: string | undefined) => {
  const digits = hex ?? dec!;
  const c = digits.length > 8 ? Infinity : hex !== undefined ? parseInt(hex, 16) : Number(dec);
  return c <= 0x10ffff ? String.fromCodePoint(c) : '';
});
export const svgActive = (text: string) => { const d = decodeCharRefs(text); const squeezed = d.replace(/[\s\0-\x1f]+/g, ''); return SVG_ACTIVE.some(r => r.test(d) || r.test(squeezed)); };
/** Eval scorers, judges and graders (FOUN-32 §4): code that decides a published result is risk class eval, by path. */
const EVAL_PATH_TOKENS = ['scorer', 'scorers', 'scoring', 'judge', 'judges', 'grader', 'graders', 'grade', 'grading', 'rubric', 'rubrics'];
const DATA_PATH_TOKENS = ['pii', 'gdpr', 'ccpa', 'privacy', 'personal', 'account', 'accounts', 'customer', 'customers', 'cookie', 'cookies', 'persistence', 'storage', 'database'];
export const DATA_LINE = [
  /\bDELETE\s+FROM\b/, /\b(?:drop\s+(?:table|column|database|schema)|truncate\s+table)\b/i, /\bdelete\s+from\s+[\w."`]+\s*(?:where\b|;|$|["'`)])/i,
  /\.(?:deleteMany|destroyAll|bulkDelete)\s*\(/, /\b(?:destroy_all|delete_all)\b/,
];

/**
 * Data and config files (HARN-1, harness-evals#231): judged by their path only, so a lease_usd value in a VM record never names money.
 * A key in a config file still names a secret.
 */
export const CONFIG_DATA_PATH = /\.(json|jsonl|ndjson|csv|tsv|ya?ml|toml|ini|cfg|conf|env|properties|xml|plist)$/i;
/**
 * Analysis scripts that live with their results (docs/benchmarks/.../results/cost-intervals.py): their path tokens and generic
 * lines name no risk class, but a secret, a spend cap or a paid-provider call in one still does (PAID_MONEY_LINE).
 */
export const STATS_SCRIPT = /(^|\/)results\/(?:[^/]+\/)*[^/]+\.(py|r|jl|ipynb)$/i;

/**
 * Docs that can print a credential (gbrain#8417: `mcp get gbrain` shows a stored bearer token): an Authorization header, a
 * bearer value, a key-shaped literal, an environment key set to a value, or a get/show command for auth config. Read on the
 * added lines of docs paths, which matchRisk never sees, and counted as security (FOUN-64 item 4).
 */
export const DOC_SECRET_LINE = [
  /\bAuthorization\s*:\s*\S/i, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/, /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/,
  new RegExp(String.raw`\b${KEY_NAME}\s*[=:]\s*['"]?[^\s'"$<{]{8,}`),
  /\b(?:mcp|auth|config|credentials?|tokens?|secrets?|keys?|login)\s+(?:get|show|print|view|cat|token)\b/i, /\b(?:get|show|print|cat)\s+(?:\S+[ ./-])?(?:tokens?|auth|credentials?|secrets?|api[_-]?keys?|bearer)\b/i,
];

/** Whether a path or line's tokens name money: a metering or charge word (a cost word too, for a path), or a pair. */
const pairs = (t: readonly string[], list: typeof MONEY_PAIRS) => list.some(([w, beside]) => t.includes(w) && t.some(x => beside.includes(x)));
const namesMoney = (t: readonly string[], words: readonly string[]) => t.some(x => words.includes(x)) || pairs(t, MONEY_PAIRS);

/** A hash of the patterns that decide the risk classes, not of this file's bytes; lib/review-depth.ts folds it into DEPTH_RULES. */
export const RISK_RULES = createHash('sha256').update(JSON.stringify({
  RISK_CLASSES, MONEY_PATH_TOKENS, AUTH_PATH_TOKENS, AUTH_PATH_PREFIXES, KEY_NAME, SECURITY_PATH_TOKENS, DATA_PATH_TOKENS, EVAL_PATH_TOKENS,
  MONEY_LINE_TOKENS, MONEY_PAIRS, SPEND_PAIRS, REPORTED_COST_WORDS, MONEY_USD_WORDS,
  SECRET_SCAN,
  patterns: Object.entries({ PROSE_PATH: [PROSE_PATH], DOC_SECRET_LINE, CONFIG_DATA_PATH: [CONFIG_DATA_PATH], STATS_SCRIPT: [STATS_SCRIPT], MONEY_LINE, PAID_MONEY_LINE, USD_COMPARE, RESULTS_TREE: [RESULTS_TREE], PRICE_USD_KEY: [PRICE_USD_KEY], PRICE_KEY_EXEMPT: [PRICE_KEY_EXEMPT], SECRET_LINE, SECRET_PATH: [SECRET_PATH], TOKEN_PATH: [TOKEN_PATH], TOKEN_SOURCE: [TOKEN_SOURCE], SECURITY_LINE, SECURITY_JOINED, PY_CLIENT_PATH: [PY_CLIENT_PATH], PY_CLIENT_CALL: [PY_CLIENT_CALL], SLASH_COMMENT: [SLASH_COMMENT], HASH_COMMENT: [HASH_COMMENT], STAR_COMMENT: [STAR_COMMENT], REGEX_LITERAL: [REGEX_LITERAL], CONST_TOKEN_FIELD, REGEX_AFTER: [REGEX_AFTER], DATA_LINE, SVG_PATH: [SVG_PATH], SVG_ACTIVE }).map(([k, v]) => [k, v.map(r => '/' + r.source + '/' + r.flags)]),
})).digest('hex').slice(0, 16);

export const tokens = (p: string) => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export interface RiskInput {
  /** Code-class paths only: the caller drops docs, tests and data its own classifier set aside. */
  codePaths: readonly string[];
  added?: Record<string, readonly string[]>;
  removed?: Record<string, readonly string[]>;
  /** gstack-diff-scope's SCOPE_AUTH: the auth class needs it and an auth token in the path. */
  scopeAuth: boolean;
  /** Executables (lib/review-collect.ts): never a config file or results script, so their lines are always read. */
  executables?: readonly string[];
  /** Code paths no code reads (an unconsumed data file or drawing): under RESULTS_TREE their name and reported costs name no money; a spend cap or paid call in them still does (GST-961). */
  dataPaths?: readonly string[];
  /** The base policy's review.risk_paths matcher: a code path it matches is risk class `policy`. */
  isRiskPath?: (p: string) => boolean;
}

/** The risk classes the code paths touch, the first reason per class, in RISK_CLASSES order. Nothing fails closed here: input errors are the caller's. */
export function matchRisk(i: RiskInput): Map<RiskClass, string> {
  const why = new Map<RiskClass, string>();
  const hit = (c: RiskClass, reason: string) => { if (!why.has(c)) why.set(c, reason); };
  for (const p of i.codePaths) {
    if (i.isRiskPath?.(p)) hit('policy', 'risk_paths: ' + p);
    const exe = !!i.executables?.includes(p);
    const stats = !exe && STATS_SCRIPT.test(p);
    const t = stats ? [] : tokens(p);
    const config = !exe && CONFIG_DATA_PATH.test(p);
    const pathOnly = config || stats;
    const prose = PROSE_PATH.test(p);
    if (i.scopeAuth && t.some(x => AUTH_PATH_TOKENS.includes(x) || AUTH_PATH_PREFIXES.some(a => x.startsWith(a)))) hit('auth', 'auth path: ' + p);
    if (secretPath(p, [...(i.added?.[p] ?? []), ...(i.removed?.[p] ?? [])])) hit('secret', 'secret path: ' + p);
    const money = !(i.dataPaths?.includes(p) && RESULTS_TREE.test(p));
    if (money && namesMoney(t, MONEY_PATH_TOKENS)) hit('money', 'money path: ' + p);
    if (t.some(x => SECURITY_PATH_TOKENS.includes(x))) hit('security', 'security path: ' + p);
    if (t.some(x => DATA_PATH_TOKENS.includes(x))) hit('data', 'data path: ' + p);
    if (!config && t.some(x => EVAL_PATH_TOKENS.includes(x))) hit('eval', 'eval scorer path: ' + p);
    if (SVG_PATH.test(p) && [i.added?.[p], i.removed?.[p]].some(l => l && svgActive(l.join('\n')))) hit('security', 'active SVG lines: ' + p);
    const lines = [...(i.added?.[p] ?? []), ...(i.removed?.[p] ?? [])];
    const pyClient = PY_CLIENT_PATH.test(p) || lines.some(l => PY_CLIENT_IMPORT.test(l));
    for (const line of lines) {
      if (!why.has('secret') && SECRET_LINE.some(r => r.test(line))) hit('secret', 'secret line: ' + p);
      if (!why.has('money') && pathOnly && (PAID_MONEY_LINE.some(r => r.test(line)) || (!PRICE_KEY_EXEMPT.test(p) && MONEY_USD.some(r => r.test(line)) && PRICE_USD_KEY.test(line)))) hit('money', 'spend cap, paid call or price key: ' + p);
      if (pathOnly) continue;
      const words = dropConstTokens(line), code = codeOf(p, line);
      if (!why.has('money') && (PAID_MONEY_LINE.some(r => r.test(line)) || (money && (usdMoney(words) || namesMoney(tokens(words), MONEY_LINE_TOKENS) || (!prose && pairs(tokens(words), SPEND_PAIRS)))))) hit('money', 'money line: ' + p);
      if (!why.has('security') && (SECURITY_LINE.some(r => r.test(code)) || (pyClient && PY_CLIENT_CALL.test(code)))) hit('security', 'security line: ' + p);
      if (!why.has('data') && DATA_LINE.some(r => r.test(line))) hit('data', 'data line: ' + p);
    }
    if (!why.has('security') && [i.added?.[p], i.removed?.[p]].some(l => l && SECURITY_JOINED.some(r => r.test(l.join('\n'))))) hit('security', 'security lines: ' + p);
  }
  return new Map(RISK_CLASSES.filter(c => why.has(c)).map(c => [c, why.get(c)!]));
}
