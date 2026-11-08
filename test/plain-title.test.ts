/**
 * lib/plain-title.ts and bin/gstack-plain-title (R76): titles, branch names, PR
 * openings, changelog entries and commit subjects read in everyday words. The
 * fixtures are real squash subjects from main for 2026-10-31..2026-11-07, frozen
 * here without GitHub's " (#n)" squash suffix, since a PR title never carries it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { PLAIN_TITLE_POLICY_PATH, checkBranch, checkChangelogEntry, checkCommitSubject, checkOpening, checkTitle, loadPlainTitlePolicy, splitTitle, type PlainFinding } from '../lib/plain-title';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin/gstack-plain-title');
const policy = loadPlainTitlePolicy(ROOT)!;
const brief = (f: PlainFinding[]) => f.map(x => `${x.kind}:${x.match}`);

const MAIN_SUBJECTS: Array<[string, string[]]> = [
  ['Let the design lint check one section of a running app for crowded rows, cramped help text, loud notes and small tap targets', []],
  ['Outside reviews that mention a problem no longer pass as clean', []],
  ['fix(autoplan): bind rec_hash to its run and plan; keep legacy gates answerable (GST-1819)', ['scope-prefix:fix(autoplan):']],
  ['fix: /autoplan gate makes each phase publish in order after its report (GST-1814)', []],
  ['fix(outside-review): a check-results sign-off keeps the no-findings conclusion (#3469)', ['scope-prefix:fix(outside-review):']],
  ['fix(ship): record-ci reuses its own CI row at the same tree, run and selection (GST-1795)', ['scope-prefix:fix(ship):']],
  ['v1.98.0.0 release: fold the changelog fragments', []],
  ['ship tooling: post-review voices dispatch, same-tree pregate clears, fix-check p<N> ledgers (GST-1775)', ['term:voices', 'term:pregate', 'term:fix-check', 'term:ledgers']],
  ["feat: crew PRs carry their brief's Plan line; ship-queue ready and land check it (GST-1751)", []],
  ['Require the daemon secret and loopback Host/Origin on the design and iOS QA daemons', []],
  ["browse: keep tunnel-paired agents on web URLs and away from the daemon's disk", []],
  ['feat(diff-scope): template UI in .ts/.js counts as frontend; receipt records the static design pass (GST-1718)', ['scope-prefix:feat(diff-scope):', 'term:receipt']],
  ["fix: gstack's GitHub waits poll REST at most once a minute and wait out rate limits (GST-1713)", []],
  ['fix(ship-receipt): name the non-ancestor targeted-read commit in RECEIPT_INVALID (GST-1700)', ['scope-prefix:fix(ship-receipt):', 'term:receipt']],
  ['fix: release stamps and a docs-audit edit after the last fix-check are no gate-class edit (GST-1702)', ['term:fix-check']],
  ["fix(ship): a cleared remote gate for HEAD's exact tree satisfies a lane whose inventory refuses that tree (GST-1688)", ['scope-prefix:fix(ship):', 'term:lane']],
  ['fix: the receipt and the review plan agree on stamp and docs carry for review_targeted (GST-1689)', ['term:receipt']],
  ['Capy session: defer the upgrade while a /ship or review run is open; upgrade-path fixes (GST-1677, GST-1658)', []],
  ['Playwright 1.65.0: bundled Chromium 158 drops the distrusted eMudhra root (#3338)', []],
  ['changelog.d: a second GST-1631 fragment names what the audit redaction does not cover yet (GST-1635)', ['code:GST-1631']],
  ['ship finish chains granted fix-check rows; a pregate rerun at the same tree keeps its clears (GST-1627)', ['term:pregate', 'term:fix-check']],
  ['release: daily stable check: important gated changes reach stable within a day, forced cut at 7 days (GST-1646, R74)', []],
];

describe('checkTitle', () => {
  test.each(MAIN_SUBJECTS)('main subject: %s', (subject, expected) => {
    expect(brief(checkTitle(subject, policy))).toEqual(expected);
  });

  test("R76's example passes with and without one trailing issue code", () => {
    const good = "Stop gstack from hitting GitHub's rate limit while it waits on PRs";
    expect(checkTitle(good, policy)).toEqual([]);
    expect(checkTitle(`${good} (GST-1713)`, policy)).toEqual([]);
    expect(checkTitle(`${good} (GST-1808, GST-1809)`, policy)).toEqual([]);
    expect(checkTitle(`${good} (#4122)`, policy)).toEqual([]);
  });

  test('a code in the front is refused, wherever it sits', () => {
    const f = checkTitle("Stop GST-1713 from hitting GitHub's rate limit", policy);
    expect(f).toEqual([{ code: 'PLAIN_TITLE_REFUSED', kind: 'code', match: 'GST-1713', hint: expect.any(String) }]);
    expect(brief(checkTitle('Apply R76 to titles (GST-1825)', policy))).toEqual(['code:R76']);
    expect(brief(checkTitle('GSTA-36 lands PRs alone', policy))).toEqual(['code:GSTA-36']);
  });

  test("GitHub's squash suffix is a second group, so a code before it stays in the front", () => {
    expect(brief(checkTitle('Fix the wait loop (GST-1713) (#4109)', policy))).toEqual(['code:GST-1713']);
  });

  test('UTF-8 and Cloudflare R2 are not read as codes', () => {
    expect(checkTitle('Store UTF-8 uploads in Cloudflare R2', policy)).toEqual([]);
  });

  test('allow entries suppress only the match they contain', () => {
    const p = { ...policy, allow: [...policy.allow, { text: 'merge train', reason: 'test' }] };
    expect(checkTitle('Speed up the merge train', p)).toEqual([]);
    expect(brief(checkTitle('Speed up the train', p))).toEqual(['term:train']);
  });

  test('terms match whole words, case-insensitive, multi-word terms included', () => {
    expect(brief(checkTitle('Ask the Outside  Voice once', policy))).toEqual(['term:Outside  Voice']);
    expect(checkTitle('Training runs no longer time out', policy)).toEqual([]);
    expect(brief(checkTitle('Report to the CAPTAIN', policy))).toEqual(['term:CAPTAIN']);
  });

  test('a scope prefix is refused; a bare type prefix and a version prefix are allowed', () => {
    expect(brief(checkTitle('docs(readme): explain setup', policy))).toEqual(['scope-prefix:docs(readme):']);
    expect(checkTitle('fix: explain setup', policy)).toEqual([]);
    expect(checkTitle('docs: explain setup', policy)).toEqual([]);
    expect(checkTitle('v1.98.0.0 release', policy)).toEqual([]);
  });

  test('a credential in a refused title is masked in the finding, so no printed line carries it', () => {
    const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const [f] = checkTitle(`fix(${key}): explain setup`, policy);
    expect(f?.kind).toBe('scope-prefix');
    expect(f?.match).not.toContain(key);
  });

  test('a credential the redactor cannot mask in place prints as a fixed placeholder, never the raw match', () => {
    const header = '-----BEGIN ' + 'PRIVATE KEY-----';
    const [f] = checkTitle(`fix(${header}): explain setup`, policy);
    expect(f?.kind).toBe('scope-prefix');
    expect(f?.match).toBe('<REDACTED>');
  });

  test('the titles gstack generates pass', () => {
    expect(checkTitle('v1.98.0.0 release', policy)).toEqual([]);
    expect(checkTitle('Add a changelog entry for changes merged by hand next to #4122', policy)).toEqual([]);
    expect(checkTitle('Merge 2 related changes together (#4120, #4121)', policy)).toEqual([]);
  });

  test('splitTitle keeps only a trailing group made of references', () => {
    expect(splitTitle('Fix waits (GST-1713)')).toEqual({ front: 'Fix waits', refs: 'GST-1713' });
    expect(splitTitle('Fix waits (#4122, R76)')).toEqual({ front: 'Fix waits', refs: '#4122, R76' });
    expect(splitTitle('Fix waits (on macOS)')).toEqual({ front: 'Fix waits (on macOS)', refs: null });
    expect(splitTitle('Fix waits')).toEqual({ front: 'Fix waits', refs: null });
  });

  test('commit subjects use the title rule under their own code', () => {
    expect(checkCommitSubject('fix(ship): pregate', policy).map(f => f.code)).toEqual(['PLAIN_COMMIT_REFUSED', 'PLAIN_COMMIT_REFUSED']);
  });
});

describe('checkBranch', () => {
  test('one trailing code is fine; a code in front is refused; generated branches are exempt', () => {
    expect(checkBranch('capy/github-rate-limit-gst-1713', policy)).toEqual([]);
    expect(checkBranch('capy/plain-english-pr-titles-gst-1825', policy)).toEqual([]);
    expect(brief(checkBranch('capy/gst-1814-autoplan-gate-order', policy))).toEqual(['code:gst-1814']);
    expect(checkBranch('release/1.98.0.0', policy)).toEqual([]);
    expect(checkBranch('wave/ab12-r12', policy)).toEqual([]);
    expect(checkBranch('gstack-land-repair/4122', policy)).toEqual([]);
  });

  test('hyphens and underscores separate words', () => {
    expect(brief(checkBranch('capy/fix-check-loop', policy))).toEqual(['term:fix check']);
    expect(brief(checkBranch('capy/faster_pregate', policy))).toEqual(['term:pregate']);
    expect(checkBranch('capy/r2-uploads_r76', policy)).toEqual([]);
    expect(checkBranch('capy/trainings-page', policy)).toEqual([]);
  });

  test("the exempt prefixes are the ones gstack's own tools generate", () => {
    const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    expect(src('lib/release-stamp.ts')).toContain('`release/${version}`');
    expect(src('crew/lib/ship-queue-wave.ts')).toContain("startsWith('wave/')");
    expect(src('lib/ship-queue-land.ts')).toContain('`gstack-land-repair/${j.pr}`');
    expect(policy.exempt_branch_prefixes).toEqual(['release/', 'wave/', 'gstack-land-repair/']);
  });
});

describe('checkOpening', () => {
  const NOTES = '<!-- gstack:agent-notes -->\n<details><summary>Agent notes</summary>\n\n```gstack-ship-receipt\n{"pr": 1}\n```\nRefs: GST-1713, pregate receipts\n\n</details>\n';

  test('two plain sentences pass, and the Agent notes section is never read', () => {
    const body = '\n\nWaits on GitHub now poll at most once a minute. This keeps gstack from hitting rate limits.\n\n## What changed\n\nGST-1713 pregate\n\n';
    expect(checkOpening(body, policy)).toEqual([]);
    expect(checkOpening(`${body}${NOTES}`, policy)).toEqual([]);
  });

  test('a receipt fence, heading, list, table, HTML or image first is refused', () => {
    for (const [first, shape] of [['```gstack-ship-receipt\n{}\n```', 'fenced block'], ['## Summary', 'heading'], ['- one', 'list'], ['| a | b |', 'table'], ['<details>', 'HTML'], ['![shot](x.png)', 'image']]) {
      expect(brief(checkOpening(`${first}\n\nPlain words.\n`, policy))).toEqual([`opening-shape:${shape} first`]);
    }
    expect(brief(checkOpening(NOTES, policy))).toEqual(['opening-shape:no opening paragraph']);
  });

  test('more than two sentences, or a code or term in the opening, is refused', () => {
    expect(brief(checkOpening('One thing. Two things. Three things.', policy))).toEqual(['opening-shape:3 sentences']);
    expect(checkOpening('This changes the setup, e.g. the default. It is plain.', policy)).toEqual([]);
    expect(brief(checkOpening('The pregate clears faster (GST-1713).', policy))).toEqual(['code:GST-1713', 'term:pregate']);
  });

  test('a marker quoted inline in the opening does not end it; only the section marker on its own line does', () => {
    const opening = 'Readers find the `<!-- gstack:agent-notes -->` section at the end. It holds the checks. It stays collapsed.\n\n';
    expect(brief(checkOpening(opening + NOTES, policy))).toEqual(['opening-shape:3 sentences']);
  });
});

describe('checkChangelogEntry', () => {
  test('no code anywhere; terms only in the bold lead; code spans, URLs and quotes skipped', () => {
    expect(brief(checkChangelogEntry('**The plan check works on public repos (GST-1774).** It reads the record.', policy))).toEqual(['code:GST-1774']);
    expect(checkChangelogEntry('**The plan check works on public repos.** The receipt and the train now agree.', policy)).toEqual([]);
    expect(brief(checkChangelogEntry('**A faster pregate.** Plain words.', policy))).toEqual(['term:pregate']);
    expect(brief(checkChangelogEntry('**Plain lead.** Fixed in GST-12.', policy))).toEqual(['code:GST-12']);
    expect(checkChangelogEntry('**Plain lead "pregate".** See `GST-12` and https://example.com/GST-12.\n\n```\nGST-13\n```\n', policy)).toEqual([]);
  });
});

describe('policy', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plain-title-'));
  const withPolicy = (text: string) => { const dir = tmp(); fs.mkdirSync(path.join(dir, '.gstack')); fs.writeFileSync(path.join(dir, PLAIN_TITLE_POLICY_PATH), text); return dir; };

  test('no policy file means no findings anywhere', () => {
    expect(loadPlainTitlePolicy(tmp())).toBeNull();
    expect(checkTitle('fix(ship): pregate GST-1', null)).toEqual([]);
    expect(checkBranch('capy/gst-1-pregate', null)).toEqual([]);
    expect(checkOpening('## heading', null)).toEqual([]);
    expect(checkChangelogEntry('**GST-1 pregate**', null)).toEqual([]);
    expect(checkCommitSubject('GST-1', null)).toEqual([]);
  });

  test('an invalid policy throws with the bad key named', () => {
    const base = { codes: ['\\bX-\\d+\\b'], terms: ['a'], allow: [], since: '2026-11-08', exempt_branch_prefixes: [] };
    expect(() => loadPlainTitlePolicy(withPolicy('{'))).toThrow(/not valid JSON/);
    expect(() => loadPlainTitlePolicy(withPolicy(JSON.stringify({ ...base, codes: ['('] })))).toThrow(/codes\[0\] is not a valid regex/);
    expect(() => loadPlainTitlePolicy(withPolicy(JSON.stringify({ ...base, codes: ['x?'] })))).toThrow(/matches empty text/);
    expect(() => loadPlainTitlePolicy(withPolicy(JSON.stringify({ ...base, allow: [{ text: 'R2' }] })))).toThrow(/allow\[0\]\.reason/);
    expect(() => loadPlainTitlePolicy(withPolicy(JSON.stringify({ ...base, since: 'soon' })))).toThrow(/since/);
    expect(() => loadPlainTitlePolicy(withPolicy(JSON.stringify({ ...base, extra: 1 })))).toThrow(/extra is not a known key/);
    expect(loadPlainTitlePolicy(withPolicy(JSON.stringify(base)))).toEqual(base);
  });

  test("gstack's policy loads and every allow entry says why", () => {
    expect(PLAIN_TITLE_POLICY_PATH).toBe('.gstack/plain-titles.json');
    expect(policy.since).toBe('2026-11-08');
    expect(policy.allow.length).toBeGreaterThan(0);
    for (const a of policy.allow) expect(a.reason.length).toBeGreaterThan(10);
  });
});

describe('bin/gstack-plain-title', () => {
  const dirs = { policy: fs.mkdtempSync(path.join(os.tmpdir(), 'plain-title-bin-')), none: fs.mkdtempSync(path.join(os.tmpdir(), 'plain-title-bin-')), invalid: fs.mkdtempSync(path.join(os.tmpdir(), 'plain-title-bin-')) };
  fs.mkdirSync(path.join(dirs.policy, '.gstack'));
  fs.copyFileSync(path.join(ROOT, PLAIN_TITLE_POLICY_PATH), path.join(dirs.policy, PLAIN_TITLE_POLICY_PATH));
  fs.mkdirSync(path.join(dirs.invalid, '.gstack'));
  fs.writeFileSync(path.join(dirs.invalid, PLAIN_TITLE_POLICY_PATH), '{"codes": [}');
  const run = (dir: string, args: string[]) => {
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), BIN, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
    const lines = r.stdout.trim().split('\n');
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: lines[lines.length - 1] };
  };
  const file = (name: string, text: string) => { const f = path.join(dirs.policy, name); fs.writeFileSync(f, text); return f; };

  test('a refused title exits 1 with one line per finding and never echoes the title', () => {
    const r = run(dirs.policy, ['check', '--title', 'fix(ship): the pregate secret-words-here']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PLAIN_TITLE: PLAIN_TITLE_REFUSED scope-prefix "fix(ship):" — ');
    expect(r.stdout).toContain('PLAIN_TITLE: PLAIN_TITLE_REFUSED term "pregate" — ');
    expect(r.stdout).not.toContain('secret-words-here');
    expect(r.last).toBe('PLAIN_TITLE: refused=2');
  });

  test('a plain title and branch exit 0 with ok', () => {
    const r = run(dirs.policy, ['check', '--title-file', file('t.txt', "Stop gstack from hitting GitHub's rate limit (GST-1713)\n"), '--branch', 'capy/github-rate-limit-gst-1713']);
    expect([r.status, r.last]).toEqual([0, 'PLAIN_TITLE: ok']);
  });

  test('warn mode and commit subjects only warn', () => {
    const warn = run(dirs.policy, ['check', '--branch', 'capy/gst-1814-autoplan-gate-order', '--body-file', file('b.md', '## Heading\n'), '--mode', 'warn']);
    expect([warn.status, warn.last]).toEqual([0, 'PLAIN_TITLE: warned=2']);
    const commits = run(dirs.policy, ['check', '--title', 'Plain title', '--commits-file', file('c.txt', 'fix(ship): pregate\nPlain subject\n\n')]);
    expect([commits.status, commits.last]).toEqual([0, 'PLAIN_TITLE: warned=2']);
    expect(commits.stdout).toContain('(warning only)');
    const both = run(dirs.policy, ['check', '--title', 'pregate', '--commits-file', file('c2.txt', 'GST-1 done\n')]);
    expect([both.status, both.last]).toEqual([1, 'PLAIN_TITLE: refused=1 warned=1']);
  });

  test('a changelog entry is checked', () => {
    const r = run(dirs.policy, ['check', '--changelog', file('frag.md', '**Plain lead (GST-1774).**\n')]);
    expect([r.status, r.last]).toEqual([1, 'PLAIN_TITLE: refused=1']);
  });

  test('a PR created before since is exempt; no policy is none', () => {
    expect(run(dirs.policy, ['check', '--title', 'pregate', '--created-at', '2026-11-01T10:00:00Z'])).toMatchObject({ status: 0, last: 'PLAIN_TITLE: exempt (created before 2026-11-08)' });
    expect(run(dirs.policy, ['check', '--title', 'pregate', '--created-at', '2026-11-08T10:00:00Z']).status).toBe(1);
    expect(run(dirs.none, ['check', '--title', 'pregate GST-1'])).toMatchObject({ status: 0, last: 'PLAIN_TITLE: none (no policy)' });
  });

  test('an invalid policy exits 3; usage errors exit 2', () => {
    const bad = run(dirs.invalid, ['check', '--title', 'x']);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain('(PLAIN_POLICY_INVALID)');
    expect(run(dirs.invalid, ['validate']).status).toBe(3);
    expect(run(dirs.policy, ['check']).status).toBe(2);
    expect(run(dirs.policy, ['check', '--nope']).status).toBe(2);
    expect(run(dirs.policy, ['check', '--title', 'x', '--mode', 'loud']).status).toBe(2);
    expect(run(dirs.policy, ['check', '--title', 'x', '--title-file', 'y']).status).toBe(2);
    expect(run(dirs.policy, ['frobnicate']).status).toBe(2);
  });

  test('--json, validate, init and --help', () => {
    const j = run(dirs.policy, ['check', '--title', 'pregate', '--json']);
    expect(j.status).toBe(1);
    expect(JSON.parse(j.stdout)).toMatchObject({ status: 'refused=1', refused: 1, warned: 0, findings: [{ code: 'PLAIN_TITLE_REFUSED', kind: 'term', match: 'pregate', severity: 'refused' }] });
    expect(run(dirs.policy, ['validate'])).toMatchObject({ status: 0, last: expect.stringMatching(/^PLAIN_TITLE: valid \.gstack\/plain-titles\.json/) });
    expect(run(dirs.none, ['validate'])).toMatchObject({ status: 0, last: 'PLAIN_TITLE: none (no policy)' });
    expect(run(dirs.policy, ['init']).status).toBe(1);
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-title-bin-'));
    expect(run(fresh, ['init']).status).toBe(0);
    expect(loadPlainTitlePolicy(fresh)).not.toBeNull();
    expect(run(dirs.policy, ['--help']).stdout).toContain('Exit codes: 0 ok');
  });
});
