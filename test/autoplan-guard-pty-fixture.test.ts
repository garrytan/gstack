import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closePacketReadAfterNotice, dispatchEventRewriter, dispatchPromptDelta, dispatchToken, guardRunNeedsJournal, prepareGuardSession, startDispatchRelay, stoppedAtPhaseBoundary } from './helpers/autoplan-guard-pty';
import { codeOf, guardFixture } from './helpers/autoplan-guard-fixture';

const base = '/home/runner/.cache/gstack-paid-shard-x/tmp/ap-guard-pty-y';

// Main backstop 41817566885 (b244e6d1, paid-slice-1-a1, green on the in-run rerun): four allows, the first unverified
// (journal_lag, payload path), so the run failed its verified-allow assertion without printing the journal.
test('an unverified allow prints the journal before cleanup; four verified allows with no card do not', () => {
  const verified = { decision: 'allow', disposition: 'allow', code: null, path: 'payload', claude_code_version: '2.1.292' };
  const captured = [{ ...verified, disposition: 'unverified', code: 'journal_lag' }, verified, verified, verified];
  expect(guardRunNeedsJournal(captured, 0)).toBe(true);
  expect(guardRunNeedsJournal([verified, verified, verified, verified], 0)).toBe(false);
  expect(guardRunNeedsJournal([verified, verified, verified, verified], 1)).toBe(true);
  expect(guardRunNeedsJournal([verified, verified, verified], 0)).toBe(true);
  expect(guardRunNeedsJournal([verified, verified, verified, { ...verified, decision: 'deny', disposition: 'deny' }], 0)).toBe(true);
  expect(guardRunNeedsJournal([verified, verified, { ...verified, disposition: 'fallback' }, verified], 0)).toBe(true);
  const live = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-autoplan-guard-pty.test.ts'), 'utf8');
  expect(live).toContain('if (guardRunNeedsJournal(log, prompts.length))');
});

test('the close-packet check accepts a Read in the notice turn and rejects one made before the notice', () => {
  // PR gate 39069171159 (b789898, pass): the CEO reviewer's notice started the turn that read the close packet.
  expect(closePacketReadAfterNotice([
    `Read ${base}/project/.gstack/tmp/autoplan/autoplan-ceo-oMVeYz/close-packet.md`,
    'Bash true autoplan-published ceo',
    `Read ${base}/home/.claude/skills/gstack/autoplan/sections/design-phase.md`,
    'Agent Design review',
  ])).toBe(true);
  // PR gate 39070276914 (dc739be, fail): the actor read the close packet in the dispatch turn, before the notice.
  expect(closePacketReadAfterNotice([
    'Bash true autoplan-published ceo',
    `Read ${base}/home/.claude/skills/gstack/autoplan/sections/design-phase.md`,
    `Bash cat "${base}/project/.gstack/tmp/autoplan/dispatch-design.txt"`,
    'Agent Design review',
  ])).toBe(false);
});

test('the scripted actor ends its turn after a background CEO dispatch and reads the close packet only after the reviewer finishes', () => {
  const s = prepareGuardSession(undefined);
  try {
    const skill = fs.readFileSync(path.join(s.project, '.claude', 'skills', fs.readdirSync(path.join(s.project, '.claude', 'skills'))[0]!, 'SKILL.md'), 'utf8');
    const step = (n: number) => skill.slice(skill.indexOf(`\n${n}. `) + 1, skill.indexOf(`\n${n + 1}. `));
    expect(step(4)).toContain('If its result says the agent is running in the background, end your turn at once with no further tool call; the completion notification starts your next turn.');
    expect(step(4)).not.toContain('If the agent runs in the background, end your turn and wait');
    expect(step(5).startsWith('5. Only after the CEO review agent has finished (in the turn its completion notification starts, when it ran in the background), Read the file whose path step 3 printed')).toBe(true);
    expect(skill.indexOf('\n5. ')).toBeGreaterThan(skill.indexOf('\n4. '));
  } finally { s.cleanup(); }
});

// PR gate 39099195754 (ce1da4e, fail): the actor published Phase 1, printed "Phase 1 complete." and ended its
// turn, so the run idled to its 480 s deadline with 2 of 4 guarded allows (the same 489 s shape as 38976253774).
const STOP_SCREEN = fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'autoplan-guard-pty-phase-boundary-stop-screen.txt'), 'utf8');

test('the captured phase-boundary stop is named; a run still working or already in Phase 2 is not', () => {
  expect(STOP_SCREEN).toContain('Phase 1 complete.');
  expect(stoppedAtPhaseBoundary(STOP_SCREEN)).toBe(true);
  const working = STOP_SCREEN.slice(0, STOP_SCREEN.indexOf('✻ Brewed'));
  expect(stoppedAtPhaseBoundary(working)).toBe(false);
  const continued = working + '●Step7:ReadingtheDesignphasefile\n\nRead 1 file\n\n●Step8:DispatchingtheDesignreview\n\n✻ Brewed for 80s · done 5:17 AM\n❯\n';
  expect(stoppedAtPhaseBoundary(continued)).toBe(false);
  expect(stoppedAtPhaseBoundary('✻ Brewed for 10s · done 5:00 AM\n❯\n')).toBe(false);
});

test('the scripted actor keeps going through the phase boundary: nothing between step 6 and step 9 lets it end its turn there', () => {
  const s = prepareGuardSession(undefined);
  try {
    const skill = fs.readFileSync(path.join(s.project, '.claude', 'skills', fs.readdirSync(path.join(s.project, '.claude', 'skills'))[0]!, 'SKILL.md'), 'utf8');
    const step = (n: number) => skill.slice(skill.indexOf(`\n${n}. `) + 1, skill.indexOf(`\n${n + 1}. `));
    const intro = skill.slice(skill.indexOf('\n---\n', 4) + 5, skill.indexOf('\n1. '));
    expect(intro).toContain('from step 1 through step 9 in one continuous run');
    expect(intro).toContain('End your turn before step 9 only where step 4 or step 8 says to wait for a background agent.');
    expect(intro).toContain('**Phase 1 complete.** is a phase boundary, not the end of the task.');
    expect(step(6)).toContain('Do not end your turn after it: when its result arrives, go straight on to step 7.');
    expect(step(7).startsWith("7. As your next assistant message, in the same turn as step 6's result (no user input is coming), Read the file")).toBe(true);
    // The publication and the Phase 2 entry stay in separate messages: the guard's boundary is unchanged.
    expect(step(6)).toContain('make exactly one tool call in that same message: the Bash command `true autoplan-published ceo`');
    for (const n of [5, 6, 7]) expect(step(n)).not.toMatch(/end your turn(?! after it)|wait for (its|a) completion/i);
  } finally { s.cleanup(); }
});

// Train gate 40992022983 (paid-slice-1-a1, passed on the in-run rerun): the guard denied the Design dispatch with
// dispatch_prompt, and the journal summary cut every input at 160 characters, so the differing bytes were lost.
test('a dispatch_prompt deny names the bytes the actor changed, read from the journal before cleanup', () => {
  const s = prepareGuardSession(undefined);
  try {
    const design = '[DESIGN] Native phase review\nRead file: /p/native-prompt.md\nApply every criterion.\nReturn findings.\n';
    fs.writeFileSync(path.join(s.project, '.gstack', 'tmp', 'autoplan', 'dispatch-design.txt'), design);
    const journal = path.join(s.config, 'projects', 'p');
    fs.mkdirSync(journal, { recursive: true });
    const sent = design.replace('every criterion', 'all criteria');
    fs.writeFileSync(path.join(journal, 'session.jsonl'), JSON.stringify({ message: { content: [
      { type: 'tool_use', name: 'Agent', input: { description: 'Design review', prompt: sent } }] } }) + '\n');
    const [delta] = s.dispatchPromptDeltas();
    expect(delta).toContain(`Design review: expected ${design.length} chars, sent ${sent.length}; first difference at offset ${design.indexOf('every')}`);
    expect(delta).toContain('Apply every criterion.');
    expect(delta).toContain('Apply all criteria.');
    expect(dispatchPromptDelta(design, design)).toBe(`identical (${design.length} chars)`);
  } finally { s.cleanup(); }
});

// PR gate 41247097050 (paid-slice-1-a1), #3646's delta: "Design review: expected 977 chars, sent 993; first difference at
// offset 875": the Haiku actor kept the dispatch's contentHash to "…1c8f8c" and invented an 80-hex tail. The actor now sends
// a declared token and the driver's relay puts the exact dispatch in its place before Claude Code sees the tool call.
test('the dispatch relay hands the guard the exact dispatch for the declared token, and passes a retyped dispatch through to its denial', async () => {
  const f = guardFixture('ceo'), retypedFixture = guardFixture('ceo');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-guard-relay-'));
  const exact = f.snapshot.nativeDispatchPrompt, hash = retypedFixture.snapshot.sha256;
  const retyped = retypedFixture.snapshot.nativeDispatchPrompt.replace(`INPUT: ceo ${hash}`, `INPUT: ceo ${hash.slice(0, 46)}65b428cec49f80716ab6f3015701${'0a'.repeat(3)}`);
  fs.writeFileSync(path.join(artifacts, 'dispatch-ceo.txt'), exact);
  const agent = (id: string, prompt: string) => ({ description: 'CEO review', subagent_type: 'general-purpose', prompt, run_in_background: false, _id: id });
  const blocks = [agent('toolu_token', dispatchToken('ceo')), agent('toolu_retyped', retyped), { _id: 'toolu_bash', command: dispatchToken('ceo') }];
  const sse = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  const stream = [sse({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }),
    ...blocks.flatMap(({ _id, ...input }, index) => {
      const json = JSON.stringify(input), name = 'command' in input ? 'Bash' : 'Agent';
      return [sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: _id, name, input: {} } }),
        ...Array.from({ length: Math.ceil(json.length / 37) }, (_, i) => sse({ type: 'content_block_delta', index,
          delta: { type: 'input_json_delta', partial_json: json.slice(i * 37, i * 37 + 37) } })),
        sse({ type: 'content_block_stop', index })];
    }),
    sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }), sse({ type: 'message_stop' })].join('');
  const seen: Array<{ path: string; key: string | null; host: string | null; body: string }> = [];
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.text(), url = new URL(req.url);
    seen.push({ path: url.pathname + url.search, key: req.headers.get('x-api-key'), host: req.headers.get('host'), body });
    if (!JSON.parse(body).stream) return Response.json({ id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_json', name: 'Agent', input: agent('toolu_json', dispatchToken('ceo')) }] });
    const bytes = new TextEncoder().encode(stream);
    return new Response(new ReadableStream({ start(sink) { for (let i = 0; i < bytes.length; i += 7) sink.enqueue(bytes.slice(i, i + 7)); sink.close(); } }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const relay = startDispatchRelay(artifacts, `http://127.0.0.1:${upstream.port}/`);
  try {
    const send = (stream: boolean) => fetch(`${relay.url}/v1/messages?beta=true`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-key' }, body: JSON.stringify({ model: 'm', stream, messages: history }) });
    // The actor's history after its CEO dispatch, and a reviewer's first turn, whose dispatch is user text.
    const history = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ceo', name: 'Agent', input: { description: 'CEO review', prompt: exact } },
      { type: 'tool_use', id: 'toolu_other', name: 'Agent', input: { description: 'CEO review', prompt: retyped } }] },
      { role: 'user', content: [{ type: 'text', text: exact }] }];
    const text = await (await send(true)).text();
    const events = text.split('\n\n').filter(Boolean).map(e => JSON.parse(/^data: (.*)$/m.exec(e)![1]!));
    const inputs = blocks.map((_, index) => JSON.parse(events.filter(e => e.index === index && e.delta?.type === 'input_json_delta').map(e => e.delta.partial_json).join('')));
    expect(events.map(e => e.type).at(-1)).toBe('message_stop');
    expect(inputs[0]).toEqual({ description: 'CEO review', subagent_type: 'general-purpose', prompt: exact, run_in_background: false });
    expect(inputs[1].prompt).toBe(retyped);
    expect(inputs[2]).toEqual({ command: dispatchToken('ceo') });
    expect((await (await send(false)).json() as any).content[0].input.prompt).toBe(exact);
    expect(relay.substituted).toEqual(['ceo', 'ceo']);
    expect(seen.map(s => [s.path, s.key, s.host === new URL(relay.url).host])).toEqual(Array(2).fill(['/v1/messages?beta=true', 'fixture-key', false]));
    // Trial 1 of the first relay panel: shown the substituted CEO dispatch as its own past call, the actor imitated it for
    // Design. Upstream sees the actor's own token in its history; any other prompt and the reviewer's dispatch are kept.
    const upstreamHistory = JSON.parse(seen[0]!.body).messages;
    expect(upstreamHistory[0].content.map((b: any) => b.input.prompt)).toEqual([dispatchToken('ceo'), retyped]);
    expect(upstreamHistory[1].content[0].text).toBe(exact);

    // The real guard on each relayed dispatch: the token's substitute is allowed; the retyped one is still denied.
    const { run_in_background: _drop, ...payload } = inputs[0];
    f.use('review', 'Agent', inputs[0]); f.journal();
    expect(await f.hook(f.input('review', 'Agent', payload))).toEqual({});
    expect(f.log().at(-1)).toMatchObject({ decision: 'allow', disposition: 'allow' });
    const { run_in_background: _keep, ...retypedPayload } = inputs[1];
    retypedFixture.use('review', 'Agent', inputs[1]); retypedFixture.journal();
    expect(codeOf(await retypedFixture.hook(retypedFixture.input('review', 'Agent', retypedPayload)))).toBe('dispatch_prompt');
    expect(dispatchPromptDelta(retypedFixture.snapshot.nativeDispatchPrompt, retyped)).toContain(`first difference at offset ${retyped.indexOf(`INPUT: ceo ${hash.slice(0, 46)}`) + 'INPUT: ceo '.length + 46}`);
  } finally {
    relay.stop(); upstream.stop(true);
    f.cleanup(); retypedFixture.cleanup(); fs.rmSync(artifacts, { recursive: true, force: true });
  }
});

// /ship outside voice on PR #3953: a CRLF stream whose \r and \n land in separate chunks kept the token unsubstituted.
test('the event rewriter substitutes the token however LF or CRLF delimiters are split across chunks', () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-guard-crlf-'));
  try {
    fs.writeFileSync(path.join(artifacts, 'dispatch-ceo.txt'), 'exact dispatch');
    const json = JSON.stringify({ description: 'CEO review', prompt: dispatchToken('ceo') });
    const lf = [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Agent', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
      { type: 'content_block_stop', index: 0 }].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    for (const stream of [lf, lf.replace(/\n/g, '\r\n')]) for (const size of [1, 2, 3, 7, stream.length]) {
      const substituted: string[] = [];
      const rewrite = dispatchEventRewriter(artifacts, phase => substituted.push(phase));
      let out = '';
      for (let i = 0; i < stream.length; i += size) out += rewrite.push(stream.slice(i, i + size));
      out += rewrite.end();
      expect({ crlf: stream !== lf, size, substituted }).toEqual({ crlf: stream !== lf, size, substituted: ['ceo'] });
      expect(out).toContain(JSON.stringify(JSON.stringify({ description: 'CEO review', prompt: 'exact dispatch' })).slice(1, -1));
    }
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
});
