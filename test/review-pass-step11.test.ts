/**
 * The Capy pass program's Step 11 voices: start tokens, the outside voice's model family and its default (gpt-6.2-sol since R116).
 * Split from test/review-pass.test.ts; shared fixtures live in test/helpers/review-pass-harness.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promptHash } from '../lib/review-brief';
import { type Manifest } from '../lib/review-pass';
import { manifest, repo, host, runPass, bin } from './helpers/review-pass-harness';

describe('Capy pass program (fake host, real bins)', () => {
  // Value: protects=Step 11.5 always has an adversarial-review start token to bind; fails_when=Step 11 reuses the pass input's logStart: ["review"] and runs the voices with no adversarial-review start, or a missing token is found only after the voices ran;
  //   why_new=GBRA-218 reran a whole pass after the loader example's logStart was reused for stage voices; seam=lib/capy-review-pass.js log starts; no_claim=gstack-review-read's binding itself
  test('Step 11 takes the adversarial-review start token by default and refuses a list without it before anything runs', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env);
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.2-sol' } };
    const base = { base: 'main', out, pass: 'x12p1', planFlags: ['--depth-floor', 'full'], logStart: ['review'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const created = h.creates.length;
    const reused = await runPass(h, { ...base, stage: 'voices', models });
    expect(reused).toStartWith('STOP: Step 11 (stage "voices") takes the adversarial-review start token');
    expect(h.creates.length).toBe(created);
    const voices = await runPass(h, { ...base, logStart: undefined, stage: 'voices', models });
    expect(voices).toMatch(/REVIEW_LOG_START: adversarial-review token=\S+/);
    expect(voices.indexOf('REVIEW_LOG_START: adversarial-review')).toBeLessThan(voices.indexOf('DISPATCHED:'));
    expect(voices).toContain('NEXT: judge the voices');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8'));
    expect(Object.keys(m.log_starts ?? {}).sort()).toEqual(['pass:review', 'voices:adversarial-review']);
  }, 240_000);

  // Value: protects=Step 11 on its own --out (the head moved after a fix round) renders and sends only the voices, so its ledger verifies clean; fails_when=pass renders the plan's first and specialists stages for a voices-only program, leaving BRIEF specialist-batched NOT_SENT in the ledger;
  //   why_new=GST-1368 (gstack-evals#208 at fb407fb: VERIFY: dirty briefs=4 outputs=3); seam=none; no_claim=which plan flags Step 11 takes
  test('Step 11 on a fresh --out renders only the voices, and its ledger verifies clean', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/s11');
    const h = host(dir, env);
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.2-sol' } };
    const res = await runPass(h, { base: 'main', out, pass: 'x7s11', planFlags: ['--depth-floor', 'full'], stage: 'voices', models });
    expect(res).toContain('NEXT: judge the voices');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    fs.writeFileSync(path.join(out, 'judged.jsonl'), '');
    expect(bin(dir, env, ['judge', '--ledger', m.ledger, '--merged', m.merged, '--judged', path.join(out, 'judged.jsonl')]).status).toBe(0);
    const v = bin(dir, env, ['verify', '--ledger', m.ledger]);
    expect(v.stdout).not.toContain('NOT_SENT');
    expect(v.stdout).toContain('VERIFY: clean briefs=' + m.readers.length);
    expect(m.readers.length).toBeGreaterThan(0);
    expect(m.readers.every(r => r.stage === 'voices' && r.state === 'collected')).toBe(true);
    expect(h.creates.map(c => c.title).sort()).toEqual(m.readers.map(r => r.title).sort());
    const rendered = fs.readFileSync(m.ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'rendered').map(e => e.reader);
    expect(rendered.sort()).toEqual(m.readers.map(r => r.reader).sort());
    const reviewer = bin(dir, env, ['pass', '--base', 'main', '--out', out, '--pass', 'x7s11', '--', '--depth-floor', 'full']);
    expect([reviewer.status === 0, reviewer.stderr]).toEqual([false, expect.stringContaining("holds only Step 11's voices")]);
    const extras = path.join(dir, '.state/extras.json');
    fs.writeFileSync(extras, JSON.stringify([{ name: 'plan', prompt_file: path.join(dir, 'package.json') }]));
    const audit = bin(dir, env, ['pass', '--base', 'main', '--out', path.join(dir, '.state/run/s11x'), '--pass', 'x7s11x', '--voices', '--extras', extras, '--', '--depth-floor', 'full']);
    expect([audit.status === 0, audit.stderr]).toEqual([false, expect.stringContaining("Step 11's voices pass sends no audit reader")]);
  }, 240_000);

  test('Step 11 voices run from the same manifest; the outside voice needs a model of another family', async () => {
    const { dir, env } = repo();
    const out = path.join(dir, '.state/run/p1');
    const h = host(dir, env);
    const base = { base: 'main', out, pass: 'x7p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    expect(await runPass(h, { ...base, stage: 'voices', laneModel: undefined })).toContain("STOP: the outside voice needs input.models['outside-voice']");
    expect(h.creates.some(c => c.title.startsWith('ship x7p1 ') && /adversarial|outside/.test(c.title))).toBe(false);
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.2-sol' }, 'adversarial-native': { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'high' } };
    const voices = await runPass(h, { ...base, stage: 'voices', models });
    expect(voices).toContain('NEXT: judge the voices');
    expect(voices).toContain('OUTSIDE_RECORD: "outside_provider":"host-subagent","outside_model":"openai/gpt-6.2-sol","outside_status":"completed"');
    expect(h.creates.find(c => c.title === 'ship x7p1 outside-voice')!.model).toEqual(models['outside-voice']);
    expect(h.creates.find(c => c.title === 'ship x7p1 adversarial-native')!.model).toEqual(models['adversarial-native']);
  }, 240_000);

  // Value: protects=Step 11's outside voice is never the native voice's or the lane's model family; fails_when=the STOP checks only that some model was given (lib/capy-review-pass.js before GSTA-167 PR B), so a Claude outside voice beside a Claude native voice runs as "outside";
  //   why_new=GSTA-167 plan R2 (autoplan-20261031135232); seam=none; no_claim=which family pairs find more
  test('a same-family explicit outside voice STOPs before either voice is created', async () => {
    const { dir, env } = repo();
    const h = host(dir, env);
    const base = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x14p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    expect(await runPass(h, { ...base, stage: 'voices', models: { 'outside-voice': { model_id: 'anthropic/claude-sonnet-5-5', reasoning_mode: 'medium' } } }))
      .toContain("STOP: the outside voice anthropic/claude-sonnet-5-5 is the anthropic family, the same as the lane model; Step 11 needs input.models['outside-voice'] from another family");
    expect(await runPass(h, { ...base, stage: 'voices', models: { 'outside-voice': { model_id: 'openai/gpt-6.2-sol', reasoning_mode: 'medium' }, 'adversarial-native': { model_id: 'openai/gpt-6-astra', reasoning_mode: 'high' } } }))
      .toContain('STOP: the outside voice openai/gpt-6.2-sol is the openai family, the same as the native voice');
    expect(h.creates.some(c => /^ship x14p1 (adversarial-native|outside-voice)$/.test(c.title))).toBe(false);
  }, 240_000);

  // Value: protects=a Step 11 rerun on one manifest keeps refusing a same-family outside voice, including one queued at the subagent cap that tools.subagent.start would pick up; fails_when=the family check runs only on the first render, so a resumed or queued voice starts unchecked;
  //   why_new=GSTA-167 plan R2; seam=none; no_claim=the host's cap timing
  test('a Step 11 rerun on one manifest still refuses a same-family outside voice, rendered or queued', async () => {
    const same = { 'outside-voice': { model_id: 'anthropic/claude-sonnet-5-5', reasoning_mode: 'medium' } };
    const refused = /STOP: the outside voice anthropic\/claude-sonnet-5-5 is the anthropic family/;
    const { dir, env } = repo();
    const h = host(dir, env);
    const base = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x15p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    expect(await runPass(h, { ...base, stage: 'voices', models: same })).toMatch(refused);
    expect(await runPass(h, { ...base, stage: 'voices', models: same })).toMatch(refused);
    expect(h.creates.some(c => /^ship x15p1 (adversarial-native|outside-voice)$/.test(c.title))).toBe(false);

    const b = repo();
    const h2 = host(b.dir, b.env, { reject: t => t.endsWith('outside-voice') });
    const base2 = { ...base, out: path.join(b.dir, '.state/run/p1'), pass: 'x18p1' };
    expect(await runPass(h2, base2)).toContain('NEXT: judge (Phase 4)');
    expect(await runPass(h2, { ...base2, stage: 'voices', budgetMs: 1 })).toMatch(/DISPATCHED: outside-voice path=\d+ queued/);
    const starts = h2.starts.length;
    const recorded = path.join(base2.out, 'voice-models.json');
    const kept = fs.readFileSync(recorded, 'utf8');
    fs.rmSync(recorded);
    expect(await runPass(h2, { ...base2, stage: 'voices', models: same })).toMatch(refused);
    expect(h2.starts.length).toBe(starts);
    fs.writeFileSync(recorded, kept);
    const resumed = await runPass(h2, { ...base2, stage: 'voices', models: same });
    expect(resumed).toContain('OUTSIDE_VOICE: openai/gpt-6.2-sol reasoning=medium as dispatched, started from the queue (default configuration)');
    expect(h2.creates.find(c => c.title === 'ship x18p1 outside-voice')!.model).toEqual({ model_id: 'openai/gpt-6.2-sol', reasoning_mode: 'medium' });
  }, 300_000);

  // Value: protects=a queued outside voice resumes on the models recorded when the voices were dispatched, so changed rerun inputs cannot pair it with a native voice of its own family; fails_when=the rerun's input decides the queued voice's model and the native family (outside-voice finding on #3698: two OpenAI voices started);
  //   why_new=/ship Step 11 review of #3698; seam=none; no_claim=inputs that change between reruns on purpose
  test('a queued outside voice resumes on its dispatched model, checked against the dispatched native family', async () => {
    const { dir, env } = repo();
    const h = host(dir, env, { reject: t => t.endsWith('outside-voice') });
    const base = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x19p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const first = { 'adversarial-native': { model_id: 'openai/gpt-6-astra', reasoning_mode: 'high' }, 'outside-voice': { model_id: 'google/gemini-4-argon', reasoning_mode: 'medium' } };
    expect(await runPass(h, { ...base, stage: 'voices', models: first, budgetMs: 1 })).toMatch(/DISPATCHED: outside-voice path=\d+ queued/);
    const res = await runPass(h, { ...base, stage: 'voices' });
    expect(res).not.toContain('STOP:');
    expect(res).toContain('OUTSIDE_VOICE: google/gemini-4-argon reasoning=medium as dispatched, started from the queue; outside the default configuration');
    expect(h.creates.find(c => c.title === 'ship x19p1 outside-voice')!.model).toEqual(first['outside-voice']);
    expect(h.creates.find(c => c.title === 'ship x19p1 adversarial-native')!.model).toEqual(first['adversarial-native']);
  }, 300_000);

  // Value: protects=a lane whose family is unknown or not Anthropic gets no default outside voice, and an explicit one cannot skip the family check; fails_when=the pin applies to a lane it was not certified for, or an outside voice runs with nothing to compare its family to;
  //   why_new=GSTA-167 plan R2; seam=none; no_claim=an OpenAI lane's pairing, which is uncertified
  test('a missing lane identity STOPs the outside voice: none given, or given with nothing to compare its family to', async () => {
    const { dir, env } = repo();
    const h = host(dir, env);
    const base = { base: 'main', out: path.join(dir, '.state/run/p1'), pass: 'x16p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const none = "STOP: the outside voice needs input.models['outside-voice'] (a model of another family); none was given";
    expect(await runPass(h, { ...base, stage: 'voices', laneModel: undefined })).toContain(none);
    expect(await runPass(h, { ...base, stage: 'voices', laneModel: 'openai/gpt-6.2-sol' })).toContain(none);
    expect(await runPass(h, { ...base, stage: 'voices', laneModel: undefined, models: { 'outside-voice': { model_id: 'openai/gpt-6.2-sol', reasoning_mode: 'medium' } } }))
      .toContain('STOP: the outside voice openai/gpt-6.2-sol cannot be checked against another family: neither input.laneModel nor a native voice model was given');
    expect(await runPass(h, { ...base, stage: 'voices', models: { 'outside-voice': { model_id: 'claude-sonnet-5-5' } } }))
      .toContain('STOP: the outside voice claude-sonnet-5-5 has no provider prefix, so its family cannot be checked');
    expect(await runPass(h, { ...base, stage: 'voices', models: { 'outside-voice': { model_id: 'Anthropic/claude-sonnet-5-5' } } }))
      .toContain('STOP: the outside voice Anthropic/claude-sonnet-5-5 is the anthropic family, the same as the lane model');
    expect(await runPass(h, { ...base, stage: 'voices', laneModel: 'claude-opus-5-5', models: { 'outside-voice': { model_id: 'openai/gpt-6.2-sol' } } }))
      .toContain('STOP: the outside voice openai/gpt-6.2-sol cannot be checked against another family: the lane model claude-opus-5-5 has no provider prefix and no native voice model was given');
    expect(h.creates.some(c => /^ship x16p1 (adversarial-native|outside-voice)$/.test(c.title))).toBe(false);
  }, 240_000);

  const certified = { model_id: 'openai/gpt-6.2-sol', reasoning_mode: 'medium' };
  async function voicesRun(dir: string, env: NodeJS.ProcessEnv, sub: string, models?: Record<string, unknown>) {
    const out = path.join(dir, '.state/run', sub);
    const h = host(dir, env);
    const base = { base: 'main', out, pass: 'x17p1', planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const res = await runPass(h, { ...base, stage: 'voices', ...(models ? { models } : {}) });
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as Manifest;
    for (const r of m.readers) expect(h.creates.find(c => c.title === r.title)!.prompt).toBe(fs.readFileSync(r.file!, 'utf8'));
    const shas = Object.fromEntries(h.creates.map(c => [c.title, promptHash(c.prompt.split(out).join('<out>'))]));
    return { res, shas, models: Object.fromEntries(h.creates.map(c => [c.title, c.model])) };
  }

  // Value: protects=an Anthropic lane's Step 11 gets the default outside voice (openai/gpt-6.2-sol at medium since R116; no-loss rounds 3-6 and A3668 ran on gpt-6.1-sol) without naming it, and every brief goes out byte for byte as it does with that model named; fails_when=the lane must pick the outside voice (gpt-6-astra in 6c/7e/8g), or the pin changes any reader's brief or another reader's model;
  //   why_new=GSTA-167 plan R2; seam=none; no_claim=the default pair's recall (arm-L6 measured gpt-6.1-sol's, not gpt-6.2-sol's)
  test('an anthropic lane defaults the outside voice to the default model, with every brief byte-identical to naming it', async () => {
    const { dir, env } = repo();
    const pinned = await voicesRun(dir, env, 'pin');
    expect(pinned.res).toContain('OUTSIDE_VOICE: openai/gpt-6.2-sol reasoning=medium default for an anthropic lane (default configuration)');
    expect(pinned.res).toContain('NEXT: judge the voices');
    expect(pinned.models['ship x17p1 outside-voice']).toEqual(certified);
    const named = await voicesRun(dir, env, 'named', { 'outside-voice': certified });
    expect(named.res).toContain('OUTSIDE_VOICE: openai/gpt-6.2-sol reasoning=medium given (default configuration)');
    expect(named.shas).toEqual(pinned.shas);
    expect(named.models).toEqual(pinned.models);
  }, 300_000);

  // Value: protects=an explicit cross-family override is accepted but its pass output says it is outside the default configuration; fails_when=a changed outside-voice model or reasoning passes silently as if certified;
  //   why_new=GSTA-167 plan R2; seam=none; no_claim=the undefault configuration's recall
  test('an explicit outside-voice override with changed reasoning runs and is recorded as outside the default, other briefs unchanged', async () => {
    const { dir, env } = repo();
    const high = { model_id: 'openai/gpt-6.2-sol', reasoning_mode: 'high' };
    const over = await voicesRun(dir, env, 'over', { 'outside-voice': high });
    expect(over.res).toContain('OUTSIDE_VOICE: openai/gpt-6.2-sol reasoning=high given; outside the default configuration (openai/gpt-6.2-sol at medium beside an anthropic lane)');
    expect(over.res).toContain('NEXT: judge the voices');
    expect(over.models['ship x17p1 outside-voice']).toEqual(high);
    const named = await voicesRun(dir, env, 'named', { 'outside-voice': certified });
    expect(over.shas).toEqual(named.shas);
    for (const t of Object.keys(named.models)) if (t !== 'ship x17p1 outside-voice') expect(over.models[t]).toEqual(named.models[t]);
  }, 300_000);
});
