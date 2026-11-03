/**
 * R56 cut ledger ratchet (GST-1088 lane C). modules/cuts.json names the pieces
 * cut from /investigate and /review in every loadout and on every host, and pins
 * each targeted skill's always-loaded bytes (its Claude SKILL.md, frontmatter
 * included). This test fails when a cut piece reappears in a generated SKILL.md,
 * when a pin moves, or when a cut or a review-only change leaks into another skill.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts/index';
import { CUT_LEDGER_FILE, loadCutLedger, preambleCuts, type CutLedger } from '../scripts/cut-ledger';
import { PREAMBLE_PIECES } from '../scripts/resolvers/preamble';
import { SHARED_PREAMBLE_FILE } from '../scripts/resolvers/preamble-hoist';
import { discoverTemplates } from '../scripts/discover-skills';
import { loadLoadouts, moduleCatalog, selectModules, validateLoadouts } from '../scripts/modules';

const ROOT = path.resolve(import.meta.dir, '..');
const TARGETED = ['investigate', 'review'];
/** Text only /review may render: the GST-1088 markers and the blocker-proof rule. */
const REVIEW_ONLY = ['Dispatching 0 specialists: (small diff)', 'Dispatching adversarial pass: native', 'Blocker proof'];

const skillOfDir = (dir: string) => (dir === '.' ? 'gstack' : dir.replace(/^gstack-/, ''));

/** Every violation of the ledger by these renders (key "host/skill") and Claude SKILL.md byte counts. */
export function cutViolations(renders: Record<string, string>, bytes: Record<string, number>, ledger: CutLedger): string[] {
  const out: string[] = [];
  for (const [key, text] of Object.entries(renders).sort(([a], [b]) => a.localeCompare(b))) {
    const [host, skill] = key.split('/');
    for (const cut of ledger.cuts.filter(c => c.skill === skill && text.includes(c.match))) {
      out.push(`${host}/${skill}/SKILL.md: cut section "${cut.match}" reappeared (${CUT_LEDGER_FILE} ${cut.id}: ${cut.why}). `
        + `Fix: remove it from ${cut.source}, then bun run gen:skill-docs. Restoring it instead needs a measurement in the PR and ${ledger.approver}.`);
    }
  }
  for (const [skill, pin] of Object.entries(ledger.pins).sort(([a], [b]) => a.localeCompare(b))) {
    const actual = bytes[skill];
    if (actual === undefined) { out.push(`pins.${skill} in ${CUT_LEDGER_FILE} names no ${skill}/SKILL.md. Delete the pin.`); continue; }
    if (actual > pin) {
      out.push(`${skill}/SKILL.md: ${actual} always-loaded bytes, pinned at ${pin} (+${actual - pin}). `
        + `Fix: edit ${skill}/SKILL.md.tmpl, then bun run gen:skill-docs. Re-pin: set pins.${skill} to ${actual} in ${CUT_LEDGER_FILE} with the measurement in the PR body; approver: ${ledger.approver}.`);
    } else if (actual < pin) {
      out.push(`${skill}/SKILL.md: ${actual} always-loaded bytes, pinned at ${pin} (-${pin - actual}). Re-pin: lower pins.${skill} to ${actual} in ${CUT_LEDGER_FILE}.`);
    }
  }
  return out;
}

/** Each skill's SKILL.md plus its own section files (the shared preamble is the same file for every skill). */
function renderAllHosts(outDir: string): Record<string, string> {
  const render = Bun.spawnSync(
    ['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', outDir],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 180_000 },
  );
  if (render.exitCode !== 0) throw new Error(`gen-skill-docs --host all --out-dir failed (exit ${render.exitCode}):\n${render.stderr.toString()}`);
  const renders: Record<string, string> = {};
  for (const host of ALL_HOST_CONFIGS) {
    const skillsRoot = host.name === 'claude' ? ROOT : path.join(outDir, host.hostSubdir, 'skills');
    const dirs = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
    if (host.name === 'claude') dirs.push('.');
    for (const dir of dirs) {
      const file = path.join(skillsRoot, dir, 'SKILL.md');
      if (!fs.existsSync(file) || (host.name === 'claude' && !fs.existsSync(`${file}.tmpl`))) continue;
      const sectionsDir = path.join(skillsRoot, dir, 'sections');
      const sections = dir !== '.' && fs.existsSync(sectionsDir)
        ? fs.readdirSync(sectionsDir).filter(f => f.endsWith('.md') && f !== SHARED_PREAMBLE_FILE).sort().map(f => fs.readFileSync(path.join(sectionsDir, f), 'utf-8'))
        : [];
      renders[`${host.name}/${skillOfDir(dir)}`] = [fs.readFileSync(file, 'utf-8'), ...sections].join('\n');
    }
  }
  return renders;
}

const ledger = loadCutLedger();
const claudeBytes = Object.fromEntries(TARGETED.map(s => [s, fs.statSync(path.join(ROOT, s, 'SKILL.md')).size]));

describe('cut ledger ratchet messages', () => {
  const fixture: CutLedger = {
    version: 1, note: '', approver: 'the owner',
    cuts: [{ id: 'part:x/learn', skill: 'x', status: 'cut', source: 'x/SKILL.md.tmpl', match: '## Learn', why: 'unused', evidence: 'run 1' }],
    pins: { x: 100, y: 50 },
  };
  test('names the file, the section and its entry, the bytes and the fix or re-pin with its approver', () => {
    expect(cutViolations({ 'codex/x': 'a\n## Learn\n', 'codex/z': '## Learn' }, { x: 101, y: 49 }, fixture)).toEqual([
      `codex/x/SKILL.md: cut section "## Learn" reappeared (${CUT_LEDGER_FILE} part:x/learn: unused). Fix: remove it from x/SKILL.md.tmpl, then bun run gen:skill-docs. Restoring it instead needs a measurement in the PR and the owner.`,
      `x/SKILL.md: 101 always-loaded bytes, pinned at 100 (+1). Fix: edit x/SKILL.md.tmpl, then bun run gen:skill-docs. Re-pin: set pins.x to 101 in ${CUT_LEDGER_FILE} with the measurement in the PR body; approver: the owner.`,
      `y/SKILL.md: 49 always-loaded bytes, pinned at 50 (-1). Re-pin: lower pins.y to 49 in ${CUT_LEDGER_FILE}.`,
    ]);
  });
});

describe('modules/cuts.json', () => {
  test('cuts and pins cover exactly /investigate and /review', () => {
    expect([...new Set(ledger.cuts.map(c => c.skill))].sort()).toEqual(TARGETED);
    expect(Object.keys(ledger.pins).sort()).toEqual(TARGETED);
  });

  test('each cut is a skill-qualified id with a real source, preamble piece and match', () => {
    const pieces = new Set(PREAMBLE_PIECES.map(p => p.id));
    const others = discoverTemplates(ROOT).map(t => path.join(ROOT, path.dirname(t.tmpl), 'SKILL.md'))
      .filter(f => !TARGETED.some(s => f.endsWith(`/${s}/SKILL.md`)) && fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf-8'));
    expect(new Set(ledger.cuts.map(c => c.id)).size).toBe(ledger.cuts.length);
    for (const cut of ledger.cuts) {
      expect(cut.id).toMatch(new RegExp(`^part:${cut.skill}/[a-z0-9-]+$`));
      expect(cut.status).toBe('cut');
      expect(fs.existsSync(path.join(ROOT, cut.source)), `${cut.id} source ${cut.source}`).toBe(true);
      if (cut.preamble_piece) expect(pieces.has(cut.preamble_piece), `${cut.id} preamble_piece`).toBe(true);
      expect(others.some(text => text.includes(cut.match)), `${cut.id} match "${cut.match}" appears in no other skill, so it guards nothing`).toBe(true);
    }
  });

  test('a preamble cut applies to its own skill alone', () => {
    for (const { tmpl } of discoverTemplates(ROOT)) {
      const skill = skillOfDir(path.dirname(tmpl));
      expect([...preambleCuts(skill)]).toEqual(ledger.cuts.filter(c => c.skill === skill && c.preamble_piece).map(c => c.preamble_piece!));
    }
  });
});

describe('module catalog lists cuts', () => {
  const manifest = loadLoadouts();
  test('every cut id is a catalog entry with status cut', () => {
    const catalog = moduleCatalog(manifest);
    for (const cut of ledger.cuts) expect(catalog.find(e => e.id === cut.id)).toMatchObject({ kind: 'part', status: 'cut', pinned: false });
  });
  test('a loadout or a --modules spec cannot name a cut, since it is cut in every loadout', () => {
    const id = ledger.cuts[0].id;
    const bad = { ...manifest, loadouts: { ...manifest.loadouts, odd: { base: 'full', include: [id] } } };
    expect(validateLoadouts(bad, moduleCatalog(manifest))).toContain(`loadouts.odd names ${id}, which is cut in every loadout (${CUT_LEDGER_FILE})`);
    expect(() => selectModules({ modules: `full,+${id}` })).toThrow(/cut in every loadout/);
  });
});

describe('cut ledger against every host render', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cut-ledger-'));
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const renders = renderAllHosts(outDir);

  test('no cut piece reappears in its skill or its sections, and each pin matches its SKILL.md', () => {
    for (const host of ALL_HOST_CONFIGS) for (const skill of TARGETED) expect(renders[`${host.name}/${skill}`], `${host.name}/${skill}`).toBeDefined();
    const violations = cutViolations(renders, claudeBytes, ledger);
    if (violations.length) throw new Error(`${violations.length} cut ledger violation(s):\n  ${violations.join('\n  ')}`);
  });

  test('a preamble cut never comes back through the shared preamble file, on any host', () => {
    const leaks: string[] = [];
    for (const host of ALL_HOST_CONFIGS) for (const cut of ledger.cuts.filter(c => c.preamble_piece)) {
      const file = host.name === 'claude'
        ? path.join(ROOT, cut.skill, 'sections', SHARED_PREAMBLE_FILE)
        : path.join(outDir, host.hostSubdir, 'skills', `gstack-${cut.skill}`, 'sections', SHARED_PREAMBLE_FILE);
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes(cut.match)) leaks.push(`${host.name}: ${cut.id} "${cut.match}" in ${path.relative(outDir, file)}`);
    }
    expect(leaks).toEqual([]);
  });

  test('review-only GST-1088 text renders in /review alone, on every host', () => {
    const leaks = Object.entries(renders).filter(([key]) => !key.endsWith('/review'))
      .flatMap(([key, text]) => REVIEW_ONLY.filter(s => text.includes(s)).map(s => `${key}: "${s}"`));
    expect(leaks).toEqual([]);
    expect(REVIEW_ONLY.filter(s => !renders['claude/review'].includes(s))).toEqual([]);
  });
});

/** Every file under dir (relative path to bytes), skipping the targeted skills' own trees. */
function readOtherSkills(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const rel of fs.readdirSync(dir, { recursive: true, withFileTypes: false }) as string[]) {
    const file = path.join(dir, rel);
    if (fs.statSync(file).isFile()) out.set(rel, fs.readFileSync(file));
  }
  return out;
}

const targetedPath = new RegExp(`(^|/)(gstack-)?(${TARGETED.join('|')})/`);

describe('the ledger reaches only /investigate and /review', () => {
  test('every other skill renders byte-identical on every host with modules/cuts.json and with an empty ledger', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cut-scope-'));
    try {
      const copy = path.join(work, 'checkout');
      const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
      if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
      for (const rel of listed.stdout.toString().split('\0').filter(Boolean)) {
        const source = path.join(ROOT, rel);
        if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) continue;
        fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
        fs.copyFileSync(source, path.join(copy, rel));
      }
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'));
      fs.writeFileSync(path.join(copy, CUT_LEDGER_FILE), JSON.stringify({ ...ledger, cuts: [], pins: {} }, null, 2) + '\n');

      const out = path.join(work, 'out');
      const [withCuts, empty] = [ROOT, copy].map(cwd => {
        const render = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', out],
          { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 180_000 });
        if (render.exitCode !== 0) throw new Error(`gen-skill-docs in ${cwd} failed (exit ${render.exitCode}):\n${render.stderr.toString()}`);
        const tree = readOtherSkills(out);
        fs.rmSync(out, { recursive: true, force: true });
        return tree;
      });

      expect(withCuts.get('review/SKILL.md')?.equals(empty.get('review/SKILL.md')!), 'the empty ledger must change /review, or this test proves nothing').toBe(false);
      const differs = [...new Set([...withCuts.keys(), ...empty.keys()])].filter(rel => !targetedPath.test(rel)).sort()
        .filter(rel => !withCuts.get(rel)?.equals(empty.get(rel) ?? Buffer.alloc(0)) || !empty.has(rel));
      expect(differs, `${CUT_LEDGER_FILE} changed files outside /investigate and /review`).toEqual([]);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 600_000);
});
