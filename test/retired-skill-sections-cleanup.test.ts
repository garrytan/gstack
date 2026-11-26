/**
 * Retired and renamed skill entries keep no stranded sections/ directory.
 *
 * A gbrain-rendered install (and setup's Kiro and render paths) serves a
 * skill's sections/ as a REAL directory of per-file links. When /ship became
 * /gstack-ship and /cso was removed (1.104.0.0), the cleanup removed each old
 * entry's SKILL.md, marker and top-level links but not that directory, so
 * ship/ and cso/ stayed behind holding only sections/ (working links for ship,
 * dangling ones for cso). The next relink or setup must remove what gstack put
 * there, including on machines that already upgraded, and never a file, link
 * or directory of the user's.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const REGISTRY = path.join(ROOT, 'bin', 'gstack-install-registry.sh');
const BINS = ['gstack-config', 'gstack-lock.sh', 'gstack-relink', 'gstack-patch-names', 'gstack-skill-name.sh', 'gstack-state-root.sh', 'gstack-install-registry.sh'];
const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n';
const SHIP_SECTIONS = ['review.md', 'changelog.md', 'pr-body.md'];
const CSO_SECTIONS = ['owasp.md', 'secrets.md', 'supply-chain.md'];

const gone = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false }) === undefined;

// Value: protects=relink removes gstack's stranded ship/, cso/, gstack-cso/ and gstack-ship-era entries whose sections/ is a real dir of our links;
//   fails_when=the cleanup leaves a real sections/ directory of gstack links (working or dangling) or deletes a user's file, link or directory inside one;
//   why_new=retired-skills and claude-code-reserved-names cover only entries with no real asset subdirectory; seam=the real gstack-relink on a fixture install
describe.skipIf(process.platform === 'win32')('gstack-relink: retired and renamed entries leave no sections/ behind (GST-3999)', () => {
  let tmp: string;
  let install: string;
  let skills: string;
  let render: string;
  const relink = (config = 'skill_prefix: false\n') => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'config.yaml'), config);
    return spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
        GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '', GSTACK_USER_RENDER_DIR: render, GSTACK_USER_RENDER_PER_INSTALL: '',
      },
    });
  };
  // The 1.103.x rendered shape: a real dir, SKILL.md linked, sections/ a real dir of per-file links.
  const oldEntry = (name: string, skill: string, files: string[], opts: { marker?: boolean; skillMd?: boolean; via?: string } = {}) => {
    const dir = path.join(skills, name);
    fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
    if (opts.skillMd !== false) fs.symlinkSync(path.join(install, skill, 'SKILL.md'), path.join(dir, 'SKILL.md'));
    if (opts.marker) fs.writeFileSync(path.join(dir, '.gstack-owned'), install + '\n');
    for (const f of files) fs.symlinkSync(path.join(opts.via ?? install, skill, 'sections', f), path.join(dir, 'sections', f));
    return dir;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stranded-sections-'));
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    render = path.join(tmp, 'render');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(install, 'VERSION'), '2.0.0.0\n');
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    for (const [dir, name] of [['ship', 'gstack-ship'], ['qa', 'qa']]) {
      fs.mkdirSync(path.join(install, dir, 'sections'), { recursive: true });
      fs.writeFileSync(path.join(install, dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n# ${dir}\n`);
    }
    for (const f of SHIP_SECTIONS) fs.writeFileSync(path.join(install, 'ship', 'sections', f), `# ${f}\n`);
    fs.mkdirSync(skills, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  for (const prefix of ['false', 'true']) {
    test(`skill_prefix ${prefix}, upgrading from 1.103.x: the old ship and cso entries go whole, sections/ included`, () => {
      oldEntry('ship', 'ship', SHIP_SECTIONS, { marker: true });
      oldEntry('cso', 'cso', CSO_SECTIONS, { marker: true });
      oldEntry('gstack-cso', 'cso', CSO_SECTIONS, { via: render });
      const r = relink(`skill_prefix: ${prefix}\n`);
      expect(r.status, r.stderr).toBe(0);
      for (const name of ['ship', 'cso', 'gstack-cso']) expect(gone(path.join(skills, name))).toBe(true);
      expect(fs.readFileSync(path.join(skills, 'gstack-ship', 'SKILL.md'), 'utf8')).toContain('name: gstack-ship');
      expect(r.stdout).not.toContain('other files in that directory were left in place');
      for (const f of SHIP_SECTIONS) expect(fs.existsSync(path.join(install, 'ship', 'sections', f))).toBe(true);
    });
  }

  test('prefix mode: an unmarked legacy ship entry with a real sections/ of our links goes whole', () => {
    oldEntry('ship', 'ship', SHIP_SECTIONS);
    const r = relink('skill_prefix: true\n');
    expect(r.status, r.stderr).toBe(0);
    expect(gone(path.join(skills, 'ship'))).toBe(true);
  });

  test('already on 1.104.0.0: entries holding only sections/ of working or dangling links are removed', () => {
    oldEntry('ship', 'ship', SHIP_SECTIONS, { skillMd: false });
    oldEntry('cso', 'cso', CSO_SECTIONS, { skillMd: false });
    oldEntry('gstack-cso', 'cso', CSO_SECTIONS, { skillMd: false, via: render });
    oldEntry('gstack-investigate', 'investigate', ['a.md'], { skillMd: false });
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    for (const name of ['ship', 'cso', 'gstack-cso', 'gstack-investigate']) expect(gone(path.join(skills, name))).toBe(true);
    expect(fs.existsSync(path.join(skills, 'gstack-ship', 'SKILL.md'))).toBe(true);
  });

  test("the user's files, links and directories inside an old entry and its sections/ stay", () => {
    const ship = oldEntry('ship', 'ship', SHIP_SECTIONS, { marker: true });
    fs.writeFileSync(path.join(ship, 'sections', 'mine.md'), 'mine\n');
    fs.writeFileSync(path.join(ship, 'notes.md'), 'keep\n');
    const cso = oldEntry('cso', 'cso', CSO_SECTIONS, { skillMd: false });
    const notes = path.join(tmp, 'my-notes.md');
    fs.writeFileSync(notes, 'mine\n');
    fs.symlinkSync(notes, path.join(cso, 'sections', 'notes.md'));
    fs.mkdirSync(path.join(cso, 'sections', 'drafts'));
    fs.writeFileSync(path.join(cso, 'sections', 'drafts', 'd.md'), 'draft\n');
    fs.mkdirSync(path.join(ship, 'empty'));
    fs.mkdirSync(path.join(skills, 'gstack-cso', 'empty'), { recursive: true });
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(path.join(skills, 'gstack-cso'))).toEqual(['empty']);
    expect(fs.readdirSync(ship).sort()).toEqual(['empty', 'notes.md', 'sections']);
    expect(fs.readdirSync(path.join(ship, 'sections'))).toEqual(['mine.md']);
    expect(fs.readFileSync(path.join(ship, 'notes.md'), 'utf8')).toBe('keep\n');
    expect(fs.readdirSync(path.join(cso, 'sections')).sort()).toEqual(['drafts', 'notes.md']);
    expect(fs.readlinkSync(path.join(cso, 'sections', 'notes.md'))).toBe(notes);
    expect(fs.readFileSync(path.join(cso, 'sections', 'drafts', 'd.md'), 'utf8')).toBe('draft\n');
  });

  test('a linked sections/ is unlinked or kept, never followed', () => {
    const mine = path.join(tmp, 'my-sections');
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(mine, 'x.md'), 'mine\n');
    fs.mkdirSync(path.join(skills, 'cso'));
    fs.symlinkSync(mine, path.join(skills, 'cso', 'sections'));
    fs.mkdirSync(path.join(skills, 'ship'));
    fs.symlinkSync(path.join(install, 'ship', 'sections'), path.join(skills, 'ship', 'sections'));
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readlinkSync(path.join(skills, 'cso', 'sections'))).toBe(mine);
    expect(fs.readFileSync(path.join(mine, 'x.md'), 'utf8')).toBe('mine\n');
    expect(gone(path.join(skills, 'ship'))).toBe(true);
    for (const f of SHIP_SECTIONS) expect(fs.existsSync(path.join(install, 'ship', 'sections', f))).toBe(true);
  });

  test('a customized SKILL.md is still backed up, and the sections/ beside it is cleaned', () => {
    const cso = oldEntry('cso', 'cso', CSO_SECTIONS, { skillMd: false, marker: true });
    const edited = `---\nname: cso\ndescription: test\n---\n${BANNER}MY LOCAL EDITS\n`;
    fs.writeFileSync(path.join(cso, 'SKILL.md'), edited);
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(gone(cso)).toBe(true);
    const root = path.join(tmp, 'state', 'backups', 'skills');
    const saved = fs.readdirSync(root).map(s => path.join(root, s, 'cso', 'SKILL.md')).filter(f => fs.existsSync(f));
    expect(saved.map(f => fs.readFileSync(f, 'utf8'))).toEqual([edited]);
  });

  test('Windows copy shape: copies identical to the source go, an edited copy stays', () => {
    const ship = path.join(skills, 'ship');
    fs.mkdirSync(path.join(ship, 'sections'), { recursive: true });
    fs.writeFileSync(path.join(ship, '.gstack-owned'), install + '\n');
    fs.copyFileSync(path.join(install, 'ship', 'SKILL.md'), path.join(ship, 'SKILL.md'));
    for (const f of SHIP_SECTIONS) fs.copyFileSync(path.join(install, 'ship', 'sections', f), path.join(ship, 'sections', f));
    fs.writeFileSync(path.join(ship, 'sections', 'review.md'), '# my edited review\n');
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(ship)).toEqual(['sections']);
    expect(fs.readdirSync(path.join(ship, 'sections'))).toEqual(['review.md']);
    expect(fs.readFileSync(path.join(ship, 'sections', 'review.md'), 'utf8')).toBe('# my edited review\n');
  });
});

// Value: protects=setup's own cleanup (_cleanup_weak_dir via _prune_stale_generated and _cleanup_linked_dir) removes a real sections/ of gstack links;
//   fails_when=setup strands a retired host entry's sections/ (1.103.x shape or already-upgraded shape) or deletes the user's files in it;
//   why_new=setup-prune-stale-generated and retired-skills cover entries without an asset subdirectory; seam=the setup helpers extracted and run on a temp tree
describe.skipIf(process.platform === 'win32')('setup: retired host entries leave no sections/ behind (GST-3999)', () => {
  const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
  const extractFn = (name: string) => {
    const start = SETUP_SRC.indexOf(`${name}() {`);
    const end = SETUP_SRC.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
    return SETUP_SRC.slice(start, end + 2);
  };
  const FNS = ['_gstack_link_target_abs', '_gstack_target_is_ours', '_gstack_generated_header', '_backup_skill_md', '_cleanup_weak_dir',
    '_gstack_dir_only_links', '_cleanup_linked_dir', '_owned_for_windows_refresh', '_skill_source_exists', '_prune_stale_generated'];
  let t: string;
  let src: string;
  let gen: string;
  let host: string;
  const run = (call: string) => spawnSync('bash', ['-c', [
    'set -e', 'HOME=/nonexistent-home', 'log() { echo "$@"; }', `. "${REGISTRY}"`, `GSTACK_STATE_ROOT="${t}/state"`, `_SKILL_BACKUP_ROOT="${t}/backup"`, '_BACKED_UP_SKILL_MDS=()',
    ...FNS.map(extractFn), call,
  ].join('\n')], { encoding: 'utf-8', timeout: 30_000 });
  // Kiro-style host entry: a bannered SKILL.md copy and sections/ as a real dir of links into a render that is gone.
  const hostEntry = (name: string, withSkillMd: boolean) => {
    const dir = path.join(host, name);
    fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
    if (withSkillMd) fs.writeFileSync(path.join(dir, 'SKILL.md'), `${BANNER}# ${name}\n`);
    for (const f of CSO_SECTIONS) fs.symlinkSync(path.join(gen, name, 'sections', f), path.join(dir, 'sections', f));
    return dir;
  };

  beforeEach(() => {
    t = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-stranded-'));
    src = path.join(t, 'gstack');
    gen = path.join(src, '.kiro', 'skills');
    host = path.join(t, 'host');
    fs.mkdirSync(path.join(src, 'qa'), { recursive: true });
    fs.writeFileSync(path.join(src, 'qa', 'SKILL.md.tmpl'), '---\nname: qa\n---\nx\n');
    fs.mkdirSync(gen, { recursive: true });
    fs.mkdirSync(host, { recursive: true });
  });
  afterEach(() => fs.rmSync(t, { recursive: true, force: true }));

  test('upgrading from 1.103.x: a retired gstack-cso copy and its sections/ of dangling links go whole', () => {
    hostEntry('gstack-cso', true);
    const r = run(`_prune_stale_generated "${src}" "${gen}" "${host}"`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('pruned retired skill: gstack-cso');
    expect(fs.readdirSync(host)).toEqual([]);
  });

  test('already on 1.104.0.0: a gstack-cso holding only sections/ is removed; one holding a user file keeps it', () => {
    hostEntry('gstack-cso', false);
    const kept = hostEntry('gstack-investigate', false);
    fs.writeFileSync(path.join(kept, 'sections', 'mine.md'), 'mine\n');
    fs.mkdirSync(path.join(host, 'gstack-verify', 'empty'), { recursive: true });
    const r = run(`_prune_stale_generated "${src}" "${gen}" "${host}"`);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(host).sort()).toEqual(['gstack-investigate', 'gstack-verify']);
    expect(fs.readdirSync(path.join(host, 'gstack-verify'))).toEqual(['empty']);
    expect(fs.readdirSync(path.join(kept, 'sections'))).toEqual(['mine.md']);
  });

  test('a prefix flip: an old linked Claude entry whose sections/ is a real dir of our links goes whole, a user file stays', () => {
    for (const name of ['review', 'qa']) {
      fs.mkdirSync(path.join(src, name, 'sections'), { recursive: true });
      fs.writeFileSync(path.join(src, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
      fs.writeFileSync(path.join(src, name, 'sections', 'a.md'), 'a\n');
      const dir = path.join(host, name);
      fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
      fs.symlinkSync(path.join(src, name, 'SKILL.md'), path.join(dir, 'SKILL.md'));
      fs.symlinkSync(path.join(src, name, 'sections', 'a.md'), path.join(dir, 'sections', 'a.md'));
    }
    fs.writeFileSync(path.join(host, 'qa', 'sections', 'mine.md'), 'mine\n');
    const r = run(`_cleanup_linked_dir "${host}/review" "${src}"; _cleanup_linked_dir "${host}/qa" "${src}"`);
    expect(r.status, r.stderr).toBe(0);
    expect(gone(path.join(host, 'review'))).toBe(true);
    expect(fs.readdirSync(path.join(host, 'qa'))).toEqual(['sections']);
    expect(fs.readdirSync(path.join(host, 'qa', 'sections'))).toEqual(['mine.md']);
    expect(fs.readFileSync(path.join(src, 'qa', 'sections', 'a.md'), 'utf8')).toBe('a\n');
  });
});
