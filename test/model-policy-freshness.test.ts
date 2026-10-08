import { describe, expect, test, spyOn } from 'bun:test';
import { collectFreshnessSources, fetchOfficialSource, FRESHNESS_BOUNDS, FRESHNESS_SOURCES, lifecycleDate, parseOfficialSource, parseOfficialSourceBounded, withinDeadline } from '../lib/model-policy-freshness-sources';
import { assessFreshness, renderFreshnessReport, storedEvidenceStatus, validEvidence, validLifecycle, validState } from '../lib/model-policy-freshness';
import { freshnessFixture, freshnessObservation, freshnessReplacementObservation, retirementFixture } from './fixtures/model-policy-freshness.ts';

describe('official recommendation and lifecycle structures', () => {
  test('four official fixtures parse, with Mythos and replacement mentions excluded', () => {
    const observation = freshnessObservation();
    expect(assessFreshness(observation).status).toBe('current');
    const anthropic = parseOfficialSource('anthropic-models', freshnessFixture('anthropic-models'));
    expect(anthropic.recommendations).toEqual({ frontier: 'claude-fable-5-1', smart: 'claude-opus-5-5' });
    expect(anthropic.lineup).not.toContain('claude-mythos-5-1');
    const openai = parseOfficialSource('openai-lifecycle', freshnessFixture('openai-lifecycle'));
    expect(openai.lifecycle?.map(row => row.modelId)).toEqual(['gpt-5.3-codex', 'gpt-old', 'gpt-unicode-date', 'gpt-iso-date', 'gpt-date-floor']);
    expect(openai.lifecycle?.find(row => row.modelId === 'gpt-date-floor')).toMatchObject({ deadline: null, supportFloor: '2024-06-13' });
  });

  test('known-family and actual unknown-family lineup replacements become candidates', () => {
    const known = freshnessFixture('anthropic-models').replaceAll('fable-5-1', 'fable-5-2').replaceAll('Fable 5.1', 'Fable 5.2');
    const knownReport = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-models': known }));
    expect(knownReport.status).toBe('update-candidate');
    expect(knownReport.candidates[0].reason).toBe('changed-monitored-family-recommendation');
    const unknown = freshnessFixture('anthropic-models').replaceAll('fable-5-1', 'mythos-5-1').replaceAll('Fable 5.1', 'Mythos 5.1');
    const report = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-models': unknown }));
    expect(report.status).toBe('update-candidate');
    expect(report.candidates[0]).toMatchObject({ proposed: 'claude-mythos-5-1', reason: 'unknown-replacement-family-needs-triage' });
    expect(report.complete).toBe(true);
  });

  test('OpenAI full-catalog newer IDs alone are not recommendations', () => {
    const original = freshnessFixture('openai-models');
    expect(assessFreshness(freshnessObservation()).candidates).toEqual([]);
    const changed = original.replaceAll('gpt-6.1-sol', 'gpt-6.2-sol').replaceAll('GPT-6.1 Sol', 'GPT-6.2 Sol');
    expect(assessFreshness(freshnessObservation('100', undefined, { 'openai-models': changed })).candidates[0]).toMatchObject({ proposed: 'gpt-6.2-sol' });
  });

  test('active support floors are never retirement deadlines, even after the floor', () => {
    const parsed = parseOfficialSource('anthropic-lifecycle', freshnessFixture('anthropic-lifecycle'));
    expect(parsed.lifecycle?.[0]).toMatchObject({ state: 'active', deadline: null, supportFloor: '2027-09-01' });
    expect(assessFreshness(freshnessObservation('100', '2028-10-07T12:00:00.000Z')).state.lifecycle).toEqual([]);
  });

  test('actual API retirement and removal are urgent, incidental partner prose is ignored', () => {
    const report = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    expect(report.status).toBe('update-candidate');
    expect(report.state.lifecycle[0]).toMatchObject({ state: 'deprecated', deadline: '2026-11-01' });
    expect(renderFreshnessReport(report)).toContain('URGENT');
    expect(renderFreshnessReport(report)).toContain('Bedrock/Vertex/custom');
    const removed = assessFreshness(freshnessObservation('100', '2026-11-02T12:00:00.000Z', { 'anthropic-lifecycle': retirementFixture() }));
    expect(removed.state.lifecycle[0].state).toBe('removed');
  });

  test('OpenAI shutdown rows apply to the deprecated column, not the replacement', () => {
    const text = freshnessFixture('openai-lifecycle').replace('`gpt-5.3-codex`', '`gpt-6-astra`');
    const report = assessFreshness(freshnessObservation('100', undefined, { 'openai-lifecycle': text }));
    expect(report.state.lifecycle).toHaveLength(1);
    expect(report.state.lifecycle[0]).toMatchObject({ modelId: 'gpt-6-astra', deadline: '2027-04-01' });
  });

  test('missing required structures and semantic drift fail closed', () => {
    expect(() => parseOfficialSource('anthropic-models', freshnessFixture('anthropic-models').replace('Claude API ID', 'Google Cloud ID'))).toThrow('missing-api-id-row');
    expect(() => parseOfficialSource('anthropic-models', freshnessFixture('anthropic-models').replace('for demanding reasoning', 'for unexplained goals'))).toThrow('unrecognized-recommendation');
    expect(() => parseOfficialSource('openai-models', freshnessFixture('openai-models').replace('Balance intelligence and cost.', 'Best new model.'))).toThrow('unrecognized-recommendation');
    expect(() => parseOfficialSource('openai-lifecycle', '# New deprecations\nNo model tables')).toThrow('missing-or-ambiguous-section');
    expect(() => parseOfficialSource('openai-lifecycle', freshnessFixture('openai-lifecycle').replace('`gpt-5.3-codex`', 'gpt-5.3-codex'))).toThrow('unrecognized-deprecated-model-cell');
    expect(() => parseOfficialSource('anthropic-lifecycle', freshnessFixture('anthropic-lifecycle').replace('Active', 'Probably active'))).toThrow('unrecognized-lifecycle-state');
    expect(() => lifecycleDate('February 30, 2027')).toThrow('malformed-lifecycle-date');
    expect(() => lifecycleDate('tomorrow')).toThrow('malformed-lifecycle-date');
    expect(() => parseOfficialSource('anthropic-models', `${freshnessFixture('anthropic-models')}\n## Compare models\nDuplicate`)).toThrow('ambiguous-section');
    expect(() => parseOfficialSource('anthropic-models', freshnessFixture('anthropic-models').replace('## Using the Models API', 'Use [Other](https://platform.claude.com/docs/en/models/opus-5-5/overview) for demanding reasoning.\n\n## Using the Models API'))).toThrow('unrecognized-recommendation');
  });
});

describe('bounded fixed-source fetching', () => {
  test('exact byte limit passes and a streamed byte beyond it fails without trusting content-length', async () => {
    const atCap = 'x'.repeat(FRESHNESS_BOUNDS.responseBytes);
    expect((await fetchOfficialSource('openai-models', async () => new Response(atCap))).bytes).toBe(2_097_152);
    await expect(fetchOfficialSource('openai-models', async () => new Response(`${atCap}x`))).rejects.toThrow('response-too-large');
    await expect(fetchOfficialSource('openai-models', async () => new Response('x', { headers: { 'content-length': '2097153' } }))).rejects.toThrow('response-too-large');
    expect(() => parseOfficialSource('openai-models', `${atCap}x`)).toThrow('response-too-large');
  });

  test('all redirect destinations are checked; three redirects pass, four fail', async () => {
    const credentialUrl = new URL(FRESHNESS_SOURCES[2].url);
    credentialUrl.username = 'user';
    credentialUrl.password = 'pass';
    for (const location of ['https://evil.example/models.md', 'http://developers.openai.com/api/docs/models.md', credentialUrl.href, 'https://developers.openai.com/api/docs/models.md?untrusted=1']) {
      let calls = 0;
      await expect(fetchOfficialSource('openai-models', async () => { calls++; return new Response(null, { status: 302, headers: { location } }); })).rejects.toThrow('redirect-not-allowlisted');
      expect(calls).toBe(1);
    }
    let calls = 0;
    expect((await fetchOfficialSource('openai-models', async () => ++calls <= 3 ? new Response(null, { status: 302, headers: { location: FRESHNESS_SOURCES[2].url } }) : new Response('data'))).text).toBe('data');
    calls = 0;
    await expect(fetchOfficialSource('openai-models', async () => { calls++; return new Response(null, { status: 302, headers: { location: FRESHNESS_SOURCES[2].url } }); })).rejects.toThrow('redirect-limit');
    expect(calls).toBe(4);
  });

  test('per-response and whole-check clocks are installed at the exact approved bounds', async () => {
    const installed: number[] = [];
    const real = globalThis.setTimeout;
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, milliseconds: number) => {
      installed.push(milliseconds);
      return real(callback, milliseconds === 30_000 ? 5 : milliseconds);
    }) as typeof setTimeout);
    try {
      const result = await collectFreshnessSources(async () => new Promise<Response>(() => {}));
      expect(result.every(source => source.error === 'deadline-exceeded')).toBe(true);
      expect(installed.filter(ms => ms === 30_000)).toHaveLength(4);
      expect(installed).toContain(180_000);
    } finally { timers.mockRestore(); }
    const controller = new AbortController();
    await expect(withinDeadline(new Promise(() => {}), 5, controller)).rejects.toThrow('deadline-exceeded');
    expect(controller.signal.aborted).toBe(true);
  });

  test('only four fixed sources are fetched and failures never become parseable success', async () => {
    const urls: string[] = [];
    const result = await collectFreshnessSources(async (url, init) => {
      urls.push(url);
      expect(init.redirect).toBe('manual');
      const id = FRESHNESS_SOURCES.find(source => source.url === url)!.id;
      return id === 'openai-lifecycle' ? new Response('authentication needed', { status: 403 }) : new Response(freshnessFixture(id));
    });
    expect(urls.sort()).toEqual(FRESHNESS_SOURCES.map(source => source.url).sort());
    expect(result.find(source => source.id === 'openai-lifecycle')?.error).toBe('http-403');
    const observation = freshnessObservation();
    observation.sources = result;
    expect(assessFreshness(observation).status).toBe('unknown/source-unavailable');
  });

  test('CPU-bound parsing is terminable and the complete-check deadline stops all blocked parsers', async () => {
    let terminations = 0;
    const createWorker = () => ({ postMessage() {}, terminate() { terminations++; }, onmessage: null, onerror: null }) as unknown as Worker;
    const controller = new AbortController();
    const blocked = parseOfficialSourceBounded('openai-models', freshnessFixture('openai-models'), controller.signal, createWorker);
    controller.abort();
    await expect(blocked).rejects.toThrow('deadline-exceeded');
    expect(terminations).toBe(1);
    const real = globalThis.setTimeout;
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => real(callback, ms === 180_000 ? 5 : ms)) as typeof setTimeout);
    try {
      const result = await collectFreshnessSources(async url => new Response(freshnessFixture(FRESHNESS_SOURCES.find(source => source.url === url)!.id)), createWorker);
      expect(result.every(source => source.error && !source.receipt)).toBe(true);
    } finally { timers.mockRestore(); }
    expect(terminations).toBe(5);
  });
});

describe('trustworthy evidence and deterministic statuses', () => {
  test('source-check evidence is separate from catalog qualification and survives artifact expiry', () => {
    const report = assessFreshness(freshnessObservation());
    expect(validState(report.state)).toBe(true);
    expect(validEvidence(report.state.lastSuccess)).toBe(true);
    expect(report.state.lastSuccess?.nextCheckDueBy).toBe('2026-10-14T12:00:00.000Z');
    expect(report.state.lastSuccess?.sources).toHaveLength(4);
    expect(report.state.lastSuccess?.catalog).toEqual(freshnessObservation().catalog);
    expect(storedEvidenceStatus(freshnessObservation().catalog, JSON.parse(JSON.stringify(report.state.lastSuccess)), '2026-10-08T12:00:00.000Z')).toBe('current');
    expect(renderFreshnessReport(report)).toContain('not automatic liveness monitoring');
  });

  test('missing/corrupt/mismatched/future evidence is unknown; thirty-day staleness has an exact boundary', () => {
    const observation = freshnessObservation();
    const evidence = assessFreshness(observation).state.lastSuccess!;
    expect(storedEvidenceStatus(observation.catalog, null, observation.checkedAt)).toBe('unknown/source-unavailable');
    expect(storedEvidenceStatus({ ...observation.catalog, sha256: 'b'.repeat(64) }, evidence, observation.checkedAt)).toBe('unknown/source-unavailable');
    expect(storedEvidenceStatus(observation.catalog, { ...evidence, parserVersion: 99 }, observation.checkedAt)).toBe('unknown/source-unavailable');
    expect(storedEvidenceStatus(observation.catalog, evidence, '2026-10-06T12:00:00.000Z')).toBe('unknown/source-unavailable');
    expect(storedEvidenceStatus(observation.catalog, evidence, '2026-11-06T12:00:00.000Z')).toBe('current');
    expect(storedEvidenceStatus(observation.catalog, evidence, '2026-11-06T12:00:00.001Z')).toBe('stale');
  });

  test('partial recovery cannot refresh evidence or erase an unresolved retirement', () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    const next = assessFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z', { 'openai-lifecycle': null }), initial.state);
    expect(next.status).toBe('unknown/source-unavailable');
    expect(next.state.lastSuccess).toEqual(initial.state.lastSuccess);
    expect(next.state.lifecycle).toEqual(initial.state.lifecycle);
    const old = assessFreshness(freshnessObservation('102', '2026-11-08T12:00:00.000Z', { 'openai-lifecycle': null }), next.state);
    expect(old.evidenceStatus).toBe('stale');
    expect(old.status).toBe('unknown/source-unavailable');
    const recovered = assessFreshness(freshnessObservation('103', '2026-11-09T12:00:00.000Z'), old.state);
    expect(recovered.status).toBe('update-candidate');
    expect(recovered.state.lifecycle).toEqual(old.state.lifecycle);
  });

  test('corrupt duplicate lifecycle keys and source receipts cannot certify current', () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    expect(validLifecycle([initial.state.lifecycle[0], initial.state.lifecycle[0]])).toBe(false);
    const observation = freshnessObservation();
    observation.sources[0].receipt!.finalUrl = 'https://evil.example/docs';
    expect(assessFreshness(observation).status).toBe('unknown/source-unavailable');
    const evidence = structuredClone(initial.state.lastSuccess!);
    evidence.sources[0] = evidence.sources[1];
    expect(validEvidence(evidence)).toBe(false);
    expect(validState({ ...initial.state, lastSuccess: evidence })).toBe(false);
  });

  test('a partial run cannot downgrade an unresolved retirement to legacy or extend its deadline', () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    const legacy = freshnessFixture('anthropic-lifecycle').replace('claude-fable-5-1 | Active', 'claude-fable-5-1 | Legacy');
    const report = assessFreshness(freshnessObservation('101', '2026-10-08T12:00:00.000Z', { 'anthropic-lifecycle': legacy, 'openai-lifecycle': null }), initial.state);
    expect(report.state.lifecycle[0]).toMatchObject({ state: 'deprecated', deadline: '2026-11-01' });
    expect(report.state.lastSuccess).toEqual(initial.state.lastSuccess);
  });

  test('only a complete check of a reviewed replacement catalog resolves removed identities', () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    const replacement = freshnessObservation('101', '2026-10-08T12:00:00.000Z');
    replacement.catalog.models[0].modelId = 'claude-fable-5-2';
    replacement.catalog.sha256 = 'b'.repeat(64);
    replacement.sources = freshnessObservation('101', replacement.checkedAt, {
      'anthropic-models': freshnessFixture('anthropic-models').replaceAll('fable-5-1', 'fable-5-2'),
      'anthropic-lifecycle': freshnessFixture('anthropic-lifecycle').replaceAll('fable-5-1', 'fable-5-2'),
    }).sources;
    const incomplete = structuredClone(replacement);
    incomplete.sources[3] = { id: 'openai-lifecycle', error: 'http-503' };
    expect(assessFreshness(incomplete, initial.state).state.lifecycle[0].resolvedByCatalog).toBeUndefined();
    const complete = assessFreshness(replacement, initial.state);
    expect(complete.status).toBe('current');
    expect(complete.state.lifecycle[0].resolvedByCatalog).toBe('b'.repeat(64));
  });

  test('complete catalog rollback reopens the historical retirement even when the current source row is active', () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    const replacement = assessFreshness(freshnessReplacementObservation(), initial.state);
    expect(replacement.status).toBe('current');
    expect(replacement.state.lifecycle[0].resolvedByCatalog).toBe('b'.repeat(64));
    const rollback = assessFreshness(freshnessObservation('102', '2026-10-09T12:00:00.000Z'), replacement.state);
    expect(rollback.status).toBe('update-candidate');
    expect(rollback.state.lifecycle[0]).toMatchObject({ state: 'deprecated', deadline: '2026-11-01', firstObservedAt: initial.state.lifecycle[0].firstObservedAt });
    expect(rollback.state.lifecycle[0].resolvedByCatalog).toBeUndefined();
    expect(replacement.state.lifecycle[0].resolvedByCatalog).toBe('b'.repeat(64));
  });

  test('source-unavailable catalog rollback reopens history without refreshing prior replacement evidence', () => {
    const initial = assessFreshness(freshnessObservation('100', undefined, { 'anthropic-lifecycle': retirementFixture() }));
    const replacement = assessFreshness(freshnessReplacementObservation(), initial.state);
    const rollback = assessFreshness(freshnessObservation('102', '2026-10-09T12:00:00.000Z', { 'anthropic-lifecycle': null, 'openai-lifecycle': null }), replacement.state);
    expect(rollback.status).toBe('unknown/source-unavailable');
    expect(rollback.state.lastSuccess).toEqual(replacement.state.lastSuccess);
    expect(rollback.state.lifecycle[0]).toMatchObject({ state: 'deprecated', deadline: '2026-11-01' });
    expect(rollback.state.lifecycle[0].resolvedByCatalog).toBeUndefined();
  });
});
