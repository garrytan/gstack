/**
 * factory-scorecard (free): the window's merged PRs, lead times, gate runs with
 * known cost, red-train rate, flaky events, issues and releases, computed from
 * recorded gh responses (test/fixtures/factory-scorecard/recorded.json); an
 * unreadable input marks its lines unavailable and the rest still print; the
 * bin writes the table, the CSV and the JSON without touching the network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BENCHMARKS, DEFAULTS, classifyGate, collectScorecard, fixtureSource, flakeRecords, fmtHours, gateOutcome, inWindow, passCount, percentile, readComments, renderCsv,
  renderMarkdown, scorecardRows, searchRange, verdictCost, type FixtureFile, type ScorecardOptions,
} from '../lib/factory-scorecard';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'factory-scorecard', 'recorded.json');
const BIN = path.join(ROOT, 'bin', 'gstack-factory-scorecard');
const NOW = Date.parse('2026-10-26T12:00:00Z');

const tmp: string[] = [];
afterEach(() => { for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-scorecard-test-')); tmp.push(dir); return dir; };

const fixture = (): FixtureFile => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const options = (over: Partial<ScorecardOptions> = {}): ScorecardOptions => ({
  repo: 'acme/widgets', base: DEFAULTS.base, now: NOW, sinceDays: DEFAULTS.sinceDays, crew: null, gateWorkflow: DEFAULTS.gateWorkflow,
  gateEvent: DEFAULTS.gateEvent, freeWorkflow: DEFAULTS.freeWorkflow, trainPrefix: DEFAULTS.trainPrefix,
  readyMarker: new RegExp(DEFAULTS.readyMarker, 'm'), passMarker: new RegExp(DEFAULTS.passMarker, 'm'), passCap: DEFAULTS.passCap,
  maxArtifactRuns: DEFAULTS.maxArtifactRuns, ...over,
});
const byId = (rows: ReturnType<typeof scorecardRows>) => Object.fromEntries(rows.map(r => [r.id, r.value]));

describe('factory-scorecard: recorded window', () => {
  test('merged PRs, lead times, gates, cost, trains, flakes, issues and releases from the recorded responses', () => {
    const source = fixtureSource(fixture(), scratch());
    const card = collectScorecard(source, options());
    expect(card.unavailable).toEqual([]);
    expect(card.prs.map(p => p.number)).toEqual([101, 103, 102]);
    expect(card.prs.map(p => p.crew)).toEqual([true, true, false]);
    expect(card.prs.find(p => p.number === 101)!.readyAt).toBe('2026-10-24T16:00:00Z');
    expect(card.prs.find(p => p.number === 101)!.commentCostUsd).toBe(12.5);
    expect(card.prs.find(p => p.number === 102)!.readyAt).toBeNull();
    expect(card.prs.map(p => p.passes)).toEqual([2, 3, null]);
    expect(card.gates.map(g => [g.id, g.kind, g.outcome, g.costUsd, g.costSource, g.flakes])).toEqual([
      [9004, 'backstop', 'cancelled', null, null, 0],
      [9003, 'screen', 'green', 12.5, 'comment', 0],
      [9002, 'train', 'red', null, null, 0],
      [9001, 'train', 'green', 30.5, 'artifact', 2],
    ]);
    expect(card.gates.find(g => g.id === 9001)!.flakeRerunUsd).toBe(1.1);
    expect(card.freeRuns.map(r => [r.id, r.retries])).toEqual([[8003, 0], [8002, 0], [8001, 2]]);
    expect([card.issuesOpened, card.issuesClosed]).toEqual([5, 7]);
    expect(card.releases).toEqual([{ tag: 'v1.0.0', publishedAt: '2026-10-23T07:00:00Z' }]);

    const values = byId(scorecardRows(card));
    expect(values.merged).toBe('3 (crew 2, outside 1)');
    expect(values.lead_time).toBe('median 8.0h, p90 5.0d');
    expect(values.ready_to_merge).toBe('median 1.0h, p90 2.0h (2 of 3 PRs with a READY comment)');
    expect(values.review_passes).toBe('median 2, p90 3 (2 of 3 PRs report a pass count; 1 at the cap of 3)');
    expect(values.gates).toBe('2 / 1 / 1; known cost $43.00 on 2 of 4 runs');
    expect(values.cost_per_merge).toBe('$14.33 (2 runs without a known cost)');
    expect(values.red_train).toBe('50% (1 red of 2 trains; 0 red backstop, 0 red screens)');
    expect(values.flaky).toBe('2 paid case(s) passed on their one rerun (rerun spend $1.10); 2 free-suite retries in 1 of 3 runs');
    expect(values.issues).toBe('5 / 7');
    expect(values.releases).toBe('1 (v1.0.0)');
  });

  test('a crew login list overrides the author_association rule', () => {
    const card = collectScorecard(fixtureSource(fixture(), scratch()), options({ crew: ['Alice'] }));
    expect(byId(scorecardRows(card)).merged).toBe('3 (crew 1, outside 2)');
  });

  test('a run older than the window, a non-dispatch event and a draft release are left out; the page stops once older than the window', () => {
    const source = fixtureSource(fixture(), scratch());
    const card = collectScorecard(source, options());
    expect(card.gates.map(g => g.id)).not.toContain(9000);
    expect(card.gates.map(g => g.id)).not.toContain(9005);
    expect(card.releases.map(r => r.tag)).not.toContain('v1.1.0');
    expect(source.calls.filter(c => c.includes('/pulls?'))).toHaveLength(1);
  });

  test('a full page inside the window reads the next page; a full page whose oldest update predates the window does not', () => {
    // Value: protects=the PR paging loop continues past page 1 only while the page is full and still inside the window; fails_when=the break condition stops after one page or ignores the oldest update; why_new=the recorded fixture never fills a page, so the continue branch was untested; seam=none; no_claim=none beyond protects
    const pullsKey = (page: number) => `repos/acme/widgets/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`;
    const page = (first: number, updatedAt: string) => Array.from({ length: 100 }, (_, i) => ({ number: first + i, title: `pr ${first + i}`, user: { login: 'alice' }, author_association: 'MEMBER',
      created_at: '2026-10-24T00:00:00Z', merged_at: '2026-10-25T00:00:00Z', updated_at: updatedAt }));
    const withPages = (oldest: string) => {
      const fx = fixture();
      fx.responses[pullsKey(1)] = page(1000, oldest);
      fx.responses[pullsKey(2)] = page(2000, oldest).slice(0, 5);
      for (let n = 1000; n < 1100; n++) fx.responses[`repos/acme/widgets/issues/${n}/comments?per_page=100&page=1`] = [];
      for (let n = 2000; n < 2005; n++) fx.responses[`repos/acme/widgets/issues/${n}/comments?per_page=100&page=1`] = [];
      return fx;
    };
    const inWindow = fixtureSource(withPages('2026-10-25T00:00:00Z'), scratch());
    expect(collectScorecard(inWindow, options()).prs).toHaveLength(105);
    expect(inWindow.calls.filter(c => c.includes('/pulls?'))).toHaveLength(2);
    const stale = fixtureSource(withPages('2026-10-01T00:00:00Z'), scratch());
    expect(collectScorecard(stale, options()).prs).toHaveLength(100);
    expect(stale.calls.filter(c => c.includes('/pulls?'))).toHaveLength(1);
  });

  test('a PR comment cost backs one gate run per PR; the gate-run read failing marks only its lines unavailable', () => {
    // Value: protects=two artifact-less gate runs on one PR do not both copy the PR's comment cost into known cost; fails_when=the once-per-PR guard is removed; why_new=review found the fallback keyed by PR number only; seam=none; no_claim=none beyond protects
    const fx = fixture();
    const runsKey = Object.keys(fx.responses).find(k => k.includes('/actions/workflows/evals.yml/runs?') && k.includes('event=workflow_dispatch'))!;
    const body = fx.responses[runsKey] as { workflow_runs: any[] };
    const screen = body.workflow_runs.find(r => r.id === 9003)!;
    body.workflow_runs.push({ ...screen, id: 9006, created_at: '2026-10-25T13:00:00Z' });
    const card = collectScorecard(fixtureSource(fx, scratch()), options());
    expect(card.gates.filter(g => g.id === 9003 || g.id === 9006).map(g => [g.pr, g.costSource])).toEqual([[101, 'comment'], [101, null]]);
    expect(byId(scorecardRows(card)).gates).toBe('3 / 1 / 1; known cost $43.00 on 2 of 5 runs');
    const broken = fixture();
    delete broken.responses[runsKey];
    const noGates = collectScorecard(fixtureSource(broken, scratch()), options());
    expect(noGates.unavailable).toHaveLength(1);
    expect(noGates.unavailable[0]).toStartWith('gate runs: ');
    const values = byId(scorecardRows(noGates));
    expect(values.gates).toStartWith('unavailable (');
    expect(values.red_train).toStartWith('unavailable (');
    expect(values.merged).toBe('3 (crew 2, outside 1)');
  });

  test('--now closes the window: a PR, gate run, free run or release at or after now is left out, and the runs and issue queries carry the end', () => {
    // Value: protects=every windowed line counts [now - since-days, now) only, so a past window counts nothing that happened after it; fails_when=a read filters on the window start alone or a query drops the end bound; why_new=GST-135: --now 2026-10-15 counted 290 merged PRs (every merge through the 2026-10-30 run) against 65 in the window, and the gate and release lines ignored --now; seam=none; no_claim=GitHub's server-side date filters, which the reads re-check per item
    const fx = fixture();
    const key = (part: string) => Object.keys(fx.responses).find(k => k.includes(part))!;
    (fx.responses[key('/pulls?')] as any[]).unshift({ number: 106, title: 'merged at the window end', user: { login: 'garry' }, author_association: 'OWNER',
      created_at: '2026-10-26T10:00:00Z', merged_at: '2026-10-26T12:00:00Z', updated_at: '2026-10-26T13:00:00Z', base: { ref: 'main' } });
    fx.responses['repos/acme/widgets/issues/106/comments?per_page=100&page=1'] = [];
    const gateRuns = fx.responses[key('/evals.yml/runs?')] as { workflow_runs: any[] };
    gateRuns.workflow_runs.unshift({ ...gateRuns.workflow_runs.find(r => r.id === 9002), id: 9007, conclusion: 'success', created_at: '2026-10-26T12:30:00Z' });
    const freeRuns = fx.responses[key('/free-tests.yml/runs?')] as { workflow_runs: any[] };
    freeRuns.workflow_runs.unshift({ ...freeRuns.workflow_runs[0], id: 8004, created_at: '2026-10-26T13:00:00Z' });
    (fx.responses[key('/releases?')] as any[]).unshift({ tag_name: 'v1.2.0', draft: false, prerelease: false, published_at: '2026-10-26T12:00:00Z' });
    const source = fixtureSource(fx, scratch());
    const card = collectScorecard(source, options());
    expect(card.unavailable).toEqual([]);
    expect(card.prs.map(p => p.number)).toEqual([101, 103, 102]);
    expect(card.gates.map(g => g.id)).toEqual([9004, 9003, 9002, 9001]);
    expect(card.freeRuns.map(r => r.id)).toEqual([8003, 8002, 8001]);
    expect(card.releases.map(r => r.tag)).toEqual(['v1.0.0']);
    const values = byId(scorecardRows(card));
    expect(values.merged).toBe('3 (crew 2, outside 1)');
    expect(values.lead_time).toBe('median 8.0h, p90 5.0d');
    expect(values.gates).toBe('2 / 1 / 1; known cost $43.00 on 2 of 4 runs');
    expect(values.releases).toBe('1 (v1.0.0)');
    for (const workflow of ['/evals.yml/runs?', '/free-tests.yml/runs?']) {
      expect(decodeURIComponent(source.calls.find(c => c.includes(workflow))!)).toContain('created=2026-10-19..2026-10-26');
    }
    const searches = source.calls.filter(c => c.startsWith('search/issues')).map(decodeURIComponent);
    expect(searches).toEqual([
      'search/issues?q=repo:acme/widgets is:issue created:2026-10-19T12:00:00Z..2026-10-26T11:59:59Z&per_page=1',
      'search/issues?q=repo:acme/widgets is:issue closed:2026-10-19T12:00:00Z..2026-10-26T11:59:59Z&per_page=1',
    ]);
  });

  test('a past window pages past newer releases, and a read that runs past the page cap is unavailable instead of partial', () => {
    // Value: protects=a past window still finds its releases behind a full page of newer ones, and a PR read that never reaches the window start reports unavailable rather than a short count; fails_when=releases read page 1 only again or the PR loop exits at MAX_PAGES without throwing; why_new=adversarial review of GST-135 found both truncations silent for past windows; seam=none; no_claim=GitHub's ordering of releases beyond newest-first
    const fx = fixture();
    const releasesKey = (page: number) => `repos/acme/widgets/releases?per_page=100&page=${page}`;
    const recorded = fx.responses[releasesKey(1)] as any[];
    fx.responses[releasesKey(1)] = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v2.0.${i}`, draft: false, prerelease: false, published_at: '2026-10-27T00:00:00Z' }));
    fx.responses[releasesKey(2)] = recorded;
    expect(collectScorecard(fixtureSource(fx, scratch()), options()).releases.map(r => r.tag)).toEqual(['v1.0.0']);
    const pullsKey = (page: number) => `repos/acme/widgets/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`;
    const capped = fixture();
    for (let page = 1; page <= 20; page++) {
      capped.responses[pullsKey(page)] = Array.from({ length: 100 }, (_, i) => ({ number: page * 1000 + i, title: 'closed without merge', user: { login: 'garry' },
        author_association: 'OWNER', created_at: '2026-10-25T00:00:00Z', merged_at: null, updated_at: '2026-10-25T00:00:00Z' }));
    }
    const card = collectScorecard(fixtureSource(capped, scratch()), options());
    expect(card.unavailable).toHaveLength(1);
    expect(card.unavailable[0]).toStartWith('merged PRs: PRs updated since 2026-10-19T12:00:00.000Z ran past 20 pages of 100');
    expect(byId(scorecardRows(card)).merged).toStartWith('unavailable (');
  });

  test('gate-run and release reads past the page cap are unavailable, and a release published late is found on a later page', () => {
    // Value: protects=the gate, cost and red-train lines and the releases line report unavailable instead of a short count, and a draft published inside the window counts wherever it sits in GitHub's creation order; fails_when=either loop exits at MAX_PAGES without throwing, or release paging stops on a page's oldest publication again; why_new=review of GST-135 found only the merged-PR cap tested and the release stop relying on publication order; seam=none; no_claim=GitHub's 1,000-result limit on filtered workflow-run lists
    const fx = fixture();
    const releasesKey = (page: number) => `repos/acme/widgets/releases?per_page=100&page=${page}`;
    fx.responses[releasesKey(1)] = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.9.${i}`, draft: false, created_at: '2026-10-01T00:00:00Z', published_at: '2026-10-02T00:00:00Z' }));
    fx.responses[releasesKey(2)] = [{ tag_name: 'v0.1.0', draft: false, created_at: '2026-09-01T00:00:00Z', published_at: '2026-10-20T00:00:00Z' }];
    expect(collectScorecard(fixtureSource(fx, scratch()), options()).releases.map(r => r.tag)).toEqual(['v0.1.0']);
    const capped = fixture();
    const runsKey = Object.keys(capped.responses).find(k => k.includes('/evals.yml/runs?'))!.replace(/page=1$/, 'page=');
    const run = (capped.responses[runsKey + '1'] as any).workflow_runs[0];
    for (let page = 1; page <= 20; page++) {
      capped.responses[runsKey + page] = { workflow_runs: Array.from({ length: 100 }, (_, i) => ({ ...run, id: page * 1000 + i })) };
      capped.responses[releasesKey(page)] = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v${page}.${i}`, draft: false, published_at: '2026-10-27T00:00:00Z' }));
    }
    const card = collectScorecard(fixtureSource(capped, scratch()), options());
    expect(card.unavailable.some(u => u.startsWith('gate runs: gate runs in the window ran past 20 pages of 100'))).toBe(true);
    expect(card.unavailable.some(u => u.startsWith('releases: releases published since 2026-10-19T12:00:00.000Z ran past 20 pages of 100'))).toBe(true);
    const values = byId(scorecardRows(card));
    expect(values.gates).toStartWith('unavailable (');
    expect(values.releases).toStartWith('unavailable (');
  });

  test('--max-artifact-runs caps artifact reads: later runs count without cost or flake data', () => {
    const card = collectScorecard(fixtureSource(fixture(), scratch()), options({ maxArtifactRuns: 2 }));
    expect(card.artifactRunsRead).toBe(2);
    expect(card.gates.find(g => g.id === 9001)!.costUsd).toBeNull();
    expect(card.gates.find(g => g.id === 9001)!.flakes).toBe(0);
    expect(byId(scorecardRows(card)).gates).toBe('2 / 1 / 1; known cost $12.50 on 1 of 4 runs');
  });

  test('an unreadable input marks only its lines unavailable, with the reason, and the rest still print', () => {
    const fx = fixture();
    for (const key of Object.keys(fx.responses)) if (key.startsWith('search/issues')) delete fx.responses[key];
    const card = collectScorecard(fixtureSource(fx, scratch()), options());
    expect(card.unavailable).toHaveLength(1);
    expect(card.unavailable[0]).toStartWith('issues: ');
    const values = byId(scorecardRows(card));
    expect(values.issues).toStartWith('unavailable (');
    expect(values.merged).toBe('3 (crew 2, outside 1)');
    expect(renderMarkdown(card, scorecardRows(card))).toContain('Unavailable inputs: issues: ');
  });

  test('markdown and CSV carry every row with its benchmark and counting rule', () => {
    const card = collectScorecard(fixtureSource(fixture(), scratch()), options());
    const rows = scorecardRows(card);
    expect(rows.map(r => r.id)).toEqual(Object.keys(BENCHMARKS));
    const md = renderMarkdown(card, rows);
    expect(md).toStartWith('## Factory scorecard: acme/widgets (2026-10-19 to 2026-10-26, 7 days)');
    expect(md).toContain('| Metric | This window | One of the best factories would show | Counting rule |');
    expect(md).toContain('| Red-train rate | 50% (1 red of 2 trains; 0 red backstop, 0 red screens) | under 5% of trains red');
    const csv = renderCsv(card, rows).split('\n');
    expect(csv[0]).toBe('repo,window_start,window_end,metric_id,metric,value,benchmark,rule');
    expect(csv).toHaveLength(rows.length + 2);
    expect(csv[1]).toStartWith('"acme/widgets","2026-10-19T12:00:00.000Z","2026-10-26T12:00:00.000Z","merged","Merged PRs","3 (crew 2, outside 1)"');
  });

  test('--gate-event any keeps non-dispatch runs and drops the event filter from the query', () => {
    // Value: protects=gateEvent null counts every completed gate run and omits event= from the runs query; fails_when=the null branch filters or the query keeps event=; why_new=only the default dispatch path was covered; seam=none; no_claim=live GitHub query semantics
    const fx = fixture();
    const key = Object.keys(fx.responses).find(k => k.includes('/evals.yml/runs?'))!;
    fx.responses[key.replace('&event=workflow_dispatch', '')] = fx.responses[key];
    const source = fixtureSource(fx, scratch());
    const card = collectScorecard(source, options({ gateEvent: null }));
    expect(source.calls.find(c => c.includes('/evals.yml/runs?'))).not.toContain('event=');
    expect(card.gates.map(g => g.id)).toEqual([9005, 9004, 9003, 9002, 9001]);
    expect(card.gates.find(g => g.id === 9005)!.kind).toBe('other');
  });

  test('an empty window prints n/a on every ratio instead of NaN, and short durations read as minutes', () => {
    // Value: protects=zero merges and zero trains render n/a and sub-hour lead times render as minutes; fails_when=a 0/0 guard is removed or fmtHours loses a branch; why_new=every other case has merges and hour-scale durations; seam=none; no_claim=none beyond protects
    const fx = fixture();
    for (const key of Object.keys(fx.responses)) {
      if (key.includes('/pulls?') || key.includes('/releases?')) fx.responses[key] = [];
      else if (key.includes('/runs?')) fx.responses[key] = { total_count: 0, workflow_runs: [] };
      else if (key.startsWith('search/issues')) fx.responses[key] = { total_count: 0, items: [] };
    }
    const card = collectScorecard(fixtureSource(fx, scratch()), options());
    const values = byId(scorecardRows(card));
    expect(card.unavailable).toEqual([]);
    expect(values.merged).toBe('0 (crew 0, outside 0)');
    expect(values.lead_time).toBe('median n/a, p90 n/a');
    expect(values.cost_per_merge).toBe('n/a (no merges)');
    expect(values.red_train).toBe('n/a (0 red of 0 trains; 0 red backstop, 0 red screens)');
    expect(values.releases).toBe('0');
    expect(renderMarkdown(card, scorecardRows(card))).not.toContain('NaN');
    expect(fmtHours(0.5)).toBe('30m');
    expect(fmtHours(null)).toBe('n/a');
  });

  test('a failed merged-PR read leaves gate rows standing with comment costs unknown', () => {
    // Value: protects=each input is guarded on its own so a PR-list failure still prints gates, free retries, issues and releases; fails_when=the guards are merged into one try or the gate read depends on the PR read succeeding; why_new=only the issues guard was exercised; seam=none; no_claim=none beyond protects
    const fx = fixture();
    for (const key of Object.keys(fx.responses)) if (key.includes('/pulls?')) delete fx.responses[key];
    const card = collectScorecard(fixtureSource(fx, scratch()), options());
    expect(card.unavailable).toHaveLength(1);
    expect(card.unavailable[0]).toStartWith('merged PRs: ');
    const values = byId(scorecardRows(card));
    expect(values.merged).toStartWith('unavailable (');
    expect(values.lead_time).toStartWith('unavailable (');
    expect(values.gates).toBe('2 / 1 / 1; known cost $30.50 on 1 of 4 runs (comment costs unavailable: merged PRs unreadable)');
    expect(values.cost_per_merge).toStartWith('unavailable (');
    expect(values.review_passes).toStartWith('unavailable (');
    expect(card.gates.find(g => g.id === 9003)!.costSource).toBeNull();
    expect(values.issues).toBe('5 / 7');
  });

  test('a failed free-run read marks only the free half of the flaky line; an unreadable artifact leaves its run without cost or flake data', () => {
    // Value: protects=the flaky line never prints a clean 0 for a read that failed, and one bad artifact does not drop the whole gate section; fails_when=the flaky row is keyed to one guard again or the per-run try/catch is removed; why_new=red-team review found both; seam=none; no_claim=none beyond protects
    const fx = fixture();
    for (const key of Object.keys(fx.responses)) if (key.includes('/actions/workflows/free-tests.yml/')) delete fx.responses[key];
    const values = byId(scorecardRows(collectScorecard(fixtureSource(fx, scratch()), options())));
    expect(values.flaky).toMatch(/^2 paid case\(s\) passed on their one rerun \(rerun spend \$1\.10\); unavailable \(/);
    expect(values.gates).toBe('2 / 1 / 1; known cost $43.00 on 2 of 4 runs');
    const inner = fixtureSource(fixture(), scratch());
    const flaky = { getJson: (p: string) => inner.getJson(p), artifactDirs: (id: number, m: (n: string) => boolean) => { if (id === 9001 || id === 8001) throw new Error('unzip failed'); return inner.artifactDirs(id, m); } };
    const card = collectScorecard(flaky, options());
    expect(card.unavailable).toEqual([]);
    expect(card.artifactErrors).toBe(1);
    expect(card.gates.find(g => g.id === 9001)!.costUsd).toBeNull();
    expect(card.freeRuns.find(r => r.id === 8001)!.retries).toBeNull();
    const v = byId(scorecardRows(card));
    expect(v.gates).toBe('2 / 1 / 1; known cost $12.50 on 1 of 4 runs');
    expect(v.flaky).toBe('0 paid case(s) passed on their one rerun (rerun spend $0.00); artifacts unreadable on 1 run(s); 0 free-suite retries in 0 of 3 runs (1 unreadable)');
  });
});

describe('factory-scorecard: pieces', () => {
  test('gate kind by train prefix, backstop and screen titles; outcome by conclusion', () => {
    expect(classifyGate({ branch: 'train/gate.train-x', title: 'E2E Evals [eval-bg gate.train-x]' }, 'train/')).toBe('train');
    expect(classifyGate({ branch: 'main', title: 'E2E Evals [eval-bg gate.backstop-abc]' }, 'train/')).toBe('backstop');
    expect(classifyGate({ branch: 'main', title: 'E2E Evals [eval-bg pr.screen.narrow-x] screen #12' }, 'train/')).toBe('screen');
    expect(classifyGate({ branch: 'feature/x', title: 'E2E Evals [eval-bg pr.gate-x]' }, 'train/')).toBe('other');
    expect(classifyGate({ branch: 'queue/gate-1', title: 'gate' }, 'queue/')).toBe('train');
    expect(['success', 'failure', 'timed_out', 'cancelled', 'skipped', null].map(gateOutcome)).toEqual(['green', 'red', 'red', 'cancelled', 'cancelled', 'red']);
  });

  test('READY marker: the first matching comment wins and the newest cost line is kept', () => {
    const source = fixtureSource(fixture(), scratch());
    const markers = (readyMarker: RegExp, mergedAt?: string) => ({ readyMarker, passMarker: new RegExp(DEFAULTS.passMarker, 'm'), mergedAt });
    expect(readComments(source, 'acme/widgets', 101, markers(/READY #\d+/m))).toEqual({ readyAt: '2026-10-24T16:00:00Z', costUsd: 12.5, passes: null });
    expect(readComments(source, 'acme/widgets', 101, markers(/never matches/m))).toEqual({ readyAt: null, costUsd: 12.5, passes: null });
    expect(readComments(source, 'acme/widgets', 103, markers(new RegExp(DEFAULTS.readyMarker, 'm')))).toEqual({ readyAt: '2026-10-25T03:00:00Z', costUsd: null, passes: 3 });
    // Value: protects=a READY-style comment posted after the merge (a controller recap) does not become the READY time; fails_when=the mergedAt bound is dropped; why_new=review found negative READY-to-merge durations possible; seam=none; no_claim=none beyond protects
    expect(readComments(source, 'acme/widgets', 102, markers(/READY #\d+/m, '2026-10-25T12:00:00Z')).readyAt).toBeNull();
    expect(readComments(source, 'acme/widgets', 102, markers(/READY #\d+/m)).readyAt).toBe('2026-10-26T01:00:00Z');
    expect(passCount('"passes": 4 then passes=1 then REVIEW_PASSES: 2', new RegExp(DEFAULTS.passMarker, 'm'))).toBe(4);
    expect(passCount('reviews: 3 and passes=2', /(passes|reviews)[=: ]+(\d+)/m)).toBe(3);
    expect(passCount('no count here', new RegExp(DEFAULTS.passMarker, 'm'))).toBeNull();
  });

  test('verdict cost reads collector-outcomes.json and ignores an unreadable one; flake records skip torn lines and unknown rerun cost', () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, 'a', 'paid-report'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'paid-report', 'collector-outcomes.json'), '{not json');
    expect(verdictCost([path.join(dir, 'a')])).toBeNull();
    fs.writeFileSync(path.join(dir, 'a', 'paid-report', 'collector-outcomes.json'), JSON.stringify({ verdict: { costUsd: 23.814 } }));
    expect(verdictCost([path.join(dir, 'a')])).toBe(23.81);
    fs.writeFileSync(path.join(dir, 'a', 'flake-records.jsonl'), [
      JSON.stringify({ kind: 'gate-flake', case: 'x', rerun_cost_usd: 0.5 }), 'torn {', JSON.stringify({ kind: 'gate-flake', case: 'y', rerun_cost_usd: null }),
      JSON.stringify({ kind: 'other', case: 'z', rerun_cost_usd: 9 }), ''].join('\n'));
    expect(flakeRecords([path.join(dir, 'a')])).toEqual({ flakes: 2, rerunUsd: 0.5 });
    expect(flakeRecords([path.join(dir, 'missing')])).toEqual({ flakes: 0, rerunUsd: 0 });
  });

  test('the window is end-exclusive at millisecond precision; the issue search range stays inside it at whole seconds', () => {
    // Value: protects=a sub-second --now (the default, Date.now()) neither drops an issue at the end second nor counts one before the start; fails_when=either rounding in searchRange flips or inWindow stops rejecting unparsable timestamps; why_new=the --now test uses a whole-second now only; seam=none; no_claim=GitHub search's inclusive-range semantics
    const w = { start: '2026-10-19T12:00:00.500Z', end: '2026-10-26T12:00:00.500Z' };
    expect(searchRange(w)).toBe('2026-10-19T12:00:01Z..2026-10-26T12:00:00Z');
    expect(searchRange({ start: '2026-10-19T12:00:00.000Z', end: '2026-10-26T12:00:00.000Z' })).toBe('2026-10-19T12:00:00Z..2026-10-26T11:59:59Z');
    expect(['2026-10-19T12:00:00Z', '2026-10-19T12:00:01Z', '2026-10-26T12:00:00Z', '2026-10-26T12:00:01Z'].map(at => inWindow(at, w))).toEqual([false, true, true, false]);
    expect([undefined, null, '', 'soon', Date.parse('2026-10-20T00:00:00Z')].map(at => inWindow(at, w))).toEqual([false, false, false, false, false]);
  });

  test('percentile is nearest-rank: p50 and p90 of small samples, null when empty', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([4, 8, 120], 0.5)).toBe(8);
    expect(percentile([4, 8, 120], 0.9)).toBe(120);
    expect(percentile([2, 1], 0.5)).toBe(1);
  });
});

describe('factory-scorecard: the bin', () => {
  const run = (args: string[], cwd: string) => spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: cwd } });

  test('--fixtures replays the recorded window and writes the table, the CSV and the JSON', () => {
    const cwd = scratch();
    const r = run(['--repo', 'acme/widgets', '--fixtures', FIXTURE, '--now', '2026-10-26T12:00:00Z', '--json'], cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('| Merged PRs | 3 (crew 2, outside 1) |');
    expect(r.stdout).toContain('| Known gate cost per merged PR | $14.33 (2 runs without a known cost) |');
    expect(r.stdout).toContain(`SCORECARD_CSV: ${path.join('.context', 'factory-scorecard', 'scorecard.csv')}`);
    const csv = fs.readFileSync(path.join(cwd, '.context', 'factory-scorecard', 'scorecard.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('repo,window_start,window_end,metric_id,metric,value,benchmark,rule');
    expect(csv).toContain('"red_train","Red-train rate","50% (1 red of 2 trains; 0 red backstop, 0 red screens)"');
    expect(fs.existsSync(path.join(cwd, '.context', 'factory-scorecard', 'scorecard.md'))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(cwd, '.context', 'factory-scorecard', 'scorecard.json'), 'utf8'));
    expect(json.card.prs).toHaveLength(3);
    expect(json.rows).toHaveLength(Object.keys(BENCHMARKS).length);
  });

  test('--crew, --out-dir, --csv and a custom --ready-marker are honoured', () => {
    const cwd = scratch();
    const out = path.join(cwd, 'out');
    const r = run(['--repo', 'acme/widgets', '--fixtures', FIXTURE, '--now', '2026-10-26T12:00:00Z', '--crew', 'alice,bo', '--out-dir', out,
      '--csv', path.join(cwd, 'card.csv'), '--ready-marker', 'ship receipt follows'], cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('| Merged PRs | 3 (crew 2, outside 1) |');
    expect(r.stdout).toContain('(1 of 3 PRs with a READY comment)');
    expect(fs.existsSync(path.join(cwd, 'card.csv'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'scorecard.md'))).toBe(true);
    // Value: protects=--csv into a directory that does not exist yet is created instead of crashing after every read; fails_when=the mkdirSync before the CSV write is removed; why_new=review found only --out-dir was created; seam=none; no_claim=none beyond protects
    const nested = run(['--repo', 'acme/widgets', '--fixtures', FIXTURE, '--now', '2026-10-26T12:00:00Z', '--csv', path.join(cwd, 'trends', 'w43', 'card.csv')], cwd);
    expect(nested.status, nested.stderr).toBe(0);
    expect(fs.existsSync(path.join(cwd, 'trends', 'w43', 'card.csv'))).toBe(true);
    // Value: protects=every run appends its rows to trend.csv with one header, so weeks line up without renaming files; fails_when=the append is removed or the header repeats; why_new=review found scorecard.csv overwritten every run; seam=none; no_claim=none beyond protects
    const trend = fs.readFileSync(path.join(cwd, '.context', 'factory-scorecard', 'trend.csv'), 'utf8').split('\n').filter(Boolean);
    expect(trend.filter(l => l.startsWith('repo,')).length).toBe(1);
    expect(trend.length).toBe(1 + Object.keys(BENCHMARKS).length);
    const again = run(['--repo', 'acme/widgets', '--fixtures', FIXTURE, '--now', '2026-10-27T12:00:00Z'], cwd);
    expect(again.status, again.stderr).toBe(0);
    const trendLines = () => fs.readFileSync(path.join(cwd, '.context', 'factory-scorecard', 'trend.csv'), 'utf8').split('\n').filter(Boolean).length;
    expect(trendLines()).toBe(1 + 2 * Object.keys(BENCHMARKS).length);
    expect(run(['--repo', 'acme/widgets', '--fixtures', FIXTURE, '--now', '2026-10-27T12:00:00Z'], cwd).status).toBe(0);
    expect(trendLines()).toBe(1 + 2 * Object.keys(BENCHMARKS).length);
    expect(nested.stdout).toContain(`SCORECARD_TREND: ${path.join('.context', 'factory-scorecard', 'trend.csv')}`);
  });

  test('bad usage exits 2 with the usage text; --help exits 0', () => {
    const cwd = scratch();
    expect(run(['--since-days', 'soon'], cwd).status).toBe(2);
    // Value: protects=an unparsable --now exits 2 before any read; fails_when=the --now validation branch is removed; why_new=the other flag validations were covered and this one was not; seam=none; no_claim=none beyond protects
    expect(run(['--now', 'yesterday-ish', '--fixtures', FIXTURE], cwd).status).toBe(2);
    expect(run(['--ready-marker', '(', '--fixtures', FIXTURE], cwd).status).toBe(2);
    // Value: protects=a non-numeric or negative --max-artifact-runs exits 2 instead of silently reading no artifact; fails_when=the validation is removed and Number('lots') flows into Math.min; why_new=review found this flag unvalidated; seam=none; no_claim=none beyond protects
    const lots = run(['--max-artifact-runs', 'lots', '--fixtures', FIXTURE], cwd);
    expect(lots.status).toBe(2);
    expect(lots.stderr).toContain('--max-artifact-runs must be a non-negative integer');
    expect(run(['--max-artifact-runs', '-1', '--fixtures', FIXTURE], cwd).status).toBe(2);
    expect(run(['--pass-cap', '0', '--fixtures', FIXTURE], cwd).status).toBe(2);
    expect(run(['--pass-marker', '[', '--fixtures', FIXTURE], cwd).status).toBe(2);
    // Value: protects=without --repo and without a GitHub origin the bin refuses instead of guessing a repository; fails_when=a hard-coded fallback repository returns; why_new=red-team review found the shared helper's fallback would score the wrong repository; seam=none; no_claim=none beyond protects
    const noRepo = run(['--fixtures', FIXTURE], cwd);
    expect(noRepo.status).toBe(2);
    expect(noRepo.stderr).toContain('--repo owner/name is required');
    const local = scratch();
    spawnSync('git', ['init', '-q', local]);
    spawnSync('git', ['-C', local, 'remote', 'add', 'origin', '/srv/git/repo.git']);
    expect(run(['--fixtures', FIXTURE], local).stderr).toContain('--repo owner/name is required');
    spawnSync('git', ['-C', local, 'remote', 'set-url', 'origin', 'git@ghe.example.test:acme/widgets.git']);
    const ghe = spawnSync(BIN, ['--fixtures', FIXTURE, '--now', '2026-10-26T12:00:00Z'], { cwd: local, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: local, GH_HOST: 'ghe.example.test' } });
    expect(ghe.status, ghe.stderr).toBe(0);
    expect(ghe.stdout).toContain('| Merged PRs | 3 (crew 2, outside 1) |');
    expect(run(['--pass-marker', 'passes', '--fixtures', FIXTURE], cwd).stderr).toContain('--pass-marker needs a capture group');
    const stray = run(['stray'], cwd);
    expect(stray.status).toBe(2);
    expect(stray.stderr).toContain('unexpected argument: stray');
    const help = run(['--help'], cwd);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('gstack-factory-scorecard [--repo owner/name]');
    expect(help.stdout).not.toContain(' * ');
  });

  test('the retro template runs the bin from the runtime root and reads its table', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md.tmpl'), 'utf8');
    expect(tmpl).toContain('"{{RUNTIME_ROOT}}/bin/gstack-factory-scorecard"');
    expect(tmpl).toContain('### Step 7.5: Factory scorecard');
    expect(fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf8')).toContain('$HOME/.claude/skills/gstack/bin/gstack-factory-scorecard');
  });
});
