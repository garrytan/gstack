/**
 * GST-1888: gbrain-evals#387, an eval write-up whose only code is a local stub standing in for a model API, planned the
 * full panel as risk:money and risk:security. A comment that names a trust-boundary call or a credential, a doc that
 * mentions money or keys, and a canned usage object of numeric constants raise neither class on their own, and a JS
 * variable named requests or got is not the Python requests or got HTTP client. Money still reads comments and strings
 * (Captain ruling A: a comment can be the only sign that changed code handles billing, gbrain-evals#289). Code that reads
 * keys, sends auth headers, meters tokens, calls a paid provider or crosses a trust boundary classifies exactly as before,
 * comments and strings beside it included.
 */
import { describe, expect, test } from 'bun:test';
import { classifyDiff } from '../lib/review-depth';
import { matchRisk } from '../lib/review-risk';

const risk = (p: string, lines: string[], scopeAuth = false): string[] => [...matchRisk({ codePaths: [p], added: { [p]: lines }, removed: {}, scopeAuth }).keys()];

const STUB_TS = [
  '// Stands in for the model API: the real harness reads an API key from the environment and sends a bearer token.',
  '/**',
  ' * The stub never calls fetch( or eval(, never spawns through child_process and never runs rm -rf on a credentials file;',
  ' * the API key, the bearer token and the auth headers are never read.',
  ' */',
  'const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };',
  'const delta = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };',
  'const openai = { usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 2 } };',
  "export const reply = (text: string) => ({ content: [{ type: 'text', text }], usage, delta, openai }); // no fetch( or exec( here",
];
const STUB_PY = [
  '# Stands in for the API; requests.get( and subprocess with shell=True are never called, and no API key is read.',
  'def reply(text):',
  '    return {"usage": {"input_tokens": 1, "output_tokens": 1}, "text": text}  # never eval( the text',
];
const STUB_DOC = [
  '# Skill listing truncation',
  'The harness runs against a local stub, so no step makes a paid model call or spends credits.',
  'The real run bills token usage, reads an API key from the environment and sends a bearer token; the stub does none of that.',
];

describe('GST-1888: mentions and canned usage name no money or security', () => {
  // Value: protects=an eval write-up with a model-API stub plans light, as R51 says; fails_when=a comment, a prose string, a
  //   doc or a canned usage object raises money or security; why_new=GST-1888 (gbrain-evals#387); seam=matchRisk + classifyDiff
  test('a stub whose comments name trust-boundary calls and credentials, with canned usage objects and a doc that mentions money and keys, has no risk class', () => {
    expect(risk('bench/capture-server.ts', STUB_TS)).toEqual([]);
    expect(risk('bench/stub.py', STUB_PY)).toEqual([]);
    const paths = ['bench/capture-server.ts', 'bench/stub.py', 'docs/bench.md'];
    const added = { 'bench/capture-server.ts': STUB_TS, 'bench/stub.py': STUB_PY, 'docs/bench.md': STUB_DOC };
    const c = classifyDiff({ paths, gateTagged: 0, added, removed: {}, perPath: paths.map(p => ({ path: p, lines: added[p as keyof typeof added].length, binary: false })) });
    expect({ class: c.class, risk: c.risk }).toEqual({ class: 'code', risk: [] });
  });
  // Value: protects=a JS array named requests and a string named got stay out of the outbound-HTTP rule; fails_when=either
  //   collision raises security again; why_new=GST-1888 (#387's run.ts); seam=matchRisk
  test('a JS variable named requests or got is not an HTTP client', () => {
    expect(risk('bench/run.ts', ['const posts = requests.filter((r) => r.method === "POST");'])).toEqual([]);
    expect(risk('bench/run.ts', ['const stem = got.replace("…", "").trimEnd();', 'expect(got.trim()).toBe(want);'])).toEqual([]);
  });
});

describe('GST-1888 fail-closed: code that handles money, keys, auth or a trust boundary keeps its classes', () => {
  // Value: protects=the fail-closed side of the mention fix; fails_when=a comment or string beside real code, a computed
  //   or read token count, an interpolated or SQL string, a regex literal, or an unknown language hides a class main raised;
  //   why_new=GST-1888; seam=matchRisk
  test.each([
    ['a comment that is the only sign of billing (ruling A)', 'src/loop.ts', ['  /** The provider may have billed that turn, so a caller never runs the question again. */'], ['money']],
    ['a prose string naming a charge (ruling A)', 'src/loop.ts', ['throw new Error("refusing to resend: the provider may have charged for it");'], ['money']],
    ['token cost read from usage', 'src/meter.ts', ['const cost = usage.input_tokens * pricePerToken; // per-call price'], ['money']],
    ['a computed usage field', 'src/meter.ts', ['const usage = { input_tokens: inTok, output_tokens: 1 };'], ['money']],
    ['a summed usage field', 'src/meter.ts', ['const usage = { total_tokens: 1 + extra };'], ['money']],
    ['a running token total', 'src/meter.ts', ['totalTokens += usage.output_tokens; // "no charge" note'], ['money']],
    ['a meter call with a quoted comment', 'src/meter.ts', ['await meter.record(usage); // "nothing is charged" is wrong here'], ['money']],
    ['a billing call', 'src/billing-client.ts', ['const charge = await stripe.charges.create({ amount, currency: "usd" }); // bill the customer'], ['money']],
    ['a paid client', 'src/llm.ts', ['const client = new Anthropic({ apiKey }); // paid'], ['money']],
    ['a paid endpoint in a string', 'src/llm.ts', ['const r = await fetch("https://api.openai.com/v1/responses", init); // the paid call'], ['money', 'security']],
    ['a credits update in SQL', 'src/db.ts', ['db.query("UPDATE wallets SET credits = credits - $1 WHERE id = $2", [n, id]);'], ['money']],
    ['an interpolated log of a charge', 'src/meter.ts', ['log(`charged ${n} credits for ${user}`);'], ['money']],
    ['a Python token cost', 'scripts/cost.py', ['cost = resp.usage.input_tokens * PRICE  # tokens are billed'], ['money']],
    ['a Rust continuation line', 'src/bill.rs', ['    * charge_rate'], ['money']],
    ['a key read from env', 'src/llm.ts', ['const key = process.env.OPENAI_API_KEY; // never logged'], ['secret']],
    ['a Python key read from env', 'scripts/llm.py', ['key = os.environ["ANTHROPIC_API_KEY"]  # read once'], ['secret']],
    ['a shell key header to a paid API', 'bin/call.sh', ['curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com/v1/messages # paid'], ['money', 'secret']],
    ['an auth header on a fetch', 'src/gh.ts', ['await fetch(url, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` } }); // "paid" call'], ['secret', 'security']],
    ['an API key header', 'src/llm.ts', ["headers['x-api-key'] = process.env.ANTHROPIC_API_KEY; // see the \"billing\" docs"], ['secret']],
    ['an exec beside a quoted comment', 'src/run.ts', ['const out = execSync(cmd); // "never" runs untrusted input'], ['security']],
    ['a recursive delete before a block comment', 'src/run.ts', ['fs.rmSync(dir, { recursive: true, force: true }); /* clean up */'], ['security']],
    ['a fetch after a block comment', 'src/run.ts', ['const a = 1; /* no fetch( here */ await fetch(u);'], ['security']],
    ['a fetch after a regex holding //', 'src/run.ts', ['if (/\\/\\//.test(u)) await fetch(u);'], ['security']],
    ['an eval after a regex holding a quote', 'src/run.ts', ['const re = /"/; eval(src);'], ['security']],
    ['a child_process import', 'src/run.ts', ['import { execFileSync } from "node:child_process"; // shell out'], ['security']],
    ['a shell command in a string', 'src/run.ts', ['const CLEAN = "rm -rf build";'], ['security']],
    ['an HTML sink', 'src/view.ts', ['el.innerHTML = html; // "safe" because sanitized'], ['security']],
    ['code after a closing block comment', 'src/run.ts', [' */ await fetch(u);'], ['security']],
    ['a line closing a template literal', 'src/run.ts', ['  ends here` + await fetch(u);'], ['security']],
    ['a line with an unterminated quote', 'src/run.ts', ["it's done\"; await fetch(u);"], ['security']],
    ['a shell length expansion before a paid call', 'bin/x.sh', ['n=${#ITEMS[@]}; curl https://api.openai.com/v1/models'], ['money']],
    ['an extensionless executable', 'bin/tool', ['# no fetch( here'], ['security']],
    ['an auth path', 'src/auth/session.ts', ['// mentions only'], ['auth']],
  ] as [string, string, string[], string[]][])('%s keeps its classes', (_n, p, lines, classes) => {
    expect(risk(p, lines, true)).toEqual(classes);
  });
  // Value: protects=real Python requests and got use stays outbound HTTP; fails_when=narrowing the two rules drops an
  //   import or a call of the real client; why_new=GST-1888 (Captain ruling); seam=matchRisk
  test.each([
    ['import requests', 'scripts/pull.py', ['import requests']],
    ['from requests', 'scripts/pull.py', ['from requests.adapters import HTTPAdapter']],
    ['a requests call in Python', 'scripts/pull.py', ['r = requests.get(url, timeout=5)']],
    ['an httpx call in Python', 'scripts/pull.py', ['r = httpx.post(url, json=body)']],
    ['a requests call in an extensionless script', 'bin/pull', ['r = requests.get(url)']],
    ['a requests call beside its import in a TS file', 'src/py-bridge.ts', ['import requests', 'requests.get(url)']],
    ['import got', 'src/http.ts', ["import got from 'got';"]],
    ['require got', 'src/http.js', ['const got = require("got");']],
    ['a dynamic import of got', 'src/http.ts', ["const { default: got } = await import('got');"]],
    ['a got call', 'src/http.ts', ['const body = await got(url).json();']],
    ['a got verb call', 'src/http.ts', ['await got.post(url, { json });']],
  ] as [string, string, string[]][])('%s is security', (_n, p, lines) => {
    expect(risk(p, lines)).toEqual(['security']);
  });
});

describe('GST-1888: the comment reader and the canned-usage rule run in linear time', () => {
  // Value: protects=gstack-review-plan never stalls on one hostile added line; fails_when=the comment reader or the canned-usage
  //   rule goes quadratic on deep nesting, repeated division, unclosed comments or quotes; why_new=GST-1888; seam=matchRisk
  test.each([
    ['nested token objects', '{a_tokens:'.repeat(10_000) + '1' + '}'.repeat(10_000)],
    ['nested empty token objects', 'x = ' + 'a_tokens: {'.repeat(9_000) + '}'.repeat(9_000)],
    ['repeated division', 'x = ' + 'a / '.repeat(25_000)],
    ['repeated division after spaces', 'x = a' + ' '.repeat(50_000) + '/ b /'.repeat(10_000)],
    ['unclosed block comments', '/*'.repeat(50_000)],
    ['closed block comments', '/* */'.repeat(20_000) + ' fetch(u)'],
    ['an unclosed quote', 'x = "' + 'a'.repeat(100_000)],
    ['many short strings', '"a" + '.repeat(16_000)],
  ])('%s in a TS file returns in under 250 ms', (_n, line) => {
    const t = performance.now();
    matchRisk({ codePaths: ['src/x.ts'], added: { 'src/x.ts': [line] }, removed: {}, scopeAuth: false });
    expect(performance.now() - t).toBeLessThan(250);
  });
});
