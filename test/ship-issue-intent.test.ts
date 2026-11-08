/**
 * C6: `Fixes #N` only on explicit closure intent. References, partial fixes,
 * deferred asks and cross-repo ids are `Refs`; an unreadable closure issue is
 * downgraded (ISSUE_UNREADABLE); failing CI run ids map to flake issues.
 * The bin reads issues only through gstack-issue-guard (a gh shim on PATH).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitAgentNotes } from '../lib/agent-notes';
import { EXIT } from '../lib/headless-artifacts';
import { lineSources, mentionsIn, promotionCandidates, relatedPrs, renderIssueLines, resolveLinks, selectFlakes, type ClosingPr, type IssueRow } from '../lib/issue-links';
import { cleanup, commit, ghShim, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const BOT = { login: 'app/github-actions', is_bot: true };

describe('issue intent (pure)', () => {
  test('trailers carry closure; bare mentions, partial fixes, deferred asks and cross-repo ids are references', () => {
    const m = mentionsIn('fix: retry\n\nContext in #12. Partially fixes #13; deferring #17 to a follow-up.\nSee owner/other#9.\n\nFixes #14\nCloses: #15\nResolves GH-18\n');
    expect(m.map(x => [x.repo ? `${x.repo}#${x.issue}` : `#${x.issue}`, x.intent])).toEqual([
      ['#12', 'refs'], ['#13', 'refs'], ['#17', 'refs'], ['owner/other#9', 'refs'], ['#14', 'fixes'], ['#15', 'fixes'], ['#18', 'fixes'],
    ]);
    expect(mentionsIn('Fixes #14 and #15 together').map(x => x.intent)).toEqual(['refs', 'refs']);
    expect(mentionsIn('v1.2.3 (#301) release notes').map(x => x.issue)).toEqual([301]);
  });

  // Value: protects=a parenthesised named reference "(name #N, #M)", "(name PR #N)" or "(name issue #N)" is a cross-repo reference to that name, never a
  // same-repo Refs line or a promotion candidate, while "(see #12)", "(closing #12)", "(cf. #12)", "(v1.2 #3)", "(#301)" and "Fixes #12" keep their
  // meaning; fails_when=the bare-#N rule reads the numbers as this repository's issues (Refs lines and fix-#N prompts for issues that do not exist here), or
  // a closure, reference, filler or version word in the parentheses is taken for a repository name (the issue then vanishes from Refs and from the fix-#N
  // offer as a phantom cross-repo reference); why_new=the intent tests cover owner/repo#N as the only cross form; seam=none; no_claim=none beyond protects
  test('a parenthesised named reference is a cross-repo reference, never a same-repo Refs or promotion candidate', () => {
    const named = mentionsIn('ship-queue: screen verdict from the run (gbrain #7625, #7606)\n\nPorts the fix from (gbrain PR #7630) and (acme/tools issue #4).\n');
    expect(named.map(x => [x.repo ?? '', x.issue, x.intent])).toEqual([['gbrain', 7625, 'refs'], ['gbrain', 7606, 'refs'], ['gbrain', 7630, 'refs'], ['acme/tools', 4, 'refs']]);
    const links = resolveLinks(named, [], () => true);
    expect(links).toEqual({ fixes: [], refs: [], flakes: [], cross: ['acme/tools#4', 'gbrain#7606', 'gbrain#7625', 'gbrain#7630'], unreadable: [] });
    expect(renderIssueLines(links)).toEqual(['Refs acme/tools#4', 'Refs gbrain#7606', 'Refs gbrain#7625', 'Refs gbrain#7630']);
    expect(promotionCandidates(named, links)).toEqual([]);
    for (const word of ['see', 'fixes', 'refs', 'related', 'part of', 'follow-up', 'closes', 'PR', 'issue', 'closing', 'addresses', 'fixing', 'implements', 'cf.', 'e.g.', 'i.e.', 'bug', 'upstream PR', 'v1.2', 'v1.2.3-rc1', 'supersedes', 'duplicate of']) {
      expect([word, mentionsIn(`retry (${word} #12)`).map(x => [x.repo ?? '', x.issue, x.intent])]).toEqual([word, [['', 12, 'refs']]]);
    }
    expect(mentionsIn('v1.2.3 (#301) release notes').map(x => [x.repo ?? '', x.issue])).toEqual([['', 301]]);
    expect(mentionsIn('Fixes #12').map(x => [x.repo ?? '', x.issue, x.intent])).toEqual([['', 12, 'fixes']]);
    expect(mentionsIn('same line (gbrain #7625) and #13 here').map(x => [x.repo ?? '', x.issue])).toEqual([['gbrain', 7625], ['', 13]]);
  });

  test('resolution: explicit --issue is closure, unreadable closure becomes Refs, a flake issue is never a plain Ref', () => {
    const links = resolveLinks(mentionsIn('Fixes #14\nFixes #15\nsee #40 and #16'), [16], n => n !== 15, [{ issue: 40, run: '7' }]);
    expect(links).toEqual({ fixes: [14, 16], refs: [15], flakes: [{ issue: 40, run: '7' }], cross: [], unreadable: [15] });
    expect(renderIssueLines(links)).toEqual(['Fixes #14', 'Fixes #16', 'Refs #15 (unreadable through gstack-issue-guard; not auto-closed)', 'Flake: #40 (run 7)']);
    expect(renderIssueLines(resolveLinks([], [], () => true))).toEqual([]);
  });
});

describe('gstack-issue-links (bin)', () => {
  test('reads origin/<base>..HEAD, probes closure issues through gstack-issue-guard, maps CI run ids to flake issues, writes the receipt object', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" }, 'fix add\n\nSee #12 for context, partially fixes #13.\n\nFixes #14\nCloses #15\nRefs other/repo#9\n');
    const env = ghShim(repo, {
      issues: { '14': { title: 't', body: 'b', comments: [] }, '16': { title: 'u', body: '', comments: [] } },
      issueList: [{ number: 40, title: 'Flake: test/util.test.js', author: BOT, body: 'Flake in https://github.com/owner/repo/actions/runs/123456' }, { number: 41, body: 'unrelated' }],
      closing: { '14': [[]], '16': [[]] },
    });
    const out = path.join(repo.work, '.gstack/tmp/issues.json');
    const r = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--ci-run', '123456', '--issue', '16', '--out', out], env);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toBe(['Fixes #14', 'Fixes #16', 'Refs #12', 'Refs #13', 'Refs #15 (unreadable through gstack-issue-guard; not auto-closed)', 'Refs other/repo#9', 'Flake: #40 (run 123456)', ''].join('\n'));
    expect(r.err).toContain('(#15)');
    expect(r.err).toContain('(ISSUE_UNREADABLE)');
    expect(r.err).toContain('closure #14 ← commit ');
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({ fixes: [14, 16], refs: [12, 13, 15], flakes: [{ issue: 40, run: '123456' }] });
    const receipt = runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--version', '1.0.0', '--session-kind', 'interactive', '--issues', `@${out}`, '--json'], env);
    expect(receipt.status).toBe(EXIT.ok);
    expect(JSON.parse(receipt.out).issues).toEqual({ fixes: [14, 16], refs: [12, 13, 15], flakes: [{ issue: 40, run: '123456' }] });
  });

  test('no mentions prints ISSUE_LINKS: none with exit 0; a bare mention never closes; bad flags are usage', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" }, 'tidy\n\nmentions #12 only\n');
    const env = ghShim(repo, { issues: { '12': { title: 't', body: 'b', comments: [] } } });
    const r = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--json'], env);
    expect(r.status).toBe(EXIT.ok);
    expect(JSON.parse(r.out)).toMatchObject({ fixes: [], refs: [12], flakes: [] });
    const none = fixture();
    expect(runBin(none, 'gstack-issue-links', ['--base', 'main']).out).toBe('ISSUE_LINKS: none\n');
    expect(runBin(none, 'gstack-issue-links', ['--base', 'main', '--issue', 'abc']).status).toBe(EXIT.usage);
    expect(runBin(none, 'gstack-issue-links', ['--help']).out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
  });
});

const flakeJson = (run: number, file: string, test: string) =>
  `failed on master\n\n<!-- flake:json -->\n\`\`\`json\n${JSON.stringify({ schema: 'flake/v1', file, test, first_seen: { run_id: run } }, null, 2)}\n\`\`\`\n`;

describe('promotion candidates (D1)', () => {
  test('a subject parenthetical is a Refs candidate the owner promotes with fix #N; a Fixes: trailer closes', () => {
    const subject = 'sync groups: a member after an uncommitted member is cancelled, never published ahead of it (#6252)\n\nContributor PR #6253 took the counting.\n';
    const mentions = mentionsIn(subject, 'commit a33b20ea8a');
    const links = resolveLinks(mentions, [], () => true);
    expect(renderIssueLines(links)).toEqual(['Refs #6252', 'Refs #6253']);
    expect(promotionCandidates(mentions, links)).toEqual([
      { issue: 6252, source: 'commit a33b20ea8a: sync groups: a member after an uncommitted member is cancelled, never published ahead of it (#6252)' },
      { issue: 6253, source: 'commit a33b20ea8a: Contributor PR #6253 took the counting.' },
    ]);
    const promoted = resolveLinks(mentions, [6252], () => true);
    expect(renderIssueLines(promoted)).toEqual(['Fixes #6252', 'Refs #6253']);
    expect(promotionCandidates(mentions, promoted).map(c => c.issue)).toEqual([6253]);
    expect(renderIssueLines(resolveLinks(mentionsIn(`${subject}\nFixes: #6252\n`), [], () => true))).toEqual(['Fixes #6252', 'Refs #6253']);
    const unreadable = resolveLinks(mentionsIn('Fixes #9'), [], () => false);
    expect(promotionCandidates(mentionsIn('Fixes #9'), unreadable)).toEqual([]);
  });
});

describe('flake issues (D3): bot-opened, this repository, this run, a named test', () => {
  const repo = 'garrytan/gbrain';
  const rows: IssueRow[] = [
    { number: 6304, title: 'Flake: test/bounded-child-exec.test.ts › keeps stdout', author: BOT, body: flakeJson(37769719459, 'test/bounded-child-exec.test.ts', 'keeps stdout') },
    { number: 6310, title: 'CI is red again', author: { login: 'andreineacsu', is_bot: false }, body: 'see https://github.com/garrytan/gbrain/actions/runs/37769719459' },
    { number: 6311, title: 'Flake: test/a.test.ts', author: { login: 'github-actions[bot]' }, body: 'first seen https://github.com/other/fork/actions/runs/37769719459' },
    { number: 6312, title: 'nightly summary', author: BOT, body: 'run https://github.com/garrytan/gbrain/actions/runs/37769719459' },
    { number: 6313, title: 'Flake: test/b.test.ts', author: BOT, body: 'run https://github.com/garrytan/gbrain/actions/runs/377697194590' },
    { number: 6490, title: 'Flake: test/write-gate-perf.slow.test.ts › p95', author: BOT, body: flakeJson(37769719459, 'test/write-gate-perf.slow.test.ts', 'p95') },
    { number: 6570, title: 'Flake: test/write-gate-perf.slow.test.ts › p95', author: BOT, body: flakeJson(37769719459, 'test/write-gate-perf.slow.test.ts', 'p95') },
    { number: 6600, title: 'Flake: test/c.test.ts', author: { login: 'app/capy-ai', is_bot: true }, body: 'Failed in https://github.com/GarryTan/GBrain/actions/runs/37769719459.' },
  ];

  test('keeps only qualifying issues and says why each other one was refused', () => {
    const picked = selectFlakes('37769719459', repo, [...rows].reverse());
    expect(picked.flakes).toEqual([
      { issue: 6304, run: '37769719459', test: 'test/bounded-child-exec.test.ts › keeps stdout' },
      { issue: 6490, run: '37769719459', test: 'test/write-gate-perf.slow.test.ts › p95' },
      { issue: 6600, run: '37769719459', test: 'test/c.test.ts' },
    ]);
    expect(picked.rejected).toEqual([
      { issue: 6310, reason: 'opened by @andreineacsu, not a bot' },
      { issue: 6311, reason: 'names run 37769719459 of other/fork, not garrytan/gbrain' },
      { issue: 6312, reason: 'names no test (no flake:json file, no "Flake: <test>" title)' },
      { issue: 6313, reason: 'does not name run 37769719459 of garrytan/gbrain' },
      { issue: 6570, reason: 'duplicate of #6490 (test/write-gate-perf.slow.test.ts › p95)' },
    ]);
    expect(selectFlakes('1', repo, [{ number: 1, title: 'Flake: x', author: BOT, body: '<!-- flake:json -->\n```json\n{not json\n```' }]).rejected).toEqual([{ issue: 1, reason: 'does not name run 1 of garrytan/gbrain' }]);
  });
});

describe('related PRs (D2)', () => {
  const pr = (number: number, login: string, extra: Partial<ClosingPr> = {}): ClosingPr => ({ number, state: 'OPEN', headRefName: `b${number}`, author: { login }, repository: { nameWithOwner: 'garrytan/gbrain' }, ...extra });

  test('open PRs by other authors closing a fixed issue are Related; own, own-branch and closed PRs are not; Supersedes and credit only when confirmed', () => {
    const closing = new Map<number, ClosingPr[]>([
      [6252, [pr(6253, 'andreineacsu'), pr(6279, 'garrytan'), pr(6290, 'someone', { headRefName: 'feature' }), pr(6291, 'x', { state: 'CLOSED' }), pr(12, 'forker', { repository: { nameWithOwner: 'forker/gbrain' } })]],
      [6275, [pr(6253, 'andreineacsu'), pr(6299, 'other', { author: null })]],
    ]);
    const related = relatedPrs(closing, { repo: 'GarryTan/gbrain', viewer: 'GarryTan', branch: 'feature' });
    expect(related).toEqual([
      { pr: 6253, author: 'andreineacsu', closes: [6252, 6275] },
      { pr: 6299, author: 'ghost', closes: [6275] },
      { pr: 12, repo: 'forker/gbrain', author: 'forker', closes: [6252] },
    ]);
    const links = resolveLinks(mentionsIn('Fixes #6252\nFixes #6275'), [], () => true, [], related);
    expect(renderIssueLines(links)).toEqual(['Fixes #6252', 'Fixes #6275', 'Related: #6253 (@andreineacsu)', 'Related: #6299 (@ghost)', 'Related: forker/gbrain#12 (@forker)']);
    related[0]!.supersedes = true;
    related[0]!.credit = true;
    expect(renderIssueLines(links).slice(2, 4)).toEqual(['Supersedes #6253', 'Contributed by @andreineacsu']);
    expect(lineSources(links).slice(0, 2)).toEqual([
      'Supersedes #6253 ← open PR closing #6252, #6275 by @andreineacsu; owner confirmed --supersedes',
      'Contributed by @andreineacsu ← #6253, open PR closing #6252, #6275; owner confirmed --credit',
    ]);
    expect(resolveLinks([], [], () => true, [], [])).not.toHaveProperty('related');
  });
});

describe('gstack-issue-links (bin): related PRs, flake validation, lookup failures', () => {
  const setup = (data: Parameters<typeof ghShim>[1]) => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" }, 'fix: cancel members after an uncommitted head (#30)\n\nFixes #14\n');
    return { repo, env: ghShim(repo, { issues: { '14': { title: 't', body: 'b', comments: [] }, '30': { title: 'c', body: '', comments: [] } }, ...data }) };
  };

  test('pages through open PRs closing a fixed issue, prints Related lines with their sources, and records owner-confirmed credit', () => {
    const { repo, env } = setup({ closing: { '14': [[{ number: 7, state: 'OPEN', headRefName: 'contrib', author: { login: 'alice' } }, { number: 8, state: 'OPEN', headRefName: 'feature', author: { login: 'bob' } }], [{ number: 9, state: 'OPEN', headRefName: 'x', author: { login: 'me' } }, { number: 11, state: 'OPEN', headRefName: 'y', author: { login: 'carol' }, repository: { nameWithOwner: 'carol/repo' } }]] } });
    const r = runBin(repo, 'gstack-issue-links', ['--base', 'main'], env);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toBe('Fixes #14\nRefs #30\nRelated: #7 (@alice)\nRelated: carol/repo#11 (@carol)\n');
    expect(r.err).toContain('reference #30 ← commit ');
    expect(r.err).toContain('(promote: fix #30)');
    expect(r.err).toContain('  Related: #7 (@alice) ← open PR closing #14\n');
    const out = path.join(repo.work, '.gstack/tmp/issues.json');
    const credited = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--supersedes', '7', '--credit', '7', '--out', out, '--json'], env);
    expect(credited.status).toBe(EXIT.ok);
    const j = JSON.parse(credited.out);
    expect(j.lines).toEqual(['Fixes #14', 'Refs #30', 'Supersedes #7', 'Contributed by @alice', 'Related: carol/repo#11 (@carol)']);
    expect(j.candidates.map((c: { issue: number }) => c.issue)).toEqual([30]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({ fixes: [14], refs: [30], flakes: [], related: [{ pr: 7, author: 'alice', closes: [14], supersedes: true, credit: true }, { pr: 11, repo: 'carol/repo', author: 'carol', closes: [14] }] });
    expect(runBin(repo, 'gstack-issue-links', ['--base', 'main', '--author', 'Alice'], env).out).toBe('Fixes #14\nRefs #30\nRelated: #9 (@me)\nRelated: carol/repo#11 (@carol)\n');
    expect(runBin(repo, 'gstack-issue-links', ['--base', 'main', '--supersedes', '99'], env)).toMatchObject({ status: EXIT.usage, err: expect.stringContaining('--supersedes #99 is not a Related PR (#7, carol/repo#11)') });
  });

  test('--no-auto-links makes no Related lookup; a failed lookup is ISSUE_LOOKUP_FAILED with its anchor and leaves the closure lines', () => {
    const { repo, env } = setup({});
    const off = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--no-auto-links'], env);
    expect(off).toMatchObject({ status: EXIT.ok, out: 'Fixes #14\nRefs #30\n' });
    expect(off.err).not.toContain('ISSUE_LOOKUP_FAILED');
    const failed = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--json'], env);
    expect(failed.status).toBe(EXIT.ok);
    expect(JSON.parse(failed.out)).toMatchObject({ fixes: [14], unavailable: ['open PRs closing #14: HTTP 502: Bad Gateway (https://api.github.com/graphql)'] });
    expect(failed.err).toContain('gstack-issue-links: gstack-issue-links could not read');
    expect(failed.err).toContain('(ISSUE_LOOKUP_FAILED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#issue-lookup-failed)');
    const noRepo = ghShim(repo, { repo: null, issues: { '14': { title: 't', body: 'b', comments: [] } } });
    const r = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--ci-run', '123456', '--json'], noRepo);
    expect(JSON.parse(r.out)).toMatchObject({ flakes: [], unavailable: ['repository: no git remotes found'] });
  });

  test('--ci-run keeps the bot flake issue and lists the refused matches', () => {
    const { repo, env } = setup({ closing: { '14': [[]] }, issueList: [
      { number: 40, title: 'Flake: test/util.test.js', author: BOT, body: 'https://github.com/owner/repo/actions/runs/123456' },
      { number: 41, title: 'me too', author: { login: 'dev', is_bot: false }, body: 'https://github.com/owner/repo/actions/runs/123456' },
      { number: 42, title: 'Flake: test/util.test.js', author: BOT, body: 'https://github.com/elsewhere/repo/actions/runs/123456' },
    ] });
    const r = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--ci-run', '123456'], env);
    expect(r.out).toBe('Fixes #14\nRefs #30\nFlake: #40 (run 123456)\n');
    expect(r.err).toContain('  Flake: #40 (run 123456) ← bot flake issue for test/util.test.js\n');
    expect(r.err).toContain('  not a flake link: #41 (run 123456) ← opened by @dev, not a bot\n');
    expect(r.err).toContain('  not a flake link: #42 (run 123456) ← names run 123456 of elsewhere/repo, not owner/repo\n');
  });

  test('gstack-ship-receipt write refuses a body missing a printed issue line (ISSUE_LINKS_MISSING) and embeds the issues without the lines', () => {
    const { repo, env } = setup({ closing: { '14': [[{ number: 7, state: 'OPEN', headRefName: 'contrib', author: { login: 'alice' } }]] } });
    const out = path.join(repo.work, '.gstack/tmp/issues.json');
    expect(runBin(repo, 'gstack-issue-links', ['--base', 'main', '--out', out], env).status).toBe(EXIT.ok);
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\nx\n\n## Issues\nFixes #14\nRefs #30 (a context mention)\n');
    const args = ['write', '--base', 'main', '--version', '1.0.0', '--session-kind', 'interactive', '--issues', `@${out}`, '--body', body, '--json'];
    const refused = runBin(repo, 'gstack-ship-receipt', args, env);
    expect(refused.status).toBe(EXIT.fail);
    expect(refused.err).toContain(`— ${body} lacks "Related: #7 (@alice)"; fix: `);
    expect(refused.err).toContain('(ISSUE_LINKS_MISSING; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#issue-links-missing)');
    expect(fs.readFileSync(body, 'utf8').startsWith('## Summary')).toBe(true);
    fs.appendFileSync(body, 'Related: #7 (@alice)\n');
    const ok = runBin(repo, 'gstack-ship-receipt', args, env);
    expect(ok.status).toBe(EXIT.ok);
    expect(JSON.parse(ok.out).issues).toEqual({ fixes: [14], refs: [30], flakes: [], related: [{ pr: 7, author: 'alice', closes: [14] }] });
    expect(fs.readFileSync(body, 'utf8').startsWith('## Summary')).toBe(true);
    expect(splitAgentNotes(fs.readFileSync(body, 'utf8')).notes).toStartWith('```gstack-ship-receipt');
  });
});

describe('gstack-issue-links (bin): this PR\'s author when gh runs as an app', () => {
  const ownPr = { number: 8, state: 'OPEN', headRefName: 'other-wave', author: { login: 'garrytan' } };
  const contrib = { number: 7, state: 'OPEN', headRefName: 'contrib', author: { login: 'alice' } };
  const setup = (data: Parameters<typeof ghShim>[1]) => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" }, 'fix: tidy\n\nFixes #14\n');
    return { repo, env: ghShim(repo, { repo: 'garrytan/gbrain', viewer: 'capy-ai[bot]', issues: { '14': { title: 't', body: 'b', comments: [] } }, closing: { '14': [[contrib, ownPr]] }, ...data }) };
  };

  test('an app viewer is replaced by the HEAD commit author, else a user-owned repository\'s owner, so the owner\'s own PRs are not Related', () => {
    const byCommit = setup({ headAuthor: 'GarryTan', ownerType: 'Organization' });
    const r = runBin(byCommit.repo, 'gstack-issue-links', ['--base', 'main', '--json'], byCommit.env);
    expect(JSON.parse(r.out)).toMatchObject({ lines: ['Fixes #14', 'Related: #7 (@alice)'], author: { login: 'GarryTan', source: 'HEAD commit author' }, unavailable: [] });
    const byOwner = setup({});
    expect(JSON.parse(runBin(byOwner.repo, 'gstack-issue-links', ['--base', 'main', '--json'], byOwner.env).out)).toMatchObject({ lines: ['Fixes #14', 'Related: #7 (@alice)'], author: { login: 'garrytan', source: 'repository owner' } });
    expect(JSON.parse(runBin(byOwner.repo, 'gstack-issue-links', ['--base', 'main', '--author', 'alice', '--json'], byOwner.env).out)).toMatchObject({ lines: ['Fixes #14', 'Related: #8 (@garrytan)'], author: { login: 'alice', source: '--author' } });
  });

  test('an app viewer with no user to stand in keeps every PR and reports the gap as ISSUE_LOOKUP_FAILED', () => {
    const { repo, env } = setup({ ownerType: 'Organization' });
    const r = runBin(repo, 'gstack-issue-links', ['--base', 'main', '--json'], env);
    expect(r.status).toBe(EXIT.ok);
    expect(JSON.parse(r.out)).toMatchObject({ lines: ['Fixes #14', 'Related: #7 (@alice)', 'Related: #8 (@garrytan)'], author: { login: 'capy-ai[bot]', source: 'gh viewer' } });
    expect(JSON.parse(r.out).unavailable).toEqual(['this PR\'s author: gh runs as capy-ai[bot] and neither the HEAD commit nor the repository owner names a user; pass --author <login>']);
  });
});
