/**
 * GST-1698: /plan-eng-review is cut. Its source stays as /autoplan's eng-phase
 * methodology, and no host registers it. setup and gstack-relink treat it as a
 * disabled skill that config cannot re-enable (GSTACK_RETIRED_SKILLS), so an
 * existing gstack-owned entry is removed on the next setup or upgrade and a
 * user's own same-name skill stays. External hosts carry the methodology beside
 * gstack-autoplan/SKILL.md as plan-eng-review.md (Codex and Copilot register
 * every nested SKILL.md).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RETIRED_SKILLS } from '../scripts/discover-skills';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const REGISTRY = path.join(ROOT, 'bin', 'gstack-install-registry.sh');
const BINS = ['gstack-config', 'gstack-relink', 'gstack-patch-names', 'gstack-skill-name.sh', 'gstack-state-root.sh', 'gstack-install-registry.sh'];
const PLAN_ENG = 'plan-eng-review'; // pregate-literal: GSTACK_RETIRED_SKILLS=plan-eng-review still retired; GST-1717 appended investigate to the list

test('setup and gstack-relink retire the same skills as the generator', () => {
  const r = spawnSync('bash', ['-c', '. "$1" && printf %s "$GSTACK_RETIRED_SKILLS"', '_', REGISTRY], { encoding: 'utf8', timeout: 10_000 });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.split(/\s+/).filter(Boolean)).toEqual(RETIRED_SKILLS);
  expect(RETIRED_SKILLS.join(' ')).toBe('plan-eng-review investigate');
});

describe('gstack-relink after an upgrade removed /investigate (GST-1717)', () => {
  let tmp: string;
  let install: string;
  let skills: string;
  const relink = () => spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
      GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '',
    },
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-retired-gone-'));
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    fs.mkdirSync(path.join(install, 'ship'));
    fs.writeFileSync(path.join(install, 'ship', 'SKILL.md'), '---\nname: ship\ndescription: test\n---\n# ship\n');
    fs.mkdirSync(skills, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('the dangling investigate and gstack-investigate entries are removed', () => {
    fs.mkdirSync(path.join(skills, 'investigate'));
    fs.symlinkSync(path.join(install, 'investigate', 'SKILL.md'), path.join(skills, 'investigate', 'SKILL.md'));
    fs.symlinkSync(path.join(install, 'investigate'), path.join(skills, 'gstack-investigate'));
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, 'investigate'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync(path.join(skills, 'gstack-investigate'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(path.join(skills, 'ship', 'SKILL.md'))).toBe(true);
  });

  test("a user's own investigate skill is left alone", () => {
    fs.mkdirSync(path.join(skills, 'investigate'));
    const own = '---\nname: investigate\ndescription: mine\n---\nmy own debugger\n';
    fs.writeFileSync(path.join(skills, 'investigate', 'SKILL.md'), own);
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'investigate', 'SKILL.md'), 'utf8')).toBe(own);
  });

  test('an edited gstack-generated investigate copy moves to the backup root instead of being deleted', () => {
    fs.mkdirSync(path.join(skills, 'investigate'));
    const edited = '---\nname: investigate\ndescription: test\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\nMY LOCAL EDITS\n';
    fs.writeFileSync(path.join(skills, 'investigate', 'SKILL.md'), edited);
    fs.writeFileSync(path.join(skills, 'investigate', 'notes.md'), 'mine\n');
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(skills, 'investigate', 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(skills, 'investigate', 'notes.md'), 'utf8')).toBe('mine\n');
    const root = path.join(tmp, 'state', 'backups', 'skills');
    const backups = fs.readdirSync(root).map(stamp => path.join(root, stamp, 'investigate', 'SKILL.md')).filter(f => fs.existsSync(f));
    expect(backups.map(f => fs.readFileSync(f, 'utf8'))).toEqual([edited]);
  });

  test("a marked gstack-investigate directory keeps the user's files and backs up its real SKILL.md", () => {
    fs.mkdirSync(path.join(skills, 'gstack-investigate'));
    fs.writeFileSync(path.join(skills, 'gstack-investigate', '.gstack-owned'), '');
    const edited = '---\nname: gstack-investigate\ndescription: test\n---\nMY LOCAL EDITS\n';
    fs.writeFileSync(path.join(skills, 'gstack-investigate', 'SKILL.md'), edited);
    fs.writeFileSync(path.join(skills, 'gstack-investigate', 'my-notes.md'), 'mine\n');
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(path.join(skills, 'gstack-investigate'))).toEqual(['my-notes.md']);
    const root = path.join(tmp, 'state', 'backups', 'skills');
    const backups = fs.readdirSync(root).map(stamp => path.join(root, stamp, 'gstack-investigate', 'SKILL.md')).filter(f => fs.existsSync(f));
    expect(backups.map(f => fs.readFileSync(f, 'utf8'))).toEqual([edited]);
  });
});

describe('gstack-relink on an install that still has /plan-eng-review', () => {
  let tmp: string;
  let install: string;
  let skills: string;
  const relink = () => spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
      GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '',
    },
  });
  const setRegistry = (retired: string) => {
    const src = fs.readFileSync(REGISTRY, 'utf8');
    fs.writeFileSync(path.join(install, 'bin', 'gstack-install-registry.sh'), src.replace(/^GSTACK_RETIRED_SKILLS=.*$/m, `GSTACK_RETIRED_SKILLS="${retired}"`));
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-retired-'));
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    for (const skill of [PLAN_ENG, 'ship']) {
      fs.mkdirSync(path.join(install, skill));
      fs.writeFileSync(path.join(install, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: test\n---\n# ${skill}\n`);
    }
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('an upgrade removes the old gstack-owned entry and keeps the methodology source', () => {
    setRegistry('');
    const before = relink();
    expect(before.status, before.stderr).toBe(0);
    expect(fs.existsSync(path.join(skills, PLAN_ENG, 'SKILL.md'))).toBe(true);

    setRegistry(PLAN_ENG);
    const after = relink();
    expect(after.status, after.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, PLAN_ENG), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(path.join(skills, 'ship', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(install, PLAN_ENG, 'SKILL.md'))).toBe(true);
    expect(after.stdout).not.toContain('Disabled (gstack-config disabled_skills');
  });

  test('a gstack-plan-eng-review entry from a prefixed install goes too', () => {
    fs.mkdirSync(path.join(skills, 'gstack-plan-eng-review'), { recursive: true });
    fs.symlinkSync(path.join(install, PLAN_ENG, 'SKILL.md'), path.join(skills, 'gstack-plan-eng-review', 'SKILL.md'));
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, 'gstack-plan-eng-review'), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("a user's own plan-eng-review skill is left alone", () => {
    fs.mkdirSync(path.join(skills, PLAN_ENG), { recursive: true });
    const own = '---\nname: plan-eng-review\ndescription: mine\n---\nmy own review\n';
    fs.writeFileSync(path.join(skills, PLAN_ENG, 'SKILL.md'), own);
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, PLAN_ENG, 'SKILL.md'), 'utf8')).toBe(own);
  });
});

describe('setup prunes external-host entries for a retired skill whose source still exists', () => {
  const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
  const extractFn = (name: string) => {
    const start = SETUP_SRC.indexOf(`${name}() {`);
    const end = SETUP_SRC.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
    return SETUP_SRC.slice(start, end + 2);
  };

  test('the old gstack-plan-eng-review render and its host link are removed, live skills stay', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-prune-'));
    try {
      const src = path.join(t, 'src'), gen = path.join(t, 'gen'), host = path.join(t, 'host');
      for (const s of [PLAN_ENG, 'autoplan']) {
        fs.mkdirSync(path.join(src, s), { recursive: true });
        fs.writeFileSync(path.join(src, s, 'SKILL.md.tmpl'), `---\nname: ${s}\n---\nx\n`);
      }
      for (const g of ['gstack-plan-eng-review', 'gstack-autoplan']) {
        fs.mkdirSync(path.join(gen, g), { recursive: true });
        fs.writeFileSync(path.join(gen, g, 'SKILL.md'), `<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n# ${g}\n`);
      }
      fs.mkdirSync(host);
      for (const g of ['gstack-plan-eng-review', 'gstack-autoplan']) fs.symlinkSync(path.join(gen, g) + '/', path.join(host, g));
      const script = [
        'set -e', 'log() { echo "$@"; }', `. "${REGISTRY}"`,
        ...['_gstack_link_target_abs', '_gstack_target_is_ours', '_gstack_generated_header', '_backup_skill_md', '_cleanup_weak_dir',
          '_owned_for_windows_refresh', '_skill_source_exists', '_prune_stale_generated'].map(extractFn),
        `_prune_stale_generated "${src}" "${gen}" "${host}"`,
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('pruned retired skill: gstack-plan-eng-review');
      expect(fs.readdirSync(gen)).toEqual(['gstack-autoplan']);
      expect(fs.readdirSync(host)).toEqual(['gstack-autoplan']);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('a copied gstack-investigate whose source is gone: an edited SKILL.md is backed up, a pristine copy goes (GST-1717)', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-prune-gone-'));
    try {
      const src = path.join(t, 'src'), gen = path.join(t, 'gen'), edited = path.join(t, 'edited'), pristine = path.join(t, 'pristine'), backup = path.join(t, 'backup');
      fs.mkdirSync(path.join(src, 'autoplan'), { recursive: true });
      fs.writeFileSync(path.join(src, 'autoplan', 'SKILL.md.tmpl'), '---\nname: autoplan\n---\nx\n');
      const ours = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n# gstack-investigate\n';
      fs.mkdirSync(path.join(gen, 'gstack-investigate'), { recursive: true });
      fs.writeFileSync(path.join(gen, 'gstack-investigate', 'SKILL.md'), ours);
      for (const host of [edited, pristine]) fs.mkdirSync(path.join(host, 'gstack-investigate'), { recursive: true });
      fs.writeFileSync(path.join(edited, 'gstack-investigate', 'SKILL.md'), ours + 'MY LOCAL EDITS\n');
      fs.writeFileSync(path.join(edited, 'gstack-investigate', 'notes.md'), 'mine\n');
      fs.writeFileSync(path.join(pristine, 'gstack-investigate', 'SKILL.md'), ours);
      const script = [
        'set -e', 'HOME=/nonexistent-home', 'log() { echo "$@"; }', `. "${REGISTRY}"`, `_SKILL_BACKUP_ROOT="${backup}"`, '_BACKED_UP_SKILL_MDS=()',
        ...['_gstack_link_target_abs', '_gstack_target_is_ours', '_gstack_generated_header', '_backup_skill_md', '_cleanup_weak_dir',
          '_owned_for_windows_refresh', '_skill_source_exists', '_prune_stale_generated'].map(extractFn),
        `_prune_stale_generated "${src}" "${gen}" "${edited}" "${pristine}"`,
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('pruned retired skill: gstack-investigate');
      expect(fs.readdirSync(gen)).toEqual([]);
      expect(fs.readdirSync(path.join(edited, 'gstack-investigate'))).toEqual(['notes.md']);
      expect(fs.readFileSync(path.join(backup, edited.slice(1).split(path.sep).join('_'), 'gstack-investigate', 'SKILL.md'), 'utf8')).toBe(ours + 'MY LOCAL EDITS\n');
      expect(fs.readdirSync(pristine)).toEqual([]);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('two copy hosts whose render is already gone each keep their own backup (GST-1717)', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-prune-hosts-'));
    try {
      const src = path.join(t, 'src'), gen = path.join(t, 'gen'), backup = path.join(t, 'backup');
      const hosts = [path.join(t, 'codex', 'skills'), path.join(t, 'factory', 'skills')];
      fs.mkdirSync(path.join(src, 'autoplan'), { recursive: true });
      fs.writeFileSync(path.join(src, 'autoplan', 'SKILL.md.tmpl'), '---\nname: autoplan\n---\nx\n');
      fs.mkdirSync(gen, { recursive: true });
      const ours = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n# gstack-investigate\n';
      const copies = [ours + 'MY CODEX EDITS\n', ours];
      hosts.forEach((host, i) => {
        fs.mkdirSync(path.join(host, 'gstack-investigate'), { recursive: true });
        fs.writeFileSync(path.join(host, 'gstack-investigate', 'SKILL.md'), copies[i]!);
      });
      const script = [
        'set -e', 'HOME=/nonexistent-home', 'log() { echo "$@"; }', `. "${REGISTRY}"`, `_SKILL_BACKUP_ROOT="${backup}"`, '_BACKED_UP_SKILL_MDS=()',
        ...['_gstack_link_target_abs', '_gstack_target_is_ours', '_gstack_generated_header', '_backup_skill_md', '_cleanup_weak_dir',
          '_owned_for_windows_refresh', '_skill_source_exists', '_prune_stale_generated'].map(extractFn),
        ...hosts.map(host => `_prune_stale_generated "${src}" "${gen}" "${host}"`),
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      for (const host of hosts) expect(fs.readdirSync(host)).toEqual([]);
      const saved = hosts.map(host => fs.readFileSync(path.join(backup, host.slice(1).split(path.sep).join('_'), 'gstack-investigate', 'SKILL.md'), 'utf8'));
      expect(saved).toEqual(copies);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });
});

test('no host renders a plan-eng-review skill; external hosts get the methodology beside gstack-autoplan', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-gen-'));
  try {
    const result = await runGeneration({ host: 'all', outputRoot: out });
    expect(result.diagnostics.filter(d => d.kind === 'error'), JSON.stringify(result.diagnostics.filter(d => d.kind === 'error'))).toEqual([]);
    const paths = result.artifacts.map(a => a.relativePath);
    expect(paths.filter(p => /gstack-plan-eng-review\//.test(p))).toEqual([]);
    expect(paths).toContain('plan-eng-review/SKILL.md');
    const external = result.artifacts.filter(a => a.host && a.host !== 'claude' && a.kind === 'skill');
    const hosts = new Set(external.map(a => a.host));
    for (const host of hosts) {
      const copy = external.find(a => a.host === host && a.relativePath.endsWith('/skills/gstack-autoplan/plan-eng-review.md'));
      expect(copy, host).toBeDefined();
      expect(fs.readFileSync(path.join(out, copy!.relativePath), 'utf8')).toMatch(/^---\nname: (gstack-)?plan-eng-review\n/);
    }
    const router = fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8');
    expect(router).not.toContain('/plan-eng-review');
    expect(fs.readFileSync(path.join(out, 'gstack', 'llms.txt'), 'utf8')).not.toContain(PLAN_ENG);
    expect(paths.filter(p => /(^|\/)(gstack-)?investigate\//.test(p))).toEqual([]);
    expect(router).not.toContain('/investigate');
    expect(fs.readFileSync(path.join(out, 'gstack', 'llms.txt'), 'utf8')).not.toContain('/investigate');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}, 300_000);
