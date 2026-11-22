/**
 * Rule 15's preregistered no-loss replay for GST-3260 PR 3 (docs/evals/r51-final-review-after-grant-prereg.md), deterministic and
 * free. Plan replay: main's planner (lib/review-depth.ts at blob 47ac26b, a fixture copy) against this branch's, over every History
 * the planner tests recorded, an exhaustive grid and nine real shapes. Packet replay: decision 3.5's documented hunks command against
 * plain git diff $PASS_HEAD.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nextStep, type Depth, type History, type NextStep } from '../lib/review-depth';

const ROOT = path.join(import.meta.dir, '..');
const FIX = path.join(ROOT, 'test/fixtures/r51-replay');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r51-replay-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const OLD_BLOB = '47ac26b58e397466121a70cefd28dda4251615ce';
const oldText = fs.readFileSync(path.join(FIX, 'review-depth-main.ts.txt'));
const oldFile = path.join(tmp, 'review-depth-main.ts');
fs.writeFileSync(oldFile, oldText.toString('utf8').replace(/from '\.\/([\w-]+)'/g, (_, m) => `from '${pathToFileURL(path.join(ROOT, 'lib', m)).href}'`));
const oldStep: (h: History, d?: Depth) => NextStep = (await import(pathToFileURL(oldFile).href)).nextStep;

type Step = NextStep['step'];
const DEPTHS = [undefined, 'light', 'standard', 'full'] as const;
const REVIEW: readonly Step[] = ['full', 'scoped', 'fix-check'];

describe('plan replay: every step main\'s planner ran still runs (R51 final review after a granted fix-check)', () => {
  // Value: protects=the replay compares against main's real planner; fails_when=the fixture copy drifts from main's blob 47ac26b;
  //   seam=the fixture; no_claim=that main has not moved since (the pin and the replay id record which planner was compared)
  test('the old planner is main\'s lib/review-depth.ts at blob 47ac26b', () => {
    expect(createHash('sha1').update(`blob ${oldText.length}\0`).update(oldText).digest('hex')).toBe(OLD_BLOB);
    expect(oldStep({ fullPasses: 0, last: 'none' })).toEqual(nextStep({ fullPasses: 0, last: 'none' }));
  });

  // Value: protects=no loss on every recorded case: without the new field the new planner returns main's step and reason;
  //   fails_when=any recorded History plans differently; seam=nextStep; no_claim=cases the tests never wrote (the grid below)
  test('every History the planner tests recorded plans exactly as on main', () => {
    const { histories } = JSON.parse(fs.readFileSync(path.join(FIX, 'histories.json'), 'utf8')) as { histories: Array<{ history: History; depth: Depth | null }> };
    expect(histories.length).toBeGreaterThan(2000);
    const diff = histories.filter(({ history, depth }) => JSON.stringify(oldStep(history, depth ?? undefined)) !== JSON.stringify(nextStep(history, depth ?? undefined)));
    expect(diff).toEqual([]);
  });

  // Value: protects=no loss off the recorded path, and with the new field never a fix-check or scoped pass, and a full review only
  //   where main said done after a granted fix-check that changed runtime lines; fails_when=any grid History plans differently
  //   without the field, or the field adds a fix round; seam=nextStep; no_claim=how the CLI sets the field (fix-check-clearing tests)
  test('the exhaustive grid plans exactly as on main without the field, and adds at most the final full review with it', () => {
    let same = 0, withField = 0, added = 0;
    const bad: string[] = [];
    const flags = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    for (const last of ['none', 'full', 'fix-check'] as const)
      for (const fullPasses of [0, 1, 2, 3])
        for (const fixChecks of [undefined, 1, 2])
          for (const f of flags)
            for (const rangeRuntimeLines of [undefined, null, 0, 4, 500])
              for (const grant of [{}, { granted: 'a-1' }, { grantedStop: 'a-2' }, { roundGrant: 'a-3' }])
                for (const lean of [false, true])
                  for (const gate of [{}, { gate: true }, { gate: true, adversarialRan: true }])
                    for (const loop of [{}, { postReview: true }, { chained: true }])
                      for (const priorFull of [0, 3])
                        for (const depth of DEPTHS) {
                          const h: History = { fullPasses, last, fixChecks, fixedBlocking: !!(f & 1), fixedBelow: !!(f & 2), blockingOpen: !!(f & 4), touchedGate: !!(f & 8), rangeRuntimeLines, lean, priorFull, pass1Depth: depth === 'light' ? 'light' : undefined, ...grant, ...gate, ...loop };
                          const o = oldStep(h, depth), n = nextStep(h, depth);
                          if (o.step !== n.step || o.reason !== n.reason) bad.push(`no field: ${JSON.stringify(h)} ${depth}: ${o.step} -> ${n.step}`); else same++;
                          if (last === 'none') continue;
                          const s = nextStep({ ...h, grantFixChecked: true }, depth);
                          withField++;
                          if (s.step === 'fix-check' || s.step === 'scoped') bad.push(`field: ${JSON.stringify(h)} ${depth}: plans ${s.step}`);
                          if (s.step === 'full') {
                            if (last === 'fix-check' && o.step === 'done' && (rangeRuntimeLines ?? 0) > 0) added++;
                            else bad.push(`field: ${JSON.stringify(h)} ${depth}: full where main planned ${o.step}`);
                          }
                          if (last === 'full' && !['done', 'stop', 'voices'].includes(s.step)) bad.push(`field: ${JSON.stringify(h)} ${depth}: final review plans ${s.step}`);
                        }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(same).toBe(3 * 4 * 3 * 16 * 5 * 4 * 2 * 3 * 3 * 2 * 4);
    expect(withField).toBe(same * 2 / 3);
    expect(added).toBe(27648);
  });
});

/**
 * A real shape as the CLI would plan it: the History at the start, what each review step finds, and the grant recorded at the
 * first stop. The old CLI never set grantFixChecked and refused a spent --grant, so after the granted fix-check the old run
 * replans without the grant; the new CLI reads the fix-check row and passes grantFixChecked. A fix-check grant answering a stop
 * replans with last 'none' until a fix-check spends it (gstack-review-plan's grantUnspent).
 */
interface Shape { name: string; start: History; depth?: Depth; finds: Array<Partial<History>>; grant?: Partial<History>; oldSteps: Step[]; newSteps: Step[] }
function simulate(s: Shape, plan: typeof nextStep, isNew: boolean): Step[] {
  let h: History = { ...s.start };
  let granted = !!(h.granted || h.grantedStop), spent = false, i = 0;
  const steps: Step[] = [];
  for (let n = 0; n < 8; n++) {
    const asked = h.grantedStop && !spent && h.last === 'fix-check' ? { ...h, last: 'none' as const } : h;
    const step = plan(asked, s.depth).step;
    steps.push(step);
    if (step === 'stop' && s.grant && !granted) { h = { ...h, ...s.grant }; granted = true; continue; }
    if (!REVIEW.includes(step)) return steps;
    const found = s.finds[i++] ?? {};
    const wasGranted = step === 'fix-check' && granted && !spent;
    h = { ...h, fixedBlocking: false, fixedBelow: false, blockingOpen: false, touchedGate: false, ...found, last: step === 'fix-check' ? 'fix-check' : 'full', fullPasses: h.fullPasses + (step === 'fix-check' ? 0 : 1), fixChecks: (h.fixChecks ?? 0) + (step === 'fix-check' ? 1 : 0) };
    if (wasGranted) { spent = true; if (isNew) h.grantFixChecked = true; else if (h.granted) { const { granted: _g, chained: _c, ...rest } = h; h = rest; } }
  }
  return steps;
}

const RUNTIME = { rangeRuntimeLines: 6 };
const SHAPES: Shape[] = [
  { name: 'gstack #4537: a new run spends the grant on a read-only run\'s stop', start: { fullPasses: 0, last: 'none', priorFull: 3, priorRounds: 3, grantedStop: 'a-1', ...RUNTIME }, finds: [{}, {}], oldSteps: ['fix-check', 'done'], newSteps: ['fix-check', 'full', 'done'] },
  { name: 'harness-evals#508: the stopped run spends the grant on its own stop', start: { fullPasses: 1, last: 'full', priorFull: 2, blockingOpen: true, grantedStop: 'a-1', ...RUNTIME }, finds: [{}, {}], oldSteps: ['fix-check', 'done'], newSteps: ['fix-check', 'full', 'done'] },
  { name: '#4612: the same route, counted by finish', start: { fullPasses: 1, last: 'full', priorFull: 2, fixedBlocking: true, grantedStop: 'a-1', ...RUNTIME }, finds: [{}, { fixedBelow: true }], oldSteps: ['fix-check', 'done'], newSteps: ['fix-check', 'full', 'done'] },
  { name: '#4597: a trailer plus a later clean full round, no grant', start: { fullPasses: 0, last: 'none', ...RUNTIME }, depth: 'full', finds: [{ fixedBlocking: true }, {}], oldSteps: ['full', 'full', 'done'], newSteps: ['full', 'full', 'done'] },
  { name: 'harness-evals#504: a fix-check grant answering a stop after a gate-class fix-check edit', start: { fullPasses: 1, last: 'fix-check', fixChecks: 1, priorFull: 2, priorRounds: 3, touchedGate: true, grantedStop: 'a-2', ...RUNTIME }, finds: [{}, {}], oldSteps: ['fix-check', 'done'], newSteps: ['fix-check', 'full', 'done'] },
  { name: '#4664: granted fix-check at b2d3ab4 after a round-2 stop', start: { fullPasses: 0, last: 'none', ...RUNTIME }, depth: 'full', finds: [{ fixedBlocking: true }, { fixedBlocking: true }, {}, {}], grant: { grantedStop: 'a-3d9a27629e31' }, oldSteps: ['full', 'full', 'stop', 'fix-check', 'done'], newSteps: ['full', 'full', 'stop', 'fix-check', 'full', 'done'] },
  { name: '#4663: the read-only final review a Captain ruled by hand after a grant is now planned', start: { fullPasses: 0, last: 'none', priorFull: 2, priorRounds: 2, grantedStop: 'a-4', rangeRuntimeLines: 3 }, finds: [{}, { fixedBelow: true }], oldSteps: ['fix-check', 'done'], newSteps: ['fix-check', 'full', 'done'] },
  { name: 'gbrain#10036: an in-run grant whose fix-check read the fixed blockers clean', start: { fullPasses: 0, last: 'none', ...RUNTIME }, depth: 'full', finds: [{ fixedBlocking: true }, { fixedBlocking: true }, {}, {}], grant: { granted: 'a-685e316454ff' }, oldSteps: ['full', 'full', 'stop', 'fix-check', 'done'], newSteps: ['full', 'full', 'stop', 'fix-check', 'full', 'done'] },
  { name: 'control: a granted fix round that changed only docs and tests (0 runtime lines)', start: { fullPasses: 1, last: 'full', priorFull: 2, blockingOpen: true, grantedStop: 'a-5', rangeRuntimeLines: 0 }, finds: [{}], oldSteps: ['fix-check', 'done'], newSteps: ['fix-check', 'done'] },
  { name: 'control: the final review finds a blocker', start: { fullPasses: 1, last: 'full', priorFull: 2, blockingOpen: true, grantedStop: 'a-6', ...RUNTIME }, finds: [{}, { fixedBlocking: true }], oldSteps: ['fix-check', 'done'], newSteps: ['fix-check', 'full', 'stop'] },
];

describe('plan replay on real shapes: the only added step is one read-only full review after a granted fix-check', () => {
  for (const s of SHAPES) {
    // Value: protects=the real shapes keep every old step, in order, and add at most one full review right after the granted
    //   fix-check, followed only by done or stop; fails_when=a step is lost, a fix round or fix-check is added, or the control adds a
    //   review; seam=nextStep through the CLI's history mapping; no_claim=each case's bytes (shapes follow its recorded route)
    test(s.name, () => {
      const old = simulate(s, oldStep, false), now = simulate(s, nextStep, true);
      expect([old, now]).toEqual([s.oldSteps, s.newSteps]);
      const at = now.findIndex((step, i) => step !== old[i]);
      if (at < 0) return expect(now).toEqual(old);
      expect([now[at - 1], now[at], now.length - old.length]).toEqual(['fix-check', 'full', 1]);
      expect(now.slice(at + 1).every(x => x === 'done' || x === 'stop')).toBe(true);
      const review = (steps: Step[]) => steps.filter(x => REVIEW.includes(x));
      expect(review([...now.slice(0, at), ...now.slice(at + 1)])).toEqual(review(old));
    });
  }
});

describe('packet replay: decision 3.5\'s hunks are byte-identical without an untracked file (Part B)', () => {
  const hunksDoc = /touched hunks \(([^)]*)\)/.exec(fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf8'))?.[1] ?? '';
  function repo(files: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(tmp, 'pkt-'));
    const git = (...a: string[]) => { const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8', timeout: 30_000 }); expect(r.status, r.stderr).toBe(0); return r.stdout; };
    const write = (f: Record<string, string>) => { for (const [p, t] of Object.entries(f)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); } };
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    write(files); git('add', '-A'); git('commit', '-qm', 'pass head');
    return { dir, git, write, passHead: git('rev-parse', 'HEAD').trim() };
  }
  const documented = (r: ReturnType<typeof repo>) => {
    const created = r.git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
    if (created.length) r.git('add', '-N', '--', ...created);
    return r.git('diff', r.passHead);
  };
  // Value: protects=the packet a fix-check reader gets is unchanged on a fix that created no file, and holds a created file;
  //   fails_when=the bytes differ from plain git diff $PASS_HEAD, or a new file is missing; seam=the documented command;
  //   no_claim=what a reader concludes from the hunks
  test('tracked edits, a deletion and ignored files are byte-identical; a created file is included', () => {
    expect(hunksDoc).toContain('git add -N');
    const cases: Array<[string, Record<string, string>, (r: ReturnType<typeof repo>) => void]> = [
      ['tracked edits', { 'src/a.ts': 'export const a = 1;\n' }, r => r.write({ 'src/a.ts': 'export const a = 2;\n' })],
      ['a deletion', { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' }, r => fs.rmSync(path.join(r.dir, 'src/b.ts'))],
      ['ignored files', { '.gitignore': 'out/\n', 'src/a.ts': 'export const a = 1;\n' }, r => r.write({ 'src/a.ts': 'export const a = 2;\n', 'out/x.js': 'x\n' })],
    ];
    for (const [name, files, fix] of cases) {
      const r = repo(files);
      fix(r);
      const plain = r.git('diff', r.passHead);
      expect(Buffer.from(documented(r)), name).toEqual(Buffer.from(plain));
    }
    const r = repo({ 'src/a.ts': 'export const a = 1;\n' });
    r.write({ 'src/a.ts': 'export const a = 2;\n', 'src/new.ts': 'export const n = 1;\n' });
    const plain = r.git('diff', r.passHead);
    const text = documented(r);
    expect(plain).not.toContain('src/new.ts');
    expect(text).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(text.startsWith(plain.slice(0, plain.indexOf('\n')))).toBe(true);
  });
});
