import { describe, test, expect } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const ADAPTER = path.join(ROOT, 'bin', 'gstack-outside-voice');
const CONFIG = path.join(ROOT, 'bin', 'gstack-config');

// Temp roots follow bin/gstack-paths' chain — TMPDIR -> TMP -> project-local .gstack/tmp —
// and NOT os.tmpdir(), which bottoms out at /tmp.
//
// This was argued three times before it was settled, and the first two answers were mine and
// wrong. Round 28 flagged the hand-rolled `process.env.TMPDIR || '/tmp'` and asked for the
// platform helper. Round 32 flagged the helper and asked to "redirect through a writable
// test-specific location or TMPDIR"; I measured that os.tmpdir() already returns $TMPDIR when
// set, declined it as a false positive on that basis, and recorded here that "if $TMPDIR is
// unset AND /tmp is unwritable there is no third option a test file could choose". Round 33
// raised it again — and the recorded claim was false. The decline answered the TMPDIR half of
// the request and dropped the "writable test-specific location" half, which was the half with
// substance: gstack-paths resolves TMP_ROOT to a project-local `.gstack/tmp` precisely "so we
// never write to a system /tmp that may be read-only or shared" (its own comment). A third
// option is exactly what production already has, so these tests were the only part of the
// branch still assuming /tmp — in a suite whose subject is an adapter hardened for the case
// where /tmp is read-only or absent.
//
// Writability is PROBED rather than assumed: a directory named by $TMPDIR is a claim, not a
// capability, and a mkdir that throws at module load would fail the file before any assertion
// runs — the exact failure mode being fixed.
export function resolveTmpRoot(env: Record<string, string | undefined> = process.env): string {
  const candidates = [env.TMPDIR, env.TMP, path.join(ROOT, '.gstack', 'tmp')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      // Prove the write, don't infer it from the mkdir: an existing-but-read-only dir makes
      // `mkdir -p` a no-op success.
      fs.rmSync(fs.mkdtempSync(path.join(candidate, 'gstack-probe-')), { recursive: true, force: true });
      return candidate;
    } catch {
      // Try the next candidate. The project-local floor is last and is inside the repo, which
      // .gitignore already excludes, so a fallback leaves no tracked artefacts.
    }
  }
  throw new Error('no writable temp root: set $TMPDIR to a writable directory');
}
const TMP_ROOT = resolveTmpRoot();

// The default loop model is stated in THREE places and nothing reconciled them:
//
//   1. bin/gstack-config  CONFIG_HEADER prose  — what the user reads
//   2. bin/gstack-config  lookup_default()     — what `gstack-config get` returns
//   3. bin/gstack-outside-voice exec_openrouter — the fallback when gstack-config is broken
//
// The adapter's own comment says "it is a third copy of one fact ... grep the model id before
// assuming one edit is enough". That is a remembered rule, and a remembered rule is exactly
// what this repo's history says does not hold. The failure it guards against is quiet and
// expensive in the same breath: change (2) alone and every install with a working config bills
// the new model while the docs promise the old one; change (2) and (3) but not (1) and the
// documentation lies. Nobody notices, because every path still "works".
//
// So pin the fact instead of remembering it. This test fails LOUD on drift, which is the whole
// difference between a contract and a comment.
function extract(file: string, re: RegExp): string[] {
  const text = fs.readFileSync(file, 'utf-8');
  return [...text.matchAll(re)].map((m) => m[1]);
}

describe('outside_voice_loop_model default is stated once, consistently', () => {
  test('all three copies of the default model id agree', () => {
    // All three regexes carry /g: String.matchAll THROWS on a non-global pattern. Caught by
    // the length assertions below rather than by reading — a lenient extraction would have
    // returned nothing and compared an empty set, which passes while measuring nothing. That
    // is the same "an empty result reads as agreement" failure this test exists to prevent,
    // one level up, in the test itself.
    const headerProse = extract(CONFIG, /^#\s*outside_voice_loop_model:\s*(\S+)/gm);
    const lookupDefault = extract(CONFIG, /outside_voice_loop_model\)\s*echo\s*"([^"]+)"/g);
    const adapterFallback = extract(ADAPTER, /\[\s*-n\s*"\$model"\s*\]\s*\|\|\s*model="([^"]+)"/g);

    // Each site must exist. A regex that silently matches nothing is indistinguishable from
    // "the sites agree" — the empty-result-reads-as-pass trap this suite exists to avoid.
    expect(headerProse.length).toBe(1);
    expect(lookupDefault.length).toBe(1);
    expect(adapterFallback.length).toBe(1);

    const all = [headerProse[0], lookupDefault[0], adapterFallback[0]];
    expect(new Set(all).size).toBe(1);
  });
});

describe('the suite resolves its own temp root the way production does', () => {
  // Without this, the fallback is a branch no run ever takes on a normal box (where $TMPDIR or
  // /tmp always works), so it could rot untouched and be discovered only in the read-only-/tmp
  // environment it exists for — which is the one place nobody is watching a test suite.
  test('an env naming no temp dir falls back to the project-local root', () => {
    expect(resolveTmpRoot({})).toBe(path.join(ROOT, '.gstack', 'tmp'));
  });

  test('$TMPDIR is honoured when it is usable', () => {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-tmproot-'));
    try {
      expect(resolveTmpRoot({ TMPDIR: dir })).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a named-but-unusable $TMPDIR falls through instead of throwing', () => {
    // The parent is a FILE, so mkdir fails with ENOTDIR for any uid. A chmod-000 directory
    // would not do: it stays writable for root, so the test would quietly pass by skipping the
    // branch it means to exercise whenever the suite runs as root (CI containers, often).
    const blocker = path.join(fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-tmproot-')), 'a-file');
    fs.writeFileSync(blocker, '');
    try {
      expect(resolveTmpRoot({ TMPDIR: path.join(blocker, 'nested') }))
        .toBe(path.join(ROOT, '.gstack', 'tmp'));
    } finally {
      fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
    }
  });
});

describe('backend resolution refuses to guess', () => {
  function backend(value: string): { out: string; status: number } {
    // A hand-edited config is the case that matters: `gstack-config set` rejects an invalid
    // value, so the only way one reaches resolve_backend is by editing the file directly —
    // which the config header explicitly invites ("edit freely").
    const home = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-ov-test-'));
    fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), `outside_voice_loop: ${value}\n`);
    const r = spawnSync('bash', [ADAPTER, 'backend', '--phase', 'loop'], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: '' } as Record<string, string>,
      encoding: 'utf-8',
    });
    fs.rmSync(home, { recursive: true, force: true });
    return { out: (r.stdout || '').trim(), status: r.status ?? -1 };
  }

  test('recognised values pass through', () => {
    expect(backend('openrouter').out).toBe('openrouter');
    expect(backend('codex').out).toBe('codex');
    expect(backend('disabled').out).toBe('disabled');
  });

  // The regression that matters. This previously resolved to `codex` with a warning on a
  // stderr the caller prints only on FAILURE — so a typo'd loop backend billed every round at
  // frontier price and was indistinguishable from a correct run.
  test('a typo resolves to misconfigured, NOT to codex', () => {
    expect(backend('opnerouter').out).toBe('misconfigured');
  });

  test('unset still resolves to codex, so an unconfigured install is unchanged', () => {
    const home = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-ov-test-'));
    const r = spawnSync('bash', [ADAPTER, 'backend', '--phase', 'loop'], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: '' } as Record<string, string>,
      encoding: 'utf-8',
    });
    fs.rmSync(home, { recursive: true, force: true });
    expect((r.stdout || '').trim()).toBe('codex');
  });
});

describe('the API key never travels across a redirect', () => {
  // The scheme allowlist validates the URL we were CONFIGURED with. It cannot see where that
  // URL points us next — and urllib follows 301/302/303 on a POST while forwarding request
  // headers, including Authorization, including to a plain-http target. Probed in a local
  // harness before this was written: all three codes leaked a Bearer token. 307 happens to
  // raise instead, which is safety by accident. So the allowlist is worth exactly as much as
  // this refusal, and the refusal needs a test that actually performs the hop.
  test('a redirecting base URL is refused before the second request is made', () => {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-ov-redir-'));
    const marker = path.join(dir, 'leaked');
    fs.writeFileSync(
      path.join(dir, 'stub.py'),
      [
        'import threading, time, sys',
        'from http.server import BaseHTTPRequestHandler, HTTPServer',
        'class T(BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        `        open(${JSON.stringify(marker)}, "w").write(self.headers.get("Authorization") or "")`,
        '        b=b"{}"; self.send_response(200); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)',
        '    do_POST = do_GET',
        '    def log_message(self,*a): pass',
        'class R(BaseHTTPRequestHandler):',
        '    def do_POST(self):',
        '        self.rfile.read(int(self.headers.get("Content-Length", 0)))',
        '        self.send_response(302); self.send_header("Location","http://127.0.0.1:8794/v1")',
        '        self.send_header("Content-Length","0"); self.end_headers()',
        '    def log_message(self,*a): pass',
        'threading.Thread(target=HTTPServer(("127.0.0.1",8794), T).serve_forever, daemon=True).start()',
        'threading.Thread(target=HTTPServer(("127.0.0.1",8793), R).serve_forever, daemon=True).start()',
        'print("up", flush=True)',
        'time.sleep(20)',
      ].join('\n'),
    );
    const stub = spawn('python3', [path.join(dir, 'stub.py')], { stdio: 'ignore' });
    try {
      // A readiness handshake over stdout does not work here: spawnSync below blocks node's
      // event loop, so the 'data' callback can never fire and the wait burns the whole test
      // budget. Poll the port with a blocking probe instead — same information, no event loop.
      for (let i = 0; i < 50; i++) {
        const up = spawnSync('bash', ['-c', 'exec 3<>/dev/tcp/127.0.0.1/8793'], { encoding: 'utf-8' });
        if (up.status === 0) break;
        spawnSync('sleep', ['0.1']);
      }

      const prompt = path.join(dir, 'p.txt');
      fs.writeFileSync(prompt, 'review\n');
      const r = spawnSync('python3', [path.join(ROOT, 'bin', 'gstack-outside-voice-request.py')], {
        env: {
          PATH: process.env.PATH,
          OR_MODEL: 'stub',
          OR_PROMPT_FILE: prompt,
          OR_RESP: path.join(dir, 'r.json'),
          OR_TIMEOUT: '30',
          OPENROUTER_API_KEY: 'sk-or-v1-test-value-never-to-be-forwarded',
          GSTACK_OUTSIDE_VOICE_BASE_URL: 'http://127.0.0.1:8793/v1',
        } as Record<string, string>,
        encoding: 'utf-8',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing to follow a redirect/);
      // The property that matters is not the message — it is that the hop never happened.
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      stub.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the findings fence tolerates what models actually emit', () => {
  // 5 of 11 live rounds bought a second full-priced call because the first reply's block was
  // not recognised. A stricter fence buys nothing — the per-request NONCE is what authenticates
  // the block, not the absence of a trailing language hint.
  function parse(text: string): number | null {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-ov-fence-'));
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-outside-voice-request.py'), 'utf-8');
    const reLine = src.split('\n').slice(src.split('\n').findIndex((l) => l.startsWith('BLOCK_RE = re.compile('))).slice(0, 3).join('\n');
    const script = path.join(dir, 'p.py');
    fs.writeFileSync(
      script,
      `import re, json, sys\nFENCE = "findings-json-deadbeef"\n${reLine}\n` +
        `m = BLOCK_RE.findall(sys.stdin.read())\nprint(json.loads(m[-1])["p1"] if m else -1)\n`,
    );
    const r = spawnSync('python3', [script], { input: text, encoding: 'utf-8' });
    fs.rmSync(dir, { recursive: true, force: true });
    const n = parseInt((r.stdout || '').trim(), 10);
    return Number.isNaN(n) ? null : n;
  }

  const FENCE = 'findings-json-deadbeef';
  const J = '{"p1": 1, "p2": 0, "p3": 0, "findings": [{"severity":"P1","title":"a","location":"f:1"}]}';

  test.each([
    ['plain', '```' + FENCE + '\n' + J + '\n```'],
    ['with a language hint', '```' + FENCE + ' json\n' + J + '\n```'],
    ['all on one line', '```' + FENCE + ' ' + J + '```'],
    ['crlf line endings', '```' + FENCE + '\r\n' + J + '\r\n```'],
  ])('accepts a block %s', (_label, text) => {
    expect(parse(text as string)).toBe(1);
  });

  // The nonce is the whole security property: a block echoed out of the diff must not count.
  test('still rejects a block whose fence nonce is wrong', () => {
    expect(parse('```findings-json-cafebabe\n' + J + '\n```')).toBe(-1);
  });
});

describe('outsideVoicePreflight renders valid bash', () => {
  // `$${m}` inside a TS template literal is a LITERAL $ followed by an interpolation, so it
  // renders `$_CODEX_MODE`. A reviewer read it as `$$` + name — bash's PID variable — and
  // filed it as a P1 twice. It is correct, but it is correct in a way that has now cost two
  // review rounds to re-establish, and the "fix" would silently break every downstream branch.
  // Assert the rendered output instead of arguing about the source: `$$` must not survive.
  test('the mode variable renders as a name, not as $$ (the PID)', async () => {
    const { outsideVoicePreflight } = await import('../scripts/resolvers/constants');
    for (const phase of ['loop', 'final_gate'] as const) {
      const out = outsideVoicePreflight({ phase, disabledBehavior: 'codex-only' });
      expect(out).toContain('_CODEX_MODE=$(');
      expect(out).toContain('echo "CODEX_MODE: $_CODEX_MODE"');
      expect(out).not.toContain('$$');
    }
  });

  // The probe grew a fifth state. The generated branch table is the only thing telling a
  // consuming skill what to do with it, and it silently lagged for four rounds.
  test('the branch table covers every state probe can emit', async () => {
    const { outsideVoicePreflight } = await import('../scripts/resolvers/constants');
    const out = outsideVoicePreflight({ phase: 'loop', disabledBehavior: 'skip-all' });
    const adapter = fs.readFileSync(ADAPTER, 'utf-8');
    const probeBody = adapter.slice(adapter.indexOf('probe() {'), adapter.indexOf('# --- usage log'));
    const emitted = new Set([...probeBody.matchAll(/echo "(disabled|not_installed|not_authed|ready|misconfigured)"/g)].map((m) => m[1]));
    expect(emitted.size).toBeGreaterThanOrEqual(5);
    for (const state of emitted) expect(out).toContain(`\`${state}\``);
  });
});

describe('the usage log never reports an unknown cost as zero', () => {
  // The codex CLI reports no token counts, so those rows carried a hard 0. That is not
  // "unknown", it is "free" — and it is the wrong answer in the one analysis this log exists
  // to feed: a cost comparison between a cheap loop and a frontier gate comes out backwards if
  // every frontier row sums to nothing. null cannot be summed by accident.
  function emit(args: string): Record<string, unknown>[] {
    const state = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-ov-log-'));
    const adapter = fs.readFileSync(ADAPTER, 'utf-8');
    const fn = adapter.slice(adapter.indexOf('log_usage() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    const harness = path.join(state, 'h.sh');
    fs.writeFileSync(harness, `set -uo pipefail\n_STATE_DIR="${state}"\n_cfg() { echo community; }\n${body}`);
    spawnSync('bash', ['-c', `source '${harness}'\nlog_usage ${args}`], { encoding: 'utf-8' });
    const log = path.join(state, 'analytics', 'outside-voice.jsonl');
    const rows = fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    fs.rmSync(state, { recursive: true, force: true });
    return rows;
  }

  // Pins the CALL SITES, not just the function. Round 10 changed the codex rows to log
  // `unknown` via a replace whose old text ended in a space and whose new text did not, fusing
  // the token argument to the status: `log_usage … unknown unknowntimeout`. $6 became
  // "unknowntimeout" (coerced to 0 — the exact bug being fixed) and $7 went empty. The
  // unit test above passed throughout, because it hand-writes correct arguments: a test that
  // constructs its own inputs can say nothing about whether the real callers pass valid ones.
  test('every exec_codex call site passes 7 args and yields null tokens with a real status', () => {
    const adapter = fs.readFileSync(ADAPTER, 'utf-8');
    const sites = [...adapter.matchAll(/log_usage codex .*$/gm)].map((m) => m[0]);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const rows = emit(
        site.replace(/^log_usage /, '').replace(/\$phase/g, 'final_gate').replace(/\$label/g, 'gate').replace(/\$rc/g, '7'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].prompt_tokens).toBeNull();
      expect(rows[0].completion_tokens).toBeNull();
      expect(rows[0].status).toBeTruthy();
    }
  });

  test('an unknown count is null, not 0', () => {
    const [row] = emit("codex '' final_gate gate unknown unknown ok");
    expect(row).toBeDefined();
    expect(row.prompt_tokens).toBeNull();
    expect(row.completion_tokens).toBeNull();
  });

  test('a real count is preserved as a number', () => {
    const [row] = emit("openrouter minimax/minimax-m3 loop loop 38428 7876 ok");
    expect(row.prompt_tokens).toBe(38428);
    expect(row.completion_tokens).toBe(7876);
  });

  test('a non-numeric count still yields valid JSON rather than a broken row', () => {
    const [row] = emit("openrouter m loop loop 'not-a-number' '' ok");
    expect(row.prompt_tokens).toBe(0);
    expect(row.completion_tokens).toBe(0);
  });
});

describe('the base-url guard allowlists schemes rather than blocklisting http', () => {
  const REQUEST = path.join(ROOT, 'bin', 'gstack-outside-voice-request.py');

  function attempt(baseUrl: string): string {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-ov-url-'));
    const prompt = path.join(dir, 'p.txt');
    fs.writeFileSync(prompt, 'review this\n');
    const r = spawnSync('python3', [REQUEST], {
      env: {
        PATH: process.env.PATH,
        OR_MODEL: 'x',
        OR_PROMPT_FILE: prompt,
        OR_RESP: path.join(dir, 'r.json'),
        OR_TIMEOUT: '30',
        OPENROUTER_API_KEY: 'dummy-never-sent',
        GSTACK_OUTSIDE_VOICE_BASE_URL: baseUrl,
      } as Record<string, string>,
      encoding: 'utf-8',
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return r.stderr || '';
  }

  // Each of these previously reached the network with the API key attached, because the guard
  // tested for the literal string "http" instead of allowlisting what is permitted.
  test.each([
    ['uppercase scheme', 'HTTP://evil.example.com/v1'],
    ['plain http', 'http://evil.example.com/v1'],
    ['userinfo pointing at loopback', 'http://127.0.0.1:9999@evil.example/v1'],
    ['ftp', 'ftp://evil.example.com/v1'],
    ['file', 'file:///etc/passwd'],
  ])('refuses %s before sending the key', (_label, url) => {
    expect(attempt(url as string)).toMatch(/refusing to send the API key/);
  });

  // Loopback over http is the one permitted plaintext case (local test stubs). It must get
  // PAST the guard — proven by failing at the socket instead, on a port nothing listens on.
  test.each([
    ['IPv4 loopback', 'http://127.0.0.1:9/v1'],
    ['IPv6 loopback', 'http://[::1]:9/v1'],
  ])('allows %s through to the socket', (_label, url) => {
    const err = attempt(url as string);
    expect(err).not.toMatch(/refusing to send the API key/);
    expect(err).toMatch(/request failed/);
  });
});

// The probe is what the generated skills BRANCH on: `ready` is a promise that a round can run.
// It used to approximate the base-url rule above with a glob `case`, and the approximation
// disagreed with the real rule on 7 of 15 tried URLs, in both directions — the fourth time the
// two sides had disagreed about what "usable" means (after key whitespace and model id).
//
// Two of the disagreements are worth naming, because they are opposite failures:
//   * `http://localhost@evil.com` — `localhost` there is USERINFO, the host is evil.com. The
//     glob `http://localhost*` matched, so probe said `ready` for a plaintext REMOTE carrying
//     the API key. The request layer refused it, so it was never exploitable end to end; but
//     probe had promised a round that could not run, which is the contract breach.
//   * `HTTPS://…` — schemes are case-insensitive, so the request layer accepts it while the
//     case-sensitive glob called a working config `misconfigured`.
//
// A prefix glob cannot express "the host IS loopback"; only a parser can. So probe now CALLS
// the request layer's validator. This pins that, because the reason the glob existed —
// "shelling out to python from the probe felt heavy" — is exactly the reasoning that would
// reintroduce it.
describe('probe enforces the request layer base-url rule rather than a copy of it', () => {
  const REQUEST = path.join(ROOT, 'bin', 'gstack-outside-voice-request.py');

  // What probe says. Configured so every OTHER readiness gate passes, leaving the base URL as
  // the only variable — otherwise a `misconfigured` could come from the model or the key and
  // the test would agree for the wrong reason.
  function probeVerdict(baseUrl: string): string {
    const home = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-ov-probe-'));
    fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), 'outside_voice_loop: openrouter\n');
    const r = spawnSync('bash', [ADAPTER, 'probe', '--phase', 'loop'], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: '',
        OPENROUTER_API_KEY: 'dummy-never-sent',
        GSTACK_OUTSIDE_VOICE_BASE_URL: baseUrl,
      } as Record<string, string>,
      encoding: 'utf-8',
    });
    fs.rmSync(home, { recursive: true, force: true });
    return (r.stdout || '').trim();
  }

  // What the request layer does with the same URL, via the real script.
  function requestRefuses(baseUrl: string): boolean {
    const r = spawnSync('python3', [REQUEST, '--check-base-url'], {
      env: {
        PATH: process.env.PATH,
        GSTACK_OUTSIDE_VOICE_BASE_URL: baseUrl,
      } as Record<string, string>,
      encoding: 'utf-8',
    });
    return (r.status ?? -1) !== 0;
  }

  // Every row the glob and the parser disagreed on, plus the ones they agreed on — a table
  // where the old code passes proves nothing, so the disagreements must be present.
  test.each([
    ['canonical https', 'https://openrouter.ai/api/v1'],
    ['uppercase scheme', 'HTTPS://openrouter.ai/api/v1'],
    ['mixed-case scheme', 'Https://openrouter.ai/api/v1'],
    ['IPv4 loopback', 'http://127.0.0.1:8080/v1'],
    ['named loopback', 'http://localhost:8080/v1'],
    ['IPv6 loopback', 'http://[::1]:8080/v1'],
    ['uppercase http loopback', 'HTTP://127.0.0.1:8080/v1'],
    ['loopback-prefixed remote host', 'http://localhost.evil.com/v1'],
    ['IPv4-prefixed remote host', 'http://127.0.0.1.evil.com/v1'],
    ['loopback as userinfo', 'http://localhost@evil.com/v1'],
    ['userinfo before loopback', 'http://user@127.0.0.1:8080/v1'],
    ['ftp', 'ftp://openrouter.ai/v1'],
    ['file', 'file:///etc/passwd'],
    ['plain http remote', 'http://evil.com/v1'],
    ['https on loopback', 'https://127.0.0.1:8080/v1'],
    // The allowlist was three literal strings, which refused the rest of 127.0.0.0/8 — both of
    // these are ordinary choices for a local stub and were rejected as remote. A pattern
    // standing in for a property, the same shape as the glob this file already replaced once.
    ['other loopback in 127/8', 'http://127.0.0.2:8080/v1'],
    ['debian-style loopback', 'http://127.0.1.1:8080/v1'],
    // Widening the range must not widen what it lets through: a private address is not
    // loopback, and the traffic would leave the machine with the key on it.
    ['private but NOT loopback', 'http://10.0.0.1/v1'],
  ])('probe and the request layer agree on %s', (_label, url) => {
    const refused = requestRefuses(url as string);
    expect(probeVerdict(url as string)).toBe(refused ? 'misconfigured' : 'ready');
  });

  // Structural guard. The behavioural table above only catches a divergence that a URL in the
  // table exposes; this catches the reintroduction of a SECOND implementation at all.
  test('the shell holds no second copy of the scheme rule', () => {
    const shell = fs.readFileSync(ADAPTER, 'utf-8');
    expect(shell).toContain('--check-base-url');
    expect(shell).not.toMatch(/^\s*https:\/\/\*\)/m);
  });
});

describe('the loop launcher passes paths as argv, not as shell text', () => {
  // The `'"$VAR"'` idiom closed the quote and pasted each VALUE into the string `bash -c` then
  // parses. Measured against the real idiom: a path holding `$(id -u)` or a backtick EXECUTED,
  // and one holding a double quote was silently corrupted (the quotes vanished and the round
  // wrote to a filename nobody asked for). A single quote — the case usually reported, and the
  // one the review that found this named — was harmless, because the value sits inside inner
  // double quotes. That mismatch is why this is pinned structurally: escaping quotes would fix
  // the symptom people look for and leave expansion, the actual hazard, wide open.
  const SKILL = path.join(ROOT, 'codex', 'SKILL.md');
  const TMPL = path.join(ROOT, 'codex', 'SKILL.md.tmpl');

  test.each([['generated skill', SKILL], ['template', TMPL]])('%s launches via argv', (_l, f) => {
    const text = fs.readFileSync(f as string, 'utf-8');
    // The values arrive as positional parameters...
    expect(text).toContain(
      '_ "$_LOOP_PROMPT" "$_REPO_ROOT" "$_OV_FINDINGS" "$TMPERR" "$_OV_DONE" "$_OV_EFFORT"');
    expect(text).toContain('--prompt-file "$1" --repo-root "$2"');
    // ...including the effort, which was hard-coded to medium and silently dropped --xhigh.
    expect(text).toContain('--effort "$6"');
    expect(text).not.toContain('--effort medium --timeout 900');
    // ...and no path is spliced into the quoted script text any more.
    expect(text).not.toContain(`--prompt-file "'"$_LOOP_PROMPT"'"`);
    expect(text).not.toContain(`echo $? > "'"$_OV_DONE"'"`);
  });
});

// Windows and Git Bash commonly ship a working `python` and no `python3`, so hard-coding the
// name made the hosted backend unreachable there while Python sat installed. The fallback must
// also VERIFY the major version: `python` is Python 2 on plenty of boxes, and accepting it on
// name alone would let probe say `ready` and then hand Python 3 source to a Python 2 interpreter
// — the probe-says-ready/exec-fails disagreement this adapter has already hit four times.
describe('the hosted backend finds Python under either name, but only Python 3', () => {
  const REAL_PY3 = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf-8' }).stdout.trim();

  // Runs the adapter's OWN resolution lines, lifted verbatim, rather than a copy of them — a
  // reimplementation here would be the very drift this suite exists to catch. Driving the full
  // `probe` subcommand was tried first and is the wrong instrument: under a PATH stripped of
  // python, gstack-config also fails, so every case returned not_installed for a reason that had
  // nothing to do with Python and the fixture agreed with itself no matter what the code did.
  function resolveBlock(): string {
    const text = fs.readFileSync(ADAPTER, 'utf-8');
    const m = text.match(/_PY="\$\(command -v python3[\s\S]*?\nfi\n/);
    if (!m) throw new Error('the _PY resolution block was not found — did it move or get renamed?');
    return m[0];
  }

  function resolvedWith(shims: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-py-'));
    for (const [name, body] of Object.entries(shims)) {
      fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
    }
    // PATH is reset to ONLY the shim dir INSIDE the script, so `command -v python3` can find
    // nothing we did not put there. The spawn env keeps the real PATH, because Node resolves the
    // `bash` executable itself through it — passing the shim dir here instead made every spawn
    // fail silently, and the two negative cases then "passed" on a null stdout while measuring
    // nothing at all. Only the positive cases exposed it.
    const r = spawnSync('bash', ['-c', `PATH=${JSON.stringify(dir)}\n${resolveBlock()}\nprintf '%s' "$_PY"`],
      { env: { PATH: process.env.PATH } as Record<string, string>, encoding: 'utf-8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return (r.stdout || '').trim();
  }

  test('the block is still present to test', () => {
    expect(REAL_PY3).toBeTruthy();
    expect(resolveBlock()).toContain('version_info[0] == 3');
  });

  test('python3 by name wins when present', () => {
    const out = resolvedWith({ python3: `#!/bin/sh\nexec ${REAL_PY3} "$@"\n` });
    expect(out).toMatch(/python3$/);
  });

  // The Windows / Git Bash case that made the hosted backend unreachable.
  test('a Python 3 named only `python` is accepted', () => {
    const out = resolvedWith({ python: `#!/bin/sh\nexec ${REAL_PY3} "$@"\n` });
    expect(out).toMatch(/\/python$/);
  });

  test('no python of any name resolves to nothing', () => {
    expect(resolvedWith({})).toBe('');
  });

  // The trap the version check exists for. A name-only fallback would accept this and let probe
  // report `ready`, then hand Python 3 source to a Python 2 interpreter at call time.
  test('a `python` that is not Python 3 is rejected', () => {
    // Fails the major-version probe exactly as a python2 binary would.
    expect(resolvedWith({ python: '#!/bin/sh\nexit 1\n' })).toBe('');
  });
});

// `set -u` turns a bare `$HOME` into an ABORT when HOME is unset, and a HOME-less container is a
// case this adapter explicitly supports (it resolves TMP_ROOT via gstack-paths for exactly that
// reason). Three sites expanded it bare; probe died with "HOME: unbound variable" before it could
// emit any readiness word, so every review failed instead of falling back.
describe('the adapter survives a HOME-less environment', () => {
  function probeHomeless(extra: Record<string, string>): { out: string; status: number } {
    const r = spawnSync('bash', [ADAPTER, 'probe', '--phase', 'loop'], {
      // No HOME, no CODEX_HOME, and none of the state-root overrides unless a case adds them.
      env: { PATH: process.env.PATH, ...extra } as Record<string, string>,
      encoding: 'utf-8',
    });
    return { out: (r.stdout || '').trim(), status: r.status ?? -1 };
  }

  test('probe emits a readiness word instead of aborting when HOME is unset', () => {
    const r = probeHomeless({});
    expect(r.status).toBe(0);
    expect(['ready', 'not_authed', 'not_installed', 'misconfigured', 'disabled']).toContain(r.out);
  });

  test('no bare $HOME expansion remains outside comments', () => {
    const lines = fs.readFileSync(ADAPTER, 'utf-8').split('\n')
      .filter(l => !l.trim().startsWith('#'))
      .filter(l => /\$HOME\b/.test(l) && !/\$\{HOME:-\}/.test(l));
    expect(lines).toEqual([]);
  });

  // The site the review did NOT report: _STATE_DIR runs before everything else and is safe today
  // only because the plugin path happens to set GSTACK_STATE_ROOT. With every override unset it
  // was the earliest abort of the three.
  test('the state dir resolves with every override and HOME unset', () => {
    const r = probeHomeless({});
    expect(r.status).toBe(0);
  });
});

// Step 0.3 promises `--xhigh` overrides the per-mode default for every review mode. Round 21
// honoured that on the LOOP invocation and left the other two hard-coded at `high`, so the
// override still vanished on the default gate and the custom-focus branch. That is the
// first-site-vs-sibling miss this run has made ten times, so the invariant is pinned over the
// enumerated SET of call sites rather than over the one that was reported.
describe('every adapter invocation carries a resolved effort, not a literal', () => {
  const files = [
    ['generated skill', path.join(ROOT, 'codex', 'SKILL.md')],
    ['template', path.join(ROOT, 'codex', 'SKILL.md.tmpl')],
  ] as const;

  test.each(files)('%s: all three call sites are present', (_l, f) => {
    const calls = fs.readFileSync(f, 'utf-8').match(/gstack-outside-voice exec --explicit/g) ?? [];
    // If this count changes, a call site was added or removed — go and give it an effort
    // variable too, rather than updating the number.
    expect(calls.length).toBe(3);
  });

  // Five review rounds read a bare `_REVIEW_EFFORT=high` as a hard-coded literal. They were
  // wrong that the override was missing and right that a static reader cannot see an override
  // path existing only in a comment. Written as a validated branch, the xhigh path is visible
  // in the code — and one flag replaces three independent re-decisions of the same rule, which
  // is what let round 21 fix one site and leave two.
  test.each(files)('%s: effort is derived from one validated _XHIGH flag', (_l, f) => {
    const text = fs.readFileSync(f, 'utf-8');
    // One flag per block (blocks are separate bash invocations), but the SAME shape each time.
    expect((text.match(/^_XHIGH=no$/gm) ?? []).length).toBe(3);
    expect((text.match(/case "\$_XHIGH" in yes\|no\)/g) ?? []).length).toBe(3);
    // Both branches present at every site: the override is code, not prose.
    expect((text.match(/if \[ "\$_XHIGH" = yes \]; then _REVIEW_EFFORT=xhigh; else _REVIEW_EFFORT=high; fi/g) ?? []).length).toBe(2);
    expect((text.match(/if \[ "\$_XHIGH" = yes \]; then _OV_EFFORT=xhigh; else _OV_EFFORT=medium; fi/g) ?? []).length).toBe(1);
  });

  test.each(files)('%s: no invocation hard-codes its effort', (_l, f) => {
    const text = fs.readFileSync(f, 'utf-8');
    expect(text).not.toMatch(/--effort (high|medium|low|xhigh)\b/);
    // The two review paths share one variable; the loop passes its own through argv.
    expect(text).toContain('--effort "$_REVIEW_EFFORT"');
    expect(text).toContain('--effort "$6"');
  });
});

// `list` used to re-parse config.yaml itself instead of asking `get`, and the two readers
// disagreed exactly where it mattered: a blank `outside_voice_loop:` printed `codex (default)`
// as though unset, and `outside_voice_loop_model: foo bar` printed `foo (set)` because awk takes
// one field. Both are values `get` refuses and probe calls `misconfigured` — so the built-in
// diagnostic contradicted the tool it exists to explain, at the moment someone ran it to find
// out why their backend would not start.
describe('gstack-config list agrees with gstack-config get', () => {
  // Both readings are taken EAGERLY, before the temp home is removed. Returning a lazy `get`
  // closure meant it ran after the cleanup and read a config that no longer existed, so it
  // returned "" and the tests failed against the code being correct — a fixture measuring its
  // own teardown rather than the tool.
  function withConfig(yaml: string, keys: string[] = []): { list: string; values: Record<string, string> } {
    const home = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-list-'));
    fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), yaml);
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: '' } as Record<string, string>;
    const list = spawnSync('bash', [CONFIG, 'list'], { env, encoding: 'utf-8' }).stdout || '';
    const values: Record<string, string> = {};
    for (const k of keys) {
      values[k] = (spawnSync('bash', [CONFIG, 'get', k], { env, encoding: 'utf-8' }).stdout || '').trim();
    }
    fs.rmSync(home, { recursive: true, force: true });
    return { list, values };
  }

  test('a blank value is reported as invalid, not as the default', () => {
    const { list, values } = withConfig('outside_voice_loop:\n', ['outside_voice_loop']);
    expect(values.outside_voice_loop).toBe('__blank__');
    expect(list).toMatch(/outside_voice_loop:\s+INVALID/);
    expect(list).not.toMatch(/outside_voice_loop:\s+codex \(default\)/);
  });

  test('a whitespace-bearing model id is not truncated into a plausible one', () => {
    const { list, values } = withConfig('outside_voice_loop_model: foo bar\n', ['outside_voice_loop_model']);
    expect(values.outside_voice_loop_model).toBe('__blank__');
    expect(list).toMatch(/outside_voice_loop_model:\s+INVALID/);
    expect(list).not.toMatch(/outside_voice_loop_model:\s+foo \(set\)/);
  });

  // The negative case: hardening must not make healthy configs read as broken.
  test('valid values and genuine defaults still read normally', () => {
    const { list } = withConfig('outside_voice_loop: openrouter\noutside_voice_loop_model: minimax/minimax-m3\n');
    expect(list).toMatch(/outside_voice_loop:\s+openrouter \(set\)/);
    expect(list).toMatch(/outside_voice_loop_model:\s+minimax\/minimax-m3 \(set\)/);
    expect(list).toMatch(/outside_voice_gate:\s+codex \(default\)/);
    expect(list).not.toMatch(/INVALID/);
  });
});

// The fifth probe/exec divergence of this lane: the scheme allowlist validates the URL we were
// CONFIGURED with, but exec ALSO refuses redirects (urllib forwards Authorization across a
// 301/302/303 on POST). A syntactically perfect https URL that 301s therefore passed probe as
// `ready` and died at request time.
describe('probe refuses a redirecting base URL, without doing I/O on the default', () => {
  const REQUEST = path.join(ROOT, 'bin', 'gstack-outside-voice-request.py');

  function check(env: Record<string, string>): number {
    return spawnSync('python3', [REQUEST, '--check-base-url'],
      { env: { PATH: process.env.PATH, ...env } as Record<string, string>, encoding: 'utf-8' }).status ?? -1;
  }

  test('the DEFAULT url is accepted without a network round-trip', () => {
    // No server is running, so a network probe against the default would hang or fail. Passing
    // instantly is the evidence that the default path does no I/O at all.
    const started = Date.now();
    expect(check({})).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('an unreachable CUSTOM url stays ready — undetermined must not read as broken', () => {
    // Fail-open here on purpose: exec still fail-closes, so the guarantee holds either way, and
    // telling an offline box its config is wrong is a worse lie than the one being fixed.
    expect(check({ GSTACK_OUTSIDE_VOICE_BASE_URL: 'https://127.0.0.1:9/v1' })).toBe(0);
  });

  test('a redirecting CUSTOM url is refused', () => {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-redir-'));
    fs.writeFileSync(path.join(dir, 'srv.py'), [
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      'class R(BaseHTTPRequestHandler):',
      '    def do_HEAD(self):',
      '        self.send_response(302); self.send_header("Location","https://evil.example/v1")',
      '        self.send_header("Content-Length","0"); self.end_headers()',
      '    do_GET = do_HEAD',
      '    def log_message(self,*a): pass',
      'HTTPServer(("127.0.0.1",8792), R).serve_forever()',
    ].join('\n'));
    const srv = spawn('python3', [path.join(dir, 'srv.py')], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50; i++) {
        if (spawnSync('bash', ['-c', 'exec 3<>/dev/tcp/127.0.0.1/8792'], { encoding: 'utf-8' }).status === 0) break;
        spawnSync('sleep', ['0.1']);
      }
      expect(check({ GSTACK_OUTSIDE_VOICE_BASE_URL: 'http://127.0.0.1:8792/v1' })).not.toBe(0);
    } finally {
      srv.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the phase placeholder validates itself', () => {
  // Was `_OV_PHASE=` — blank, with the obligation stated only in a comment. Safe but invisible,
  // and four review rounds read the block as dead code because a static reader cannot tell an
  // unfilled placeholder from a dead literal. Re-proving that each round costs a real finding.
  function runPhaseBlock(substitution: string | null): number {
    const skill = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    const m = skill.match(/_OV_PHASE="<<SET-ME[\s\S]*?\nfi\n/);
    if (!m) throw new Error('the _OV_PHASE block was not found — did it move?');
    const block = substitution === null ? m[0]
      : m[0].replace(/^_OV_PHASE=.*$/m, `_OV_PHASE=${substitution}`);
    return spawnSync('bash', ['-c', block],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME } as Record<string, string>, encoding: 'utf-8' }).status ?? -1;
  }

  test('an unsubstituted placeholder stops the block', () => {
    expect(runPhaseBlock(null)).toBe(2);
  });

  test.each([['loop'], ['final_gate'], ['none']])('a substituted %s proceeds', (v) => {
    expect(runPhaseBlock(v as string)).toBe(0);
  });
});

describe('an oversized prompt is refused, not truncated', () => {
  // The diff is capped and truncated-with-a-warning; the prompt had no guard at all. Refusing is
  // deliberately the OPPOSITE of the diff's handling: truncating a diff drops material the
  // reviewer might have commented on and says so, while truncating the prompt drops the
  // instructions — including the findings contract that decides how severities are reported.
  function exec(promptBytes: number): { status: number; err: string } {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'gstack-prompt-'));
    const f = path.join(dir, 'p.txt');
    fs.writeFileSync(f, 'x'.repeat(promptBytes));
    const r = spawnSync('bash', [ADAPTER, 'exec', '--phase', 'loop', '--prompt-file', f, '--repo-root', ROOT],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, GSTACK_OUTSIDE_VOICE_MAX_PROMPT_BYTES: '1000' } as Record<string, string>, encoding: 'utf-8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status ?? -1, err: r.stderr || '' };
  }

  test('over the cap refuses and names the cap', () => {
    const r = exec(1500);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/over the 1000-byte cap/);
  });

  test('under the cap does not trip the guard', () => {
    expect(exec(500).err).not.toMatch(/over the .*-byte cap/);
  });
});

describe('the retry prompt cannot feed a live fence back to the model', () => {
  const REQUEST = path.join(ROOT, 'bin', 'gstack-outside-voice-request.py');

  // The nonce authenticates the block against anything echoed out of the DIFF, because the diff
  // is fixed before the nonce is drawn. The retry prompt quotes the model's OWN previous reply,
  // whose malformed fence carries this request's live nonce — so the retry response could hold
  // two blocks with the same valid marker, and `blocks[-1]` would return the stale one the retry
  // was sent to replace. Proven directly: with the echo unneutralised the parser returned
  // {"p1": 9,...} (the stale block) and with it neutralised {"p1": 0,...} (the corrected one).
  test('the quoted previous reply has its fence marker stripped of the nonce', () => {
    const py = fs.readFileSync(REQUEST, 'utf-8');
    expect(py).toContain('text[:200000].replace(FENCE, "findings-json-QUOTED-ECHO")');
    // Never embed the raw reply again.
    expect(py).not.toMatch(/%\s*\(why,\s*FENCE,\s*text\[:200000\]\)\)/);
  });

  // The near-miss worth pinning: BLOCK_RE tolerates a trailing [A-Za-z0-9_.+-]* language tag
  // after the fence, so `FENCE + "-QUOTED-ECHO"` STILL matches it. A suffix does not neutralise
  // anything; only dropping the nonce does. This asserts the replacement is a standalone
  // literal rather than one built from FENCE.
  test('the echo marker is a standalone literal, not a suffix of the live fence', () => {
    const py = fs.readFileSync(REQUEST, 'utf-8');
    expect(py).not.toMatch(/replace\(FENCE,\s*FENCE\s*\+/);
  });
});
