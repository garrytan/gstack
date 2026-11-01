/**
 * review-risk — the risk signals behind /ship's review depth (R51, docs/review-policy.md#review-depth) and the
 * targeted pass (lib/review-targeted.ts). A leaf module: callers pass only code-class paths with their added
 * and deleted lines, so it imports neither the depth nor the targeted module.
 *
 * money, auth and secret are the targeted pass's matchers (GST-257). security is a trust-boundary path or line
 * (a redaction, sanitizer, consent or trust module; a shell, eval or raw HTML sink); data is user data (a path
 * naming personal or stored data, or a line that drops or bulk-deletes it). Path and identifier signals are
 * token-bounded: costume never names cost.
 */
import { createHash } from 'node:crypto';

export const RISK_CLASSES = ['money', 'auth', 'secret', 'security', 'data'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const MONEY_PATH_TOKENS = ['cost', 'costs', 'spend', 'spending', 'budget', 'budgets', 'ledger', 'billing', 'price', 'prices', 'pricing', 'fee', 'fees', 'invoice', 'invoices'];
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
const SECURITY_LINE = [
  /\bshell\s*:\s*true\b/, /\bshell\s*=\s*True\b/, /(?<![.\w])execSync\s*\(/, /\bchild_process\.exec(?:Sync)?\s*\(/, /\bos\.system\s*\(/,
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

/** A hash of the patterns that decide the risk classes, not of this file's bytes; lib/review-depth.ts folds it into DEPTH_RULES. */
export const RISK_RULES = createHash('sha256').update(JSON.stringify({
  RISK_CLASSES, MONEY_PATH_TOKENS, AUTH_PATH_TOKENS, AUTH_PATH_PREFIXES, KEY_NAME, SECURITY_PATH_TOKENS, DATA_PATH_TOKENS,
  patterns: Object.entries({ MONEY_LINE, SECRET_LINE, SECRET_PATH: [SECRET_PATH], SECURITY_LINE, DATA_LINE }).map(([k, v]) => [k, v.map(r => '/' + r.source + '/' + r.flags)]),
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
    if (t.some(x => MONEY_PATH_TOKENS.includes(x))) hit('money', 'money path: ' + p);
    if (t.some(x => SECURITY_PATH_TOKENS.includes(x))) hit('security', 'security path: ' + p);
    if (t.some(x => DATA_PATH_TOKENS.includes(x))) hit('data', 'data path: ' + p);
    for (const line of [...(i.added?.[p] ?? []), ...(i.removed?.[p] ?? [])]) {
      if (!why.has('money') && MONEY_LINE.some(r => r.test(line))) hit('money', 'money line: ' + p);
      if (!why.has('secret') && SECRET_LINE.some(r => r.test(line))) hit('secret', 'secret line: ' + p);
      if (!why.has('security') && SECURITY_LINE.some(r => r.test(line))) hit('security', 'security line: ' + p);
      if (!why.has('data') && DATA_LINE.some(r => r.test(line))) hit('data', 'data line: ' + p);
    }
  }
  return new Map(RISK_CLASSES.filter(c => why.has(c)).map(c => [c, why.get(c)!]));
}
