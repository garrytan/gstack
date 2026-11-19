/**
 * The /review contract on Codex (GST-3173): lib/codex-rollout.ts reads Codex
 * 0.170 rollouts, checkContract skips the specialists item there, and the Stop
 * hook holds a Codex /review once. The fixtures are real Codex rollouts
 * (test/fixtures/skill-contract/codex/README.md says how they were captured).
 * Claude Code's behaviour is pinned by test/skill-contract.test.ts and
 * test/skill-contract-stop-hook.test.ts; the checks here that touch Claude
 * transcripts only prove the Codex branch leaves them alone.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import codex from '../hosts/codex';
import { BACKED_BY } from '../scripts/resolvers/contract-done-means';
import {
  CODEX_SKIPPED_KINDS, ITEM_KINDS, UnknownShape, checkContract, parseTranscript, skillLoads, transcriptContract,
  type Contract, type Transcript,
} from '../lib/skill-contract';
import { CONTRACT_HOOK, J1_TRANSCRIPT, ROOT, hookEnv, runHook, skillsDir, tmpDir } from './helpers/skill-contract-fixture';

const DIR = path.join(ROOT, 'test', 'fixtures', 'skill-contract', 'codex');
const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8');
const rollout = (name: string) => parseTranscript(read(name));
const lines = (name: string) => read(name).trimEnd().split('\n');
const STOPS = JSON.parse(read('stop-payloads.json')) as { payload: Record<string, unknown>; hook_stdout: string }[];
/** exec-read-blocked.jsonl as it stood at the first Stop: everything before the hook's <hook_prompt> message. */
const AT_FIRST_STOP = lines('exec-read-blocked.jsonl').slice(0, lines('exec-read-blocked.jsonl').findIndex(l => l.includes('<hook_prompt')));
const BIN = path.join(ROOT, 'bin', 'gstack-skill-contract');
const realReview = (t: Transcript) => {
  const found = transcriptContract(t, 'gstack-review', {});
  if (!('contract' in found)) throw new Error(found.error);
  return found.contract;
};
const status = (t: Transcript, contract: Contract) => Object.fromEntries(checkContract(t, 'gstack-review', contract).items.map(i => [i.id, i.status]));

describe('format: chosen by content', () => {
  test('every fixture parses as a Codex rollout with its session_meta id', () => {
    for (const name of fs.readdirSync(DIR).filter(n => n.endsWith('.jsonl'))) {
      const t = rollout(name);
      expect(t.format).toBe('codex');
      expect(t.sessionId).toBe(JSON.parse(lines(name)[0]).payload.id);
    }
  });

  test('a Claude Code transcript parses exactly as before: no format or subagent key', () => {
    const t = parseTranscript(`${J1_TRANSCRIPT.join('\n')}\n`);
    expect(Object.keys(t).sort()).toEqual(['events', 'sessionId']);
    expect(t.events.some(e => e.kind === 'load')).toBe(false);
  });

  test('the path does not decide: a rollout under ~/.claude/projects is still Codex, a transcript under ~/.codex/sessions still Claude', () => {
    const work = tmpDir('gstack-codex-format-');
    try {
      const claudeDir = path.join(work, '.claude', 'projects', 'p');
      const codexDir = path.join(work, '.codex', 'sessions', '2026', '11', '19');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'x.jsonl'), read('exec-read-met.jsonl'));
      fs.writeFileSync(path.join(codexDir, 'rollout-x.jsonl'), `${J1_TRANSCRIPT.join('\n')}\n`);
      expect(parseTranscript(fs.readFileSync(path.join(claudeDir, 'x.jsonl'), 'utf8')).format).toBe('codex');
      expect(parseTranscript(fs.readFileSync(path.join(codexDir, 'rollout-x.jsonl'), 'utf8')).format).toBeUndefined();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test('a rollout this reader does not know throws UnknownShape', () => {
    const meta = lines('exec-read-met.jsonl')[0];
    expect(() => parseTranscript(`${meta}\n`)).toThrow(UnknownShape);
    expect(() => parseTranscript(`${meta}\n${JSON.stringify({ type: 'response_item', payload: 'text' })}\n`)).toThrow(UnknownShape);
    expect(() => parseTranscript(`${meta}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'hi' } })}\n`)).toThrow(UnknownShape);
  });
});

describe('loads: Codex reading or injecting a gstack-* SKILL.md', () => {
  test('a shell read (cat) of the installed SKILL.md is a load', () => {
    expect(skillLoads(rollout('exec-read-met.jsonl')).map(l => [l.skill, l.via])).toEqual([['gstack-review', 'read']]);
  });

  test('a <skill> injection (the TUI and app-server skill input) is a load', () => {
    expect(skillLoads(rollout('app-server-injected-early-exit.jsonl')).map(l => [l.skill, l.via])).toEqual([['gstack-review', 'injected']]);
  });

  test('a $gstack-review typed into codex exec is plain text: no load', () => {
    expect(skillLoads(rollout('exec-mention-not-loaded.jsonl'))).toEqual([]);
  });

  test('only a read program on a skills/gstack-*/SKILL.md path loads', () => {
    const meta = lines('exec-read-met.jsonl')[0];
    const call = (cmd: string) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: 'c1' } });
    const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review this' }] } });
    const loads = (cmd: string) => skillLoads(parseTranscript([meta, user, call(cmd)].join('\n'))).map(l => l.skill);
    expect(loads("sed -n '1,200p' \"$CODEX_HOME/skills/gstack-review/SKILL.md\"")).toEqual(['gstack-review']);
    expect(loads('ls ~/.codex/skills/gstack-review/SKILL.md')).toEqual([]);
    expect(loads('cat ~/src/gstack/review/SKILL.md')).toEqual([]);
    expect(loads('cat ~/.codex/skills/review/SKILL.md')).toEqual([]);
  });
});

describe('dispatch: a spawn_agent call that started an agent', () => {
  test('a spawn_agent that failed is not a dispatch; the one that started is', () => {
    const t = rollout('exec-read-failed-spawn.jsonl');
    const spawns = t.events.filter(e => e.kind === 'tool_use' && (e.name === 'Agent' || e.name === 'spawn_agent')) as { name: string; input: Record<string, unknown> }[];
    expect(spawns.map(s => s.name)).toEqual(['spawn_agent', 'Agent']);
    expect(String(spawns[1].input.prompt)).toContain('Think like an attacker and a chaos engineer');
  });

  test('negative control: without the spawn that started, the adversarial pass is missing', () => {
    const all = lines('exec-read-failed-spawn.jsonl');
    const callId = all.map(l => JSON.parse(l).payload).find(p => p?.type === 'function_call_output' && String(p.output).includes('agent_id')).call_id;
    const t = parseTranscript(all.filter(l => !l.includes(callId)).join('\n'));
    expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
  });
});

describe('turns: Codex harness messages are meta', () => {
  test("the hook's reason, a subagent notification and the environment are meta; the user's request is the only prompt", () => {
    const t = rollout('exec-read-blocked.jsonl');
    const prompts = t.events.filter(e => e.kind === 'prompt') as { text: string }[];
    expect(prompts.map(p => p.text)).toEqual([expect.stringContaining('do not start any subagents')]);
    const metas = (t.events.filter(e => e.kind === 'meta') as { text: string }[]).map(m => m.text.split(/[>\s]/)[0]);
    expect(metas).toEqual(expect.arrayContaining(['<environment_context', '<hook_prompt']));
  });

  test('a subagent rollout is marked, so the hook never checks it', () => {
    expect(rollout('exec-subagent.jsonl').subagent).toBe(true);
    expect(rollout('exec-read-met.jsonl').subagent).toBeUndefined();
  });
});

describe('checkContract on Codex with the real /review contract', () => {
  test('the contract comes from gstack\'s own review/SKILL.md, all three items', () => {
    const t = rollout('exec-read-met.jsonl');
    expect(transcriptContract(t, 'gstack-review', {})).toMatchObject({ file: path.join(ROOT, 'review', 'SKILL.md') });
    expect(realReview(t).items.map(i => i.kind)).toEqual(['selected_specialists_dispatched', 'agent_dispatch', 'report_labels']);
  });

  test('specialists-dispatched is skipped on Codex and only there', () => {
    const t = rollout('exec-read-met.jsonl');
    expect(status(t, realReview(t))).toEqual({ 'adversarial-pass': 'met', 'review-report': 'met' });
    const asClaude: Transcript = { events: t.events, sessionId: t.sessionId };
    expect(status(asClaude, realReview(t))['specialists-dispatched']).toBe('missing');
  });

  test('each real run gets the verdict the run earned', () => {
    const at = (text: string) => parseTranscript(text);
    const blocked = at(AT_FIRST_STOP.join('\n'));
    expect(status(blocked, realReview(blocked))).toEqual({ 'adversarial-pass': 'missing', 'review-report': 'missing' });
    const fixed = rollout('exec-read-blocked.jsonl');
    expect(checkContract(fixed, 'gstack-review', realReview(fixed)).met).toBe(true);
    const failedSpawn = rollout('exec-read-failed-spawn.jsonl');
    expect(status(failedSpawn, realReview(failedSpawn))).toEqual({ 'adversarial-pass': 'met', 'review-report': 'missing' });
    const early = rollout('app-server-injected-early-exit.jsonl');
    expect(checkContract(early, 'gstack-review', realReview(early)).met).toBe(true);
  });

  test('the Codex wording stays in its branch: the same events as a Claude transcript get the Claude text', () => {
    const t = parseTranscript(AT_FIRST_STOP.join('\n'));
    const item = (tr: Transcript) => checkContract(tr, 'gstack-review', realReview(t)).items.find(i => i.id === 'adversarial-pass');
    expect(item(t)).toMatchObject({
      detail: 'no spawn_agent call matches /Think like an attacker and a chaos engineer/',
      fix: 'start the subagent pass matching /Think like an attacker and a chaos engineer/ with spawn_agent, then wait_agent for its result',
    });
    expect(item({ events: t.events, sessionId: t.sessionId })).toMatchObject({
      detail: 'no Agent dispatch matches /Think like an attacker and a chaos engineer/',
      fix: 'dispatch the Agent pass matching /Think like an attacker and a chaos engineer/',
    });
  });

  test('CODEX_SKIPPED_KINDS is exactly the kinds whose resolver Codex suppresses', () => {
    const suppressed = new Set(codex.suppressedResolvers ?? []);
    const expected = ITEM_KINDS.filter(k => { const b = BACKED_BY[k]; return !!b && suppressed.has(b.resolver); });
    expect([...CODEX_SKIPPED_KINDS]).toEqual(expected);
  });
});

describe('the Stop hook on Codex', () => {
  let state = '', work = '', skills = '';
  beforeEach(() => {
    state = tmpDir('gstack-codex-state-');
    work = tmpDir('gstack-codex-work-');
    skills = skillsDir(['review']);
  });
  afterEach(() => {
    for (const d of [state, work, skills]) fs.rmSync(d, { recursive: true, force: true });
  });

  /** One of Codex's real Stop payloads, pointed at a copy of the rollout. */
  const stop = (n: number, rolloutLines: string[], env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
    const file = path.join(work, 'rollout.jsonl');
    fs.writeFileSync(file, `${rolloutLines.join('\n')}\n`);
    const payload = { ...STOPS[n].payload, transcript_path: file, ...extra };
    return runHook(CONTRACT_HOOK, JSON.stringify(payload), hookEnv(state, skills, { GSTACK_SKILL_CONTRACTS: 'on', CLAUDE_CODE_ENTRYPOINT: '', ...env }));
  };
  const record = () => JSON.parse(fs.readFileSync(path.join(state, 'skill-contracts', `${STOPS[1].payload.session_id}.json`), 'utf8'));

  test('blocks once with the Codex reason, then records met_after_block', () => {
    const first = stop(1, AT_FIRST_STOP);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    const out = JSON.parse(first.stdout);
    expect(Object.keys(out).sort()).toEqual(['decision', 'reason']);
    expect(out.decision).toBe('block');
    expect(out.reason).toBe(read('../block-message-codex.txt').trimEnd().replace('{bin}', BIN));
    expect(Object.values(record().runs)).toEqual([expect.objectContaining({ skill: 'gstack-review', outcome: 'blocked', missing: ['adversarial', 'report'] })]);
    const second = stop(2, lines('exec-read-blocked.jsonl'));
    expect(second.stdout).toBe('');
    expect(second.stderr).toBe('');
    expect(Object.values(record().runs)).toEqual([expect.objectContaining({ outcome: 'met_after_block', missing: [] })]);
  });

  test('stop_hook_active on the first stop it sees: never blocks', () => {
    const r = stop(2, AT_FIRST_STOP, {}, { last_assistant_message: STOPS[1].payload.last_assistant_message });
    expect(r.stdout).toBe('');
  });

  test('the real met run: allowed and recorded met', () => {
    const r = stop(0, lines('exec-read-met.jsonl'));
    expect(r.stdout).toBe('');
    const rec = JSON.parse(fs.readFileSync(path.join(state, 'skill-contracts', `${STOPS[0].payload.session_id}.json`), 'utf8'));
    expect(Object.values(rec.runs)).toEqual([expect.objectContaining({ outcome: 'met' })]);
  });

  test('an unknown rollout shape fails open and bumps the same canary as on Claude Code', () => {
    const meta = lines('exec-read-met.jsonl')[0];
    const r = stop(1, [meta, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'x' } })]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^gstack-skill-contract: SKILL_CONTRACT_STATE_ERROR .+: unknown transcript shape: line 2: message content is not a list \(canary 1\); stop allowed/);
    expect(JSON.parse(fs.readFileSync(path.join(state, 'hooks', 'skill-contract.canary.json'), 'utf8')).count).toBe(1);
  });

  test('a Codex subagent rollout is never checked', () => {
    const r = stop(1, lines('exec-subagent.jsonl'), {}, { last_assistant_message: undefined });
    expect(r.stdout).toBe('');
    expect(fs.readFileSync(path.join(state, 'hooks', 'skill-contract.log'), 'utf8')).toContain('event=codex-subagent');
  });

  test('skill_contracts off turns it off on Codex too', () => {
    expect(stop(1, AT_FIRST_STOP, { GSTACK_SKILL_CONTRACTS: 'off' }).stdout).toBe('');
    expect(fs.existsSync(path.join(state, 'skill-contracts'))).toBe(false);
  });
});
