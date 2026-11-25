/**
 * Readers on a shared machine review the checkout the pass ships (GST-482).
 * Split from test/review-pass.test.ts; shared fixtures live in test/helpers/review-pass-harness.ts.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { workspaceParagraph, workspaceStep } from '../lib/review-brief';
import { renderStage } from '../lib/review-pass';
import { tmp, unrelated, repo, cleanReply, treeLine, host, runPass, bin, briefDirOf } from './helpers/review-pass-harness';

describe('readers on a shared machine review the checkout the pass ships (GST-482)', () => {
  /** The primary checkout on feat, and a worktree of it on another branch with one more commit: the GBRA-218 layout. */
  function worktree() {
    const { dir, env } = repo();
    const wt = path.join(tmp('rp-wt-'), 'wt');
    const sh = (c: string, cwd = dir) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(c + ': ' + r.stderr); return r.stdout.trim(); };
    sh(`git worktree add -q -b allow ${JSON.stringify(wt)} feat`);
    sh('for i in $(seq 1 20); do echo "export const w$i = $i;" >> src/a.ts; done && git commit -qam allow', wt);
    return { dir, env, wt: fs.realpathSync(wt) };
  }
  // Value: protects=/ship can ship a checkout other than the one shared readers start in (HARN-105/HARN-107: a project whose default checkout is a repository of another history), each brief opening with the cd into the shipped checkout and each reply still proving its tree; fails_when=the program refuses readers because their start checkout differs from the shipped one, a brief does not open with the cd, a reply from the start checkout or with a foreign tree is merged, or readers are dispatched from a worktree or clone that holds the diff base (where a command without its cd reads the wrong diff with no error) or to a shipped checkout they cannot reach;
  //   why_new=GST-3145 on gstack 1.101.0.0 (the GST-482 start-checkout refusal contradicted the workspace step); seam=lib/capy-review-pass.js before any log start or create, and gstack-review-dispatch collect; no_claim=model compliance with the cd
  test('readers that start in a repository of another history are dispatched with the cd into the shipped checkout first, a reply naming another tree is refused, and another worktree of the same repository or an unreachable checkout stops', async () => {
    const { dir, env, wt } = worktree();
    const other = unrelated(env);
    const out = path.join(wt, '.state/run/p1');
    const h = host(other, env);
    const res = await runPass(h, { base: 'main', out, pass: 'w0p1', cwd: wt, planFlags: ['--depth-floor', 'full'], logStart: ['review'] });
    expect(res).not.toContain('STOP:');
    expect(res).toContain('REVIEW_LOG_START: review');
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.length).toBeGreaterThan(0);
    const cdFirst = `First step, before anything else: run \`cd '${wt}' && `;
    for (const c of h.creates) {
      const verdict = !c.title.includes(' audit/');
      expect([c.prompt.startsWith(workspaceStep(wt, verdict) + '\n\n'), workspaceStep(wt, verdict).startsWith(cdFirst), c.prompt.endsWith('\n\n' + workspaceParagraph(wt, undefined, verdict))], c.title).toEqual([true, true, true]);
      expect(c.summary!.split('\n')[0], c.title).toBe(treeLine(wt).trim());
    }
    expect(bin(wt, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout).not.toContain('wrong_tree');
    const passCreates = h.creates.length;
    const voices = await runPass(h, { base: 'main', out, pass: 'w0p1', cwd: wt, planFlags: ['--depth-floor', 'full'], stage: 'voices', models: { 'outside-voice': { model_id: 'openai/gpt-6.1-sol' } } });
    expect(voices).not.toContain('STOP:');
    expect(h.creates.length).toBeGreaterThan(passCreates);
    for (const c of h.creates.slice(passCreates)) expect(c.prompt.startsWith(cdFirst), c.title).toBe(true);
    const stayed = host(other, env, { reportFrom: () => other });
    const wrong = await runPass(stayed, { base: 'main', out: path.join(wt, '.state/run/p2'), pass: 'w0p2', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(wrong).toContain('COLLECT_WRONG_TREE: reader=');
    expect(wrong).toContain(`reported="${treeLine(other).slice(15).trim()}"`);
    expect(wrong).not.toContain('NEXT: judge');
    expect(fs.existsSync(path.join(wt, '.state/run/p2/merged.jsonl')) ? fs.readFileSync(path.join(wt, '.state/run/p2/merged.jsonl'), 'utf8') : '').toBe('');
    const forged = host(other, env, { reportFrom: () => '', output: t => `REVIEWED_TREE: ${'0'.repeat(40)} ${wt}\n${cleanReply(t)}` });
    const moved = await runPass(forged, { base: 'main', out: path.join(wt, '.state/run/p3'), pass: 'w0p3', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(moved).toMatch(/COLLECT_(WRONG_TREE|TREE_MOVED): reader=/);
    expect(moved).not.toContain('NEXT: judge');
    const outside = host(path.dirname(wt), env);
    expect(await runPass(outside, { base: 'main', out: path.join(wt, '.state/run/p4'), pass: 'w0p4', cwd: wt, planFlags: ['--depth-floor', 'full'] })).toContain('NEXT: judge (Phase 4)');
    const sibling = host(dir, env);
    const same = await runPass(sibling, { base: 'main', out: path.join(wt, '.state/run/p7'), pass: 'w0p7', cwd: wt, planFlags: ['--depth-floor', 'full'], logStart: ['review'] });
    expect(same).toContain(`STOP: readers on the shared machine start in ${fs.realpathSync(dir)}, not in ${wt}, the checkout this pass ships, and ${fs.realpathSync(dir)} also holds its diff base `);
    expect(same).toContain(`Start /ship in the shipped checkout: run it from a thread whose working directory is ${wt}`);
    expect(same).not.toContain('REVIEW_LOG_START:');
    expect(sibling.creates.length).toBe(0);
    const walled = host(other, env);
    const bashW = walled.tools.capy.bash;
    walled.tools.capy.bash = async (a: { command: string; description?: string }) => (a.description?.endsWith('reader reach check') ? { exit_code: 1, output: `none\n${other}\nbash: line 1: cd: ${wt}: Permission denied\n` } : bashW(a));
    const unreachable = await runPass(walled, { base: 'main', out: path.join(wt, '.state/run/p5'), pass: 'w0p5', cwd: wt, planFlags: ['--depth-floor', 'full'], logStart: ['review'] });
    expect(unreachable).toContain(`STOP: readers on the shared machine cannot reach ${wt}, the checkout this pass ships: bash: line 1: cd: ${wt}: Permission denied`);
    expect(unreachable).not.toContain('REVIEW_LOG_START:');
    expect(walled.creates.length).toBe(0);
    const slow = host(other, env, { pollsToFinish: 30 });
    let probes = 0;
    const bash = slow.tools.capy.bash;
    slow.tools.capy.bash = async (a: { command: string; description?: string }) => { if (a.description?.endsWith('reader reach check')) probes++; return bash(a); };
    const input = { base: 'main', out: path.join(wt, '.state/run/p6'), pass: 'w0p6', cwd: wt, planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(slow, input)).toContain('NEXT: poll');
    expect(await runPass(slow, input)).toContain('NEXT: poll');
    expect(probes).toBe(1);
    expect(await runPass(host(wt, env), { ...input, logStart: [7] })).toStartWith('STOP: input.logStart must be a list');
  }, 240_000);

  // Value: protects=a separate clone of the shipped history, which holds the diff base, cannot be the start checkout of a pass; fails_when=readers are dispatched from such a clone (a reader that skips the cd diffs the clone with no error and still prints the shipped REVIEWED_TREE), or a start directory with a broken .git is refused although every brief cds out of it;
  //   why_new=GST-3145 second-model trail read on 6b90158 (the common-dir check let a clone through); seam=lib/capy-review-pass.js reader reach check; no_claim=a start checkout that fetched the base after the check
  test('a separate clone that holds the diff base is refused before any start token or reader; a start directory with a broken .git dispatches', async () => {
    const { dir, env, wt } = worktree();
    const clone = path.join(tmp('rp-clone-'), 'clone');
    expect(spawnSync('git', ['clone', '-q', dir, clone], { env, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    const cloned = host(clone, env);
    const res = await runPass(cloned, { base: 'main', out: path.join(wt, '.state/run/c1'), pass: 'c1p1', cwd: wt, planFlags: ['--depth-floor', 'full'], logStart: ['review'] });
    expect(res).toContain(`STOP: readers on the shared machine start in ${fs.realpathSync(clone)}, not in ${wt}, the checkout this pass ships, and ${fs.realpathSync(clone)} also holds its diff base `);
    expect(res).not.toContain('REVIEW_LOG_START:');
    expect(cloned.creates.length).toBe(0);
    const broken = tmp('rp-broken-');
    fs.writeFileSync(path.join(broken, '.git'), 'garbage\n');
    const unreadable = host(broken, env);
    expect(await runPass(unreadable, { base: 'main', out: path.join(wt, '.state/run/c2'), pass: 'c2p1', cwd: wt, planFlags: ['--depth-floor', 'full'] })).toContain('NEXT: judge (Phase 4)');
    expect(unreadable.creates.length).toBeGreaterThan(0);
  }, 240_000);

  // Value: protects=a reader that never left the machine's default checkout cannot hand /ship a review of another tree; fails_when=collect merges a reply whose REVIEWED_TREE names the primary checkout while the pass ships a worktree, or a reply with no such line;
  //   why_new=GBRA-218: pass 1's specialist reviewed /workspace/gbrain while /ship shipped ~/.capy/work/wt-allow; seam=gstack-review-dispatch collect; no_claim=a reader that fingerprints the right checkout but reads another
  test('a reader that reviews the primary checkout instead of the worktree is refused and nothing it said is merged', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const h = host(wt, env, { reportFrom: () => dir, output: t => (t.includes('specialist') ? '[CRITICAL] (confidence: 9/10) src/other.ts:3 a file outside this PR' : cleanReply(t)) });
    const res = await runPass(h, { base: 'main', out, pass: 'w1p1', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=');
    expect(res).toContain(`reported="${treeLine(dir).slice(15).trim()}"`);
    expect(res).toMatch(/STOP: collect \S+ exited 1/);
    expect(res).not.toContain('NEXT: judge');
    expect(fs.existsSync(path.join(out, 'merged.jsonl')) ? fs.readFileSync(path.join(out, 'merged.jsonl'), 'utf8') : '').toBe('');
    const v = bin(wt, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout;
    expect(v).toMatch(/^OUTPUT \S+ NOT_REVIEWED .*wrong_tree/m);
    expect(v).toContain('VERIFY: dirty');
  }, 240_000);

  test('a reply that names no checkout is refused the same way', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const res = await runPass(host(wt, env, { reportFrom: () => '' }), { base: 'main', out, pass: 'w2p1', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=');
    expect(res).toContain('reported="none"');
    expect(res).not.toContain('NEXT: judge');
  }, 240_000);

  // Value: protects=/ship from a worktree that is the shared machine's start checkout works, its readers' briefs naming it (readers that start in a repository of another history are covered by the GST-3145 tests above); fails_when=a brief does not name the shipped checkout, or a correct reply is refused;
  //   why_new=GBRA-218 (no brief named a directory); seam=lib/review-pass.ts renderStage and the Capy pass program; no_claim=model compliance with the paragraph
  test('a reader that works in the checkout its brief names passes, and every brief names the worktree', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'coverage.prompt.md'), 'Run Step 7 as written.\n');
    const h = host(wt, env);
    const res = await runPass(h, { base: 'main', out, pass: 'w3p1', cwd: wt, planFlags: ['--depth-floor', 'full'],
      extras: [{ name: 'coverage', prompt_file: path.join(out, 'coverage.prompt.md'), first: true }] });
    expect(res).not.toContain('STOP:');
    expect(res).toContain('NEXT: judge (Phase 4)');
    expect(h.creates.length).toBeGreaterThan(2);
    for (const c of h.creates) {
      const verdict = !c.title.includes(' audit/');
      expect([c.prompt.startsWith(workspaceStep(wt, verdict) + '\n\n'), c.prompt.endsWith('\n\n' + workspaceParagraph(wt, undefined, verdict))], c.title).toEqual([true, true]);
    }
    expect(bin(wt, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout).not.toContain('wrong_tree');
  }, 240_000);

  test('an audit reader that worked in the primary checkout is refused when it is collected', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'docs.prompt.md'), 'Run the Step 14.5 audit as written.\n');
    const h = host(wt, env, { reportFrom: t => (t.endsWith('audit/docs') ? dir : briefDirOf(h, t)) });
    const res = await runPass(h, { base: 'main', out, pass: 'w4p1', cwd: wt, planFlags: ['--depth-floor', 'full'],
      extras: [{ name: 'docs', prompt_file: path.join(out, 'docs.prompt.md'), first: true }] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=audit/docs');
    expect(res).not.toContain('NEXT: judge');
    expect(h.creates.map(c => c.title)).toEqual(['ship w4p1 audit/docs']);
  }, 240_000);

  test('a rerun after a wrong-tree STOP stops on the failed reader and never collects its reply twice', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const h = host(wt, env, { reportFrom: () => dir });
    const input = { base: 'main', out, pass: 'w5p1', cwd: wt, planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, input)).toContain('COLLECT_WRONG_TREE: reader=');
    const again = await runPass(h, input);
    expect(again).toMatch(/STOP: \S+ \(subagent \d+\) reviewed another tree: [0-9a-f]{40} /);
    const outputs = fs.readFileSync(path.join(out, 'review-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'output');
    expect(outputs.length).toBe(1);
  }, 240_000);

  test('a worktree at the same commit as the primary checkout is still told apart by its toplevel', async () => {
    const { dir, env } = repo();
    const wt = path.join(tmp('rp-wt-'), 'same');
    expect(spawnSync('git', ['worktree', 'add', '-q', '--detach', wt, 'feat'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    const out = path.join(wt, '.state/run/p1');
    const res = await runPass(host(wt, env, { reportFrom: () => dir }), { base: 'main', out, pass: 'w6p1', cwd: fs.realpathSync(wt), planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_WRONG_TREE: reader=');
    expect(res).not.toContain('COLLECT_TREE_MOVED');
  }, 240_000);

  test('a commit between render and reply is COLLECT_TREE_MOVED, not a pass', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    let moved = false;
    const h = host(wt, env, { reportFrom: t => {
      if (!moved) { moved = true; spawnSync('bash', ['-c', 'echo "export const late = 1;" >> src/a.ts && git commit -qam late'], { cwd: wt, env, encoding: 'utf8', timeout: 60_000 }); }
      return briefDirOf(h, t);
    } });
    const res = await runPass(h, { base: 'main', out, pass: 'w7p1', cwd: wt, planFlags: ['--depth-floor', 'full'] });
    expect(res).toContain('COLLECT_TREE_MOVED: reader=');
    expect(res).not.toContain('NEXT: judge');
  }, 240_000);

  test('an outside voice that reviewed another tree is recorded as unavailable coverage, never clean, and the voices still finish', async () => {
    const { dir, env, wt } = worktree();
    const out = path.join(wt, '.state/run/p1');
    const h = host(wt, env, { reportFrom: t => (t.endsWith('outside-voice') ? dir : briefDirOf(h, t)) });
    const base = { base: 'main', out, pass: 'w8p1', cwd: wt, planFlags: ['--depth-floor', 'full'] };
    expect(await runPass(h, base)).toContain('NEXT: judge (Phase 4)');
    const models = { 'outside-voice': { model_id: 'openai/gpt-6.1-sol' }, 'adversarial-native': { model_id: 'anthropic/claude-opus-5-5', reasoning_mode: 'high' } };
    const res = await runPass(h, { ...base, stage: 'voices', models });
    expect(res).toContain('COLLECT_UNAVAILABLE: reader=outside-voice');
    expect(res).toContain('reviewed another tree');
    expect(res).toContain('NEXT: judge the voices');
    const v = bin(wt, env, ['verify', '--ledger', path.join(out, 'review-ledger.jsonl')]).stdout;
    expect(v).toMatch(/^BRIEF outside-voice UNAVAILABLE /m);
  }, 240_000);
});
