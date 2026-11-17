// gstack /ship phase program for Capy (lib/capy-ship-phase.js, G2). The body of an async function (tools, sleep, now, input),
// served verbatim by `gstack-ship-phase program` and loaded the way capy/skill/gstack/SKILL.md loads the review pass program;
// never retyped. One call runs one ship/DRIVER.md phase end to end:
// 1. `gstack-ship-phase run` with input.commands, in order and resumable (lib/ship-phase.ts). With input.jam, this jam's
//    cost.tokens and cost.credits (cost.dollars x 1,000 when the host reports only dollars) go to the commands as
//    $GSTACK_SHIP_READING and $GSTACK_SHIP_CREDITS (gstack-ship-budget start).
//    A command still running at 200 s returns NEXT: rerun: call the same program again with the same input.
// 2. With input.pass, the review pass program (gstack-review-dispatch program) on that pass's input: its dispatches, polls
//    and closing note. Otherwise, with input.record and input.step, the closing `gstack-ship-budget note` with a fresh reading.
// 3. The next phase's section parts (`gstack-ship-parts next`) once Phase 2 started <dir>/parts.
// It returns result lines only, at most 32 KB; any STOP: line ends the phase (STOP: past 100 minutes included).
const T0 = input.startedAt ?? (await now());
const RETURN_BYTES = 32000;
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const lines = [];
const sh = async (cmd, env) => {
  const pre = (input.launch ? '. ' + q(input.launch) + ' && ' : '') + (input.cwd ? 'cd ' + q(input.cwd) + ' && ' : '') + (env || '');
  const r = await tools.capy.bash({ command: pre + cmd, description: 'Ship phase ' + input.phase, timeout: 300 });
  return { code: r.exit_code, out: (r.output || '').trimEnd() };
};
const finish = () => {
  const text = lines.join('\n');
  if (text.length <= RETURN_BYTES) return text;
  const last = '\n(return capped at 32 KB; each command\'s log is under <dir>/phases)\n' + lines[lines.length - 1];
  return lines.slice(0, -1).join('\n').slice(0, Math.max(0, RETURN_BYTES - last.length)) + last;
};
const push = (out) => { for (const l of out.split('\n')) if (l.trim()) lines.push(l); };
const stopped = () => lines.some((l) => l.startsWith('STOP:'));
const reading = async () => {
  const t = await tools.thread.get({ thread_id: input.jam });
  return { tokens: t.cost.tokens, credits: t.cost.credits ?? Math.round(Number(String(t.cost.dollars).replace(/[^0-9.]/g, '')) * 100000) / 100 };
};
if (!input.dir || input.phase === undefined || input.phase === null) return 'STOP: input.dir and input.phase are required; nothing ran';
const commands = input.commands || [];
if (!Array.isArray(commands) || !commands.every((c) => typeof c === 'string' && c.trim())) return 'STOP: input.commands must be a list of shell command strings; nothing ran';
if (commands.length) {
  const r0 = input.jam ? await reading() : null;
  const env = r0 ? 'GSTACK_SHIP_READING=' + r0.tokens + ' GSTACK_SHIP_CREDITS=' + r0.credits + ' ' : '';
  const run = await sh('gstack-ship-phase run --dir ' + q(input.dir) + ' --phase ' + q(input.phase) + (input.record ? ' --record ' + q(input.record) : '')
    + ' --wait-s ' + Math.max(1, Math.round((T0 + (input.budgetMs || 200000) - (await now())) / 1000)) + ' -- ' + commands.map(q).join(' '), env);
  push(run.out);
  if (run.code !== 0 && !stopped()) lines.push('STOP: gstack-ship-phase run exited ' + run.code + '; nothing after it ran');
  if (run.code !== 0 || (lines.length && lines[lines.length - 1].startsWith('NEXT: rerun'))) return finish();
}
if (input.pass) {
  const p = await sh('gstack-review-dispatch program');
  const nl = p.out.indexOf('\n');
  if (p.code !== 0 || !p.out.startsWith('PROGRAM: ') || nl < 0) { lines.push('STOP: gstack-review-dispatch program exited ' + p.code + ': ' + p.out.slice(0, 300)); return finish(); }
  lines.push(p.out.slice(0, nl));
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const passInput = Object.assign({ startedAt: T0, launch: input.launch, cwd: input.cwd, record: input.record, jam: input.jam }, input.pass);
  push(String(await new AsyncFunction('tools', 'sleep', 'now', 'input', JSON.parse(p.out.slice(nl + 1).split('\n')[0]))(tools, sleep, now, passInput)));
  return finish();
}
if (input.record && input.step) {
  if (!input.jam) { lines.push('STOP: the closing note needs input.jam (this jam\'s id) for its reading; the phase\'s commands ran'); return finish(); }
  const r1 = await reading();
  const n = await sh('gstack-ship-budget note --record ' + q(input.record) + ' --step ' + q(input.step) + (input.label ? ' --label ' + q(input.label) : '')
    + ' --reading ' + r1.tokens + ' --credits ' + r1.credits);
  push(n.out);
  if (n.code !== 0) { if (!stopped()) lines.push('STOP: gstack-ship-budget note exited ' + n.code + ' (its lines above say why)'); return finish(); }
}
const s = await sh('test -f ' + q(String(input.dir).replace(/\/+$/, '') + '/parts/state.json') + ' && echo started || true');
if (s.out.startsWith('started') && /^\d+$/.test(String(input.phase))) {
  const room = RETURN_BYTES - lines.join('\n').length - 200;
  const p = await sh('gstack-ship-parts next --run ' + q(input.dir) + ' --phase ' + (Number(input.phase) + 1) + ' --room ' + Math.max(0, room));
  push(p.out);
}
return finish();
