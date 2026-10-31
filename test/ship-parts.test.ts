/**
 * GSTA-167 calls plan C5 in code: gstack-ship-parts returns the sections /ship's next phase uses,
 * verbatim, split at headings, each byte once per run, inside the program before that phase.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PARTS, PART_MAX, ROOM_DEFAULT, WHOLE, block, resolveParts } from '../lib/ship-parts';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-ship-parts');
const run = (args: string[]) => spawnSync(BIN, args, { encoding: 'utf8', timeout: 30_000 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ship-parts-'));
const parts = resolveParts(ROOT);

describe('the parts manifest', () => {
  // Value: protects=the parent gets every byte of review-army.md, adversarial.md, documentation.md and review/checklist.md exactly once, and Steps 8.1-8.2 whole, so moving the reads into phase programs loses nothing; fails_when=a heading split skips or repeats bytes, a section grows past what one return can carry, or a part is scheduled after the phase that first uses it;
  //   why_new=C5 moved section reads from prose into a bin; seam=none; no_claim=what the parent does with the text
  test('whole files are covered byte for byte once, Steps 8.1-8.2 are exact, parts fit one return and run in phase order', () => {
    for (const f of WHOLE) {
      const own = parts.filter(p => p.file === f).sort((a, b) => a.start - b.start);
      expect(own[0]!.start).toBe(0);
      for (let i = 1; i < own.length; i++) expect(own[i]!.start).toBe(own[i - 1]!.end);
      expect(Buffer.concat(own.map(p => Buffer.from(p.text))).equals(fs.readFileSync(path.join(ROOT, f)))).toBe(true);
    }
    const plan = fs.readFileSync(path.join(ROOT, 'ship/sections/plan-completion.md'), 'utf8');
    expect(parts.find(p => p.id === 'plan-8.1-8.2')!.text).toBe(plan.slice(plan.indexOf('\n## Step 8.1: Plan Verification\n') + 1, plan.indexOf('\n## Prior Learnings\n') + 1));
    expect(new Set(parts.map(p => p.id)).size).toBe(parts.length);
    for (const p of parts) expect(Buffer.byteLength(block(p))).toBeLessThanOrEqual(PART_MAX);
    expect(parts.map(p => p.phase)).toEqual([...parts.map(p => p.phase)].sort((a, b) => a - b));
    for (const p of parts.filter(p => p.file === 'ship/sections/adversarial.md')) expect(p.phase, p.id).toBe(4);
    const phase3 = parts.filter(p => p.phase === 3).reduce((n, p) => n + Buffer.byteLength(block(p)), 0);
    expect(phase3).toBeLessThanOrEqual(PART_MAX);
  });

  // Value: protects=a section edit that renames a split heading stops the run with the file and heading named, instead of silently shifting bytes between parts; fails_when=a missing heading falls back to the file start or end;
  //   why_new=headings are the manifest's keys; seam=none; no_claim=which headings a section should have
  test('a split heading missing from its section stops with the heading and file named', () => {
    const root = tmp();
    for (const f of new Set(PARTS.map(p => p.file))) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
    }
    const ra = path.join(root, 'ship/sections/review-army.md');
    fs.writeFileSync(ra, fs.readFileSync(ra, 'utf8').replace('### Step 9.3: Cross-review finding dedup', '### Step 9.3: Dedup'));
    expect(() => resolveParts(root)).toThrow('PARTS_MANIFEST: heading "### Step 9.3: Cross-review finding dedup" not found in ship/sections/review-army.md');
  });
});

describe('gstack-ship-parts next', () => {
  // Value: protects=each program's return stays within the room it passes, no part is returned twice in a run, and a part due by the next phase that did not fit is named with the one call that fetches it; fails_when=next repeats a part, overruns --room, drops a due part silently, or the run's later calls restart from the top;
  //   why_new=the bin is new; seam=none; no_claim=the parent computing --room correctly
  test('returns parts in run order within --room, each once, and names what is due before the phase', () => {
    const dir = tmp();
    const seen: string[] = [];
    let text = '';
    for (const [phase, room] of [[3, 26000], [4, 8000], [4, ROOM_DEFAULT], [4, ROOM_DEFAULT], [4, ROOM_DEFAULT], [5, ROOM_DEFAULT], [6, ROOM_DEFAULT], [7, ROOM_DEFAULT]] as const) {
      const r = run(['next', '--run', dir, '--phase', String(phase), '--room', String(room)]);
      expect(r.status, r.stderr).toBe(0);
      const ids = [...r.stdout.matchAll(/^PART: (\S+) /gm)].map(m => m[1]!);
      const body = r.stdout.slice(0, r.stdout.indexOf('PARTS: '));
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(room);
      for (const id of ids) {
        const p = parts.find(x => x.id === id)!;
        expect(body).toContain(block(p));
        text += p.text;
      }
      seen.push(...ids);
      const due = r.stdout.match(/^PARTS: phase=\d+ returned=\S+ due=(\S+) left=\d+$/m)![1]!;
      expect(due).toBe(parts.filter(p => p.phase <= phase && !seen.includes(p.id)).map(p => p.id).join(',') || 'none');
      expect(r.stdout.includes("NEXT: parts (run `gstack-ship-parts next --run '" + dir + "' --phase " + phase + '` alone before Phase ' + phase + ')')).toBe(due !== 'none');
    }
    expect(seen).toEqual(parts.map(p => p.id));
    expect(Buffer.byteLength(text)).toBe(parts.reduce((n, p) => n + p.end - p.start, 0));
    expect(run(['next', '--run', dir, '--phase', '7']).stdout).toBe('PARTS: phase=7 returned=none due=none left=0\n');
  });
});

describe('gstack-ship-parts next under loss and odd inputs (PR #3670 review)', () => {
  // Value: protects=a section batch whose return never reached the parent is delivered again, the whole output (trailer included) stays inside --room, the printed recovery command survives a run dir with spaces or quotes, and a corrupt state file stops with its path instead of a crash; fails_when=next marks parts returned before delivery with no resend, budgets only the part blocks, prints the run dir unquoted, or throws on bad JSON;
  //   why_new=Step 11 findings on #3670 (outside voice 1-3, adversarial 5, QA); seam=none; no_claim=the host noticing that a return was lost
  test('a lost return is sent again with --resend, and a plain next promotes it to returned', () => {
    const dir = tmp();
    const first = run(['next', '--run', dir, '--phase', '3', '--room', '4000']);
    const ids = [...first.stdout.matchAll(/^PART: (\S+) /gm)].map(m => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    const again = run(['next', '--run', dir, '--phase', '3', '--room', '4000', '--resend']);
    expect(again.status, again.stderr).toBe(0);
    expect([...again.stdout.matchAll(/^PART: (\S+) /gm)].map(m => m[1]!)).toEqual(ids);
    const later = run(['next', '--run', dir, '--phase', '3', '--room', '4000']);
    expect([...later.stdout.matchAll(/^PART: (\S+) /gm)].map(m => m[1]!).filter(id => ids.includes(id))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'parts', 'state.json'), 'utf8')).returned).toEqual(expect.arrayContaining(ids));
  });

  test('the PARTS: and NEXT: parts trailer counts against --room, and the run dir is shell-quoted', () => {
    const dir = path.join(tmp(), "run with 'spaces' and $(x)");
    const room = Buffer.byteLength(block(parts[0]!)) + 10;
    const r = run(['next', '--run', dir, '--phase', '3', '--room', String(room)]);
    expect(r.status, r.stderr).toBe(0);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(room);
    const cmd = r.stdout.match(/^NEXT: parts \(run `(.+)` alone before Phase 3\)$/m)![1]!;
    const echo = spawnSync('bash', ['-c', cmd.replace('gstack-ship-parts next', 'printf "%s\\n"')], { encoding: 'utf8', timeout: 30_000 });
    expect(echo.stdout.split('\n')).toContain(dir);
  });

  test('a corrupt state file stops with its path named', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'parts'));
    fs.writeFileSync(path.join(dir, 'parts', 'state.json'), '{bad');
    const r = run(['next', '--run', dir, '--phase', '3']);
    expect(r.status).toBe(3);
    expect(r.stdout).toStartWith('STOP: ' + path.join(dir, 'parts', 'state.json'));
  });
});

describe('the driver and the pass program use it', () => {
  // Value: protects=the parent learns the one call that carries the sections and the pass program carries them for Phase 3's returns, so no phase spends a call reading a section; fails_when=the driver drops the call or its NEXT rule, or the pass program stops calling the bin;
  //   why_new=C5 in code; seam=none; no_claim=the parent's adherence, which a replay's CALLS: line measures
  test('ship/DRIVER.md names the call and its NEXT rule, and the pass program runs it', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'ship/DRIVER.md'), 'utf8').replace(/\s+/g, ' ');
    expect(doc).toContain('phase programs end with `gstack-ship-parts next --run <run dir> --phase <n+1> --room <32000 - its output>`; on `NEXT: parts` run it alone');
    expect(fs.readFileSync(path.join(ROOT, 'lib/capy-review-pass.js'), 'utf8')).toContain("'gstack-ship-parts next --run '");
  });
});
