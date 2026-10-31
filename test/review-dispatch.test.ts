import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BriefError, promptHash, renderBrief, sectionTexts } from '../lib/review-brief';
import { judge, parseFindings, type MergedLine } from '../lib/review-ledger';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-review-dispatch');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-')); dirs.push(d); return d; };
const run = (args: string[], cwd = ROOT) => spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: 60_000 });
const SHA = 'a'.repeat(40);
const section = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const field = (out: string, k: string) => new RegExp(`${k}=(\\S+)`).exec(out)?.[1] ?? '';

describe('gstack-review-dispatch render: briefs from the sections, slots only', () => {
  // Value: protects=every blocking reader's brief is cut from its section's own bytes with only declared slots filled, so a driven /ship sends what ship/SKILL.md sends; fails_when=a renderer paraphrases, drops a line, leaves a placeholder, or a section edit silently stops matching (GSTA-167 no-loss round 4: 37 of 112 dispatched briefs matched; a batched brief lost two lines);
  //   why_new=no renderer existed; the driver relied on the model to fill placeholders; seam=lib/review-brief.ts and bin/gstack-review-dispatch; no_claim=that the reader then follows its brief
  test('each role renders, carries its section lines verbatim and leaves no placeholder', () => {
    const t = sectionTexts(ROOT);
    const slots = { diff_base: SHA, exclude: "-- . ':(exclude)*.lock'", stack: 'TypeScript', test_fw: 'bun:test', name: 'testing', checklist: '/x/testing.md', checklists: '/x/a.md,/x/b.md',
      findings: '[CRITICAL] a.ts:3 off by one', specialists: '4', diff: '+const a = 1;', fix_list: 'a.ts:3 fixed', hunks: '+x', tests: '3 pass' };
    const army = section('ship/sections/review-army.md');
    const adv = section('ship/sections/adversarial.md');
    const spec = renderBrief('specialist', slots, t);
    for (const line of ['Output nothing else: no preamble, no summary or commentary.', 'Required fields: severity, confidence, path, category, summary, specialist.',
      'blocks with clear intent. Skip test_stub for architectural or design-only findings.']) { expect(army).toContain(line); expect(spec).toContain(line); }
    expect(spec).toContain('Read the checklist at /x/testing.md');
    expect(spec).toContain(`git diff "$DIFF_BASE" -- . ':(exclude)*.lock'`);
    expect(spec).toContain(`DIFF_BASE=${SHA}`);
    expect(spec).not.toContain('write the sha in before dispatch');
    const batched = renderBrief('specialist-batched', slots, t);
    expect(batched).toContain('Read each checklist at /x/a.md, /x/b.md');
    expect(batched.split('\n').length).toBe(spec.split('\n').length);
    const security = renderBrief('specialist', { ...slots, name: 'security' }, t);
    expect(security.startsWith('This is an authorized defensive-security review')).toBe(true);
    expect(security).toContain('reviewed in summary mode');
    const red = renderBrief('red-team', slots, t);
    expect(red).toContain('reviewed by 4 specialists');
    expect(red).toContain('[CRITICAL] a.ts:3 off by one');
    const native = renderBrief('adversarial-native', slots, t);
    expect(adv).toContain('Think like an attacker and a chaos engineer. Your job is to find ways this code will fail in production.');
    expect(native).toContain('Think like an attacker and a chaos engineer. Your job is to find ways this code will fail in production.');
    expect(native).toContain(`DIFF_BASE=${SHA} && git diff --name-status`);
    const outside = renderBrief('outside-voice', slots, t);
    expect(outside).toContain('Filesystem boundary: do not read or execute any files under ~/.claude/');
    expect(outside).toContain('+const a = 1;');
    expect(renderBrief('fix-check', slots, t)).toContain('You are the fix-check reviewer');
    for (const text of [spec, batched, security, red, native]) for (const p of ['<diff-base>', '<exclude>', '<base>', '{checklist path}', '{STACK}', '{TEST_FW}', '{learnings']) expect(text).not.toContain(p);
  });

  test('a missing slot, a non-sha diff base and a section that lost its anchor refuse instead of rendering', () => {
    const t = sectionTexts(ROOT);
    expect(() => renderBrief('specialist', { diff_base: SHA, name: 'testing' }, t)).toThrow(BriefError);
    expect(() => renderBrief('adversarial-native', { diff_base: '$RANGE_BASE' }, t)).toThrow(/literal commit sha/);
    const root = tmp();
    fs.mkdirSync(path.join(root, 'ship/sections'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ship/sections/review-army.md'), section('ship/sections/review-army.md').replace('"You are a specialist code reviewer.', '"You review code.'));
    fs.writeFileSync(path.join(root, 'ship/sections/adversarial.md'), section('ship/sections/adversarial.md'));
    expect(() => sectionTexts(root)).toThrow(/specialist brief: start anchor not found/);
  });

  test('the CLI writes the brief, prints its hash and records it; the file hashes to the printed value', () => {
    const out = tmp();
    const r = run(['render', '--role', 'specialist', '--name', 'testing', '--out', out, '--diff-base', SHA, '--stack', 'TypeScript']);
    expect(r.status).toBe(0);
    const file = field(r.stdout, 'file');
    expect(r.stdout).toContain('BRIEF: reader=specialist/testing');
    expect(promptHash(fs.readFileSync(file, 'utf8'))).toBe(field(r.stdout, 'sha256'));
    expect(fs.readFileSync(path.join(out, 'review-ledger.jsonl'), 'utf8')).toContain('"event":"rendered"');
    expect(run(['render', '--role', 'specialist', '--name', 'no-such-specialist', '--out', out, '--diff-base', SHA]).stderr).toContain('BRIEF_RENDER_FAILED: checklist not found');
  });
});

describe('gstack-review-dispatch sent, collect, judge and verify: nothing changed on the way in or out', () => {
  function pass() {
    const out = tmp();
    const ledger = path.join(out, 'review-ledger.jsonl');
    const merged = path.join(out, 'merged.jsonl');
    const file = field(run(['render', '--role', 'specialist', '--name', 'testing', '--out', out, '--diff-base', SHA]).stdout, 'file');
    return { out, ledger, merged, file, w: (n: string, t: string) => { const f = path.join(out, n); fs.writeFileSync(f, t); return f; } };
  }
  // Value: protects=a dispatched prompt that is not byte-for-byte its rendered brief fails the pass and shows in verify; fails_when=a paraphrased or trimmed brief is recorded as reviewed (round 4: 75 of 112 briefs differed from the rendered ones);
  //   why_new=no ledger recorded prompt hashes; seam=sent and verify; no_claim=that the host passed the recorded text
  test('the rendered file sent unchanged matches; a brief with one line dropped is BRIEF_MISMATCH and verify is dirty', () => {
    const p = pass();
    const ok = run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', p.file]);
    expect([ok.status, ok.stdout.startsWith('BRIEF_SENT: reader=specialist/testing')]).toEqual([0, true]);
    expect(run(['verify', '--ledger', p.ledger]).stdout).toMatch(/^BRIEF specialist\/testing NOT_COLLECTED rendered=(\w+) sent=\1$/m);
    const lines = fs.readFileSync(p.file, 'utf8').split('\n');
    const trimmed = p.w('trimmed.txt', lines.filter((_, i) => i !== 3).join('\n'));
    const bad = run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', trimmed]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('BRIEF_MISMATCH: reader=specialist/testing');
    const v = run(['verify', '--ledger', p.ledger]);
    expect([v.status, v.stdout.includes('BRIEF specialist/testing MISMATCH'), v.stdout.includes('VERIFY: dirty')]).toEqual([1, true, true]);
  });

  // Value: protects=verify checks each render as its own dispatch, so a two-pass ledger compares pass-1 sends with pass-1 briefs, and a mismatched send re-sent byte-exact before any collect is reported as voided, never hidden; a mismatched send that produced an output stays dirty; fails_when=a run-wide verify prints dirty for a clean two-pass run, a superseded mismatch blocks, voided is not printed, or an output collected under a mismatched send reads clean (GSTA-189 #36 replay: VERIFY dirty briefs=9 outputs=16, every output MATCH);
  //   why_new=verify compared every send with the reader's last render; both passes render into one briefs directory and judge runs with relative paths, as a dispatch program does (pass-3 fix-check); seam=sent, collect and verify; no_claim=which pass a render belongs to beyond ledger order
  test('two passes verify per render; a superseded mismatch is voided=1; a mismatched send with an output stays dirty', () => {
    const p = pass();
    const out = p.w('spec.out', 'NO FINDINGS\n');
    const send = (file: string) => run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', file]);
    const take = () => run(['collect', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--output', out, '--merged', p.merged]);
    send(p.file); take();
    const second = field(run(['render', '--role', 'specialist', '--name', 'testing', '--out', p.out, '--ledger', p.ledger, '--diff-base', 'b'.repeat(40)]).stdout, 'file');
    const truncated = p.w('truncated.txt', fs.readFileSync(second, 'utf8').slice(0, 200));
    expect(send(truncated).status).toBe(1);
    send(second); take();
    p.w('judged.jsonl', '');
    expect(run(['judge', '--ledger', 'review-ledger.jsonl', '--merged', 'merged.jsonl', '--judged', 'judged.jsonl'], p.out).status).toBe(0);
    const v = run(['verify', '--ledger', p.ledger]);
    expect([v.status, v.stdout.includes('BRIEF specialist/testing MATCH'), v.stdout.includes('BRIEF specialist/testing@2 MATCH'), v.stdout.includes(' voided=1\n'), v.stdout.includes('VERIFY: clean briefs=2 outputs=2 voided=1')]).toEqual([0, true, true, true, true]);
    const q = pass();
    const qt = q.w('t.txt', fs.readFileSync(q.file, 'utf8').slice(0, 200));
    run(['sent', '--ledger', q.ledger, '--role', 'specialist', '--name', 'testing', '--sent', qt]);
    run(['collect', '--ledger', q.ledger, '--role', 'specialist', '--name', 'testing', '--output', q.w('o.out', 'NO FINDINGS\n'), '--merged', q.merged]);
    run(['sent', '--ledger', q.ledger, '--role', 'specialist', '--name', 'testing', '--sent', q.file]);
    const w = run(['verify', '--ledger', q.ledger]);
    expect([w.status, w.stdout.includes('BRIEF specialist/testing MISMATCH'), w.stdout.includes('brief_not_sent_verbatim'), w.stdout.includes('voided=0')]).toEqual([1, true, true, true]);
  });

  // Value: protects=findings reach merged.jsonl only through collect with each voice's label as written, and lead judgment can add or promote but never drop or downgrade; fails_when=the parent drops a reader's finding, lowers its severity, folds it into a weaker duplicate or adds one silently, or merged lines no longer trace to the output hash;
  //   why_new=merging was the model's own prose step; seam=collect, judge and verify; no_claim=that the judged set is used downstream by Step 9.4
  test('collect keeps raw labels; judge rejects a drop and a downgrade, accepts a reasoned promotion and a fold into an equal duplicate', () => {
    const p = pass();
    run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', p.file]);
    const spec = p.w('spec.out', '{"severity":"CRITICAL","path":"a.ts","line":3,"category":"logic","summary":"off by one","specialist":"testing"}\n{"severity":"INFORMATIONAL","path":"a.ts","line":9,"category":"style","summary":"name","specialist":"testing"}\n');
    const outside = p.w('outside.out', 'Findings:\n1. **High**: retry loop never backs off (q.ts:78)\n2. Low - log line is noisy\nRecommendation: Fix the retry because it DoSes the pool\n');
    const c1 = run(['collect', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--output', spec, '--merged', p.merged]);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const ov = field(run(['render', '--role', 'outside-voice', '--out', p.out, '--diff-base', head]).stdout, 'file');
    run(['sent', '--ledger', p.ledger, '--role', 'outside-voice', '--sent', ov]);
    const c2 = run(['collect', '--ledger', p.ledger, '--role', 'outside-voice', '--output', outside, '--merged', p.merged]);
    expect([c1.stdout.includes('findings=2'), c2.stdout.includes('findings=2')]).toEqual([true, true]);
    const merged = fs.readFileSync(p.merged, 'utf8').trim().split('\n').map(l => JSON.parse(l) as MergedLine);
    expect(merged.map(m => [m.id, m.label])).toEqual([['specialist/testing#1', 'CRITICAL'], ['specialist/testing#2', 'INFORMATIONAL'], ['outside-voice#1', 'High'], ['outside-voice#2', 'Low']]);
    const jl = (rows: object[]) => p.w('judged.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const keep = [{ id: 'specialist/testing#1', severity: 'CRITICAL' }, { id: 'specialist/testing#2', severity: 'INFORMATIONAL' }, { id: 'outside-voice#1', severity: 'High' }, { id: 'outside-voice#2', severity: 'Low' }];
    const dropped = run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', jl(keep.filter(k => k.id !== 'outside-voice#2'))]);
    expect([dropped.status, dropped.stdout]).toEqual([1, expect.stringContaining('JUDGMENT_REJECTED: dropped=["outside-voice#2"]')]);
    const downgraded = run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', jl(keep.map(k => (k.id === 'specialist/testing#1' ? { ...k, severity: 'INFORMATIONAL' } : k)))]);
    expect([downgraded.status, downgraded.stdout]).toEqual([1, expect.stringContaining('downgraded=["specialist/testing#1"]')]);
    const weakFold = run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', jl(keep.map(k => (k.id === 'outside-voice#1' ? { ...k, duplicate_of: 'specialist/testing#2' } : k)))]);
    expect(weakFold.stdout).toContain('downgraded=["outside-voice#1"]');
    const silentAdd = run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', jl([...keep, { id: 'lead#1', severity: 'CRITICAL' }])]);
    expect(silentAdd.stdout).toContain('unexplained=["lead#1"]');
    const ok = run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', jl([
      ...keep.map(k => (k.id === 'outside-voice#1' ? { ...k, duplicate_of: 'specialist/testing#1' } : k.id === 'outside-voice#2' ? { ...k, severity: 'INFORMATIONAL', reason: 'it hides a real error line' } : k)),
      { id: 'lead#1', severity: 'CRITICAL', reason: 'the core checklist found a broken caller' }])]);
    expect([ok.status, ok.stdout.trim()]).toEqual([0, 'JUDGMENT: ok added=1 promoted=1 folded=1']);
    const ledger = fs.readFileSync(p.ledger, 'utf8');
    expect(ledger).toContain('"kind":"promoted","id":"outside-voice#2","from":"Low","to":"INFORMATIONAL","reason":"it hides a real error line"');
    expect(ledger).toContain('"kind":"added","id":"lead#1"');
    const v = run(['verify', '--ledger', p.ledger]);
    expect([v.status, v.stdout.includes('OUTPUT outside-voice MATCH'), v.stdout.includes('JUDGE - OK'), v.stdout.includes('VERIFY: clean briefs=2 outputs=2')]).toEqual([0, true, true, true]);
    fs.writeFileSync(p.merged, fs.readFileSync(p.merged, 'utf8').replace('"label":"Low"', '"label":"Low","x":1').replace(/"output_sha256":"[0-9a-f]+"}\n$/, '"output_sha256":"' + '0'.repeat(64) + '"}\n'));
    const tampered = run(['verify', '--ledger', p.ledger]);
    expect([tampered.status, tampered.stdout.includes('OUTPUT outside-voice MISMATCH')]).toEqual([1, true]);
  });

  // Value: protects=verify is clean only when every collected output came from a brief rendered and sent verbatim, nothing was collected after the judgment, and the judged set still passes as recorded; a fold keeps a standalone survivor; fails_when=outputs from hand-written briefs, a finding collected after judge, a judged.jsonl edited after judge, a self-fold or a fold cycle still read clean (/ship #3648 pass-1 Red Team);
  //   why_new=the first gate trusted the last verdict and any duplicate_of; seam=verify and judge; no_claim=the host's dispatch
  test('verify is dirty for an unrendered reader, an output after judge and a judged set edited after judge; self-folds and fold cycles are drops', () => {
    const p = pass();
    run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', p.file]);
    const spec = p.w('spec.out', '{"severity":"CRITICAL","path":"a.ts","line":3,"category":"logic","summary":"x","specialist":"testing"}\n');
    run(['collect', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--output', spec, '--merged', p.merged]);
    const judged = p.w('judged.jsonl', JSON.stringify({ id: 'specialist/testing#1', severity: 'CRITICAL' }) + '\n');
    expect(run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', judged]).status).toBe(0);
    expect(run(['verify', '--ledger', p.ledger]).stdout).toContain('VERIFY: clean');
    fs.appendFileSync(judged, JSON.stringify({ id: 'lead#1', severity: 'Low', reason: 'late' }) + '\n');
    expect(run(['verify', '--ledger', p.ledger]).stdout).toContain('judged_changed_since_judge');
    const hand = p.w('hand.out', '{"severity":"CRITICAL","path":"b.ts","line":1,"category":"x","summary":"y","specialist":"red-team"}\n');
    run(['collect', '--ledger', p.ledger, '--role', 'red-team', '--output', hand, '--merged', p.merged]);
    const v = run(['verify', '--ledger', p.ledger]);
    expect([v.status, v.stdout.includes('OUTPUT red-team MISMATCH'), v.stdout.includes('brief_not_rendered'), v.stdout.includes('output_after_judge=red-team')]).toEqual([1, true, true, true]);
    const m: MergedLine[] = [{ id: 'a#1', reader: 'a', label: 'CRITICAL', raw: 'x', output_sha256: 'h' }, { id: 'a#2', reader: 'a', label: 'CRITICAL', raw: 'y', output_sha256: 'h' }];
    expect(judge(m, [{ id: 'a#1', severity: 'CRITICAL', duplicate_of: 'a#1' }, { id: 'a#2', severity: 'CRITICAL' }]).dropped).toEqual(['a#1']);
    expect(judge(m, [{ id: 'a#1', severity: 'CRITICAL', duplicate_of: 'a#2' }, { id: 'a#2', severity: 'CRITICAL', duplicate_of: 'a#1' }]).dropped).toEqual(['a#1', 'a#2']);
    expect(judge(m, [{ id: 'a#1', severity: 'CRITICAL', duplicate_of: 'a#2' }, { id: 'a#2', severity: 'CRITICAL' }]).ok).toBe(true);
  });

  // Value: protects=judge and verify see every collected finding: a judged set built from a merged file that leaves one out is a drop, and a reader sent a brief but never collected leaves verify dirty; fails_when=judge --merged <subset> or skipping one reader's collect still reads clean (/ship #3648 pass-2 Red Team, adversarial and outside voice);
  //   why_new=judge trusted the merged file it was given and verify only checked collected readers; seam=judge and verify; no_claim=the host's dispatch
  test('a judge over a merged subset is a drop and verify flags it; a sent reader never collected is NOT_COLLECTED', () => {
    const p = pass();
    run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', p.file]);
    const spec = p.w('spec.out', '{"severity":"CRITICAL","path":"a.ts","line":3,"category":"logic","summary":"x","specialist":"testing"}\n{"severity":"INFORMATIONAL","path":"b.ts","line":1,"category":"n","summary":"y","specialist":"testing"}\n');
    run(['collect', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--output', spec, '--merged', p.merged]);
    const subset = p.w('subset.jsonl', fs.readFileSync(p.merged, 'utf8').split('\n')[1] + '\n');
    const judged = p.w('judged.jsonl', JSON.stringify({ id: 'specialist/testing#2', severity: 'INFORMATIONAL' }) + '\n');
    const j = run(['judge', '--ledger', p.ledger, '--merged', subset, '--judged', judged]);
    expect([j.status, j.stdout + j.stderr]).toEqual([1, expect.stringContaining('specialist/testing#1')]);
    expect(run(['verify', '--ledger', p.ledger]).stdout).toContain('merged_ids_missing=specialist/testing#1');
    const q = pass();
    run(['sent', '--ledger', q.ledger, '--role', 'specialist', '--name', 'testing', '--sent', q.file]);
    const v = run(['verify', '--ledger', q.ledger]);
    expect([v.status, v.stdout.includes('BRIEF specialist/testing NOT_COLLECTED')]).toEqual([1, true]);
  });

  test('judge and parseFindings as functions: an unknown severity is invalid, NO FINDINGS and the Recommendation line are not findings', () => {
    expect(parseFindings('r', 'NO FINDINGS\n')).toEqual([]);
    expect(parseFindings('r', '## High\n1. The auth check skips webhooks (a.ts:4)\n  - Impact: nested evidence\n   **Fix:**\n- second one\n## Notes\n- not a finding\n**Critical findings**\n- real one\n**Recommendations**\n- consider renaming foo\n').map(f => [f.label, f.raw])).toEqual([['High', '1. The auth check skips webhooks (a.ts:4)'], ['High', '- second one'], ['Critical', '- real one']]);
    const shapes = ['1. **Unbounded retry in queue.ts:78** (FIXABLE): loops on 429', '2. `auth.ts:42` skips token expiry check — INVESTIGATE', '### CRITICAL: missing auth check in api.ts:10', '#### [P1] token not expired', '### High: authorization bypass (auth.ts:14)', '- **HIGH**: leak', '| High | race in queue.ts:4 |', 'Classification: INVESTIGATE', '7. **Informational: reads every file**'];
    expect(parseFindings('r', shapes.join('\n')).map(f => f.label)).toEqual(['FIXABLE', 'INVESTIGATE', 'CRITICAL', 'P1', 'High', 'HIGH', 'High', 'INVESTIGATE', 'Informational']);
    expect(parseFindings('r', 'FIXABLE: race in a.ts:3\nINVESTIGATE: odd lock\nRecommendation: Fix the race because x\n').map(f => f.label)).toEqual(['FIXABLE', 'INVESTIGATE']);
    const m: MergedLine[] = [{ id: 'r#1', reader: 'r', label: 'FIXABLE', raw: 'x', output_sha256: 'h' }];
    expect(judge(m, [{ id: 'r#1', severity: 'severe' }]).invalid).toEqual(['r#1']);
    expect(judge(m, [{ id: 'r#1', severity: 'INFORMATIONAL', reason: 'a real defect' }]).ok).toBe(true);
  });

  test('verify on a ledger that kept no prompts says so and exits 3', () => {
    const d = tmp();
    const ledger = path.join(d, 'ledger.jsonl');
    fs.writeFileSync(ledger, '{"event":"note","step":"9"}\n');
    const v = run(['verify', '--ledger', ledger]);
    expect([v.status, v.stdout.trim()]).toEqual([3, "VERIFY: no brief records (this run's ledger kept no prompts; dispatched-vs-rendered cannot be checked)"]);
  });
});
