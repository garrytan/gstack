import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BriefError, checkReviewedTree, promptHash, renderBrief, sectionTexts, workspaceParagraph } from '../lib/review-brief';
import { collect, judge, parseFindings, type MergedLine } from '../lib/review-ledger';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-review-dispatch');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-')); dirs.push(d); return d; };
/** A reader that follows its brief's workspace paragraph starts its reply with the REVIEWED_TREE line of that checkout (GST-482). */
function treeLineOf(cwd: string): string {
  const git = (a: string[]) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 30_000 }).stdout.trim();
  return `REVIEWED_TREE: ${git(['rev-parse', 'HEAD^{tree}'])} ${git(['rev-parse', '--show-toplevel'])}\n`;
}
function followBrief(output: string, cwd: string) {
  const text = fs.readFileSync(output, 'utf8');
  if (!text.includes('REVIEWED_TREE:')) fs.writeFileSync(output, treeLineOf(cwd) + text);
}
const run = (args: string[], cwd = ROOT) => {
  if (args[0] === 'collect' && !args.includes('--unavailable') && args.includes('--output')) followBrief(args[args.indexOf('--output') + 1]!, cwd);
  return spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: 60_000 });
};
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

  // Value: protects=a brief-render refusal reads as one clean line, not a crash (GST-507 moved the bin to process.exitCode);
  //   fails_when=the BriefError handler falls through to its rethrow and Bun dumps source and a stack after the line; seam=gstack-review-dispatch render
  test('a BriefError prints only its BRIEF_RENDER_FAILED line and exits 1', () => {
    const r = run(['render', '--role', 'specialist', '--name', 'no-such-specialist', '--out', tmp(), '--diff-base', SHA]);
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split('\n')).toEqual([expect.stringMatching(/^BRIEF_RENDER_FAILED: checklist not found/)]);
  });

  // Value: protects=the lean ensemble's one batched reader (GSTA-167 part 2) gets checklist paths when the parent passes the plan's
  //   checklists= names as printed; fails_when=the brief names bare checklist words a reader cannot open, or an unknown name
  //   renders; seam=gstack-review-dispatch render
  test('specialist-batched takes the DISPATCH checklists= names and writes each checklist path into the brief', () => {
    const out = tmp();
    const r = run(['render', '--role', 'specialist-batched', '--out', out, '--diff-base', SHA, '--checklists', 'testing,security,state-machines']);
    expect(r.status, r.stderr).toBe(0);
    const root = path.join(import.meta.dir, '..');
    const lists = ['testing', 'security', 'state-machines'].map(n => path.join(root, 'review/specialists', `${n}.md`)).join(', ');
    expect(fs.readFileSync(field(r.stdout, 'file'), 'utf8')).toContain(`Read each checklist at ${lists} (tag each finding's`);
    expect(run(['render', '--role', 'specialist-batched', '--out', out, '--diff-base', SHA, '--checklists', 'testing,maintenance']).stderr).toContain('BRIEF_RENDER_FAILED: checklist not found');
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
    // Replay C1-34 (GSTA-193): a judged line with "severity": null crashed judge with a TypeError; it is an invalid line.
    expect(judge(m, [{ id: 'r#1', severity: null as unknown as string }, { id: 'lead#1' } as unknown as { id: string; severity: string }]).invalid).toEqual(['r#1', 'lead#1']);
    expect(judge(m, [{ id: 'r#1', severity: 'INFORMATIONAL', reason: 'a real defect' }]).ok).toBe(true);
  });

  // Value: protects=normalizer v2 in production (GSTA-167 part 1, certified by round 5's G1): a prose voice's Blocks: yes reaches
  //   merged.jsonl as CRITICAL, so judge refuses a lead that keeps it below the floor; Blocks: no never lowers a label;
  //   fails_when=a Blocks: yes finding is collected at its Medium or INVESTIGATE label, a Blocks line with no finding before it is
  //   lost, or Blocks: no demotes; seam=parseFindings, judge
  test('a prose voice\'s Blocks: yes collects as CRITICAL, on its own line or the finding above it; Blocks: no never lowers', () => {
    const out = [
      '1. Retry loop drops the last row (queue.ts:78). Severity: Medium · Blocks: yes',
      '2. INVESTIGATE: lock order in pool.ts:12',
      '   Blocks: yes',
      '3. FIXABLE: stale cache key (cache.ts:4)',
      '   Severity: High',
      '   Blocks: no',
      '4. Token never expires (auth.ts:9)',
      '   Fix: check exp',
      '   **Blocks:** yes',
      'Recommendation: Fix the retry loop because it loses rows',
    ].join('\n');
    const got = parseFindings('outside-voice', out);
    expect(got.map(g => g.label)).toEqual(['CRITICAL', 'CRITICAL', 'High', 'CRITICAL']);
    expect(got[1]!.raw).toBe('2. INVESTIGATE: lock order in pool.ts:12 | Blocks: yes');
    expect(got[2]!.raw).toBe('3. FIXABLE: stale cache key (cache.ts:4) | Severity: High | Blocks: no');
    expect(got[3]!.raw).toBe('4. Token never expires (auth.ts:9) | **Blocks:** yes');
    const m: MergedLine[] = got.map((g, i) => ({ id: `o#${i + 1}`, reader: 'outside-voice', label: g.label, raw: g.raw, output_sha256: 'h' }));
    expect(judge(m, m.map(x => ({ id: x.id, severity: x.label === 'CRITICAL' ? 'Medium' : x.label }))).downgraded).toEqual(['o#1', 'o#2', 'o#4']);
  });

  // Value: protects=the prompt's own layout (a finding, then Severity, then Blocks lines) collects as ONE finding that keeps its
  //   locus, and an explicit Severity outranks a stray label word earlier on the line (#3660 Red Team and Testing findings);
  //   fails_when=the layout splits into a locus-less CRITICAL plus the finding at INVESTIGATE, or 'Low-level'/'[P2]' sets the label
  //   below an explicit Severity: Critical/High; seam=parseFindings
  test('a finding with Severity and Blocks lines below it is one record at the strongest label; a stray label word never lowers an explicit Severity', () => {
    const one = parseFindings('adversarial-native', ['1. INVESTIGATE: lock order in pool.ts:12', '   Severity: Medium', '   Blocks: yes'].join('\n'));
    expect(one).toEqual([{ label: 'CRITICAL', raw: '1. INVESTIGATE: lock order in pool.ts:12 | Severity: Medium | Blocks: yes' }]);
    const words = parseFindings('outside-voice', ['1. Low-level retry loop in queue.ts:78 drops writes on 429. Severity: Critical. Blocks: no', '- [P2] cache.ts:40 evicts live sessions. Severity: High. Blocks: no'].join('\n'));
    expect(words.map(w => w.label)).toEqual(['Critical', 'High']);
    const prose = parseFindings('outside-voice', ['1. FIXABLE: race in a.ts:3', 'Why it matters: two writers', 'Severity: Low', 'Blocks: yes', '2. Unlabeled item about b.ts:9', 'Severity: Medium'].join('\n'));
    expect(prose.map(p => [p.label, p.raw])).toEqual([['CRITICAL', '1. FIXABLE: race in a.ts:3 | Severity: Low | Blocks: yes'], ['Medium', '2. Unlabeled item about b.ts:9 | Severity: Medium']]);
  });

  // Value: protects=a prose blocker whose only marker is an inline Blocks: yes still reaches merged.jsonl as CRITICAL (#3660 pass 2
  //   Testing finding); fails_when=an unlabeled line carrying Blocks: yes collects nothing; seam=parseFindings
  test.each([
    ['1. Token never expires (auth.ts:9). Blocks: yes', '1. Token never expires (auth.ts:9). Blocks: yes'],
    ['Token never expires in auth.ts:9 — Blocks: yes', 'Token never expires in auth.ts:9 — Blocks: yes'],
    ['1. Token never expires (auth.ts:9)\nFix: check exp **Blocks:** yes', '1. Token never expires (auth.ts:9) | Fix: check exp **Blocks:** yes'],
  ])('an inline Blocks: yes with no label is one CRITICAL finding: %j', (output, raw) => {
    expect(parseFindings('outside-voice', output)).toEqual([{ label: 'CRITICAL', raw }]);
  });

  // Value: protects=a top-level `- Severity:` bullet is its own finding and keeps its section's floor (#3660 pass 2 outside voice);
  //   fails_when=two such bullets merge into one id or a Critical heading's item collects as Medium; seam=parseFindings
  test('top-level Severity bullets stay separate findings and keep the section label', () => {
    const got = parseFindings('outside-voice', ['## Critical findings', '- Severity: Medium — missing owner check at auth.ts:14', '- Severity: Low — token logged at log.ts:3'].join('\n'));
    expect(got.map(g => g.label)).toEqual(['Critical', 'Critical']);
  });
  // Value: protects=one finding per merged id however a voice lays findings out (#3660 pass 2 native adversarial); fails_when=
  //   paragraph findings or a sentence starting with "Blocks" fold into the finding above, or a numbered or quoted Blocks line
  //   collects nothing; seam=parseFindings
  test('paragraph findings stay separate, Blocks needs a colon to continue a finding, and a bare Blocks line is its own finding', () => {
    const bold = parseFindings('outside-voice', ['**Finding 1.** a.ts:3 drops rows', 'Severity: Low', 'Blocks: no', '**Finding 2.** b.ts:4 leaks', 'Severity: High', 'Blocks: yes'].join('\n'));
    expect(bold.map(b => [b.label, b.raw])).toEqual([['Low', '**Finding 1.** a.ts:3 drops rows | Severity: Low | Blocks: no'], ['CRITICAL', '**Finding 2.** b.ts:4 leaks | Severity: High | Blocks: yes']]);
    const plain = parseFindings('outside-voice', ['a.ts:3 drops rows', 'Severity: High', 'Blocks: yes', 'b.ts:4 leaks', 'Severity: High', 'Blocks: yes'].join('\n'));
    expect(plain.map(p => p.raw)).toEqual(['a.ts:3 drops rows | Severity: High | Blocks: yes', 'b.ts:4 leaks | Severity: High | Blocks: yes']);
    expect(parseFindings('outside-voice', ['1. Medium: cache key drift (c.ts:4)', '   Blocks the event loop on every miss - High'].join('\n')).map(f => f.label)).toEqual(['Medium', 'High']);
    expect(parseFindings('outside-voice', '2. Blocks: yes').map(f => f.label)).toEqual(['CRITICAL']);
    expect(parseFindings('outside-voice', '> Blocks: yes').map(f => f.label)).toEqual(['CRITICAL']);
  });
  // Value: protects=a later finding's Severity/Blocks line never lands on the finding before it, and an explicit Severity label
  //   decides its line (#3660 pass 2 Red Team); fails_when=the later blocker's text is lost and the earlier finding takes its
  //   CRITICAL, or 'Severity: Low (not High)' collects as High; seam=parseFindings
  test('prose after a finding\'s field, a blank-line paragraph or an indented block starts the next finding; an explicit Severity label wins', () => {
    const raws = (o: string) => parseFindings('outside-voice', o).map(f => [f.label, f.raw]);
    const two = [['Low', 'A in a.ts:1. | Severity: Low'], ['CRITICAL', 'B in b.ts:2. | Blocks: yes']];
    expect(raws('A in a.ts:1.\nSeverity: Low\n\nB in b.ts:2.\nBlocks: yes')).toEqual(two);
    expect(raws('A in a.ts:1.\nSeverity: Low\nB in b.ts:2.\nBlocks: yes')).toEqual(two);
    expect(raws('Findings:\n  A in a.ts:1.\n  Severity: Low\n  B in b.ts:2.\n  Blocks: yes')).toEqual(two);
  });
  // Value: protects=the fix-check's shapes (#3660): a blocker keeps its own id and its subject, field bullets stay on their finding,
  //   and no Severity label buries a stronger label on its line; fails_when=any of these collects below CRITICAL, merges a later
  //   blocker into an earlier finding, or loses the finding's file:line; seam=parseFindings
  test.each([
    ['A in a.ts:1.\nSeverity: Low\nB in b.ts:2 drops rows. Blocks: yes', [['Low', 'A in a.ts:1. | Severity: Low'], ['CRITICAL', 'B in b.ts:2 drops rows. Blocks: yes']]],
    ['**Finding 1.** a.ts:3 races. Severity: Low\n**Finding 2.** b.ts:4 leaks. Blocks: yes', [['Low', '**Finding 1.** a.ts:3 races. Severity: Low'], ['CRITICAL', '**Finding 2.** b.ts:4 leaks. Blocks: yes']]],
    ['FIXABLE: race in a.ts:3\nSeverity: Medium\nWhy: the writer races\nBlocks: yes', [['CRITICAL', 'FIXABLE: race in a.ts:3 | Severity: Medium | Blocks: yes']]],
    ['- Unlabeled thing in a.ts:3\n- Severity: Medium\n- Blocks: yes', [['CRITICAL', '- Unlabeled thing in a.ts:3 | - Severity: Medium | - Blocks: yes']]],
    ['1. Token never expires (auth.ts:9)\nFix: check exp\nBlocks: yes', [['CRITICAL', '1. Token never expires (auth.ts:9) | Blocks: yes']]],
    ['1. Retry storm (r.ts:2)\nSeverity High', [['High', '1. Retry storm (r.ts:2) | Severity High']]],
    ['CRITICAL: x.ts:4 drops rows (pass 1 had Severity: Low)', [['CRITICAL', 'CRITICAL: x.ts:4 drops rows (pass 1 had Severity: Low)']]],
  ])('fix-check shape %j', (output, want) => expect(parseFindings('outside-voice', output).map(f => [f.label, f.raw])).toEqual(want));
  test('the native voice\'s FIXABLE collects as CRITICAL under its role with or without a dispatch name', () => {
    for (const reader of ['adversarial-native', 'adversarial-native/adversarial']) expect(parseFindings(reader, 'FIXABLE: race in a.ts:3\nSeverity: Medium\nBlocks: no').map(f => f.label)).toEqual(['CRITICAL']);
    expect(parseFindings('outside-voice', 'FIXABLE: race in a.ts:3\nSeverity: Medium').map(f => f.label)).toEqual(['Medium']);
  });
  test('a non-prefix Blocks: yes under a labeled finding raises it to CRITICAL', () => {
    expect(parseFindings('outside-voice', '1. Retry loses writes (queue.ts:78). Severity: Medium\n   Fix: reject the batch. Blocks: yes')).toEqual([{ label: 'CRITICAL', raw: '1. Retry loses writes (queue.ts:78). Severity: Medium | Fix: reject the batch. Blocks: yes' }]);
  });

  // Value: protects=a reader reply with no finding and no clean marker (a refusal, an empty reply, a reader that never saw the diff) is
  //   recorded as a non-review: collect exits 1 and verify reports the brief NOT_COLLECTED, never clean; fails_when=collect hashes the
  //   GSTA-196 refusal ("I'm not returning NO FINDINGS"), an empty file or an "I could not access the diff" reply as findings=0 and verify
  //   reads MATCH (replay C3-36: the batched specialist found no diff base and its brief read MATCH);
  //   why_new=collect recorded whatever parseFindings returned and verify counted any output as collected; seam=collect and verify;
  //   no_claim=that a reply carrying a marker actually reviewed the diff
  test('a reply with no finding and no clean marker is a non-review: collect exits 1 and verify is NOT_COLLECTED, never clean', () => {
    const refusal = fs.readFileSync(path.join(ROOT, 'test/fixtures/review-ledger/gsta-196-refusal.txt'), 'utf8');
    expect(promptHash(refusal)).toBe('7150c3b9ffe2698f77a988fa422b66d7004e1939d12e81185e8d556a47dff784');
    const b = tmp();
    const batched = field(run(['render', '--role', 'specialist-batched', '--checklists', 'testing,security,state-machines', '--out', b, '--diff-base', SHA]).stdout, 'file');
    const cases = [
      { reader: 'specialist-batched', dir: b, brief: batched, output: treeLineOf(ROOT) + refusal, args: ['--role', 'specialist-batched'] },
      ...['', 'I could not access the diff: git diff failed with "bad object", so there is nothing here to review.\n'].map(output => {
        const p = pass();
        return { reader: 'specialist/testing', dir: p.out, brief: p.file, output: treeLineOf(ROOT) + output, args: ['--role', 'specialist', '--name', 'testing'] };
      }),
    ];
    for (const c of cases) {
      const ledger = path.join(c.dir, 'review-ledger.jsonl');
      const merged = path.join(c.dir, 'merged.jsonl');
      const out = path.join(c.dir, 'reply.out');
      fs.writeFileSync(out, c.output);
      expect(run(['sent', '--ledger', ledger, ...c.args, '--sent', c.brief]).status).toBe(0);
      const col = run(['collect', '--ledger', ledger, ...c.args, '--output', out, '--merged', merged]);
      expect([col.status, col.stdout.startsWith(`COLLECT_NOT_REVIEWED: reader=${c.reader} findings=0 sha256=${promptHash(c.output)} `)]).toEqual([1, true]);
      const event = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!);
      expect([event.event, event.ids, event.review]).toEqual(['output', [], false]);
      fs.writeFileSync(path.join(c.dir, 'judged.jsonl'), '');
      expect(run(['judge', '--ledger', ledger, '--merged', merged, '--judged', path.join(c.dir, 'judged.jsonl')]).status).toBe(0);
      const v = run(['verify', '--ledger', ledger]);
      expect([v.status, v.stdout.includes(`BRIEF ${c.reader} NOT_COLLECTED rendered=`), v.stdout.includes(`OUTPUT ${c.reader} NOT_REVIEWED`), v.stdout.includes(' not_reviewed\n'), v.stdout.includes('VERIFY: dirty')]).toEqual([1, true, true, true, true]);
    }
  });

  // Value: protects=a clean reply carrying its section's marker and a reply with findings still collect with exit 0 and verify clean under
  //   the non-review rule; fails_when=the rule makes a real NO FINDINGS specialist or a findings reply dirty or exit 1;
  //   why_new=the non-review rule above could over-reach; seam=collect and verify; no_claim=other roles (the matrix below covers them)
  test('a NO FINDINGS reply and a findings reply still collect with exit 0 and verify clean', () => {
    for (const [output, findings] of [[treeLineOf(ROOT) + 'NO FINDINGS\n', 0], [treeLineOf(ROOT) + '{"severity":"CRITICAL","path":"a.ts","line":3,"category":"logic","summary":"off by one","specialist":"testing"}\n', 1]] as const) {
      const p = pass();
      run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', p.file]);
      const col = run(['collect', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--output', p.w('reply.out', output), '--merged', p.merged]);
      expect([col.status, col.stdout.startsWith(`COLLECT: reader=specialist/testing findings=${findings} `)]).toEqual([0, true]);
      expect(JSON.parse(fs.readFileSync(p.ledger, 'utf8').trim().split('\n').at(-1)!).review).toBe(true);
      const judged = p.w('judged.jsonl', findings ? JSON.stringify({ id: 'specialist/testing#1', severity: 'CRITICAL' }) + '\n' : '');
      expect(run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', judged]).status).toBe(0);
      const v = run(['verify', '--ledger', p.ledger]);
      expect([v.status, v.stdout.includes(`OUTPUT specialist/testing MATCH sha=${promptHash(output).slice(0, 12)} findings=${findings}`), v.stdout.includes('VERIFY: clean briefs=1 outputs=1')]).toEqual([0, true, true]);
    }
  });

  // Value: protects=each role's zero-finding reply counts as a review only with the marker its own section prescribes (NO FINDINGS for
  //   specialists, the batched specialist, Red Team, fix-check and targeted; the Recommendation: line for the outside voice; either for the
  //   native adversarial voice); fails_when=a marker named inside a sentence, another role's marker or an empty reply reads as clean, or a
  //   prescribed marker reads as a non-review; why_new=no marker check existed; seam=collect; no_claim=that the marker's reason is true
  test('each role takes only the clean marker its section prescribes', () => {
    const d = tmp();
    const outsideClean = 'No actionable findings in the supplied diff. Static review only.\n\nRecommendation: approve because the diff introduces no demonstrated bypass.\n';
    const cases: Array<[string, string, boolean]> = [
      ['specialist/testing', 'NO FINDINGS\n', true], ['specialist-batched', '`NO FINDINGS`\n', true], ['targeted', 'NO FINDINGS\n', true], ['fix-check', 'NO FINDINGS\n', true],
      ['red-team', 'Fixtures were reviewed in summary mode only.\n\nNO FINDINGS\n', true],
      ['adversarial-native', 'Fixtures were reviewed in summary mode.\n\nRecommendation: Ship as-is because no finding survived tracing\n', true], ['adversarial-native', 'NO FINDINGS\n', true],
      ['outside-voice', outsideClean, true], ['outside-voice', 'NO FINDINGS\n', false],
      ['specialist/testing', 'Recommendation: ship because it is clean\n', false], ['specialist/testing', "I'm not returning NO FINDINGS, because I never saw the diff.\n", false],
      ['red-team', '', false], ['fix-check', 'The fixes look fine to me.\n', false], ['adversarial-native', 'I could not read the diff.\n', false],
    ];
    for (const [i, [reader, output, review]] of cases.entries()) {
      const ledger = path.join(d, `l${i}.jsonl`);
      const r = collect(ledger, reader, output, path.join(d, `m${i}.jsonl`));
      expect([reader, output, r.lines.length, r.review]).toEqual([reader, output, 0, review]);
      expect(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).review).toBe(review);
    }
  });

  // Value: protects=a paragraph finding's unlabeled detail bullets and the Severity/Blocks line after them stay one finding (GSTA-196
  //   native voice: 4 findings collected as 8, the closing Severity lines opening phantoms judge had to fold); a list item's sibling and
  //   a labeled bullet still start their own findings; fails_when=the sample collects more or fewer than 4, or a labeled bullet merges
  //   away; why_new=every margin list item closed the open finding; seam=parseFindings; no_claim=indented detail lists (already attached)
  test('unlabeled detail bullets and the Severity line after them stay on the open paragraph finding', () => {
    const native = fs.readFileSync(path.join(ROOT, 'test/fixtures/review-ledger/gsta-196-native.txt'), 'utf8');
    expect(parseFindings('adversarial-native', native).map(f => [f.label, f.raw.slice(0, 12), f.raw.endsWith('| Severity: ' + (f.label === 'High' ? 'High' : 'Low') + '. Blocks: no.')]))
      .toEqual([['High', '**1. A PR in', true], ['CRITICAL', '**2. A case ', true], ['CRITICAL', '**3. Local `', true], ['Low', '**4. No trai', true]]);
    expect(parseFindings('outside-voice', '1. FIXABLE: race in a.ts:3\n- Unlabeled sibling at b.ts:9\nSeverity: Medium').map(f => f.label)).toEqual(['FIXABLE', 'Medium']);
    expect(parseFindings('outside-voice', '**Retry storm in r.ts:2 (INVESTIGATE).**\n- detail\n- High: a second defect in s.ts:4\nSeverity: Medium').map(f => f.label)).toEqual(['INVESTIGATE', 'High']);
    expect(parseFindings('outside-voice', 'Low: cache TTL mismatch (cache.ts:4)\n\n2. Token never expires (auth.ts:9)\nSeverity: High\nBlocks: yes').map(f => [f.label, f.raw]))
      .toEqual([['Low', 'Low: cache TTL mismatch (cache.ts:4)'], ['CRITICAL', '2. Token never expires (auth.ts:9) | Severity: High | Blocks: yes']]);
    expect(parseFindings('outside-voice', '**Race in a.ts:3 (High).**\n- the writer holds no lock\nSeverity: Medium').map(f => f.raw)).toEqual(['**Race in a.ts:3 (High).** | - the writer holds no lock | Severity: Medium']);
    expect(parseFindings('outside-voice', '**Race in a.ts:3 (Medium).**\n\n- the writer holds no lock\n\nSeverity: Medium. Blocks: yes').map(f => [f.label, f.raw]))
      .toEqual([['CRITICAL', '**Race in a.ts:3 (Medium).** | - the writer holds no lock | Severity: Medium. Blocks: yes']]);
  });

  // Value: protects=a non-review the same dispatch later answers with a review is voided (counted, VERIFY clean), and a failed outside
  //   voice recorded with --unavailable reads UNAVAILABLE (missing coverage, never a review) without blocking, while --unavailable is
  //   refused for any other reader; fails_when=one outside-voice timeout or one refusal makes VERIFY dirty for good, or --unavailable
  //   lets a specialist skip coverage; why_new=#3677 Step 11 adversarial voice; seam=collect and verify; no_claim=the review-log row
  test('a refusal replaced by a review is voided; an outside voice failure is UNAVAILABLE; --unavailable is the outside voice only', () => {
    const p = pass();
    const send = () => run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', p.file]);
    const take = (f: string) => run(['collect', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--output', f, '--merged', p.merged]);
    send();
    expect(take(p.w('refusal.out', 'I could not access the diff.\n')).status).toBe(1);
    expect(run(['verify', '--ledger', p.ledger]).stdout).toContain('VERIFY: dirty');
    send();
    expect(take(p.w('clean.out', 'NO FINDINGS\n')).status).toBe(0);
    fs.writeFileSync(path.join(p.out, 'judged.jsonl'), '');
    run(['judge', '--ledger', p.ledger, '--merged', p.merged, '--judged', path.join(p.out, 'judged.jsonl')]);
    const v = run(['verify', '--ledger', p.ledger]);
    expect([v.status, v.stdout.includes('replaced_by_a_review'), v.stdout.includes('VERIFY: clean briefs=1 outputs=2 voided=1')]).toEqual([0, true, true]);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const o = tmp();
    const ov = field(run(['render', '--role', 'outside-voice', '--out', o, '--diff-base', head]).stdout, 'file');
    const ledger = path.join(o, 'review-ledger.jsonl'), merged = path.join(o, 'merged.jsonl');
    run(['sent', '--ledger', ledger, '--role', 'outside-voice', '--sent', ov]);
    const fail = path.join(o, 'timeout.out');
    fs.writeFileSync(fail, 'Codex timed out after 9 minutes and was terminated; this pass produced NO findings.\n');
    const c = run(['collect', '--ledger', ledger, '--role', 'outside-voice', '--output', fail, '--merged', merged, '--unavailable', 'timeout']);
    expect([c.status, c.stdout.startsWith('COLLECT_UNAVAILABLE: reader=outside-voice ')]).toEqual([0, true]);
    fs.writeFileSync(path.join(o, 'judged.jsonl'), '');
    run(['judge', '--ledger', ledger, '--merged', merged, '--judged', path.join(o, 'judged.jsonl')]);
    const w = run(['verify', '--ledger', ledger]);
    expect([w.status, w.stdout.includes('BRIEF outside-voice UNAVAILABLE'), w.stdout.includes('OUTPUT outside-voice UNAVAILABLE'), w.stdout.includes(' unavailable=1\n')]).toEqual([0, true, true, true]);
    const q = pass();
    run(['sent', '--ledger', q.ledger, '--role', 'specialist', '--name', 'testing', '--sent', q.file]);
    const refused = run(['collect', '--ledger', q.ledger, '--role', 'specialist', '--name', 'testing', '--output', q.w('t.out', 'timed out\n'), '--merged', q.merged, '--unavailable', 'timeout']);
    expect([refused.status, refused.stderr.includes('--unavailable is for the outside voice only')]).toEqual([2, true]);
    const partial = path.join(o, 'partial.out');
    fs.writeFileSync(partial, '1. **CRITICAL**: token leak in a.ts:3\nCodex then timed out.\n');
    const kept = run(['collect', '--ledger', ledger, '--role', 'outside-voice', '--output', partial, '--merged', merged, '--unavailable', 'timeout']);
    expect([kept.status, kept.stderr.includes('holds findings; collect it without --unavailable')]).toEqual([2, true]);
    expect(run(['collect', '--ledger', ledger, '--role', 'outside-voice', '--output', fail, '--merged', merged, '--unavailable', ' ']).status).toBe(2);
    const n = pass();
    const takeN = (f: string) => run(['collect', '--ledger', n.ledger, '--role', 'specialist', '--name', 'testing', '--output', f, '--merged', n.merged]);
    run(['sent', '--ledger', n.ledger, '--role', 'specialist', '--name', 'testing', '--sent', n.file]);
    takeN(n.w('refusal.out', 'I could not access the diff.\n'));
    takeN(n.w('clean.out', 'NO FINDINGS\n'));
    fs.writeFileSync(path.join(n.out, 'judged.jsonl'), '');
    run(['judge', '--ledger', n.ledger, '--merged', n.merged, '--judged', path.join(n.out, 'judged.jsonl')]);
    const unsent = run(['verify', '--ledger', n.ledger]);
    expect([unsent.status, unsent.stdout.includes(' NOT_REVIEWED '), unsent.stdout.includes('VERIFY: dirty')]).toEqual([1, true, true]);
  });

  test('verify on a ledger that kept no prompts says so and exits 3', () => {
    const d = tmp();
    const ledger = path.join(d, 'ledger.jsonl');
    fs.writeFileSync(ledger, '{"event":"note","step":"9"}\n');
    const v = run(['verify', '--ledger', ledger]);
    expect([v.status, v.stdout.trim()]).toEqual([3, "VERIFY: no brief records (this run's ledger kept no prompts; dispatched-vs-rendered cannot be checked)"]);
  });
});

describe('the workspace paragraph (GST-482)', () => {
  // Value: protects=GSTA-167's no-loss pin: every role's brief is renderBrief's bytes unchanged, then only the workspace paragraph naming the checkout; fails_when=the paragraph is inserted, a section byte moves, or the CLI names another folder than the checkout it ran in;
  //   why_new=GST-482 appends a paragraph to every brief; seam=gstack-review-dispatch render; no_claim=that the reader obeys it
  test('every role renders main\'s brief byte for byte, then the paragraph naming the checkout the CLI ran in', () => {
    const t = sectionTexts(ROOT);
    const top = fs.realpathSync(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.trim());
    const w = (n: string, s: string) => { const f = path.join(tmp(), n); fs.writeFileSync(f, s); return f; };
    const cases: Array<[string, string[], Record<string, string>]> = [
      ['specialist', ['--name', 'testing'], { name: 'testing', checklist: path.join(ROOT, 'review/specialists/testing.md') }],
      ['specialist', ['--name', 'security'], { name: 'security', checklist: path.join(ROOT, 'review/specialists/security.md') }],
      ['specialist-batched', ['--checklists', 'testing,security'], { checklists: ['testing', 'security'].map(c => path.join(ROOT, 'review/specialists', c + '.md')).join(',') }],
      ['red-team', ['--findings-file', w('f.jsonl', 'x\n'), '--specialists', '2'], { checklist: path.join(ROOT, 'review/specialists/red-team.md'), findings: 'x\n', specialists: '2' }],
      ['adversarial-native', [], {}],
      ['fix-check', ['--fix-list', w('fl', 'a'), '--hunks', w('h', 'b'), '--tests', w('t', 'c')], { fix_list: 'a', hunks: 'b', tests: 'c' }],
    ];
    for (const [role, args, slots] of cases) {
      const out = tmp();
      const r = run(['render', '--role', role, '--out', out, ...(role === 'fix-check' ? [] : ['--diff-base', SHA]), ...args]);
      expect(r.status, role + ': ' + r.stderr).toBe(0);
      const main = renderBrief(role as Parameters<typeof renderBrief>[0], { diff_base: role === 'fix-check' ? undefined : SHA, ...slots }, t);
      expect(fs.readFileSync(field(r.stdout, 'file'), 'utf8'), role).toBe(main + '\n\n' + workspaceParagraph(top));
    }
    expect(workspaceParagraph(top)).toContain(`begin each command with \`cd '${top}' && \``);
    expect(workspaceParagraph(top)).toContain(`absolute path under ${top}`);
  });

  test('a list-item or bold REVIEWED_TREE line counts; a ledger rendered before the paragraph existed is collected as before', () => {
    const out = tmp();
    const p = { ledger: path.join(out, 'review-ledger.jsonl'), merged: path.join(out, 'merged.jsonl'), file: field(run(['render', '--role', 'specialist', '--name', 'testing', '--out', out, '--diff-base', SHA]).stdout, 'file'),
      w: (n: string, t: string) => { const f = path.join(out, n); fs.writeFileSync(f, t); return f; } };
    run(['sent', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--sent', p.file]);
    const line = treeLineOf(ROOT).trim();
    const col = run(['collect', '--ledger', p.ledger, '--role', 'specialist', '--name', 'testing', '--output', p.w('reply.out', '- **' + line + '**\nNO FINDINGS\n'), '--merged', p.merged]);
    expect(col.stdout).toStartWith('COLLECT: reader=specialist/testing findings=0 ');
    const legacy = tmp();
    const ledger = path.join(legacy, 'review-ledger.jsonl');
    const brief = path.join(legacy, 'b.md');
    fs.writeFileSync(brief, 'old brief');
    fs.writeFileSync(ledger, JSON.stringify({ event: 'rendered', reader: 'specialist/testing', role: 'specialist', name: 'testing', file: brief, sha256: promptHash('old brief'), bytes: 9 }) + '\n');
    run(['sent', '--ledger', ledger, '--role', 'specialist', '--name', 'testing', '--sent', brief]);
    const reply = path.join(legacy, 'r.out');
    fs.writeFileSync(reply, 'NO FINDINGS\n');
    const old = spawnSync(BIN, ['collect', '--ledger', ledger, '--role', 'specialist', '--name', 'testing', '--output', reply, '--merged', path.join(legacy, 'm.jsonl')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(old.stdout).toStartWith('COLLECT: reader=specialist/testing findings=0 ');
  });
});

describe('reading the REVIEWED_TREE line (GST-482 review fixes)', () => {
  const top = fs.realpathSync(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.trim());
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
  const expected = `${tree} ${top}`;
  test('Markdown around the line, label, sha or whole path is read; the path keeps its own characters; the first line wins', () => {
    for (const line of [`REVIEWED_TREE: ${tree} ${top}`, `**REVIEWED_TREE:** ${tree} ${top}`, `REVIEWED_TREE: \`${tree}\` \`${top}\``, `## REVIEWED_TREE: ${tree} ${top}`, `- **REVIEWED_TREE: ${tree} ${top}**`])
      expect(checkReviewedTree(line + '\nNO FINDINGS', expected).ok, line).toBe(true);
    expect(checkReviewedTree(`REVIEWED_TREE: ${tree} ${top}*`, expected).ok).toBe(false);
    expect(checkReviewedTree(`REVIEWED_TREE: ${tree} ${top}\n\`\`\`\nREVIEWED_TREE: ${'b'.repeat(40)} /elsewhere\n\`\`\``, expected).ok).toBe(true);
    expect(checkReviewedTree(`REVIEWED_TREE: ${'b'.repeat(40)} /elsewhere\nREVIEWED_TREE: ${tree} ${top}`, expected)).toMatchObject({ ok: false, reported: `${'b'.repeat(40)} /elsewhere` });
  });

  test('an outside voice with findings and no tree line is refused, never turned into unavailable coverage that drops them', () => {
    const out = tmp();
    const ledger = path.join(out, 'review-ledger.jsonl');
    const merged = path.join(out, 'merged.jsonl');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    const file = field(run(['render', '--role', 'outside-voice', '--out', out, '--diff-base', head]).stdout, 'file');
    run(['sent', '--ledger', ledger, '--role', 'outside-voice', '--sent', file]);
    const reply = path.join(out, 'r.out');
    fs.writeFileSync(reply, '1. **CRITICAL**: auth bypass in a.ts:3\nBlocks: yes\n\nRecommendation: request changes\n');
    const c = spawnSync(BIN, ['collect', '--ledger', ledger, '--role', 'outside-voice', '--output', reply, '--merged', merged], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect([c.status, c.stdout.startsWith('COLLECT_WRONG_TREE: reader=outside-voice reported="none"')]).toEqual([1, true]);
    expect(run(['verify', '--ledger', ledger]).stdout).not.toContain('VERIFY: clean');
    fs.writeFileSync(reply, 'Codex timed out before it reviewed anything.\n');
    const u = spawnSync(BIN, ['collect', '--ledger', ledger, '--role', 'outside-voice', '--output', reply, '--merged', merged], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect([u.status, u.stdout.startsWith('COLLECT_UNAVAILABLE: reader=outside-voice')]).toEqual([0, true]);
  });

  test('render outside a readable checkout refuses instead of recording a fingerprint no reply can match', () => {
    const dir = tmp();
    const r = run(['render', '--role', 'adversarial-native', '--out', path.join(dir, 'o'), '--diff-base', SHA], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('BRIEF_RENDER_FAILED: cannot read HEAD^{tree} and the toplevel of');
  });
});
