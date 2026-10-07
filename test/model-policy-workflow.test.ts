import { describe, expect, test, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MODEL_CATALOG, modelCatalogSha256 } from '../lib/model-catalog';
import { assessFreshness, freshnessCatalogIdentity } from '../lib/model-policy-freshness';
import { FRESHNESS_SOURCES, FRESHNESS_BOUNDS, sha256 } from '../lib/model-policy-freshness-sources';
import { FRESHNESS_ISSUE_AUTHOR, FRESHNESS_ISSUE_MARKER, FRESHNESS_REGION_BEGIN, FRESHNESS_REGION_END, publishFreshness, readFreshnessIssue, writeFreshnessIssue, type FreshnessGitHub, type TrackingIssue } from '../lib/model-policy-freshness-publication';
import { freshnessGitHub } from '../lib/model-policy-freshness-github';
import { runModelPolicyFreshness } from '../scripts/model-policy-freshness';
import { freshnessCatalog, freshnessFixture, freshnessObservation, freshnessReplacementObservation, retirementFixture } from './fixtures/model-policy-freshness.ts';

function mockGitHub(initial: (Omit<TrackingIssue, 'author'> & { author?: string })[] = []) {
  const issues: TrackingIssue[] = structuredClone(initial).map(issue => ({ author: FRESHNESS_ISSUE_AUTHOR, ...issue }));
  const calls: string[] = [];
  let identity = { defaultBranch: 'main', sourceSha256: freshnessCatalog.sourceSha256 };
  const github: FreshnessGitHub = {
    async defaultCatalog() { calls.push('catalog'); return identity; },
    async listIssues() { calls.push('list'); return structuredClone(issues); },
    async readIssue(number) { calls.push('read'); return structuredClone(issues.find(issue => issue.number === number)!); },
    async createIssue(body) { calls.push('create'); const issue: TrackingIssue = { number: issues.length + 1, body, state: 'open', author: FRESHNESS_ISSUE_AUTHOR }; issues.push(issue); return structuredClone(issue); },
    async updateIssue(number, update) { calls.push('update'); Object.assign(issues.find(issue => issue.number === number)!, update); },
  };
  return { github, issues, calls, setIdentity(value: typeof identity) { identity = value; } };
}

describe('stable-marker issue ownership and evidence lifecycle', () => {
  test('healthy bootstrap creates one closed issue, retains evidence when closed, and repeat publication is idempotent', async () => {
    const api = mockGitHub();
    const observation = freshnessObservation();
    const created = await publishFreshness(observation, api.github, 'refs/heads/main');
    expect(created.action).toBe('created');
    expect(api.issues).toHaveLength(1);
    expect(api.issues[0].state).toBe('closed');
    expect(api.issues[0].body).toContain(FRESHNESS_ISSUE_MARKER);
    expect(readFreshnessIssue(api.issues[0].body).state?.lastSuccess?.checkedAt).toBe(observation.checkedAt);
    const body = api.issues[0].body;
    expect((await publishFreshness(observation, api.github, 'refs/heads/main')).action).toBe('rejected-older-observation');
    expect(api.issues[0].body).toBe(body);
    const next = freshnessObservation('101', '2026-10-08T12:00:00.000Z');
    expect((await publishFreshness(next, api.github, 'refs/heads/main')).action).toBe('updated');
    expect(api.issues).toHaveLength(1);
    expect(api.issues[0].state).toBe('closed');
  });

  test('marker owns the issue, title collisions and human body/disposition text are untouched', async () => {
    const initial = writeFreshnessIssue('', assessFreshness(freshnessObservation()));
    const humanPrefix = 'Human notes: retain this default until qualification.\n';
    const humanSuffix = '\nHuman disposition: mitigation pending; do not delete.\n';
    const api = mockGitHub([
      { number: 40, body: 'Model-policy freshness: advisory maintenance', state: 'open' },
      { number: 41, body: humanPrefix + initial + humanSuffix, state: 'closed' },
    ]);
    await publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z', { 'anthropic-lifecycle': retirementFixture() }), api.github, 'refs/heads/main');
    expect(api.issues[0].body).toBe('Model-policy freshness: advisory maintenance');
    expect(api.issues[1].body.startsWith(humanPrefix)).toBe(true);
    expect(api.issues[1].body.endsWith(humanSuffix)).toBe(true);
    expect(api.issues[1].state).toBe('open');
    expect(readFreshnessIssue(api.issues[1].body).lifecycle[0].state).toBe('deprecated');
  });

  test('retirement survives source failure and partial recovery; issue never closes on either', async () => {
    const api = mockGitHub();
    await publishFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }), api.github, 'refs/heads/main');
    const evidence = readFreshnessIssue(api.issues[0].body).state!.lastSuccess;
    const failure = await publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z', { 'anthropic-lifecycle': null, 'openai-lifecycle': null }), api.github, 'refs/heads/main');
    expect(failure.report?.status).toBe('unknown/source-unavailable');
    expect(api.issues[0].state).toBe('open');
    expect(readFreshnessIssue(api.issues[0].body).state?.lastSuccess).toEqual(evidence);
    await publishFreshness(freshnessObservation('102', '2026-10-09T12:00:00.000Z', { 'openai-lifecycle': null }), api.github, 'refs/heads/main');
    expect(readFreshnessIssue(api.issues[0].body).lifecycle[0].deadline).toBe('2026-11-01');
    expect(api.issues[0].state).toBe('open');
  });

  test('both complete and source-unavailable catalog rollbacks reopen the closed replacement issue', async () => {
    for (const unavailable of [false, true]) {
      const api = mockGitHub();
      await publishFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }), api.github, 'refs/heads/main');
      const replacement = freshnessReplacementObservation();
      api.setIdentity({ defaultBranch: 'main', sourceSha256: replacement.catalog.sourceSha256 });
      await publishFreshness(replacement, api.github, 'refs/heads/main');
      expect(api.issues[0].state).toBe('closed');
      expect(readFreshnessIssue(api.issues[0].body).lifecycle[0].resolvedByCatalog).toBe(replacement.catalog.sha256);
      api.setIdentity({ defaultBranch: 'main', sourceSha256: freshnessCatalog.sourceSha256 });
      const rollback = freshnessObservation('102', '2026-10-09T12:00:00.000Z', unavailable ? { 'anthropic-lifecycle': null, 'openai-lifecycle': null } : {});
      const result = await publishFreshness(rollback, api.github, 'refs/heads/main');
      expect(result.report?.status).toBe(unavailable ? 'unknown/source-unavailable' : 'update-candidate');
      expect(api.issues[0].state).toBe('open');
      expect(api.issues).toHaveLength(1);
      const stored = readFreshnessIssue(api.issues[0].body);
      expect(stored.lifecycle[0]).toMatchObject({ state: 'deprecated', deadline: '2026-11-01' });
      expect(stored.lifecycle[0].resolvedByCatalog).toBeUndefined();
      if (unavailable) expect(stored.state?.lastSuccess?.catalog.sha256).toBe(replacement.catalog.sha256);
    }
  });

  test('corrupt state salvages independent lifecycle history and requires explicit manual repair', async () => {
    const initial = writeFreshnessIssue('', assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() })));
    const broken = initial.replace(/(<!-- gstack:model-policy-freshness:state:begin -->\n)[^\n]+/, '$1{broken');
    const api = mockGitHub([{ number: 7, body: `Human retain decision\n${broken}\nHuman footer`, state: 'closed' }]);
    expect(readFreshnessIssue(api.issues[0].body).state).toBeNull();
    expect(readFreshnessIssue(api.issues[0].body).lifecycle).toHaveLength(1);
    const result = await publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main');
    expect(result.report?.status).toBe('unknown/source-unavailable');
    expect(result.report?.state.lastSuccess).toBeNull();
    expect(result.report?.state.lifecycle).toHaveLength(1);
    expect(api.issues[0].state).toBe('open');
    expect(api.issues[0].body).toContain('Human retain decision');
    expect(api.issues[0].body).toContain('Human footer');
    expect(api.issues[0].body).toContain(Buffer.from(broken.slice(broken.indexOf(FRESHNESS_REGION_BEGIN) + FRESHNESS_REGION_BEGIN.length, broken.indexOf(FRESHNESS_REGION_END)).trim(), 'utf8').toString('base64'));
    const next = await publishFreshness(freshnessObservation('102', '2026-10-09T12:00:00.000Z'), api.github, 'refs/heads/main');
    expect(next.report?.state.recoveryRequired).toBe(true);
  });

  test('missing machine state is recovery, malformed owned boundary is not overwritten, and output is bounded', async () => {
    const api = mockGitHub([{ number: 9, body: `${FRESHNESS_ISSUE_MARKER}\nMaintainer notes`, state: 'closed' }]);
    const result = await publishFreshness(freshnessObservation(), api.github, 'refs/heads/main');
    expect(result.report?.status).toBe('unknown/source-unavailable');
    expect(api.issues[0].state).toBe('open');
    expect(api.issues[0].body).toContain('Maintainer notes');
    expect(() => writeFreshnessIssue(`${FRESHNESS_ISSUE_MARKER}\n${FRESHNESS_REGION_BEGIN}\nbroken`, assessFreshness(freshnessObservation()))).toThrow('corrupt-owned-region');
    expect(() => writeFreshnessIssue('x'.repeat(FRESHNESS_BOUNDS.issueBytes), assessFreshness(freshnessObservation()))).toThrow('tracking-issue-size-limit');
    expect(() => writeFreshnessIssue(`${FRESHNESS_REGION_END}\n${FRESHNESS_REGION_BEGIN}`, assessFreshness(freshnessObservation()))).toThrow('corrupt-owned-region');
  });

  test('duplicate markers fail visibly rather than selecting an arbitrary issue', async () => {
    const api = mockGitHub([{ number: 1, body: FRESHNESS_ISSUE_MARKER, state: 'open' }, { number: 2, body: FRESHNESS_ISSUE_MARKER, state: 'closed' }]);
    await expect(publishFreshness(freshnessObservation(), api.github, 'refs/heads/main')).rejects.toThrow('duplicate-tracking-marker');
    expect(api.calls).not.toContain('update');
    expect(api.calls).not.toContain('create');
  });

  test('user-created marker copies never become authority or trigger replacement bootstrap', async () => {
    const body = writeFreshnessIssue('', assessFreshness(freshnessObservation()));
    for (const includeOwned of [false, true]) {
      const api = mockGitHub([{ number: 1, body, state: 'closed', author: 'untrusted-user' }, ...(includeOwned ? [{ number: 2, body, state: 'closed' as const }] : [])]);
      await expect(publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main')).rejects.toThrow('untrusted-tracking-marker-owner');
      expect(api.calls).not.toContain('read');
      expect(api.calls).not.toContain('update');
      expect(api.calls).not.toContain('create');
    }
  });

  test('CRLF and CR-only marker lines retain retirement history and publish to the same issue on source failure', async () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    for (const newline of ['\r\n', '\r']) {
      const prefix = `Human prefix remains byte-identical.${newline}${newline}`;
      const suffix = `${newline}${newline}Human suffix remains byte-identical.${newline}`;
      const body = prefix + writeFreshnessIssue('', initial).replaceAll('\n', newline) + suffix;
      const api = mockGitHub([{ number: 17, body, state: 'open' }]);
      const result = await publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z', { 'anthropic-lifecycle': null, 'openai-lifecycle': null }), api.github, 'refs/heads/main');
      expect(result.action).toBe('updated');
      expect(result.issueNumber).toBe(17);
      expect(api.issues).toHaveLength(1);
      expect(api.calls).not.toContain('create');
      expect(api.issues[0].body.startsWith(prefix)).toBe(true);
      expect(api.issues[0].body.endsWith(suffix)).toBe(true);
      const stored = readFreshnessIssue(api.issues[0].body);
      expect(stored.lifecycle).toEqual(initial.state.lifecycle);
      expect(stored.state?.lastSuccess).toEqual(initial.state.lastSuccess);
      expect(result.report?.status).toBe('unknown/source-unavailable');
    }
  });

  test('inline and quoted marker mentions preserve human prefix and suffix outside the real region', async () => {
    const initial = assessFreshness(freshnessObservation());
    const prefix = `Human note mentioning ${FRESHNESS_REGION_BEGIN} inline; preserve this entire sentence.\r\n> ${FRESHNESS_REGION_END}\r\nQuoted '${FRESHNESS_REGION_BEGIN}' and '${FRESHNESS_REGION_END}' are human prose.\r\n\r\n`;
    const suffix = `\r\nHuman suffix mentions ${FRESHNESS_REGION_END} inline.\r\n> ${FRESHNESS_REGION_BEGIN}\r\n`;
    const body = prefix + writeFreshnessIssue('', initial) + suffix;
    const report = assessFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), initial.state);
    const rewritten = writeFreshnessIssue(body, report);
    expect(rewritten.startsWith(prefix)).toBe(true);
    expect(rewritten.endsWith(suffix)).toBe(true);
    expect(readFreshnessIssue(rewritten).state).toEqual(report.state);
    const api = mockGitHub([{ number: 19, body, state: 'closed' }]);
    const result = await publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main');
    expect(result.action).toBe('updated');
    expect(api.issues).toHaveLength(1);
    expect(api.issues[0].body.startsWith(prefix)).toBe(true);
    expect(api.issues[0].body.endsWith(suffix)).toBe(true);
  });

  test('malformed or missing top markers with owned evidence never become a healthy bootstrap', async () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    for (const marker of ['', `${FRESHNESS_ISSUE_MARKER} `, FRESHNESS_ISSUE_MARKER.replace(':v1', ':v2'), FRESHNESS_ISSUE_MARKER.replace('<!-- ', '<!--'), FRESHNESS_ISSUE_MARKER.slice(0, -1)]) {
      const body = writeFreshnessIssue('', initial).replace(FRESHNESS_ISSUE_MARKER, marker);
      const api = mockGitHub([{ number: 23, body, state: 'open' }]);
      await expect(publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main')).rejects.toThrow('corrupt-tracking-marker');
      expect(api.issues).toHaveLength(1);
      expect(api.issues[0].body).toBe(body);
      expect(api.calls).not.toContain('create');
      expect(api.calls).not.toContain('update');
      expect(readFreshnessIssue(body).lifecycle).toEqual(initial.state.lifecycle);
      expect(readFreshnessIssue(body).recoveryRequired).toBe(true);
    }
  });

  test('standalone malformed top markers without readable regions block healthy bootstrap', async () => {
    for (const marker of [` ${FRESHNESS_ISSUE_MARKER}`, `${FRESHNESS_ISSUE_MARKER}\t`, FRESHNESS_ISSUE_MARKER.replace(':v1', ':v2'), FRESHNESS_ISSUE_MARKER.replace(':v1', '-v1')]) {
      const body = `Human text\r\n${marker}\r\nRetirement history needs manual recovery.`;
      const api = mockGitHub([{ number: 29, body, state: 'open' }]);
      await expect(publishFreshness(freshnessObservation(), api.github, 'refs/heads/main')).rejects.toThrow('corrupt-tracking-marker');
      expect(api.issues[0].body).toBe(body);
      expect(api.calls).not.toContain('create');
      expect(api.calls).not.toContain('update');
    }
  });

  test('malformed owned boundaries salvage available lifecycle history but never certify a healthy publication', async () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    const body = writeFreshnessIssue('', initial).replace(FRESHNESS_REGION_BEGIN, FRESHNESS_REGION_BEGIN.replace(':begin', ':begn')).replace(FRESHNESS_REGION_END, FRESHNESS_REGION_END.replace(':end', ':en'));
    const stored = readFreshnessIssue(body);
    expect(stored.lifecycle).toEqual(initial.state.lifecycle);
    expect(stored.recoveryRequired).toBe(true);
    const api = mockGitHub([{ number: 31, body, state: 'open' }]);
    await expect(publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main')).rejects.toThrow('corrupt-tracking-marker');
    expect(api.issues[0].body).toBe(body);
    expect(api.calls).not.toContain('create');
    expect(api.calls).not.toContain('update');
  });
});

describe('publication ordering and default-branch guards', () => {
  test('both completion orders retain the newer unresolved retirement; old rerun is rejected even with a new observation date', async () => {
    for (const newerFirst of [false, true]) {
      const api = mockGitHub();
      const older = freshnessObservation('100');
      const newer = freshnessObservation('101', '2026-10-08T12:00:00.000Z', { 'anthropic-lifecycle': retirementFixture() });
      for (const observation of newerFirst ? [newer, older] : [older, newer]) await publishFreshness(observation, api.github, 'refs/heads/main');
      expect(api.issues[0].state).toBe('open');
      expect(readFreshnessIssue(api.issues[0].body).state?.latest.run.id).toBe('101');
      expect(readFreshnessIssue(api.issues[0].body).lifecycle[0].modelId).toBe('claude-fable-5-1');
      const rerun = freshnessObservation('100', '2026-10-09T12:00:00.000Z');
      rerun.run.attempt = 2;
      expect((await publishFreshness(rerun, api.github, 'refs/heads/main')).action).toBe('rejected-older-observation');
    }
  });

  test('higher run ID cannot publish an older check timestamp, but a newer attempt can advance the same run', async () => {
    const api = mockGitHub();
    await publishFreshness(freshnessObservation('100', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main');
    expect((await publishFreshness(freshnessObservation('101', '2026-10-07T12:00:00.000Z'), api.github, 'refs/heads/main')).action).toBe('rejected-older-observation');
    const rerun = freshnessObservation('100', '2026-10-09T12:00:00.000Z');
    rerun.run.attempt = 2;
    expect((await publishFreshness(rerun, api.github, 'refs/heads/main')).action).toBe('updated');
  });

  test('non-main is report-only with zero GitHub operations; a non-main default disables writes', async () => {
    const api = mockGitHub();
    expect((await publishFreshness(freshnessObservation(), api.github, 'refs/heads/feature')).action).toBe('report-only');
    expect(api.calls).toEqual([]);
    api.setIdentity({ defaultBranch: 'develop', sourceSha256: freshnessCatalog.sourceSha256 });
    await expect(publishFreshness(freshnessObservation(), api.github, 'refs/heads/main')).rejects.toThrow('default-branch-is-not-main');
    expect(api.calls).not.toContain('create');
  });

  test('obsolete local catalog and catalog change immediately before write are rejected', async () => {
    const api = mockGitHub();
    api.setIdentity({ defaultBranch: 'main', sourceSha256: 'b'.repeat(64) });
    expect((await publishFreshness(freshnessObservation(), api.github, 'refs/heads/main')).action).toBe('rejected-obsolete-catalog');
    expect(api.calls).not.toContain('list');
    api.setIdentity({ defaultBranch: 'main', sourceSha256: freshnessCatalog.sourceSha256 });
    api.github.listIssues = async () => { api.setIdentity({ defaultBranch: 'main', sourceSha256: 'c'.repeat(64) }); return []; };
    expect((await publishFreshness(freshnessObservation(), api.github, 'refs/heads/main')).action).toBe('rejected-obsolete-catalog');
    expect(api.issues).toHaveLength(0);
  });

  test('final issue read preserves human text added during the authoritative catalog check', async () => {
    const body = writeFreshnessIssue('', assessFreshness(freshnessObservation()));
    const api = mockGitHub([{ number: 1, body, state: 'closed' }]);
    const authority = api.github.defaultCatalog;
    api.github.defaultCatalog = async signal => {
      const identity = await authority(signal);
      if (api.calls.includes('list')) api.issues[0].body += '\nLate maintainer note';
      return identity;
    };
    await publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main');
    expect(api.issues[0].body.endsWith('\nLate maintainer note')).toBe(true);
  });

  test('final issue read rejects an older observation when newer authoritative history arrives during the catalog check', async () => {
    const api = mockGitHub([{ number: 1, body: writeFreshnessIssue('', assessFreshness(freshnessObservation())), state: 'closed' }]);
    const authority = api.github.defaultCatalog;
    api.github.defaultCatalog = async signal => {
      const identity = await authority(signal);
      if (api.calls.includes('list')) api.issues[0] = { ...api.issues[0], state: 'open', body: writeFreshnessIssue(api.issues[0].body, assessFreshness(freshnessObservation('102', '2026-10-09T12:00:00.000Z', { 'anthropic-lifecycle': retirementFixture() }))) };
      return identity;
    };
    expect((await publishFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z'), api.github, 'refs/heads/main')).action).toBe('rejected-older-observation');
    expect(api.calls).not.toContain('update');
    expect(readFreshnessIssue(api.issues[0].body).state?.latest.run.id).toBe('102');
    expect(readFreshnessIssue(api.issues[0].body).lifecycle[0].state).toBe('deprecated');
  });

  test('publication has a separate exact sixty-second deadline and aborts the blocked API', async () => {
    const real = globalThis.setTimeout;
    const installed: number[] = [];
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => { installed.push(ms); return real(callback, 5); }) as typeof setTimeout);
    const api = mockGitHub();
    let signal: AbortSignal | undefined;
    api.github.defaultCatalog = async input => { signal = input; return new Promise(() => {}); };
    try { await expect(publishFreshness(freshnessObservation(), api.github, 'refs/heads/main')).rejects.toThrow('deadline-exceeded'); }
    finally { timers.mockRestore(); }
    expect(installed).toEqual([60_000]);
    expect(signal?.aborted).toBe(true);
    expect(api.issues).toHaveLength(0);
  });
});

describe('network adapter, real catalog and CLI seams', () => {
  test('real catalog export and canonical hash bind the four identities and separate source-file hash', () => {
    const source = readFileSync(new URL('../lib/model-catalog.ts', import.meta.url), 'utf8');
    const identity = freshnessCatalogIdentity(source);
    expect(identity.sha256).toBe(modelCatalogSha256());
    expect(identity.sourceSha256).toBe(sha256(source));
    expect(identity.models).toEqual(MODEL_CATALOG.map(entry => ({ provider: entry.provider, tier: entry.tier, modelId: entry.model })));
  });

  test('GitHub reads all-state paginated issues, ignores PRs, and compares remote bytes without executing them', async () => {
    const calls: { url: string; method?: string }[] = [];
    const text = 'untrusted TS is data, never import or eval';
    const api = freshnessGitHub('owner/repo', 'fixture', async (url, init) => {
      calls.push({ url, method: init.method });
      expect(init.redirect).toBe('error');
      if (url.endsWith('/repos/owner/repo')) return Response.json({ default_branch: 'main' });
      if (url.includes('/contents/')) return Response.json({ encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) });
      if (new URL(url).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: '', state: 'closed', user: { login: FRESHNESS_ISSUE_AUTHOR }, ...(i === 0 ? {} : { pull_request: {} }) })));
      if (new URL(url).searchParams.get('page') === '2') return Response.json([{ number: 101, body: FRESHNESS_ISSUE_MARKER, state: 'closed', user: { login: FRESHNESS_ISSUE_AUTHOR } }]);
      return Response.json({ number: 101, body: FRESHNESS_ISSUE_MARKER, state: 'closed', user: { login: FRESHNESS_ISSUE_AUTHOR } });
    });
    const signal = new AbortController().signal;
    expect(await api.defaultCatalog(signal)).toEqual({ defaultBranch: 'main', sourceSha256: sha256(text) });
    expect((await api.listIssues(signal)).map(issue => issue.number)).toEqual([1, 101]);
    await api.updateIssue(101, { body: 'machine-owned data', state: 'open' }, signal);
    expect(calls.at(-1)?.method).toBe('PATCH');
    expect(calls.filter(call => call.url.includes('/issues?')).every(call => call.url.includes('state=all'))).toBe(true);
    expect(() => freshnessGitHub('owner/repo; shell', 'fixture')).toThrow('prerequisites-missing');
    await expect(freshnessGitHub('owner/repo', 'fixture', async () => new Response(null, { status: 403 })).listIssues(signal)).rejects.toThrow('github-http-403');
  });

  test('creator-filtered discovery stays one request with more than one hundred unrelated issues and PRs', async () => {
    const unrelated = Array.from({ length: 301 }, (_, i) => ({ number: i + 1, body: 'Unrelated public issue body', state: 'open', user: { login: 'ordinary-user' }, ...(i % 2 ? { pull_request: {} } : {}) }));
    const items = [...unrelated, { number: 9000, body: FRESHNESS_ISSUE_MARKER, state: 'closed', user: { login: FRESHNESS_ISSUE_AUTHOR } }];
    const requests: URL[] = [];
    const api = freshnessGitHub('owner/repo', 'fixture', async url => {
      const request = new URL(url);
      requests.push(request);
      const creator = request.searchParams.get('creator');
      const selected = creator ? items.filter(issue => issue.user.login === creator) : items;
      const page = Number(request.searchParams.get('page'));
      return Response.json(selected.slice((page - 1) * 100, page * 100));
    });
    const found = await api.listIssues(new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('creator')).toBe(FRESHNESS_ISSUE_AUTHOR);
    expect(requests[0].searchParams.get('state')).toBe('all');
    expect(found.map(issue => issue.number)).toEqual([9000]);
  });

  test('creator filter never replaces returned-owner validation', async () => {
    const api = freshnessGitHub('owner/repo', 'fixture', async () => Response.json([{ number: 7, body: FRESHNESS_ISSUE_MARKER, state: 'open', user: { login: 'untrusted-user' } }]));
    await expect(api.listIssues(new AbortController().signal)).rejects.toThrow('github-issue-owner-filter-mismatch');
  });

  test('CLI non-main --publish still has no GitHub calls; main publication failure preserves source receipts and fails honestly', async () => {
    const api = mockGitHub();
    const fetcher = async (url: string) => new Response(freshnessFixture(FRESHNESS_SOURCES.find(source => source.url === url)!.id));
    const env = { GITHUB_REF: 'refs/heads/feature', GITHUB_RUN_ID: '100', GITHUB_SHA: 'a'.repeat(40) };
    const result = await runModelPolicyFreshness({ env, fetcher, github: api.github, publish: true, now: () => '2026-10-07T12:00:00.000Z' });
    expect(result.publication?.action).toBe('report-only');
    expect(api.calls).toEqual([]);
    api.github.defaultCatalog = async () => { throw new Error('github-http-403'); };
    const failed = await runModelPolicyFreshness({ env: { ...env, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'fixture' }, fetcher, github: api.github, publish: true, now: () => '2026-10-07T12:00:00.000Z' });
    expect(failed.publication?.action).toBe('failed');
    expect(failed.report.status).toBe('unknown/source-unavailable');
    expect(failed.observation.sources.filter(source => source.receipt)).toHaveLength(4);
    expect(api.issues).toHaveLength(0);
  });
});

describe('weekly/manual workflow contract', () => {
  test('one repository-wide serialized group, advisory schedule, main writes and non-main reports', () => {
    const text = readFileSync(new URL('../.github/workflows/model-policy-freshness.yml', import.meta.url), 'utf8');
    const workflow = Bun.YAML.parse(text) as { concurrency: { group: string; 'cancel-in-progress': boolean }; on: { schedule: { cron: string }[]; workflow_dispatch: unknown }; jobs: Record<string, { steps: { name?: string; if?: string; run?: string }[] }> };
    expect(workflow.concurrency).toEqual({ group: 'model-policy-freshness', 'cancel-in-progress': false });
    expect(workflow.on.schedule).toEqual([{ cron: '0 11 * * 1' }]);
    expect(Object.keys(workflow.jobs)).toEqual(['advisory']);
    expect(text).toContain('name: Model-policy freshness');
    expect(text).toContain('workflow_dispatch:');
    expect(text).toContain("cron: '0 11 * * 1'");
    expect(text.match(/group:/g)).toHaveLength(1);
    expect(text).toContain('group: model-policy-freshness\n  cancel-in-progress: false');
    expect(text).not.toContain('model-policy-freshness-${{ github.ref }}');
    expect(text).toContain("if: github.ref == 'refs/heads/main'");
    expect(text).toContain("if: github.ref != 'refs/heads/main'");
    expect(text).toContain('run: bun scripts/model-policy-freshness.ts --publish');
    expect(text).toContain('run: bun scripts/model-policy-freshness.ts\n');
    expect(text).toContain('if-no-files-found: error');
    expect(text).toContain('if: always()');
    expect(text).toContain('bun-version: 1.4.2');
    expect(text).toContain('persist-credentials: false');
    expect(text).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(text.match(/secrets\.[A-Z_]+/g)).toEqual(['secrets.GITHUB_TOKEN']);
    expect(text).not.toMatch(/pull_request|ANTHROPIC_API_KEY|OPENAI_API_KEY|codex exec|claude -p|gh issue|eval:bg|gstack-config set/);
    expect(text.match(/uses: [^\n]+/g)?.every(line => /@[a-f0-9]{40}$/.test(line))).toBe(true);
  });
});
