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
import { spawnSync } from 'node:child_process';
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
    const result = (output: string) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output } });
    const loads = (cmd: string, output?: string) => skillLoads(parseTranscript([meta, user, call(cmd), ...(output === undefined ? [] : [result(output)])].join('\n'))).map(l => l.skill);
    expect(loads("sed -n '1,200p' \"$CODEX_HOME/skills/gstack-review/SKILL.md\"")).toEqual(['gstack-review']);
    expect(loads('cat ~/.codex/skills/gstack-review/SKILL.md', 'Process exited with code 0\nOutput:\n---')).toEqual(['gstack-review']);
    expect(loads('cat ~/.codex/skills/gstack-review/SKILL.md', 'Process exited with code 1\nOutput:\ncat: /home/u/.codex/skills/gstack-review/SKILL.md: No such file or directory')).toEqual([]);
    expect(loads('cat ~/.codex/skills/gstack-review/SKILL.md && git diff missing-ref', "Process exited with code 128\nOutput:\n---\nname: gstack-review\nfatal: bad revision 'missing-ref'")).toEqual(['gstack-review']);
    expect(loads('cd ~/.codex && cat skills/gstack-review/SKILL.md')).toEqual(['gstack-review']);
    expect(loads('cat README.md && ls ~/.codex/skills/gstack-review/SKILL.md')).toEqual([]);
    expect(loads('ls ~/.codex/skills/gstack-review/SKILL.md')).toEqual([]);
    expect(loads('cat ~/src/gstack/review/SKILL.md')).toEqual([]);
    expect(loads('cat ~/.codex/skills/review/SKILL.md')).toEqual([]);
  });
});

describe('reads: shell edge cases from the #4522 notes (GST-3197)', () => {
  const meta = lines('exec-read-met.jsonl')[0];
  const record = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', payload });
  const user = record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review this' }] });
  const call = (cmd: string, id = 'c1') => record({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: id });
  const result = (output: string, id = 'c1') => record({ type: 'function_call_output', call_id: id, output });
  const loads = (cmd: string, output?: string) => skillLoads(parseTranscript([meta, user, call(cmd), ...(output === undefined ? [] : [result(output)])].join('\n'))).map(l => l.skill);
  const READ = 'cat ~/.codex/skills/gstack-review/SKILL.md';

  test('A: a read that an earlier && command kept from running is not a load; a read before a later failure still is', () => {
    expect(loads('cd /nope && ' + READ, 'Process exited with code 1\nOutput:\nbash: line 1: cd: /nope: No such file or directory')).toEqual([]);
    expect(loads('cd /repo && ' + READ, 'Process exited with code 0\nOutput:\n---\nname: review')).toEqual(['gstack-review']);
    expect(loads('cd /repo && ' + READ + ' && git diff missing-ref', "Process exited with code 128\nOutput:\n---\nfatal: bad revision 'missing-ref'")).toEqual(['gstack-review']);
    expect(loads('cd /nope && ' + READ)).toEqual(['gstack-review']);
    expect(loads('cd /nope && { ' + READ + '; }', 'Process exited with code 1\nOutput:\n')).toEqual(['gstack-review']);
  });

  test("B: ; inside quotes does not split a command, so sed -n '1,200p;201q' is a read", () => {
    expect(loads("sed -n '1,200p;201q' ~/.codex/skills/gstack-review/SKILL.md", 'Process exited with code 0\nOutput:\n---')).toEqual(['gstack-review']);
    expect(loads('sed -n "1,200p;201q" ~/.codex/skills/gstack-review/SKILL.md')).toEqual(['gstack-review']);
    expect(loads('echo x; ' + READ)).toEqual(['gstack-review']);
  });

  test('C: a user turn holding only an image ends the run, so the next read of the same skill is a new load', () => {
    const image = record({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] });
    const t = (between: string[]) => parseTranscript([meta, user, call(READ, 'a'), result('Process exited with code 0\nOutput:\n---', 'a'), ...between, call(READ, 'b'), result('Process exited with code 0\nOutput:\n---', 'b')].join('\n'));
    expect(skillLoads(t([image]))).toHaveLength(2);
    expect(skillLoads(t([]))).toHaveLength(1);
  });

  test('a || fallback whose first read fails loads from the second; the error names only the first path', () => {
    expect(loads(READ + ' || cat ~/.agents/skills/gstack-review/SKILL.md', 'Process exited with code 0\nOutput:\ncat: /home/u/.codex/skills/gstack-review/SKILL.md: No such file or directory\n---\nname: review')).toEqual(['gstack-review']);
    expect(loads(READ + ' || cat ~/.agents/skills/gstack-review/SKILL.md', 'Process exited with code 1\nOutput:\ncat: /home/u/.codex/skills/gstack-review/SKILL.md: No such file or directory\ncat: /home/u/.agents/skills/gstack-review/SKILL.md: No such file or directory')).toEqual([]);
  });

  test('a read error must name the path itself: SKILL.md.bak or another skill folder does not drop a good read', () => {
    expect(loads(READ + '; ls ~/.codex/skills/gstack-review/SKILL.md.bak', "Process exited with code 2\nOutput:\n---\nls: cannot access '/home/u/.codex/skills/gstack-review/SKILL.md.bak': No such file or directory")).toEqual(['gstack-review']);
    expect(loads(READ, "Process exited with code 1\nOutput:\ncat: /home/u/.codex/skills/gstack-review/SKILL.md: Permission denied")).toEqual([]);
  });

  test('an error line that does not provably name another file still drops the read', () => {
    expect(loads('cat "$(realpath -m ~/.codex/skills/gstack-review/SKILL.md)"', 'Process exited with code 1\nOutput:\ncat: /home/u/dotfiles/skills/gstack-review/SKILL.md: No such file or directory')).toEqual([]);
    expect(loads('cd ~/.codex/skills/gstack-review && cat SKILL.md', 'Process exited with code 1\nOutput:\ncat: SKILL.md: No such file or directory')).toEqual([]);
    expect(loads(READ + '; cat /tmp/notes.txt', 'Process exited with code 1\nOutput:\n---\nname: review\ncat: /tmp/notes.txt: No such file or directory')).toEqual(['gstack-review']);
  });

  test('a multi-file read whose other file fails still loads', () => {
    expect(loads(READ + ' /tmp/x', 'Process exited with code 1\nOutput:\n---\nname: review\ncat: /tmp/x: No such file or directory')).toEqual(['gstack-review']);
  });

  test('a one-file read that exits non-zero with no error text is not a load', () => {
    expect(loads(READ, 'Process exited with code 1\nOutput:\n')).toEqual([]);
    expect(loads("sed -n '1,200p' ~/.codex/skills/gstack-review/SKILL.md", 'Process exited with code 1\nOutput:\n')).toEqual([]);
  });

  test("PowerShell's Cannot find path is a read error", () => {
    expect(loads('Get-Content C:\\Users\\u\\.codex\\skills\\gstack-review\\SKILL.md', "Get-Content: Cannot find path 'C:\\Users\\u\\.codex\\skills\\gstack-review\\SKILL.md' because it does not exist.")).toEqual([]);
    expect(loads('Get-Content C:\\Users\\u\\.codex\\skills\\gstack-review\\SKILL.md', '---\nname: review')).toEqual(['gstack-review']);
  });
});

describe('chunked reads: reading the same SKILL.md again continues the run', () => {
  const met = lines('exec-read-met.jsonl');
  const spawnAt = met.findIndex(l => l.includes('"function_call"') && l.includes('spawn_agent') && met.some(o => o.includes('function_call_output') && o.includes(JSON.parse(l).payload.call_id) && o.includes('agent_id')));
  const record = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', payload });
  const reread = [
    record({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: "sed -n '400,800p' ~/.codex/skills/gstack-review/SKILL.md" }), call_id: 'reread' }),
    record({ type: 'function_call_output', call_id: 'reread', output: 'Process exited with code 0\nOutput:\n## Step 5' }),
  ];
  const withAfterSpawn = (extra: string[]) => parseTranscript([...met.slice(0, spawnAt + 2), ...extra, ...met.slice(spawnAt + 2)].join('\n'));

  test('a second chunk read after the adversarial spawn is not a new load, so the run stays met', () => {
    const t = withAfterSpawn(reread);
    expect(skillLoads(t)).toHaveLength(1);
    expect(checkContract(t, 'gstack-review', realReview(t)).items.every(i => i.status !== 'missing')).toBe(true);
  });

  test('a user prompt between the reads makes the second read a new load', () => {
    const prompt = record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review it again' }] });
    expect(skillLoads(withAfterSpawn([prompt, ...reread]))).toHaveLength(2);
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

  test('a spawn_agent with no output is not a dispatch', () => {
    const all = lines('exec-read-failed-spawn.jsonl');
    const callId = all.map(l => JSON.parse(l).payload).find(p => p?.type === 'function_call_output' && String(p.output).includes('agent_id')).call_id;
    const t = parseTranscript(all.filter(l => !(l.includes(callId) && l.includes('function_call_output'))).join('\n'));
    expect(t.events.some(e => e.kind === 'tool_use' && e.name === 'Agent')).toBe(false);
    expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
  });

  test("Sol's spawn_agent in Codex's collaboration namespace answers with task_name, not agent_id: that started agent is a dispatch", () => {
    const sol = lines('exec-sol-spawn-met.jsonl');
    const call = sol.map(l => JSON.parse(l).payload).find(p => p?.type === 'function_call' && p.name === 'spawn_agent');
    expect(call.namespace).toBe('collaboration');
    expect(JSON.parse(call.arguments).task_name).toBe('adversarial');
    const atFirstStop = parseTranscript(sol.slice(0, sol.findIndex(l => l.includes('<hook_prompt'))).join('\n'));
    const dispatch = atFirstStop.events.find(e => e.kind === 'tool_use' && e.name === 'Agent') as { input: Record<string, unknown> } | undefined;
    expect(String(dispatch?.input.prompt)).toContain('Think like an attacker and a chaos engineer');
    expect(status(atFirstStop, realReview(atFirstStop))).toEqual({ 'adversarial-pass': 'met', 'review-report': 'met' });
  });

  test('negative control: a collaboration spawn_agent whose output names no task_name is not a dispatch', () => {
    const sol = lines('exec-sol-spawn-met.jsonl');
    const callId = sol.map(l => JSON.parse(l).payload).find(p => p?.type === 'function_call' && p.name === 'spawn_agent').call_id;
    for (const output of ['{"task_name":""}', 'spawn_agent failed: task_name is required', '{"nickname":"Ada"}']) {
      const edited = sol.map(l => {
        const rec = JSON.parse(l);
        if (rec.payload?.type !== 'function_call_output' || rec.payload.call_id !== callId) return l;
        return JSON.stringify({ ...rec, payload: { ...rec.payload, output } });
      });
      const t = parseTranscript(edited.join('\n'));
      expect(t.events.some(e => e.kind === 'tool_use' && e.name === 'Agent')).toBe(false);
      expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
    }
  });

  test('negative control: a same-named spawn_agent from another tool namespace is not Codex\'s, whatever its result says', () => {
    const sol = lines('exec-sol-spawn-met.jsonl');
    const retag = (namespace: string, output?: string) => parseTranscript(sol.map(l => {
      const rec = JSON.parse(l);
      if (rec.payload?.type === 'function_call' && rec.payload.name === 'spawn_agent') return JSON.stringify({ ...rec, payload: { ...rec.payload, namespace } });
      if (output !== undefined && rec.payload?.type === 'function_call_output' && rec.payload.call_id === 'call_spawn_1') return JSON.stringify({ ...rec, payload: { ...rec.payload, output } });
      return l;
    }).join('\n'));
    for (const namespace of ['mcp__agents__', 'my_extension']) {
      const t = retag(namespace);
      expect(t.events.some(e => e.kind === 'tool_use' && e.name === 'Agent')).toBe(false);
      expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
    }
    expect(status(retag('multi_agent_v1'), realReview(retag('multi_agent_v1')))['adversarial-pass']).toBe('missing');
    const v1 = retag('multi_agent_v1', '{"agent_id":"019a-v1","nickname":null}');
    expect(status(v1, realReview(v1))['adversarial-pass']).toBe('met');
  });

  test('call arguments that are not a JSON object throw UnknownShape, so the hook fails open', () => {
    const meta = lines('exec-read-met.jsonl')[0];
    const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review this' }] } });
    const spawn = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: '{"message": ', call_id: 's1' } });
    expect(() => parseTranscript([meta, user, spawn].join('\n'))).toThrow(UnknownShape);
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
      fix: 'start the subagent pass with spawn_agent (task_name "adversarial", its message matching /Think like an attacker and a chaos engineer/), then wait_agent for its result',
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

describe('encrypted spawn messages: Codex multi-agent v2 with OpenAI models (GST-3375)', () => {
  // Codex encrypts the spawn_agent message for OpenAI models (openai/codex#26210), so the brief's marker never reaches
  // either rollout. These fixtures are synthetic (README): Sol's collaboration spawn with its message swapped for ciphertext.
  const enc = lines('exec-sol-encrypted-spawn.jsonl');
  const spawnCall = () => enc.map(l => JSON.parse(l).payload).find(p => p?.type === 'function_call' && p.name === 'spawn_agent');
  const edit = (fn: (p: Record<string, any>) => Record<string, any> | null) => parseTranscript(enc.flatMap(l => {
    const rec = JSON.parse(l);
    const p = rec.payload?.type ? fn({ ...rec.payload }) : rec.payload;
    return p === null ? [] : [JSON.stringify({ ...rec, payload: p })];
  }).join('\n'));
  const withArgs = (change: Record<string, unknown>) => (p: Record<string, any>) =>
    p.type === 'function_call' && p.name === 'spawn_agent' ? { ...p, arguments: JSON.stringify({ ...JSON.parse(p.arguments), ...change }) } : p;

  test('the fixtures carry ciphertext where the brief was, and the marker is in neither rollout\'s dispatch', () => {
    const args = JSON.parse(spawnCall().arguments);
    expect(args.task_name).toBe('adversarial');
    expect(args.message).toMatch(/^gAAAAAB[A-Za-z0-9_-]+=*$/);
    expect(spawnCall().arguments).not.toContain('Think like an attacker');
    expect(read('exec-sol-encrypted-subagent.jsonl')).not.toContain('Think like an attacker');
    const sub = rollout('exec-sol-encrypted-subagent.jsonl');
    expect(sub.subagent).toBe(true);
    expect(JSON.parse(lines('exec-sol-encrypted-subagent.jsonl')[0]).payload.source.subagent.thread_spawn.agent_path).toBe('/root/adversarial');
  });

  test('a started spawn named adversarial with an encrypted message meets the adversarial pass', () => {
    const t = rollout('exec-sol-encrypted-spawn.jsonl');
    expect(status(t, realReview(t))).toEqual({ 'adversarial-pass': 'met', 'review-report': 'met' });
    expect(checkContract(t, 'gstack-review', realReview(t)).met).toBe(true);
  });

  test('negative control: no adversarial spawn is still missing', () => {
    const t = edit(p => (p.call_id === 'call_spawn_1' ? null : p));
    expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
  });

  test('negative control: an encrypted spawn of a differently named agent is still missing', () => {
    for (const name of ['red-team', 'adversarial-2', 'worker']) {
      const t = edit(p => {
        const q = withArgs({ task_name: name })(p);
        return q.type === 'function_call_output' && q.call_id === 'call_spawn_1' ? { ...q, output: JSON.stringify({ task_name: `/root/${name}` }) } : q;
      });
      expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
    }
  });

  test('negative control: a spawn that never started is still missing, whatever it was named', () => {
    const t = edit(p => (p.type === 'function_call_output' && p.call_id === 'call_spawn_1' ? { ...p, output: 'spawn_agent failed: agent limit reached' } : p));
    expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
  });

  test('negative control: a plaintext message is still held to the marker, even when the agent is named adversarial', () => {
    const t = edit(withArgs({ message: 'Look over the diff and say if it looks fine.' }));
    expect(status(t, realReview(t))['adversarial-pass']).toBe('missing');
  });

  test('Claude Code is unchanged: the same events read as a Claude transcript still need the marker', () => {
    const t = rollout('exec-sol-encrypted-spawn.jsonl');
    const asClaude: Transcript = { events: t.events, sessionId: t.sessionId };
    expect(status(asClaude, realReview(t))['adversarial-pass']).toBe('missing');
  });

  test('the review report has no such blind spot: it is the parent\'s own text, which Codex does not encrypt', () => {
    const t = rollout('exec-sol-encrypted-spawn.jsonl');
    expect(status(t, realReview(t))['review-report']).toBe('met');
    const noReport = edit(p => (p.type === 'message' && p.role === 'assistant' ? null : p));
    expect(status(noReport, realReview(noReport))['review-report']).toBe('missing');
  });

  test('on Codex the block text names the task name the check looks for', () => {
    const t = edit(p => (p.call_id === 'call_spawn_1' ? null : p));
    const item = checkContract(t, 'gstack-review', realReview(t)).items.find(i => i.id === 'adversarial-pass');
    expect(item?.fix).toBe('start the subagent pass with spawn_agent (task_name "adversarial", its message matching /Think like an attacker and a chaos engineer/), then wait_agent for its result');
  });

  test('gstack-skill-contract check passes the encrypted run', () => {
    const work = tmpDir('gstack-codex-enc-');
    try {
      const r = spawnSync(BIN, ['check', '--transcript', path.join(DIR, 'exec-sol-encrypted-spawn.jsonl'), '--skill', 'gstack-review'], { env: hookEnv(work, work, { GSTACK_INSTALLED_SKILLS_DIR: '', HOME: work }), encoding: 'utf8', timeout: 20_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toStartWith('SKILL_CONTRACT_MET gstack-review');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
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

  test('gstack-skill-contract check reads a Codex rollout against gstack\'s own contract', () => {
    const check = (name: string) => spawnSync(BIN, ['check', '--transcript', path.join(DIR, name), '--skill', 'gstack-review'], { env: hookEnv(state, skills, { GSTACK_INSTALLED_SKILLS_DIR: '', HOME: work }), encoding: 'utf8', timeout: 20_000 });
    const met = check('exec-read-met.jsonl');
    expect(met.status).toBe(0);
    expect(met.stdout).toStartWith('SKILL_CONTRACT_MET gstack-review');
    const unmet = check('exec-read-failed-spawn.jsonl');
    expect(unmet.status).toBe(1);
    expect(unmet.stdout).toContain('missing review-report');
  });
});
