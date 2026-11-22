/**
 * The Capy pass program when an outside voice hangs, stops or is refused on cyber policy (R95).
 * Split from test/review-pass.test.ts; shared fixtures live in test/helpers/review-pass-harness.ts.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { READ_ONLY_RETRY } from '../lib/review-brief';
import { planCyberRetry, type Manifest } from '../lib/review-pass';
import { ROOT, BIN, repo, cleanReply, host, runPass, bin } from './helpers/review-pass-harness';

describe('Capy pass program (fake host, real bins)', () => {
  // Value: protects=GST-1104 (TRUT-7, truther#1159): an outside voice that runs past the stuck limit, or ends stopped or failed with no result, is stopped and recorded as unavailable coverage under its own runner and model, and Step 11 goes on to judge the native voice; fails_when=the stuck subagent is left running (TRUT-7 p2 burned 16.9M tokens before anyone stopped it), the pass stops with nothing recorded, or the returned record names no host-subagent runner so the review-log row falls back to the template's codex;
  //   why_new=GST-1104; seam=lib/capy-review-pass.js reader poll; no_claim=which outside model Step 11 picks
  test('an outside voice that hangs or stops with no result is stopped and recorded unavailable as the host subagent, and Step 11 goes on (GST-1104)', async () => {
    for (const [pass, o] of [['x30p1', { hang: (t: string) => t.endsWith('outside-voice') }], ['x31p1', { stopped: (t: string) => t.endsWith('outside-voice') }], ['x32p1', { fail: (t: string) => t.endsWith('outside-voice') }]] as const) {
      const { dir, env } = repo();
      const out = path.join(dir, '.state/run/p1');
      const h = host(dir, env, { ...o, epoch: Date.now() });
      const base = { base: 'main', out, pass, planFlags: ['--depth-floor', 'full'] };
      expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
      let res = '';
      for (let i = 0; i < 6; i++) {
        res = await runPass(h, { ...base, stage: 'voices', stuckMs: 60_000 });
        if (!res.includes('NEXT: poll')) break;
      }
      expect(res).not.toContain('STOP:');
      expect(res).toContain('COLLECT_UNAVAILABLE: reader=outside-voice');
      expect(res).toContain('OUTSIDE_RECORD: "outside_provider":"host-subagent","outside_model":"openai/gpt-6.2-sol","outside_status":"unavailable"');
      expect(res).toContain('first write this voice its own adversarial-review row with "source":"host-subagent","status":"unavailable","completed":false,"converged":false and no --finish, then the native row');
      expect(res).toContain('NEXT: judge the voices');
      if ('hang' in o) {
        const token = /REVIEW_LOG_START: adversarial-review token=(\S+)/.exec(res)![1]!;
        const record = /OUTSIDE_RECORD: (\S+)/.exec(res)![1]!;
        const log = (row: string, a: string[] = []) => spawnSync(path.join(BIN, 'gstack-review-log'), [row, ...a], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
        expect(log('{"skill":"adversarial-review","status":"unavailable","source":"host-subagent",' + record + ',"phase":"adversarial","completed":false,"converged":false}').status).toBe(0);
        expect(log('{"skill":"adversarial-review","status":"clean","source":"in-host",' + record + ',"phase":"adversarial","completed":true,"converged":true}', ['--finish', token]).status).toBe(0);
        const rows = spawnSync(path.join(BIN, 'gstack-review-read'), [], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }).stdout.split('---CONFIG---')[0]!.trim().split('\n').map(l => JSON.parse(l));
        expect(rows.map(r => [r.source, r.outside_provider, r.outside_status, r.converged])).toEqual([['host-subagent', 'host-subagent', 'unavailable', false], ['in-host', 'host-subagent', 'unavailable', true]]);
        expect(rows[1].review_freshness).toMatchObject({ status: 'CURRENT' });
      }
      const ov = [...h.subs].find(([, s]) => s.title === 'ship ' + pass + ' outside-voice')!;
      expect(ov[1].status).not.toBe('working');
      expect(h.stops).toEqual('hang' in o ? [ov[0]] : []);
      const v = bin(dir, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]);
      expect(v.stdout).toMatch(/^BRIEF outside-voice UNAVAILABLE/m);
      expect(v.stdout).not.toContain('MISMATCH');
      expect(v.stdout).toContain('unavailable=1');
    }
  }, 600_000);

  // Value: protects=GST-1104 review finding: an outside voice that wrote its report and then ended stopped or failed is collected from its summary, never replaced by unavailable coverage; fails_when=the pass records the voice unavailable without reading the summary, silently dropping its findings;
  //   why_new=GST-1104 /ship review (three readers); seam=lib/capy-review-pass.js reader poll; no_claim=what the voice found
  test('an outside voice that ends stopped or failed with a report is collected, not marked unavailable (GST-1104)', async () => {
    for (const [pass, o] of [['x33p1', { stopped: (t: string) => t.endsWith('outside-voice') }], ['x34p1', { fail: (t: string) => t.endsWith('outside-voice') }]] as const) {
      const { dir, env } = repo();
      const out = path.join(dir, '.state/run/p1');
      const h = host(dir, env, { ...o, keepSummary: true, output: (t: string) => (t.endsWith('outside-voice') ? '1. **A guard fails open** - `src/a.ts:1` accepts any input. Severity: Medium. Blocks: no.\n\nRecommendation: fix the guard because it fails open' : cleanReply(t)), epoch: Date.now() });
      const base = { base: 'main', out, pass, planFlags: ['--depth-floor', 'full'] };
      expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
      let res = '';
      for (let i = 0; i < 6; i++) {
        res = await runPass(h, { ...base, stage: 'voices', stuckMs: 60_000 });
        if (!res.includes('NEXT: poll')) break;
      }
      expect(res).not.toContain('STOP:');
      expect(res).not.toContain('COLLECT_UNAVAILABLE: reader=outside-voice');
      expect(res).toContain('OUTSIDE_RECORD: "outside_provider":"host-subagent","outside_model":"openai/gpt-6.2-sol","outside_status":"completed"');
      expect(res).toContain('NEXT: judge the voices');
    }
  }, 600_000);

  // Value: protects=GST-1104 review finding: an outside voice that ends stopped or failed with a summary that is not a review is recorded unavailable and Step 11 goes on; fails_when=collect's COLLECT_NOT_REVIEWED stops the pass and every rerun stops the same way;
  //   why_new=GST-1104 /ship review round 2; seam=lib/capy-review-pass.js reader collect; no_claim=what the summary says
  test('an outside voice that ends stopped with a non-review summary is recorded unavailable, not a stuck pass (GST-1104)', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env, { stopped: (t: string) => t.endsWith('outside-voice'), keepSummary: true, output: (t: string) => (t.endsWith('outside-voice') ? 'Stopped before I could read the diff.' : cleanReply(t)), epoch: Date.now() });
    const base = { base: 'main', out, pass: 'x35p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    let res = '';
    for (let i = 0; i < 6; i++) {
      res = await runPass(h, { ...base, stage: 'voices', stuckMs: 60_000 });
      if (!res.includes('NEXT: poll')) break;
    }
    expect(res).not.toContain('STOP:');
    expect(res).toContain('COLLECT_UNAVAILABLE: reader=outside-voice');
    expect(res).toContain('"outside_status":"unavailable"');
    expect(res).toContain('NEXT: judge the voices');
    const v = bin(dir, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]);
    expect(v.stdout).toMatch(/^BRIEF outside-voice UNAVAILABLE/m);
    expect(v.stdout).not.toContain('MISMATCH');
    expect(v.stdout).not.toContain('NOT_REVIEWED');
  }, 300_000);

  // R95 (2026-11-13): a cyber_policy refusal of the outside voice is retried once on GPT-6 Astra with the read-only brief, then on Gemini 4 Carbon with the original brief; when every attempt fails the second-family read is missing, disclosed, and Step 11 goes on.
  const CYBER = fs.readFileSync(path.join(ROOT, 'test/fixtures/cyber-policy/capy-latest-error.txt'), 'utf8').trim();
  const voiceReply = (t: string) => (t.includes('outside-voice') ? 'Recommendation: ship as-is because no finding survived' : cleanReply(t));
  async function refusedVoices(pass: string, error: (title: string) => string | undefined, lane: Record<string, unknown> = {}) {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env, { error, output: voiceReply, epoch: Date.now() });
    const base = { base: 'main', out, pass, planFlags: ['--depth-floor', 'full'], ...lane };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    let res = '', all = '';
    for (let i = 0; i < 12; i++) {
      res = await runPass(h, { ...base, stage: 'voices', stuckMs: 60_000 });
      all += res + '\n';
      if (!res.includes('NEXT: poll')) break;
    }
    const created = (suffix: string) => h.creates.find(c => c.title === 'ship ' + pass + ' ' + suffix);
    const verify = bin(dir, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout;
    return { res, all, h, created, verify, base };
  }

  // Value: protects=R95 on the real pass program: Capy's captured cyber_policy refusal of the Sol outside voice is recorded unavailable with its own reason and retried once on openai/gpt-6-astra with the read-only brief, whose review is the Step 11 outside record; fails_when=the refusal is recorded as a plain failure with no retry, the retry resends the original brief, or the original's unavailable record replaces the retry's;
  //   why_new=R95; seam=lib/capy-review-pass.js ended outside voice; no_claim=that Astra finishes a real refused brief (one live smoke in GSTA-537)
  test('a cyber_policy refusal is retried once on Astra with the read-only brief (R95)', async () => {
    const { res, all, h, created, verify } = await refusedVoices('x40p1', t => (t.endsWith(' outside-voice') ? CYBER : undefined));
    expect(res).not.toContain('STOP:');
    expect(all).toContain('RETRY: reader=outside-voice/astra-read-only model=openai/gpt-6-astra brief=read-only');
    expect(all).toMatch(/COLLECT_UNAVAILABLE: reader=outside-voice .*/);
    const astra = created('outside-voice/astra-read-only')!;
    expect(astra.model).toEqual({ model_id: 'openai/gpt-6-astra', reasoning_mode: 'high' });
    expect(astra.prompt).toContain(READ_ONLY_RETRY);
    expect(astra.prompt).not.toContain('Think like an attacker');
    expect(created('outside-voice')!.prompt).toContain('Think like an attacker and a chaos engineer.');
    expect(created('outside-voice/gemini-4-carbon')).toBeUndefined();
    expect(res).toContain('OUTSIDE_RECORD: "outside_provider":"host-subagent","outside_model":"openai/gpt-6-astra","outside_status":"completed","outside_note":"second-family read by openai/gpt-6-astra on the read-only retry brief after cyber_policy refused openai/gpt-6.2-sol"');
    expect(res).not.toContain('"outside_model":"openai/gpt-6.2-sol"');
    expect(res).toContain('NEXT: judge the voices');
    expect(verify).toMatch(/^BRIEF outside-voice UNAVAILABLE/m);
    expect(verify).toMatch(/^OUTPUT outside-voice UNAVAILABLE .*reason=".*cyber_policy/m);
    expect(verify).toMatch(/^BRIEF outside-voice\/astra-read-only MATCH/m);
    expect(verify).not.toContain('MISMATCH');
    expect(verify).toMatch(/^VERIFY: .* unavailable=1$/m);
    expect(h.creates.filter(c => c.title.includes('outside-voice')).length).toBe(2);
  }, 600_000);

  // Value: protects=an Astra refusal of the retry falls through to google/gemini-4-carbon with the original brief byte for byte, and a refusal or failure there records the second-family read as missing (a disclosed gap, not a pass) while Step 11 goes on to the native voice; fails_when=a fourth attempt starts, Gemini gets the reworded brief, or the exhausted chain STOPs the pass;
  //   why_new=R95; seam=lib/capy-review-pass.js retry chain; no_claim=Gemini's availability under another organization's model policy
  test('an Astra refusal falls through to Gemini 4 Carbon with the original brief, then the second-family read is missing (R95)', async () => {
    const { res, all, h, created, verify } = await refusedVoices('x41p1', t => (/outside-voice(\/astra-read-only|\/gemini-4-carbon)?$/.test(t) ? CYBER : undefined));
    expect(res).not.toContain('STOP:');
    expect(all).toContain('RETRY: reader=outside-voice/astra-read-only model=openai/gpt-6-astra brief=read-only');
    expect(all).toContain('RETRY: reader=outside-voice/gemini-4-carbon model=google/gemini-4-carbon brief=original');
    expect(all).toContain('RETRY: exhausted');
    const gemini = created('outside-voice/gemini-4-carbon')!;
    expect(gemini.model).toEqual({ model_id: 'google/gemini-4-carbon', reasoning_mode: 'high' });
    expect(gemini.prompt).toBe(created('outside-voice')!.prompt);
    expect(h.creates.filter(c => c.title.includes('outside-voice')).length).toBe(3);
    expect(res).toContain('"outside_model":"google/gemini-4-carbon","outside_status":"unavailable","outside_note":"second-family read missing: cyber_policy refused openai/gpt-6.2-sol, openai/gpt-6-astra (read-only retry brief) and google/gemini-4-carbon"');
    expect(res).toContain('first write this voice its own adversarial-review row');
    expect(res).toContain('NEXT: judge the voices');
    expect(verify).not.toContain('MISMATCH');
    expect(verify).toMatch(/^BRIEF outside-voice\/gemini-4-carbon UNAVAILABLE/m);
    expect(verify).toMatch(/^VERIFY: .* unavailable=3$/m);
  }, 900_000);

  // Value: protects=on a Google-family lane the Gemini step is skipped (Step 11 refuses an outside voice of the lane's family), so two OpenAI refusals record the second-family read as missing and a resume finishes instead of stopping; fails_when=Gemini is planned beside a Google lane and familyStop stops every resume;
  //   why_new=GSTA-537 /ship outside-voice finding (lib/review-pass.ts:274), fixed under the Captain's scoped fix-check grant; seam=planCyberRetry via gstack-review-dispatch retry; no_claim=which outside voice a Google lane should use
  test('a Google-family lane skips the Gemini retry and records the second-family read missing, with no STOP on resume (R95)', async () => {
    const lane = { laneModel: 'google/gemini-4-argon', models: { 'outside-voice': { model_id: 'openai/gpt-6.2-sol', reasoning_mode: 'medium' } } };
    const { res, all, h, created, base } = await refusedVoices('x45p1', t => (/outside-voice(\/astra-read-only)?$/.test(t) ? CYBER : undefined), lane);
    expect(all).not.toContain('STOP:');
    expect(all).toContain('RETRY: reader=outside-voice/astra-read-only model=openai/gpt-6-astra brief=read-only');
    expect(all).toContain('RETRY: exhausted reader=outside-voice/astra-read-only');
    expect(created('outside-voice/gemini-4-carbon')).toBeUndefined();
    expect(res).toContain('"outside_status":"unavailable","outside_note":"second-family read missing: cyber_policy refused openai/gpt-6.2-sol and openai/gpt-6-astra (read-only retry brief)"');
    expect(res).toContain('NEXT: judge the voices');
    const again = await runPass(h, { ...base, stage: 'voices', stuckMs: 60_000 });
    expect(again).not.toContain('STOP:');
  }, 600_000);

  // Value: protects=planCyberRetry skips only the steps whose family the lane or native voice holds: an Anthropic lane still gets Astra then Gemini, a Google lane gets Astra and then nothing; fails_when=the family check drops Gemini for every lane or keeps it beside a Google lane;
  //   why_new=GSTA-537 scoped fix-check (control for the Google-lane case); seam=lib/review-pass.ts planCyberRetry; no_claim=none
  test('planCyberRetry keeps Gemini for an Anthropic lane and skips it for a Google lane (R95)', () => {
    const chain = (taken: string[]) => {
      const m = { pass: 'u1', readers: [{ reader: 'outside-voice', role: 'outside-voice', stage: 'voices', state: 'collected' }] } as unknown as Manifest;
      const astra = planCyberRetry(m, m.readers[0]!, taken);
      return [astra?.reader, astra ? planCyberRetry(m, astra, taken)?.reader ?? null : null];
    };
    expect(chain(['anthropic'])).toEqual(['outside-voice/astra-read-only', 'outside-voice/gemini-4-carbon']);
    expect(chain(['google'])).toEqual(['outside-voice/astra-read-only', null]);
  });

  // Value: protects=only cyber_policy starts a retry: a failed voice whose host error is another provider failure, and a voice that reviews normally, each run exactly one outside voice; fails_when=any failure, or a success, dispatches an Astra or Gemini reader;
  //   why_new=R95 (no new retries for anything else; negative control); seam=lib/capy-review-pass.js; no_claim=none
  test('a non-refusal failure and a normal review never retry (R95)', async () => {
    const failed = await refusedVoices('x42p1', t => (t.endsWith(' outside-voice') ? 'OpenAI key declined the request: invalid_api_key: Incorrect API key provided.' : undefined));
    expect(failed.res).not.toContain('STOP:');
    expect(failed.all).toContain('RETRY: none');
    expect(failed.res).toContain('"outside_model":"openai/gpt-6.2-sol","outside_status":"unavailable"');
    expect(failed.h.creates.filter(c => c.title.includes('outside-voice')).length).toBe(1);
    const clean = await refusedVoices('x43p1', () => undefined);
    expect(clean.all).not.toContain('RETRY:');
    expect(clean.res).toContain('"outside_model":"openai/gpt-6.2-sol","outside_status":"completed"');
    expect(clean.res).not.toContain('outside_note');
    expect(clean.h.creates.filter(c => c.title.includes('outside-voice')).length).toBe(1);
  }, 600_000);

  // Value: protects=a voice that the host marks refused under cyber_policy but that still wrote a review is collected as that review, with its own outside record, and starts no retry; fails_when=the retry is planned before the program knows the voice left findings, so a redundant Astra reader runs and the collected voice's OUTSIDE_RECORD is dropped;
  //   why_new=GSTA-537 /ship red-team finding (capy-review-pass.js refusal before collect); seam=lib/capy-review-pass.js ended outside voice; no_claim=how often a refused voice leaves a review
  test('a cyber_policy refusal that still left a review is collected and never retried (R95)', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env, { error: t => (t.endsWith(' outside-voice') ? CYBER : undefined), keepSummary: true, output: t => (t.endsWith('outside-voice') ? '1. **A guard fails open** - `src/a.ts:1` accepts any input. Severity: Medium. Blocks: no.\n\nRecommendation: fix the guard because it fails open' : cleanReply(t)), epoch: Date.now() });
    const base = { base: 'main', out, pass: 'x44p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    let res = '', all = '';
    for (let i = 0; i < 6; i++) {
      res = await runPass(h, { ...base, stage: 'voices', stuckMs: 60_000 });
      all += res + '\n';
      if (!res.includes('NEXT: poll')) break;
    }
    expect(res).not.toContain('STOP:');
    expect(all).not.toContain('RETRY:');
    expect(h.creates.filter(c => c.title.includes('outside-voice')).length).toBe(1);
    expect(res).toContain('OUTSIDE_RECORD: "outside_provider":"host-subagent","outside_model":"openai/gpt-6.2-sol","outside_status":"completed"');
    expect(fs.readFileSync(path.join(out, 'merged.jsonl'), 'utf8')).toContain('A guard fails open');
  }, 300_000);
});
