// gstack /ship review pass program for Capy (lib/capy-review-pass.js, GSTA-167 calls PR 2).
// The body of an async function (tools, sleep, now, input), loaded verbatim by the loader in
// ship/DRIVER.md from `gstack-review-dispatch program`; never retyped. One call runs one pass or Step 11's
// voices from the manifest `gstack-review-dispatch pass` writes: render, chunked brief transport, `sent`,
// intent before create, create, poll, collect. It returns 200 s after the loader's first line
// (input.startedAt) at most; the next call resumes from the manifest. A failed, stuck or ambiguous
// reader, a brief mismatch or a failing bin returns `STOP:` for the parent; nothing is dropped.
const T0 = input.startedAt ?? (await now());
const deadline = T0 + (input.budgetMs ?? 200000);
const tick = input.tickMs ?? 20000;
const stuckMs = input.stuckMs ?? 20 * 60000;
const emptyGraceMs = 60000;
const emptyDone = {};
const RETURN_BYTES = 32000;
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const lines = [];
const sh = async (cmd) => {
  const r = await tools.capy.bash({ command: (input.launch ? '. ' + q(input.launch) + ' && ' : '') + (input.cwd ? 'cd ' + q(input.cwd) + ' && ' : '') + cmd, description: 'Ship review pass ' + input.pass, timeout: 300 });
  return { code: r.exit_code, out: r.output || '' };
};
const bin = 'gstack-review-dispatch';
const finish = (tail) => {
  const all = [...lines, ...tail];
  let text = all.join('\n');
  if (text.length > RETURN_BYTES) text = text.slice(0, RETURN_BYTES) + '\n(return capped at 32 KB; the rest is in the files named above)';
  return text;
};
const stop = (why) => finish(['STOP: ' + why]);

const passCmd = [bin, 'pass', '--base', q(input.base), '--out', q(input.out), '--pass', q(input.pass)];
if (input.ledger) passCmd.push('--ledger', q(input.ledger));
if (input.extras && typeof input.extras !== 'string') {
  const file = input.out.replace(/\/+$/, '') + '/extras.json';
  await tools.capy.write({ path: file, content: JSON.stringify(Array.isArray(input.extras) ? input.extras : [input.extras]) });
  passCmd.push('--extras', q(file));
} else if (input.extras) passCmd.push('--extras', q(input.extras));
if (input.learnings) passCmd.push('--learnings-file', q(input.learnings));
passCmd.push('--', ...(input.planFlags || []).map(q));
const pr = await sh(passCmd.join(' '));
if (pr.code !== 0) return stop('gstack-review-dispatch pass exited ' + pr.code + ': ' + pr.out.slice(-1500));
const passOut = pr.out.trimEnd().split('\n');
if (passOut[passOut.length - 1].startsWith('PASS: none ')) return finish(passOut);
const resumed = passOut.some((l) => l.startsWith('MANIFEST: ') && l.endsWith(' resumed'));
lines.push(...passOut.filter((l) => !resumed || l.startsWith('MANIFEST: ')));
const mf = input.out.replace(/\/+$/, '') + '/pass-manifest.json';

const load = async () => {
  const r = await sh(bin + ' show --manifest ' + q(mf));
  const at = r.out.indexOf('MANIFEST_JSON: ');
  if (r.code !== 0 || at < 0) throw new Error('show failed: ' + r.out.slice(-500));
  return JSON.parse(r.out.slice(at + 15).split('\n')[0]);
};
const mark = async (reader, state, extra) => {
  let cmd = bin + ' mark --manifest ' + q(mf) + ' --reader ' + q(reader) + ' --state ' + state;
  for (const [k, v] of Object.entries(extra || {})) cmd += ' --' + k + ' ' + q(v);
  const r = await sh(cmd);
  if (r.code !== 0) throw new Error('mark ' + reader + ' ' + state + ' failed: ' + r.out.slice(-500));
};
const reading = async () => {
  if (!input.record || !input.jam) return null;
  const t = await tools.thread.get({ thread_id: input.jam });
  return { tokens: t.cost.tokens, credits: t.cost.credits };
};
const briefText = async (r) => {
  let text = '';
  for (let i = 0; i < r.chunks; i++) {
    const c = await sh(bin + ' chunk --manifest ' + q(mf) + ' --reader ' + q(r.reader) + ' --index ' + i);
    const nl = c.out.indexOf('\n');
    const head = c.out.slice(0, nl);
    if (c.code !== 0 || !head.startsWith('BRIEF_CHUNK: ') || !head.includes(' of=' + r.chunks + ' ') || !head.endsWith('sha256=' + r.sha256)) throw new Error('chunk ' + i + ' of ' + r.reader + ': ' + c.out.slice(0, 300));
    text += JSON.parse(c.out.slice(nl + 1).split('\n')[0]);
  }
  return text;
};
const roleArgs = (r) => ' --role ' + q(r.role) + (r.name ? ' --name ' + q(r.name) : '');
const REASONING = { medium: 'medium', light: 'low' };
const modelOf = (r) => r.model || (input.models || {})[r.role === 'specialist-batched' ? 'specialist' : r.role]
  || (REASONING[r.effort] && input.laneModel ? { model_id: input.laneModel, reasoning_mode: REASONING[r.effort] } : undefined);
const safe = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_');
const active = input.stage === 'voices' ? ['voices'] : ['first', 'specialists', 'red-team'];

try {
  let m = await load();
  if (input.stage === 'voices' && !m.readers.some((r) => r.stage === 'voices')) return finish(['VOICES: none (the pass plan lists no Step 11 voice)', 'NEXT: judge']);
  for (const s of input.logStart || []) {
    const key = (input.stage === 'voices' ? 'voices:' : 'pass:') + s;
    if ((m.log_starts || {})[key]) continue;
    const l = await sh('gstack-review-log --start ' + s.split(' ').map(q).join(' ') + (input.reservation ? ' --reservation ' + q(input.reservation) : ''));
    if (l.code !== 0) return stop('gstack-review-log --start ' + s + ' exited ' + l.code + ': ' + l.out.slice(-500));
    const token = l.out.trim();
    const k = await sh(bin + ' mark --manifest ' + q(mf) + ' --log-start ' + q(key) + ' --token ' + q(token));
    if (k.code !== 0) return stop('recording the ' + s + ' start token exited ' + k.code + ': ' + k.out.slice(-500));
    lines.push('REVIEW_LOG_START: ' + s + ' token=' + token);
  }
  for (;;) {
    const failed = m.readers.find((x) => active.includes(x.stage) && x.state === 'failed');
    if (failed) return stop(failed.reader + ' (subagent ' + failed.path + ') ' + (failed.error || 'failed') + '; its review is incomplete, so the pass cannot certify coverage; restore it with a fresh pass under a new --pass and --out');
    const list = await tools.subagent.list({});
    const byTitle = (t) => list.tasks.filter((x) => x.title === t);
    const byPath = new Map(list.tasks.map((x) => [x.path, x]));
    for (const r of m.readers.filter((x) => active.includes(x.stage) && x.state === 'intent')) {
      const found = byTitle(r.title);
      if (found.length !== 1) return stop(r.reader + ' was being created when the last program ended and ' + found.length + ' subagents carry its title "' + r.title + '"; check them by hand before any rerun');
      await mark(r.reader, found[0].status === 'draft' ? 'queued' : 'created', { path: found[0].path });
    }
    m = await load();
    for (const r of m.readers.filter((x) => active.includes(x.stage) && x.state === 'queued')) {
      const t = byPath.get(r.path);
      if (t && t.status !== 'draft') { await mark(r.reader, 'created', {}); continue; }
      const model = modelOf(r);
      const s = await tools.subagent.start({ indices: [Number(r.path)], machine: 'shared', ...(model ? { model } : {}) });
      if ((s.started || []).length) await mark(r.reader, 'created', {});
      else if (r.state_at && (await now()) - Date.parse(r.state_at) > stuckMs) return stop(r.reader + ' (subagent ' + r.path + ') still queued after ' + Math.round(stuckMs / 60000) + ' minutes; free a subagent slot, then rerun');
    }
    for (const r of m.readers.filter((x) => active.includes(x.stage) && x.state === 'created')) {
      const t = byPath.get(r.path);
      if (!t) return stop(r.reader + "'s subagent " + r.path + ' is missing from the subagent list');
      if (t.status === 'failed' || t.status === 'stopped') { await mark(r.reader, 'failed', { error: t.status }); return stop(r.reader + ' (subagent ' + r.path + ') ' + t.status + '; its review is incomplete, so the pass cannot certify coverage'); }
      const stuck = async () => r.state_at && (await now()) - Date.parse(r.state_at) > stuckMs;
      const g = t.status === 'done' || t.status === 'idle' ? await tools.subagent.get({ path: r.path, transcript: 'none' }) : null;
      if (!g || !g.summary) {
        if (t.status === 'done') {
          const seen = (emptyDone[r.reader] ??= await now());
          if ((await now()) - seen >= emptyGraceMs) return stop(r.reader + ' (subagent ' + r.path + ') finished with no output');
          continue;
        }
        if (await stuck()) return stop(r.reader + ' (subagent ' + r.path + ') still ' + t.status + ' after ' + Math.round(stuckMs / 60000) + ' minutes with no output');
        continue;
      }
      const file = m.out + '/out/' + safe(r.reader) + '.txt';
      await tools.capy.write({ path: file, content: g.summary });
      const c = await sh(r.prompt_file ? bin + ' mark --manifest ' + q(mf) + ' --reader ' + q(r.reader) + ' --state collected --output ' + q(file)
        : bin + ' collect --ledger ' + q(m.ledger) + roleArgs(r) + ' --output ' + q(file) + ' --merged ' + q(m.merged) + ' --manifest ' + q(mf));
      if (c.code !== 0) return stop((r.prompt_file ? 'mark ' : 'collect ') + r.reader + ' exited ' + c.code + ': ' + c.out.slice(-500));
      if (!r.prompt_file) {
        lines.push(c.out.trim());
        await mark(r.reader, 'collected', { output: file });
      }
    }
    m = await load();
    const stage = active.find((s) => m.readers.some((r) => r.stage === s && r.state !== 'collected'));
    if (!stage) break;
    if (m.readers.some((r) => r.stage === stage && r.state === 'planned')) {
      const s = await sh(bin + ' stage --manifest ' + q(mf) + ' --stage ' + stage);
      if (s.code !== 0) return stop('stage ' + stage + ' exited ' + s.code + ': ' + s.out.slice(-800));
      lines.push(...s.out.trim().split('\n'));
      m = await load();
    }
    if (m.readers.some((x) => x.stage === stage && x.role === 'outside-voice' && x.state === 'rendered' && !modelOf(x))) return stop("the outside voice needs input.models['outside-voice'] (a model of another family); none was given");
    const unmapped = m.readers.find((x) => x.stage === stage && x.state === 'rendered' && REASONING[x.effort] && !modelOf(x));
    if (unmapped) return stop(unmapped.reader + ' runs at effort=' + unmapped.effort + ', which needs input.laneModel (your model id) or input.models; none was given');
    for (const r of m.readers.filter((x) => x.stage === stage && x.state === 'rendered')) {
      const model = modelOf(r);
      const text = await briefText(r);
      const sent = m.out + '/sent/' + safe(r.reader) + '.txt';
      await tools.capy.write({ path: sent, content: text });
      if (!r.prompt_file) {
        const s = await sh(bin + ' sent --ledger ' + q(m.ledger) + roleArgs(r) + ' --sent ' + q(sent));
        if (s.code !== 0) return stop(s.out.trim());
        lines.push(s.out.trim());
      }
      if (!m.before) {
        const b = await reading();
        if (b) { await sh(bin + ' mark --manifest ' + q(mf) + ' --before ' + b.tokens + ',' + b.credits); m.before = b; }
      }
      await mark(r.reader, 'intent', {});
      const res = await tools.subagent.create({ tasks: [{ title: r.title, prompt: text }], start: { machine: 'shared', ...(model ? { model } : {}) } });
      const idx = String(res.tasks[0].index);
      const queued = (res.rejected || []).some((x) => String(x.index) === idx);
      await mark(r.reader, queued ? 'queued' : 'created', { path: idx });
      lines.push('DISPATCHED: ' + r.reader + ' path=' + idx + (queued ? ' queued (subagent cap; started as a slot frees)' : ''));
    }
    m = await load();
    if ((await now()) + tick >= deadline) {
      const open = m.readers.filter((r) => active.includes(r.stage) && r.state !== 'collected');
      return finish([...open.map((r) => 'RUNNING: ' + r.reader + ' state=' + r.state + (r.path ? ' path=' + r.path : '')), 'NEXT: poll (run this same program again now; it resumes from the manifest)']);
    }
    await sleep(tick);
  }
  const done = m.readers.filter((r) => active.includes(r.stage));
  const after = await reading();
  let noteExit = 0;
  if (after && m.before && input.record && input.step) {
    const n = await sh('gstack-ship-budget note --step ' + q(input.step) + ' --reading ' + after.tokens + ' --credits ' + after.credits + ' --record ' + q(input.record) + ' --dispatched-at ' + m.before.tokens + ' --dispatched-credits ' + m.before.credits + ' --readers ' + done.length);
    lines.push(n.out.trim());
    noteExit = n.code;
  }
  const outs = [];
  for (const r of done) {
    const o = await sh('cat ' + q(r.output));
    outs.push('OUTPUT: ' + r.reader + ' file=' + r.output, o.out.trimEnd());
  }
  if (noteExit !== 0) return finish([...outs, 'STOP: gstack-ship-budget note exited ' + noteExit + ' (its lines above say why); judge nothing further until the budget allows it']);
  return finish([...outs, input.stage === 'voices' ? 'NEXT: judge the voices' : 'NEXT: judge (Phase 4)']);
} catch (e) {
  return stop('pass program error: ' + (e && e.message ? e.message : String(e)) + ' (the manifest keeps every recorded reader; rerun resumes)');
}
