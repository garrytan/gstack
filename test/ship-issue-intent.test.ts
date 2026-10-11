/**
 * C6: `Fixes #N` only on explicit closure intent. References, partial fixes,
 * deferred asks and cross-repo ids are `Refs`; an unreadable closure issue is
 * downgraded (ISSUE_UNREADABLE); failing CI run ids map to flake issues.
 * The bin reads issues only through gstack-issue-guard (a gh shim on PATH).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { mentionsIn, renderIssueLines, resolveLinks } from '../lib/issue-links';
import { cleanup, commit, ghShim, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('issue intent (pure)', () => {
  test('trailers carry closure; bare mentions, partial fixes, deferred asks and cross-repo ids are references', () => {
    const m = mentionsIn('fix: retry\n\nContext in #12. Partially fixes #13; deferring #17 to a follow-up.\nSee owner/other#9.\n\nFixes #14\nCloses: #15\nResolves GH-18\n');
    expect(m.map(x => [x.repo ? `${x.repo}#${x.issue}` : `#${x.issue}`, x.intent])).toEqual([
      ['#12', 'refs'], ['#13', 'refs'], ['#17', 'refs'], ['owner/other#9', 'refs'], ['#14', 'fixes'], ['#15', 'fixes'], ['#18', 'fixes'],
    ]);
    expect(mentionsIn('Fixes #14 and #15 together').map(x => x.intent)).toEqual(['refs', 'refs']);
    expect(mentionsIn('v1.2.3 (#301) release notes').map(x => x.issue)).toEqual([301]);
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
    const env = ghShim(repo, { issues: { '14': { title: 't', body: 'b', comments: [] }, '16': { title: 'u', body: '', comments: [] } }, issueList: [{ number: 40, body: 'Flake in run 123456' }, { number: 41, body: 'unrelated' }] });
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
