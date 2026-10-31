/**
 * GSTA-167 PR 5: ship/DRIVER.md is the compact, host-neutral entry a parent
 * agent reads to run an unattended /ship instead of ship/SKILL.md (61 KB) plus
 * its sections. Its contract, derived from the skeleton rather than a hand list:
 * every step id ship/SKILL.md and its sections name, and every gate or result
 * code the skeleton prints, appears in the driver or in a bin the driver invokes;
 * every STOP anchor resolves to a real heading; the render stays at or under
 * 12 KB, host-neutral and fresh against the generator.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SHIP_STEPS } from '../lib/ship-budget';
import { RESULT_CODES } from '../lib/result-codes';
import { SHIP_DRIVER_STOPS } from '../scripts/resolvers/ship-driver';
import { runGeneration, SHIP_DRIVER_RELPATH } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const doc = read(SHIP_DRIVER_RELPATH);
const skill = read('ship/SKILL.md');
const body = skill.slice(skill.indexOf('\n# Ship: '));
const sectionFiles: string[] = JSON.parse(read('ship/sections/manifest.json')).sections
  .filter((s: { runner_only?: boolean }) => !s.runner_only).map((s: { file: string }) => `ship/sections/${s.file}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-driver-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const STEP_ID = String.raw`\d+(?:\.\d+)*(?:-[A-Z])?`;
const headingSteps = (text: string) => [...text.matchAll(new RegExp(`^#{2,4} Step (${STEP_ID})[:\s]`, 'gm'))].map(m => m[1]!);
/** Step ids a text names: "Step 9.4", "Steps 9, 9.1 and 9.2"; a range ("Steps 1-3") expands over SHIP_STEPS only when asked. */
function stepsNamed(text: string, expandRanges: boolean): Set<string> {
  const out = new Set<string>();
  const sep = '(?:, and |, | and |–|-(?=\\d))';
  for (const m of text.matchAll(new RegExp(`\\bSteps?\\s+(${STEP_ID}(?:${sep}${STEP_ID})*)`, 'g'))) {
    const parts = m[1]!.split(/(, and |, | and |–|-(?=\d))/);
    for (let i = 0; i < parts.length; i += 2) {
      out.add(parts[i]!);
      const range = parts[i + 1] === '–' || parts[i + 1] === '-';
      if (!range || !expandRanges) continue;
      const from = SHIP_STEPS.indexOf(parts[i] as any), to = SHIP_STEPS.indexOf(parts[i + 2] as any);
      for (const s of SHIP_STEPS.slice(Math.max(0, from), to + 1)) out.add(s);
    }
  }
  return out;
}

/** The bins the driver runs, each with the source of its bin file and the modules it imports (two levels). */
const invoked = [...new Set([...doc.matchAll(/\bgstack-[a-z0-9-]+/g)].map(m => m[0]))].filter(n => fs.existsSync(path.join(ROOT, 'bin', n)));
function binSource(name: string): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    texts.push(text);
    if (depth === 0) return;
    for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) visit(path.resolve(path.dirname(file), m[1]!.endsWith('.ts') ? m[1]! : `${m[1]}.ts`), depth - 1);
  };
  visit(path.join(ROOT, 'bin', name), 2);
  return texts.join('\n');
}
const bins = invoked.map(binSource).join('\n');

/** GitHub's heading anchors, plus explicit <a id> anchors. */
function anchors(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6} (.+)$/gm)) out.add(m[1]!.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-'));
  for (const m of text.matchAll(/<a id="([^"]+)"><\/a>/g)) out.add(m[1]!);
  return out;
}

describe('ship/DRIVER.md covers the skeleton', () => {
  test('every step id in ship/SKILL.md and its sections appears in the driver or in a bin the driver invokes', () => {
    const skeleton = new Set([...SHIP_STEPS, ...headingSteps(skill), ...sectionFiles.flatMap(f => headingSteps(read(f)))]);
    expect(skeleton.size).toBeGreaterThanOrEqual(SHIP_STEPS.length + 8);
    const covered = new Set([...stepsNamed(doc, false), ...stepsNamed(bins, true)]);
    expect([...skeleton].filter(s => !covered.has(s))).toEqual([]);
  });

  test('every gate and result code the skeleton prints appears in the driver or in a bin it invokes', () => {
    const codes = new Set([
      ...[...body.matchAll(/`([A-Z][A-Z0-9_]+):/g)].map(m => `${m[1]}:`),
      ...[...body.matchAll(/^\s*- \*\*([A-Z][A-Z0-9_]+)\*\* →/gm)].map(m => m[1]!),
      ...[...body.matchAll(/^\| ([A-Z][A-Z-]+(?:\/[A-Z][A-Z-]+)*)(?::| \()/gm)].flatMap(m => m[1]!.split('/')),
      ...[...body.matchAll(/`[A-Z][A-Z0-9_]+: ([A-Z][A-Z0-9_]+)`/g)].map(m => m[1]!),
      ...Object.keys(RESULT_CODES).filter(k => new RegExp(`\\b${k}\\b`).test(body)),
    ]);
    for (const code of ['STOP:', 'NEXT:', 'CARRY:', 'GSTACK_RESULT:', 'ALREADY_BUMPED', 'NO_VERSION', 'FRESH', 'ZERO-RUN', 'ALREADY_PUSHED', 'QUEUE_RECEIPT_STALE']) expect(codes).toContain(code);
    expect([...codes].filter(c => !doc.includes(c) && !bins.includes(c))).toEqual([]);
  });

  test('every gate the skeleton holds keeps a driver line: tests, pregate, receipt, push, queue, the budget stop', () => {
    for (const line of ['ZERO-RUN', 'gstack-ship-release finish', 'gstack-pregate clear', 'One re-audit at most', 'gstack-ship-receipt docs-caps',
      'Step 14.5, every ship', 'never clean', 'gstack-ship-receipt write', '`SHIP_RECEIPT:`', 'gstack-ship-receipt result --pr <n>',
      'gstack-ship-queue ready --pr <n>', 'Never force-push', '--mode observe', 'the one stop check']) {
      expect(doc, line).toContain(line);
    }
  });

  // Value: protects=a driven /ship sends every reviewer the brief ship/SKILL.md sends (GSTA-167 no-loss round 3: shortened reviewer context lost 9 of 19 blockers); fails_when=a review phase paraphrases its section instead of running it, or the driver copies a reviewer prompt line it could let drift;
  //   why_new=the coverage tests above check step ids and codes only; seam=none; no_claim=that the parent reads the section
  test('the review phases run their sections as written and the driver restates no reviewer prompt', () => {
    for (const [phase, sections] of [['## 3. Audits and review', ['test-coverage', 'plan-completion', 'review-army']], ['## 4. Judgment', ['adversarial']]] as const) {
      const text = doc.slice(doc.indexOf(phase), doc.indexOf('\n## ', doc.indexOf(phase) + 1));
      for (const sec of sections) expect(text, phase).toContain(`\`sections/${sec}.md\``);
      expect(text, phase).toMatch(/as\s+(?:they are\s+)?written/);
    }
    expect(doc).toContain('read `sections/documentation.md` and run its audit as written');
    expect(doc).toContain('never shortens a reviewer\'s brief');
    const prompts = ['review-army', 'adversarial', 'test-coverage', 'plan-completion', 'documentation']
      .flatMap(sec => [...read(`ship/sections/${sec}.md`).matchAll(/````?text\n([\s\S]*?)\n````?/g)].flatMap(m => m[1]!.split('\n')))
      .map(l => l.trim()).filter(l => l.length >= 40);
    expect(prompts.length).toBeGreaterThan(20);
    expect(prompts.filter(l => doc.includes(l))).toEqual([]);
  });

  test('the driver says when to fall back to ship/SKILL.md and never reads sections up front', () => {
    expect(doc).toContain('A STOP or decision this file does not cover: read `ship/SKILL.md` at that step');
    expect(doc).toContain('never\nup front');
  });
});

describe('one program per pass (GSTA-167 variant E)', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const phase = (h: string) => flat(doc.slice(doc.indexOf(h), doc.indexOf('\n## ', doc.indexOf(h) + 1)));
  // Value: protects=a review pass, Step 11 and the Step 14.5 audit each run as one program in the fixed order plan, reserve and start, BEFORE, readers, poll, AFTER and settle, later batches, collect, so the parent spends no call inside a pass and the reading pair brackets only the readers; fails_when=a phase goes back to walking Steps 9-9.4 call by call (replay 5: arm D's 69 orchestrator calls in Steps 7-14.5 against round 4's 21), the order breaks, or a phase stops pointing at the shared program;
  //   why_new=the coverage tests above check step ids, codes and section names only; seam=none; no_claim=the parent's adherence or the call count it reaches
  test('the shared program lists its acts in order and the review pass, Step 11 and Step 14.5 run through it', () => {
    const block = flat(doc.slice(doc.indexOf('**One program per pass.**'), doc.indexOf('\n## ', doc.indexOf('**One program per pass.**'))));
    expect(block).toContain('Each review pass, Step 11 and the Step 14.5 audit is one program, and the parent makes no other call while it runs');
    const order = ['`gstack-review-dispatch pass`', 'gstack-review-plan --base <base>', 'then its staged manifest', 'gstack-review-log --start <skill>` once per row the step logs', '(3) `BEFORE`',
      '(4) `sent` (`BRIEF_MISMATCH` voids it), then one subagent per reader', '(5) a poll until every reader settles', '(6) `note` with the reading pair',
      'a later batch (the Red Team', '(7) the collect: return only each reader\'s final output', 'it never walks the dispatch steps call by call'];
    const at = order.map(o => block.indexOf(o));
    expect(order.filter((_, k) => at[k]! < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(block).not.toContain('--reservation');
    expect(phase('## 3. Audits and review')).toContain('and the pass (above)');
    expect(phase('## 4. Judgment')).toContain('Step 11 from `sections/adversarial.md` as written (above)');
    expect(phase('## 6. Notes and documentation')).toContain('read `sections/documentation.md` and run its audit as written, as one program (above)');
  });

  // Value: protects=the parent reads the diff and TODOS.md once, through gstack-ship-preflight --audit's files, and the audit sections only when their reader is needed; fails_when=a phase sends the parent back to TODOS.md (346 KB on gstack, read twice per run at b617445) or the full diff (read three times), or reads test-coverage.md and plan-completion.md unconditionally;
  //   why_new=variant G moves those reads into the Phase 2 program; seam=none; no_claim=the bytes a parent actually reads
  test('Phase 2 runs --audit and the reads in its program, and no phase reads TODOS.md or the full diff into the parent', () => {
    const p2 = phase('## 2. Preflight');
    for (const s of ['gstack-ship-preflight --audit --base <base> --out <run dir>', 'writes the diff once (`CONTEXT:`)', '(`TODOS:`)', 'READER: coverage=<needed|none> plan=<needed|none>',
      'only when its reader is `needed`', 'Never read TODOS.md or the full diff into the parent']) expect(p2).toContain(s);
    expect(phase('## 4. Judgment')).toContain('on the todos and commits files');
    expect(phase('## 6. Notes and documentation')).toContain('edited from the todos file');
  });
});

describe('variant G: the call plan, observe budget, waits and audit readers (GSTA-167)', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  // Value: protects=the driver is a fixed plan of one call per phase that covers every ship step, at 9 calls for one clean pass and at most 12; fails_when=a step loses its phase, a phase is split back into per-step calls, or the stated call count drifts from the phase count (GSTA-185 appendix: 195 literal / 70 batched calls at b617445);
  //   why_new=the coverage tests check step ids anywhere in the driver, not which call runs them; seam=none; no_claim=the model's real call count
  test('each phase is one call, the phase headings cover every ship step, and the stated count is phases plus the report', () => {
    const headings = [...doc.matchAll(/^## (\d+)\. (.+)$/gm)];
    expect(headings.map(h => Number(h[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const covered = new Set(headings.flatMap(h => [...stepsNamed(h[2]!, false)]));
    expect(SHIP_STEPS.filter(s => !covered.has(s))).toEqual([]);
    expect(doc).toContain('Each phase below is one call');
    const calls = flat(doc.slice(doc.indexOf('**Calls.**'), doc.indexOf('\n\n', doc.indexOf('**Calls.**'))));
    expect(calls).toContain(`One pass with no fixes is ${headings.length + 1} calls: Phases 1-${headings.length} and the report; at most 12`);
  });

  // Value: protects=the ledger records instead of admitting: one note at each program's end with tokens and credits, the reader pair inside the dispatching program, and the cap as the single stop; fails_when=the driver brings back a check per boundary, a reservation, a meter-only call or a handoff (replay 5: 11 meter-only calls at 286k on #34's child), or drops the credits reading;
  //   why_new=observe mode is new; seam=none; no_claim=the host's counter accuracy
  test('the budget paragraph runs observe mode: note with --reading and --credits, no check per step, the cap as the one stop', () => {
    const budget = flat(doc.slice(doc.indexOf('**Budget: observe.**'), doc.indexOf('\n\n', doc.indexOf('**Budget: observe.**'))));
    for (const s of ['gstack-ship-budget start --mode observe', 'gstack-ship-budget note --step <last step> --reading R --credits C', '`cost.credits`',
      'No check per step, no reservation, no meter-only call, no handoff', '--dispatched-at <R> --dispatched-credits <C> --readers <n>']) expect(budget).toContain(s);
    expect(doc).not.toMatch(/check --step|--next dispatch:|--delegate measured/);
    expect(doc).toContain('gstack-ship-budget close --reading R --credits C');
  });

  // Value: protects=no call waits past the 5-minute prompt cache and no turn ends while readers run: a program returns 200 s after its first line, the next call resumes the poll, long commands run in background, and Capy waits on operations only when no reader runs, with the choice of a ping over a waiting child stated where the parent and Capy read it; fails_when=a phase waits in one program until slow work ends (cache probe: a call after a 7-minute gap cost ~2,820 credits against ~70), the parent ends its turn on `wait` while readers run (GSTA-189: 23 of 25 waits were one wake per finished reader), the cadence drifts back toward the cache lifetime (240 s counted from the poll loop, or 270 s), or the reason is dropped;
  //   why_new=GSTA-167 calls plan C1; seam=none; no_claim=the host's cache lifetime or wake policy
  test('waits return 200 s after a program starts and never end the turn while readers run, in the driver and the Capy skill', () => {
    const waits = flat(doc.slice(doc.indexOf('**Waits.**'), doc.indexOf('\n\n', doc.indexOf('**Waits.**'))));
    for (const s of ['No call waits past 200 s', '200 s after its first line', 'the next call resumes the poll', 'run in background', 'Never end the turn while readers run',
      'A small waiting child saves nothing', 'Past 100 minutes']) expect(waits).toContain(s);
    const capy = flat(read('capy/skill/gstack/SKILL.md'));
    for (const s of ['never let 5 minutes pass between calls', 'While readers run, never end the turn on `wait`', '`duration_seconds: 200`', 'one `tools.subagent.list` per ~20 s tick',
      'returning 200 s after the program\'s first line', 'under `rejected` with `tools.subagent.start`', 'A small waiting child saves nothing']) expect(capy).toContain(s);
    for (const text of [doc, capy]) expect(text).not.toMatch(/\b270 ?s\b|duration_seconds: 240|at most 240 s/);
  });

  // Value: protects=a program's return fits the host's output cap, a fix runs as one gated program, Step 7's test-writing audit settles before the pass reads the tree, and an unattended push never stops on the one-time pre-push offer; fails_when=Phase 2 returns review-army.md + adversarial.md + documentation.md (97,750 B) at once (replays 8G: truncated reads cost extra calls), a fix walks test, fix, tests and dispatch call by call (GSTA-189: 16 calls), Step 7 writes tests while specialists read (GSTA-164: a pregate refused mid-run), or push stops unattended (all three variant G replays);
  //   why_new=GSTA-167 calls plan C5, C6, C7 and round-2 High 11; seam=none; no_claim=the parent's adherence, which the replays' CALLS: lines measure
  test('returns stay at or under 32 KB, a fix is one gated program, Step 7 settles first, and unattended push defers the pre-push offer', () => {
    const f = flat(doc);
    for (const s of ['Returns: ≤32 KB per program; split longer reads at headings, each byte once, before first use',
      'one program runs the failing test, fix, `--tests-only` and Phase 3, each gated', 'Step 7 may write tests, so it settles first',
      'Unattended, push defers the pre-push offer; else its STOP runs Step 17\'s guard block', 'plus a keep-alive per 200 s waited']) expect(f).toContain(s);
    expect(flat(doc.slice(doc.indexOf('**Budget: observe.**')))).toContain('--reading R --credits C --record <rec>');
  });

  // Value: protects=a reader counts as settled only once it has run (status done or failed, or a final summary), in the driver, the Capy skill and the budget section, so a poll never closes a batch on a subagent that was just created; fails_when=the settled rule is dropped or lets a bare idle status through (replay 7e #36: the Red Team reservation settled actual=0 because a just-created subagent read idle);
  //   why_new=replay 7e; seam=none; no_claim=the host's status semantics beyond done, failed, idle and summary
  test('a poll settles a reader only at done, failed or a summary, never on a fresh idle', () => {
    expect(flat(doc)).toContain('(5) a poll until every reader settles (status `done` or `failed`, or a final summary; a fresh `idle` has not run)');
    expect(read('capy/skill/gstack/SKILL.md')).toContain('a reader is settled only at status `done` or `failed` or with a `summary` (a just-created `idle` reader has not run)');
    expect(flat(read('ship/sections/budget-handoff.md.tmpl'))).toContain('the wait until the last settles (`done`, `failed` or a final summary; a fresh `idle` has not run)');
  });

  // Value: protects=audits that cannot block (Steps 7, 8, 9.2.1, 14.5) run on a small model at low effort with their sections' own briefs, and skip their reader when --audit decides them; fails_when=an audit reader inherits the lane's model and effort (#36: the coverage audit alone was 2.45M at Opus), or an audit brief is paraphrased;
  //   why_new=audit model routing is new; seam=none; no_claim=the audits' recall
  test('audit readers run on a small model at low effort, named for Capy, and Phase 3 dispatches only what READER names', () => {
    expect(flat(doc)).toContain('Audit readers (Steps 7, 8, 9.2.1, 14.5) cannot block, so each runs on a small model at low effort; their findings go to the PR body');
    expect(flat(doc)).toContain('`Coverage:` and Step 8\'s line come from `--audit` when no reader ran');
    const capy = read('capy/skill/gstack/SKILL.md');
    expect(capy).toContain('model: { model_id: "anthropic/claude-sonnet-5-5", reasoning_mode: "low" }');
    expect(capy).toContain('`anthropic/claude-haiku-5-5` also fits');
  });

  // Value: protects=a driven /ship dispatches every blocking reader on its rendered brief file unchanged, checks it with `sent`, merges findings only through `collect`, gates judgment with `judge` and verifies the run before the bind; fails_when=the driver lets the model write or trim a brief again or merge findings in prose (round 4b: arm D lost 8 blockers with 75 of 112 briefs paraphrased);
  //   why_new=the driver named no renderer or hash check; seam=none; no_claim=the parent's adherence, which verify checks after the fact
  test('briefs go out as rendered and findings come back unchanged: render, sent, collect, judge, verify', () => {
    const f = flat(doc);
    for (const s of ["A blocking reader's prompt is its `gstack-review-dispatch render` file, unchanged", 'only via `collect`', '`judge` refuses a drop or downgrade',
      '(4) `sent` (`BRIEF_MISMATCH` voids it), then one subagent per reader on its rendered file', 'final output and status, via `collect`', '`JUDGMENT: ok` before any fix',
      '`gstack-review-dispatch verify` (`VERIFY: clean`)']) expect(f).toContain(s);
    expect(f.indexOf('gstack-review-dispatch verify')).toBeLessThan(f.indexOf('`gstack-review-read`'));
  });
});

describe('STOP anchors', () => {
  test('every STOP row is rendered and its anchor names a heading that exists', () => {
    for (const s of SHIP_DRIVER_STOPS) {
      expect(doc).toContain(`- ${s.when}: \`${s.read}\``);
      const [file, anchor] = s.read.split('#');
      const text = read(path.join('ship', file!));
      expect(anchors(text).has(anchor!), s.read).toBe(true);
    }
  });

  test('the anchor reader matches GitHub on the headings the driver uses', () => {
    expect(anchors('## Step 9.4: Fix-First and persistence\n## Step 14: TODOS.md (auto-update)\n## Step 9.1: Review Army — Specialist Dispatch'))
      .toEqual(new Set(['step-94-fix-first-and-persistence', 'step-14-todosmd-auto-update', 'step-91-review-army--specialist-dispatch']));
  });
});

describe('shape', () => {
  test('at most 12 KB, no harness vocabulary, and every bin it names exists', () => {
    expect(Buffer.byteLength(doc)).toBeLessThanOrEqual(12 * 1024);
    for (const term of ['AskUserQuestion', 'Agent tool', 'PreToolUse', 'SessionStart', '~/.claude', 'run_in_background']) expect(doc).not.toContain(term);
    const named = [...new Set([...doc.matchAll(/\bgstack-[a-z0-9-]+/g)].map(m => m[0]))];
    expect(named.filter(n => !fs.existsSync(path.join(ROOT, 'bin', n)))).toEqual([]);
    expect(invoked).toEqual(expect.arrayContaining(['gstack-ship-preflight', 'gstack-ship-release', 'gstack-ship-budget', 'gstack-review-plan', 'gstack-ship-receipt', 'gstack-ship-queue']));
  });

  test('the Capy skill points /ship at the driver with the autoplan line\'s shape', () => {
    const capy = read('capy/skill/gstack/SKILL.md');
    for (const s of ['autoplan', 'ship']) {
      expect(capy).toContain(`For \`/${s}\` driven from Capy, read \`${s}/DRIVER.md\` in the checkout (\`~/.local/share/gstack/${s}/DRIVER.md\`)`);
      expect(capy).toContain(`A checkout without that file predates it; follow its \`${s}/SKILL.md\` instead`);
    }
    expect(capy).toContain('--mode observe');
  });
});

describe('generator inventory', () => {
  test('the committed render names ship/DRIVER.md.tmpl as its source, and that template exists', () => {
    const template = 'ship/DRIVER.md.tmpl';
    expect(fs.existsSync(path.join(ROOT, template))).toBe(true);
    expect(doc.split('\n')[0]).toBe(`<!-- AUTO-GENERATED from ${template} — do not edit directly -->`);
  });

  test('a fresh render carries ship/DRIVER.md as a claude asset, byte-identical to the committed file', async () => {
    const written = await runGeneration({ host: 'claude', outputRoot: tmp, contentLinkRoot: null });
    expect(written.artifacts).toContainEqual({ relativePath: SHIP_DRIVER_RELPATH, kind: 'asset', host: 'claude' });
    expect(fs.readFileSync(path.join(tmp, SHIP_DRIVER_RELPATH), 'utf8')).toBe(doc);
    const dry = await runGeneration({ host: 'claude', dryRun: true });
    expect(dry.diagnostics.filter(d => d.relativePath === SHIP_DRIVER_RELPATH)).toEqual([]);
  }, 120_000);
});
