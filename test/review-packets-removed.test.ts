/**
 * The reviewer-packet path from #3621 and #3636 was reverted after no-loss round 3
 * (GSTA-167): packet reviewers found 10 of the 19 blockers the pre-#3621 reviewers find.
 * This keeps the removed commands and modules gone and unreferenced, so a branch cut
 * before the revert cannot bring back a dangling call to them through a merge.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sectionTexts } from '../lib/review-brief';
import { mergePinEdits, type PinMerge } from './helpers/pin-merge-fixture';

const ROOT = path.join(import.meta.dir, '..');
const REMOVED = [
  'bin/gstack-review-packet',
  'lib/review-packet.ts',
  'lib/review-packet-collect.ts',
  'lib/review-plan-live.ts',
  'lib/review-prompts.ts',
];
const NAMES = /gstack-review-packet|review-packet-collect|review-plan-live|lib\/review-prompts|review-packet\.ts|READ_BUDGET|reviewer-packets|review-packets-fc|REVIEW_COVERAGE_INCOMPLETE|review-coverage-incomplete/;
const SELF = path.relative(ROOT, import.meta.path);

describe('reviewer packets stay reverted (GSTA-167)', () => {
  test('the removed packet files do not exist', () => {
    expect(REMOVED.filter(f => fs.existsSync(path.join(ROOT, f)))).toEqual([]);
  });

  test('no tracked file outside CHANGELOG.md names a removed packet file, the packet read rule or a packet-only anchor or code', () => {
    const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    expect(ls.status).toBe(0);
    const files = ls.stdout.split('\0').filter(f => f && f !== 'CHANGELOG.md' && f !== SELF && fs.existsSync(path.join(ROOT, f)));
    expect(files.length).toBeGreaterThan(1000);
    const hits = files.filter(f => {
      const full = path.join(ROOT, f);
      if (!fs.statSync(full).isFile()) return false;
      return NAMES.test(fs.readFileSync(full, 'utf8'));
    });
    expect(hits).toEqual([]);
  });
});

/**
 * The reviewer briefs main restored in #3638 (v1.91.331.0), pinned by content: the rendered
 * specialist, Red Team, adversarial and outside-voice prompts, the checklists they read, the
 * fix-check prompt and the depth rules that pick reviewers. A change to any of them changes what a
 * reviewer sees or how its findings rate, so it merges only after its preregistered no-loss replay
 * passes (GStack Minder crew rule, 2026-10-30); a cost replay alone is not enough (#3621 passed its
 * cost replay, then its no-loss replay found 11 of 30 blockers). Every pin names the replay that
 * admits its bytes: repin with that replay's id in the pin file and in the commit message, and merge only on
 * its passing result.
 *
 * The pins live one file per pin under test/fixtures/review-pins (GST-1084), so two PRs that repin
 * different files, or add different replays, never edit the same lines and merge without a conflict:
 *   files/<pinned path>.json   {"sha", "replay"}: the sha256 of the file's LF-normalized bytes and the replay that admits them
 *   replays/<slug>.json        {"replay", "justification"}: one replay id and its written no-loss justification,
 *                              where <slug> is replaySlug(replay)
 *   brief-bodies/<name>.json   {"sha"}: one brief body lib/review-brief.ts cuts from the ship sections (below)
 */
const PINS = path.join(ROOT, 'test/fixtures/review-pins');
const replaySlug = (replay: string) => replay.replace(/[^A-Za-z0-9+-]+/g, '-').replace(/^-+|-+$/g, '');

/** Every pin file under dir, keyed by its path below dir without `.json`; any other file is an error. */
function readPinDir(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rel of (fs.readdirSync(dir, { recursive: true }) as string[]).map(f => f.split(path.sep).join('/')).sort()) {
    if (fs.statSync(path.join(dir, rel)).isDirectory()) continue;
    if (!rel.endsWith('.json')) throw new Error(`${dir}/${rel}: every pin file is <name>.json`);
    try {
      out[rel.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    } catch (e) {
      throw new Error(`${dir}/${rel}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** The pin store at pins, with every file that is not exactly its kind's fields as non-empty strings, or is misnamed. */
function readPins(pins: string) {
  const malformed: string[] = [];
  const kind = <K extends string>(sub: string, keys: readonly K[]) => {
    const out: Record<string, Record<K, string>> = {};
    for (const [name, value] of Object.entries(readPinDir(path.join(pins, sub)))) {
      const fields = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (Object.keys(fields).sort().join() === [...keys].sort().join() && keys.every(k => typeof fields[k] === 'string' && fields[k] !== '')) out[name] = fields as Record<K, string>;
      else malformed.push(`${sub}/${name}.json (expected exactly ${keys.join(', ')})`);
    }
    return out;
  };
  const replayFiles = kind('replays', ['replay', 'justification']);
  for (const [name, r] of Object.entries(replayFiles)) if (name !== replaySlug(r.replay)) malformed.push(`replays/${name}.json (replay ${r.replay} belongs in replays/${replaySlug(r.replay)}.json)`);
  return {
    malformed,
    replays: Object.fromEntries(Object.values(replayFiles).map(r => [r.replay, r.justification])),
    files: kind('files', ['sha', 'replay']),
    bodies: Object.fromEntries(Object.entries(kind('brief-bodies', ['sha'])).map(([name, body]) => [name, body.sha])),
  };
}
type Pins = ReturnType<typeof readPins>;

/** Every source a reviewer brief, checklist or depth rule comes from: deleting one of these pins fails, never drops the check. */
const MUST_PIN = [
  'lib/review-depth.ts',
  'lib/review-risk.ts',
  'review/checklist.md',
  'review/design-checklist.md',
  'review/gate-integrity.md',
  'review/sections/adversarial.md',
  'review/sections/review-army.md',
  'scripts/resolvers/fix-check.ts',
  'ship/sections/adversarial.md',
  'ship/sections/review-army.md',
];

/** MUST_PIN entries and specialist checklists under root with no pin. */
const unpinned = (pins: Pins, root: string) => [...MUST_PIN, ...fs.readdirSync(path.join(root, 'review/specialists')).filter(f => f.endsWith('.md')).map(f => `review/specialists/${f}`)]
  .filter(f => !Object.hasOwn(pins.files, f));

/** Pinned files whose LF-normalized bytes under root no longer hash to their pin. */
const stalePins = (pins: Pins, root: string) => Object.entries(pins.files).filter(([file, pin]) => {
  const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex') !== pin.sha;
}).map(([file, pin]) => `${file} (a repin needs a passing no-loss replay; the current pin names ${pin.replay})`);

/** Pins naming no replay in the store, and replays whose justification names no no-loss replay or re-score. */
const unadmitted = (pins: Pins) => [
  ...Object.entries(pins.files).filter(([, pin]) => !Object.hasOwn(pins.replays, pin.replay)).map(([file, pin]) => `${file} names unknown replay ${pin.replay}`),
  ...Object.entries(pins.replays).filter(([, what]) => !/no-loss|re-score/.test(what)).map(([replay]) => `replay ${replay} is not a no-loss replay or re-score`),
];

const PINNED = readPins(PINS);

describe('reviewer briefs stay at their no-loss-tested bytes (GSTA-167)', () => {
  // Value: protects=the GST-986 repin of ship/sections/adversarial.md admits only a lead-instruction edit: every brief a reviewer
  //   reads renders byte-identical to the no-loss-tested bodies; fails_when=an edit inside a cut span changes a brief while the
  //   section pin moves; seam=sectionTexts, the function every render uses; no_claim=the checklists (pinned by file hash below)
  test('every reviewer brief cut from the ship sections is byte-identical to its pinned body', () => {
    const hashes = (root: string) => Object.fromEntries(Object.entries(sectionTexts(root)).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]));
    expect(hashes(ROOT)).toEqual(PINNED.bodies);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-bodies-'));
    try {
      fs.cpSync(path.join(ROOT, 'ship', 'sections'), path.join(copy, 'ship', 'sections'), { recursive: true });
      const adversarial = path.join(copy, 'ship', 'sections', 'adversarial.md');
      fs.writeFileSync(adversarial, fs.readFileSync(adversarial, 'utf8').replace('Recommendation:', 'Recommendation (short):'));
      expect(hashes(copy)).not.toEqual(PINNED.bodies);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  test('every pinned reviewer brief, checklist and depth rule hashes to its pin', () => {
    expect(PINNED.malformed).toEqual([]);
    expect(stalePins(PINNED, ROOT)).toEqual([]);
  });

  test('every pin names the preregistered no-loss replay that admits its bytes', () => {
    expect(unadmitted(PINNED)).toEqual([]);
  });

  test('the pins cover every specialist checklist', () => {
    const specialists = fs.readdirSync(path.join(ROOT, 'review/specialists')).filter(f => f.endsWith('.md')).map(f => `review/specialists/${f}`);
    expect(specialists.filter(f => !Object.hasOwn(PINNED.files, f))).toEqual([]);
  });

  test('every source a reviewer brief, checklist or depth rule comes from has a pin (GST-1084)', () => {
    expect(unpinned(PINNED, ROOT)).toEqual([]);
  });

  // Value: protects=the one-file-per-pin layout keeps every check the in-file table had; fails_when=a stale sha, an unknown or
  //   unjustified replay, a malformed or misnamed pin file, or a stray file passes; seam=readPins, stalePins and unadmitted, the
  //   functions the checks above call; no_claim=that a repin's replay actually passed (the commit and PR carry that)
  test('a stale pin, an unknown or unjustified replay and a malformed pin file each fail (GST-1084)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pins-'));
    try {
      const src = path.join(tmp, 'src'), pins = path.join(tmp, 'pins');
      for (const file of Object.keys(PINNED.files)) fs.cpSync(path.join(ROOT, file), path.join(src, file));
      fs.cpSync(PINS, pins, { recursive: true });
      expect(stalePins(readPins(pins), src)).toEqual([]);
      fs.writeFileSync(path.join(src, 'review/checklist.md'), fs.readFileSync(path.join(src, 'review/checklist.md'), 'utf8').replace(/\n/g, '\r\n'));
      expect(stalePins(readPins(pins), src)).toEqual([]);
      fs.appendFileSync(path.join(src, 'review/checklist.md'), 'One more rule.\r\n');
      expect(stalePins(readPins(pins), src)).toEqual([`review/checklist.md (a repin needs a passing no-loss replay; the current pin names ${PINNED.files['review/checklist.md']!.replay})`]);

      const pin = (file: string, value: unknown) => fs.writeFileSync(path.join(pins, 'files', `${file}.json`), `${JSON.stringify(value)}\n`);
      pin('review/design-checklist.md', { sha: PINNED.files['review/design-checklist.md']!.sha, replay: 'GST-0000' });
      pin('lib/review-risk.ts', { sha: PINNED.files['lib/review-risk.ts']!.sha, replay: 'toString' });
      fs.writeFileSync(path.join(pins, 'replays', 'GST-0001.json'), `${JSON.stringify({ replay: 'GST-0001', justification: 'reviewed by hand' })}\n`);
      expect(unadmitted(readPins(pins))).toEqual(['lib/review-risk.ts names unknown replay toString', 'review/design-checklist.md names unknown replay GST-0000',
        'replay GST-0001 is not a no-loss replay or re-score']);

      expect(unpinned(readPins(pins), ROOT)).toEqual([]);
      fs.rmSync(path.join(pins, 'files', 'lib/review-risk.ts.json'));
      fs.rmSync(path.join(pins, 'files', 'review/specialists/testing.md.json'));
      expect(unpinned(readPins(pins), ROOT)).toEqual(['lib/review-risk.ts', 'review/specialists/testing.md']);

      pin('review/gate-integrity.md', { ...PINNED.files['review/gate-integrity.md'], note: 'extra' });
      fs.writeFileSync(path.join(pins, 'replays', 'GST-0002.json'), `${JSON.stringify({ replay: 'GST-0003', justification: 'a no-loss replay' })}\n`);
      expect(readPins(pins).malformed).toEqual(['replays/GST-0002.json (replay GST-0003 belongs in replays/GST-0003.json)',
        'files/review/gate-integrity.md.json (expected exactly sha, replay)']);
      fs.writeFileSync(path.join(pins, 'files', 'review/gate-integrity.md.json'), '<<<<<<< a\n{}\n');
      expect(() => readPins(pins)).toThrow('files/review/gate-integrity.md.json: ');
      fs.rmSync(path.join(pins, 'files', 'review/gate-integrity.md.json'));
      fs.writeFileSync(path.join(pins, 'brief-bodies', 'specialist.txt'), 'stray\n');
      expect(() => readPins(pins)).toThrow('every pin file is <name>.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Value: protects=PRs that repin different review files merge without a conflict (five main-merge conflicts on 2026-11-02 came
  //   from the in-file table); fails_when=two repins of adjacent pins, each with its own new replay, conflict in a real merge, or
  //   two repins of one pin merge silently; seam=git merge-tree --write-tree on two branches; no_claim=semantic merge correctness
  test('repins of two different files, each with its own new replay, merge cleanly in a real git merge (GST-1084)', () => {
    const repin = (file: string, sha: string, replay: string) => (root: string) => {
      fs.writeFileSync(path.join(root, 'files', `${file}.json`), `${JSON.stringify({ sha, replay })}\n`);
      fs.writeFileSync(path.join(root, 'replays', `${replaySlug(replay)}.json`), `${JSON.stringify({ replay, justification: `${replay} no-loss replay` })}\n`);
    };
    const seed = (root: string) => fs.cpSync(PINS, root, { recursive: true });
    const army = 'ship/sections/review-army.md', adversarial = 'ship/sections/adversarial.md';
    const merges: PinMerge[] = [];
    try {
      const clean = mergePinEdits(seed, repin(army, 'a'.repeat(64), 'GST-9001+GST-967'), repin(adversarial, 'b'.repeat(64), 'GST-9002'));
      merges.push(clean);
      const conflict = mergePinEdits(seed, repin(army, 'a'.repeat(64), 'GST-9001'), repin(army, 'c'.repeat(64), 'GST-9003'));
      merges.push(conflict);
      expect(clean.output).not.toContain('CONFLICT');
      expect(clean.clean).toBe(true);
      expect(JSON.parse(clean.read(`files/${army}.json`))).toEqual({ sha: 'a'.repeat(64), replay: 'GST-9001+GST-967' });
      expect(JSON.parse(clean.read(`files/${adversarial}.json`))).toEqual({ sha: 'b'.repeat(64), replay: 'GST-9002' });
      expect(JSON.parse(clean.read('replays/GST-9001+GST-967.json')).replay).toBe('GST-9001+GST-967');
      expect(JSON.parse(clean.read('replays/GST-9002.json')).replay).toBe('GST-9002');
      expect(conflict.clean).toBe(false);
      expect(conflict.output).toContain(`CONFLICT (content): Merge conflict in files/${army}.json`);
    } finally {
      for (const merge of merges) fs.rmSync(merge.root, { recursive: true, force: true });
    }
  });
});
