#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * A local stand-in for the Anthropic Messages and OpenAI Chat Completions APIs,
 * so the shadow-mode tests (test/autoplan-shadow*.test.ts) never make a real
 * network call: the tests point ANTHROPIC_BASE_URL and OPENAI_BASE_URL at it.
 * Usage: bun test/fixtures/shadow-fake-model.ts <dir>. It writes <dir>/port,
 * appends every request to <dir>/requests.jsonl, and answers the n-th request
 * with step n of <dir>/script.json (the last step repeats; default valid):
 * { "mode": valid | missing | duplicate | foreign | bad_option | bad_cite | bad_conf | garbage | truncated | send_back | http500,
 *   "delay_ms"?: n }. A valid reply picks each question's first option with the
 * question's first finding as its cite; usage is 1,000 input and 500 output tokens.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = process.argv[2]!;
interface Step { mode: string; delay_ms?: number }
interface Question { id: string; options: Array<{ key: string }>; findings: Array<{ id: string }> }
let served = 0;

function questions(prompt: string): Question[] {
  const at = prompt.indexOf('## The questions');
  const block = /```json\n([\s\S]*?)\n```/.exec(prompt.slice(at))?.[1];
  return block ? JSON.parse(block) : [];
}

function answer(mode: string, qs: Question[]): string {
  const rows: Array<Record<string, unknown>> = qs.map(q => ({ id: q.id, action: mode === 'send_back' ? 'send_back' : 'decide', pick: q.options[0]!.key, confidence: 0.75, cites: q.findings.slice(0, 1).map(f => f.id), reason: 'fake prediction' }));
  if (mode === 'missing') rows.pop();
  if (mode === 'duplicate') rows.push({ ...rows[0]! });
  if (mode === 'foreign') rows.push({ ...rows[0]!, id: 'zz9' });
  if (mode === 'bad_option') rows[0]!.pick = 'z';
  if (mode === 'bad_cite') rows[0]!.cites = ['not-a-finding'];
  if (mode === 'bad_conf') rows[0]!.confidence = 1.5;
  if (mode === 'garbage') return 'I would approve it.';
  if (mode === 'truncated') return '```json\n[{"id": "' + (qs[0]?.id ?? 'p1') + '", "act';
  return 'Here is my prediction.\n```json\n' + JSON.stringify(rows, null, 2) + '\n```\n';
}

const server = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.json() as Record<string, any>;
    let steps: Step[] = [{ mode: 'valid' }];
    try { steps = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8')); } catch { /* default */ }
    const step = steps[Math.min(served, steps.length - 1)]!;
    served++;
    fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify({ n: served, path: url.pathname, mode: step.mode, body, at: Date.now() }) + '\n');
    if (step.delay_ms) await Bun.sleep(step.delay_ms);
    if (step.mode === 'http500') return Response.json({ error: { message: 'fake overloaded' } }, { status: 500 });
    const text = answer(step.mode, questions(String(body.messages?.[0]?.content ?? '')));
    const cut = step.mode === 'truncated';
    if (url.pathname.endsWith('/v1/messages')) return Response.json({ model: body.model, content: [{ type: 'text', text }], stop_reason: cut ? 'max_tokens' : 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } });
    return Response.json({ model: body.model, choices: [{ message: { content: text }, finish_reason: cut ? 'length' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  },
});
fs.writeFileSync(path.join(dir, 'port.tmp'), String(server.port));
fs.renameSync(path.join(dir, 'port.tmp'), path.join(dir, 'port'));
