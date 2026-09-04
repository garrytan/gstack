import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-learnings-search');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-test-'));
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-cwd-'));
// gstack-slug derives slug from git remote (none here) → falls back to basename of cwd.
const slug = path.basename(tmpCwd).replace(/[^a-zA-Z0-9._-]/g, '');
const projDir = path.join(tmpHome, 'projects', slug);
const otherProjDir = path.join(tmpHome, 'projects', 'other-project');

function run(args: string[]): string {
  return execFileSync(BIN, args, {
    timeout: 30_000,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    cwd: tmpCwd,
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(otherProjDir, { recursive: true });
  const entries = [
    { ts: '2026-05-01T00:00:00Z', skill: 'test', type: 'pattern', key: 'foo-pattern', insight: 'A foo-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-02T00:00:00Z', skill: 'test', type: 'pitfall', key: 'bar-pitfall', insight: 'A bar-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-03T00:00:00Z', skill: 'test', type: 'pattern', key: 'baz-pattern', insight: 'A baz-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
  ];
  const otherEntries = [
    { ts: '2026-05-04T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-observed', insight: 'A foreign observed insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-05T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-user', insight: 'A foreign user-stated insight', confidence: 8, source: 'user-stated', trusted: true, files: [] },
    // #1745: legacy row with NO `trusted` field at all (written before the field
    // existed). The old `=== false` denylist admitted these; the allowlist must exclude.
    { ts: '2026-05-06T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-legacy', insight: 'A foreign legacy insight with no trusted field', confidence: 8, source: 'observed', files: [] },
  ];
  fs.writeFileSync(path.join(projDir, 'learnings.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(otherProjDir, 'learnings.jsonl'), otherEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
  // #2762: rankCwd is created at module scope, so it must be removed at module
  // scope too. A describe-scoped afterAll leaks it whenever a filtered run
  // (bun test -t ...) skips that describe.
  fs.rmSync(rankCwd, { recursive: true, force: true });
});

describe('gstack-learnings-search token-OR query semantics', () => {
  test('multi-token query returns entries matching ANY token', () => {
    const out = run(['--query', 'foo bar']);
    expect(out).toContain('foo-pattern');
    expect(out).toContain('bar-pitfall');
    expect(out).not.toContain('baz-pattern');
  });

  test('single-token query returns only entries matching that token', () => {
    const out = run(['--query', 'foo']);
    expect(out).toContain('foo-pattern');
    expect(out).not.toContain('bar-pitfall');
    expect(out).not.toContain('baz-pattern');
  });

  test('no --query flag returns all entries (backwards-compat)', () => {
    const out = run(['--limit', '10']);
    expect(out).toContain('foo-pattern');
    expect(out).toContain('bar-pitfall');
    expect(out).toContain('baz-pattern');
  });
});

describe('gstack-learnings-search cross-project trust gating', () => {
  test('cross-project mode still includes observed entries from the current project', () => {
    const out = run(['--cross-project', '--query', 'foo']);
    expect(out).toContain('foo-pattern');
    expect(out).not.toContain('[cross-project]');
  });

  test('cross-project mode only imports trusted entries from other projects', () => {
    const out = run(['--cross-project', '--query', 'foreign']);
    expect(out).toContain('foreign-user');
    expect(out).toContain('[cross-project]');
    expect(out).not.toContain('foreign-observed');
  });

  // #1745: the gate is an allowlist, not a denylist. A cross-project row with no
  // `trusted` field (legacy / hand-edited / other-tool) must NOT be imported.
  test('cross-project mode excludes foreign rows missing the trusted field (#1745)', () => {
    const out = run(['--cross-project', '--query', 'foreign']);
    expect(out).not.toContain('foreign-legacy');
  });
});

// #2762: relevance ranking. The query filter is token-OR over substrings, so a
// broad token can admit most of a store. Ranking on confidence alone then lets a
// high-confidence single-token match outrank an entry that matched every token,
// and the default --limit 10 truncates the exact answer off the end. The caller
// gets ten confident, well-formed, wrong entries and reads them as a complete
// answer -- a false absence, which is the dangerous failure direction.
//
// This fixture lives in its own project dir so the assertions above (which depend
// on a three-entry store) keep their meaning. Every entry is `user-stated` because
// that source is exempt from confidence decay -- an `observed` fixture would drift
// as wall-clock time passes and turn these into date-dependent flakes. Every entry
// is the same `type` so the formatter emits one group and printed order is rank order.
const rankCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-rank-cwd-'));
const rankSlug = path.basename(rankCwd).replace(/[^a-zA-Z0-9._-]/g, '');
const rankProjDir = path.join(tmpHome, 'projects', rankSlug);

const TARGET = 'verify-preflight-project-line-before-trusting-report';
// Twelve decoys, each matching ONLY the token `line`, via substring hits inside
// guideline / pipeline / deadline / etc. All outrank the target on confidence.
const DECOY_WORDS = [
  'guideline', 'pipeline', 'deadline', 'headline', 'baseline', 'timeline',
  'outline', 'airline', 'lifeline', 'sideline', 'streamline', 'underline',
];

function rankEntry(over: Record<string, unknown>): Record<string, unknown> {
  return { ts: '2026-05-01T00:00:00Z', skill: 'test', type: 'pattern', confidence: 8, source: 'user-stated', trusted: false, files: [], ...over };
}

// #2762 / I11: assert on the printed order as an ARRAY, never with indexOf
// comparisons. indexOf returns -1 for an absent key, and -1 is less than every
// real index, so `indexOf(a) < indexOf(b)` reports green when `a` has vanished
// entirely -- the exact false-absence this suite exists to catch.
function rankedKeys(args: string[]): string[] {
  return runRank(args)
    .split('\n')
    .map(line => /^- \[([^\]]+)\]/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => m[1]);
}

function runRank(args: string[]): string {
  return execFileSync(BIN, args, {
    timeout: 30_000,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    cwd: rankCwd,
    encoding: 'utf-8',
  });
}

describe('gstack-learnings-search relevance ranking (#2762)', () => {
  beforeAll(() => {
    fs.mkdirSync(rankProjDir, { recursive: true });
    const rows = [
      // Matches all three tokens of "preflight project line", at LOWER confidence
      // than every decoy. This is the entry the caller is looking for.
      rankEntry({ key: TARGET, insight: 'Check the project line in the preflight report before trusting it', confidence: 8 }),
      // 1-of-3 matches (`line` only) at max confidence: enough of them to fill the
      // default limit on their own.
      ...DECOY_WORDS.map((w, i) => rankEntry({
        ts: '2026-05-' + String(4 + i).padStart(2, '0') + 'T00:00:00Z',
        key: 'decoy-' + w + '-rule',
        insight: 'A ' + w + ' related insight',
        confidence: 10,
      })),
      // Tie-break probes for the query "alpha beta": 2 hits at confidence 9, 2 hits
      // at confidence 5, 1 hit at confidence 10. Correct order is 9, 5, 10 -- hits
      // outrank confidence, and confidence still breaks a tie between equal hits.
      // The lower-confidence row is deliberately the NEWER one, so recency alone
      // would order these backwards. Only the confidence tier produces the
      // expected order, which is what makes the assertion able to fail.
      rankEntry({ ts: '2026-05-01T00:00:00Z', key: 'tiebreak-alpha-beta-high', insight: 'alpha beta both present', confidence: 9 }),
      rankEntry({ ts: '2026-06-01T00:00:00Z', key: 'tiebreak-alpha-beta-low', insight: 'alpha beta both present', confidence: 5 }),
      rankEntry({ key: 'tiebreak-alpha-solo', insight: 'alpha only here', confidence: 10 }),
      // Recency probes for "gamma delta": identical hits AND identical confidence,
      // so the third comparison (recency) has to decide.
      rankEntry({ ts: '2026-05-01T00:00:00Z', key: 'recency-gamma-delta-older', insight: 'gamma delta pair', confidence: 7 }),
      rankEntry({ ts: '2026-06-01T00:00:00Z', key: 'recency-gamma-delta-newer', insight: 'gamma delta pair', confidence: 7 }),
      // A row carrying a stored _tokenHits, the shape gstack-learnings-log will
      // happily persist because it re-serializes unknown keys. Worst entry in the
      // store on every legacy signal: lowest confidence, oldest timestamp.
      rankEntry({ ts: '2020-01-01T00:00:00Z', key: 'planted-token-hits', insight: 'isolated poison row', confidence: 1,
        _insightHits: 9999, _contextHits: 9999, _tokenHits: 9999, _somethingAddedLater: 9999 }),
      // Substring-vs-word probes. The decoy satisfies "cause", "bug" and "fix" only
      // as substrings (be-CAUSE, de-BUG, FIX-ture); the real answer contains three
      // of them as whole words.
      rankEntry({ key: 'nested-substring-decoy', insight: 'debug output ran because the fixture was parallel', confidence: 10 }),
      rankEntry({ key: 'nested-whole-word-match', insight: 'form a root cause hypothesis first', confidence: 2 }),
      // Key-verbosity probes. The verbose key carries four query tokens; its
      // content carries none. The plain key carries none; its content carries one.
      rankEntry({ key: 'kappa-lambda-sigma-omega-verbose-key', insight: 'unrelated content', confidence: 4 }),
      rankEntry({ key: 'plain-key', insight: 'kappa appears here', confidence: 10 }),
      // Naming-tier probes: identical insight relevance (both score 1 on "sigma"),
      // so the key/file tier has to break the tie -- and it must beat confidence.
      rankEntry({ key: 'tau-rho-xi-named', insight: 'tau noted', confidence: 2 }),
      rankEntry({ key: 'unnamed-probe', insight: 'tau noted', confidence: 8 }),
      // files is a scored field; give it tokens that appear nowhere else, so a hit
      // can only have come from the path.
      rankEntry({ key: 'path-carrier', insight: 'nothing relevant here', confidence: 3, files: ['test/zulu/yankee.test.ts'] }),
      rankEntry({ key: 'insight-carrier', insight: 'zulu and yankee explained properly', confidence: 3, files: [] }),
      // Non-ASCII boundary probes. 'chi' is a real word in the CJK row and only an
      // incidental substring in 'chile'.
      rankEntry({ key: 'accented-neighbour', insight: 'psi\u00e9 deploy', confidence: 5 }),
      rankEntry({ key: 'ascii-neighbour', insight: 'psi deploy', confidence: 5 }),
      // Dedup probes. The repeated-token entry must NOT also match the other
      // concepts, or repetition inflates both rows equally and the ordering cannot
      // reveal whether tokens were deduped.
      rankEntry({ key: 'repeated-token-only', insight: 'nu only here', confidence: 9 }),
      rankEntry({ key: 'two-distinct-concepts', insight: 'omicron and kirin together', confidence: 2 }),
    ];
    fs.writeFileSync(path.join(rankProjDir, 'learnings.jsonl'), rows.map(e => JSON.stringify(e)).join('\n') + '\n');
  });

  // The reported defect: adding a discriminating token made the search WORSE.
  // On the pre-fix binary the first two queries find the target and the third
  // does not, even though its key contains all three tokens.
  test('an entry matching every query token survives the default limit', () => {
    expect(runRank(['--query', 'preflight'])).toContain(TARGET);
    expect(runRank(['--query', 'preflight project'])).toContain(TARGET);
    expect(runRank(['--query', 'preflight project line'])).toContain(TARGET);
  });

  test('a 3-of-3 match outranks twelve higher-confidence 1-of-3 matches', () => {
    expect(rankedKeys(['--query', 'preflight project line'])[0]).toBe(TARGET);
  });

  test('token hits outrank confidence, and confidence still breaks a hit tie', () => {
    expect(rankedKeys(['--query', 'alpha beta'])).toEqual([
      'tiebreak-alpha-beta-high',  // 2 hits, confidence 9
      'tiebreak-alpha-beta-low',   // 2 hits, confidence 5 -- hits tie, confidence decides
      'tiebreak-alpha-solo',       // 1 hit, confidence 10 -- outranked despite the best confidence
    ]);
  });

  test('equal hits and equal confidence still fall through to recency', () => {
    expect(rankedKeys(['--query', 'gamma delta'])).toEqual([
      'recency-gamma-delta-newer',
      'recency-gamma-delta-older',
    ]);
  });

  // Relevance applies to single-token queries too, and this is the case that shows
  // why it has to. `line` appears in all twelve decoys only inside guideline,
  // pipeline, deadline and friends; the target contains it as an actual word. The
  // pre-fix binary ranked on confidence alone and truncated the target away.
  test('a single token still discriminates a real word from an incidental substring', () => {
    const ranked = rankedKeys(['--query', 'line']);
    expect(ranked[0]).toBe(TARGET);
    // Recall is untouched: the substring-only decoys are all still returned.
    expect(ranked).toContain('decoy-underline-rule');
  });

  test('a truncated query reports the part and the whole, stated once', () => {
    const out = runRank(['--query', 'preflight project line']);
    expect(out).toContain('LEARNINGS: 10 of 13 matched');
    expect(out).toContain('raise --limit for the rest');
    // The count is stated as a fraction instead of alongside a second copy of itself.
    expect(out).not.toContain('10 loaded');
  });

  test('a query that fits under the limit says nothing about truncation', () => {
    const out = runRank(['--query', 'gamma delta']);
    expect(out).toContain('recency-gamma-delta-newer');
    expect(out).toContain('loaded');
    expect(out).not.toContain('matched');
  });

  // The preamble calls this with --limit 3 and no query on every skill invocation
  // in every session. It must not grow a line.
  test('the no-query preamble path never emits a truncation notice', () => {
    const out = runRank(['--limit', '3']);
    expect(out).toContain('LEARNINGS: 3 loaded');
    expect(out).not.toContain('matched');
  });

  // The script ends with the bun stage's own stderr redirected to /dev/null, so
  // stdout is the only channel that can reach a caller at all. Assert the notice
  // is on it and that the process still succeeds.
  test('the truncation notice is delivered on stdout with a zero exit', () => {
    const res = spawnSync(BIN, ['--query', 'preflight project line'], {
      timeout: 30_000,
      env: { ...process.env, GSTACK_HOME: tmpHome },
      cwd: rankCwd,
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('10 of 13 matched');
  });

  // A stored internal field must never become a live sort key. The query filter is
  // the only writer, so on the no-query path -- which gstack-skill-start runs at
  // --limit 3 in every session -- an unstripped field would be read straight off
  // disk. gstack-learnings-log persists unknown keys, so this row is a shape the
  // supported writer can actually produce, not a hand-edit. The fixture plants the
  // current sort fields AND a name that does not exist yet, because the defense is
  // the underscore-namespace strip rather than a list of known fields.
  test('a stored internal field cannot hijack the no-query preamble ranking', () => {
    const ranked = rankedKeys(['--limit', '3']);
    expect(ranked).not.toContain('planted-token-hits');
    expect(ranked[0]).not.toBe('planted-token-hits');
  });

  // Relevance counts whole words, not substrings. Under /investigate's shipped
  // query shape, substring scoring gave prose containing "because"/"debug"/
  // "fixture" three free hits and buried the real answer below it.
  test('substring-only hits do not score, so incidental prose cannot outrank', () => {
    const ranked = rankedKeys(['--query', 'root cause hypothesis bug fix']);
    expect(ranked[0]).toBe('nested-whole-word-match');
    // Recall unchanged: the decoy still matches the substring filter and is returned.
    expect(ranked).toContain('nested-substring-decoy');
  });

  // Naming is weaker evidence than substance. A verbose key carrying four query
  // tokens must not outrank an insight that actually says one of them.
  test('a verbose key never outranks an insight that answers the query', () => {
    const ranked = rankedKeys(['--query', 'kappa lambda sigma omega']);
    expect(ranked[0]).toBe('plain-key');
    expect(ranked).toContain('kappa-lambda-sigma-omega-verbose-key');
  });

  // But naming is not worthless: on an insight tie it breaks the tie, ahead of
  // confidence. Without this tier an entry named exactly after the query loses to
  // incidental prose and can be truncated away.
  test('on an insight tie, key and file naming breaks it ahead of confidence', () => {
    expect(rankedKeys(['--query', 'tau rho xi'])).toEqual([
      'tau-rho-xi-named',  // insight 1, naming 3, confidence 2
      'unnamed-probe',     // insight 1, naming 0, confidence 8
    ]);
  });

  test('a query token found only in files scores as naming, below a real insight', () => {
    const ranked = rankedKeys(['--query', 'zulu yankee']);
    expect(ranked[0]).toBe('insight-carrier');
    expect(ranked).toContain('path-carrier');
  });

  test('a letter with an accent is a word character, so it does not fake a boundary', () => {
    const ranked = rankedKeys(['--query', 'psi']);
    expect(ranked[0]).toBe('ascii-neighbour');
  });

  // Repeating a word must not promote an entry matching fewer concepts. Asserted
  // as an OUTCOME, not by comparing two runs: a run-vs-run comparison cannot see
  // uniform score inflation, so it stays green when the dedup is deleted.
  test('a repeated query token cannot outrank an entry matching more concepts', () => {
    // Deduped: repeated-token-only scores 1 (nu), two-distinct-concepts scores 2.
    // Undeduped it would score 3 for the same one concept and take the lead, even
    // though it answers less of the query and the other row is the better match.
    expect(rankedKeys(['--query', 'nu nu nu omicron kirin'])).toEqual([
      'two-distinct-concepts',  // 2 distinct hits, confidence 2
      'repeated-token-only',    // 1 distinct hit, confidence 9
    ]);
  });
});
