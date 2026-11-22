/**
 * Retired skills: no host registers them, and setup and gstack-relink treat
 * each as a disabled skill that config cannot re-enable (GSTACK_RETIRED_SKILLS),
 * so an existing gstack-owned entry is removed on the next setup or upgrade and
 * a user's own same-name skill stays. /investigate is retired (GST-1717).
 * /plan-eng-review was retired in GST-1698 and came back in GST-2726: every host
 * registers it again, and external hosts still carry its methodology beside
 * gstack-autoplan/SKILL.md as plan-eng-review.md for /autoplan's eng phase.
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
const BINS = ['gstack-config', 'gstack-lock.sh', 'gstack-relink', 'gstack-patch-names', 'gstack-skill-name.sh', 'gstack-state-root.sh', 'gstack-install-registry.sh'];
const PLAN_ENG = 'plan-eng-review'; // pregate-literal: GST-2726 took plan-eng-review off GSTACK_RETIRED_SKILLS; investigate stays retired

test('setup and gstack-relink retire the same skills as the generator', () => {
  const r = spawnSync('bash', ['-c', '. "$1" && printf %s "$GSTACK_RETIRED_SKILLS"', '_', REGISTRY], { encoding: 'utf8', timeout: 10_000 });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.split(/\s+/).filter(Boolean)).toEqual(RETIRED_SKILLS);
  expect(RETIRED_SKILLS.join(' ')).toBe('investigate verify');
});

describe('gstack-relink after an upgrade removed /investigate (GST-1717)', () => {
  let tmp: string;
  let install: string;
  let skills: string;
  const relink = (extra: NodeJS.ProcessEnv = {}) => spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
      GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '', ...extra,
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

  test('two relinks in the same second keep both backups (#4593)', () => {
    const shim = path.join(tmp, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'date'), '#!/bin/sh\necho 20261122T120000\n');
    fs.chmodSync(path.join(shim, 'date'), 0o755);
    const sameSecond = { PATH: `${shim}${path.delimiter}${process.env.PATH}` };
    const edits = ['FIRST EDIT', 'SECOND EDIT'].map(e => `---\nname: investigate\ndescription: test\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n${e}\n`);
    for (const edited of edits) {
      fs.mkdirSync(path.join(skills, 'investigate'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'investigate', 'SKILL.md'), edited);
      const r = relink(sameSecond);
      expect(r.status, r.stderr).toBe(0);
    }
    const root = path.join(tmp, 'state', 'backups', 'skills');
    const backups = fs.readdirSync(root).map(stamp => path.join(root, stamp, 'investigate', 'SKILL.md')).filter(f => fs.existsSync(f));
    expect(backups.map(f => fs.readFileSync(f, 'utf8')).sort()).toEqual([...edits].sort());
  });

  test('a disabled_skills entry of verify still turns off build-check (#4593)', () => {
    fs.mkdirSync(path.join(install, 'build-check'));
    fs.writeFileSync(path.join(install, 'build-check', 'SKILL.md'), '---\nname: build-check\ndescription: test\n---\n# build-check\n');
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'config.yaml'), 'disabled_skills: verify\n');
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(skills, 'build-check', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(skills, 'ship', 'SKILL.md'))).toBe(true);
  });

  test('gstack-config set disabled_skills verify stores build-check (#4593)', () => {
    fs.mkdirSync(path.join(install, 'build-check'));
    fs.writeFileSync(path.join(install, 'build-check', 'SKILL.md'), '---\nname: build-check\ndescription: test\n---\n# build-check\n');
    const r = spawnSync('bash', [path.join(install, 'bin', 'gstack-config'), 'set', 'disabled_skills', 'verify,ship'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '', GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '1' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'state', 'config.yaml'), 'utf8')).toMatch(/^disabled_skills: build-check,ship$/m);
  });

  test('the retired verify name is not mapped: build-check stays on when nothing disables it', () => {
    fs.mkdirSync(path.join(install, 'build-check'));
    fs.writeFileSync(path.join(install, 'build-check', 'SKILL.md'), '---\nname: build-check\ndescription: test\n---\n# build-check\n');
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(skills, 'build-check', 'SKILL.md'))).toBe(true);
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

describe('gstack-relink after /plan-eng-review returned (GST-2726)', () => {
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

  test('an install whose upgrade removed the entry gets /plan-eng-review back on the next relink', () => {
    setRegistry(`${PLAN_ENG} investigate`);
    const cut = relink();
    expect(cut.status, cut.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, PLAN_ENG), { throwIfNoEntry: false })).toBeUndefined();

    fs.copyFileSync(REGISTRY, path.join(install, 'bin', 'gstack-install-registry.sh'));
    const back = relink();
    expect(back.status, back.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, PLAN_ENG, 'SKILL.md'), 'utf8')).toContain(`# ${PLAN_ENG}`);
    expect(fs.existsSync(path.join(skills, 'ship', 'SKILL.md'))).toBe(true);
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

  const pruneScript = (src: string, gen: string, host: string, retired?: string) => [
    'set -e', 'log() { echo "$@"; }', `. "${REGISTRY}"`, ...(retired ? [`GSTACK_RETIRED_SKILLS="${retired}"`] : []),
    ...['_gstack_link_target_abs', '_gstack_target_is_ours', '_gstack_generated_header', '_backup_skill_md', '_cleanup_weak_dir',
      '_owned_for_windows_refresh', '_skill_source_exists', '_prune_stale_generated'].map(extractFn),
    `_prune_stale_generated "${src}" "${gen}" "${host}"`,
  ].join('\n');
  const pruneFixture = (t: string, live: string[]) => {
    const src = path.join(t, 'src'), gen = path.join(t, 'gen'), host = path.join(t, 'host');
    for (const s of live) {
      fs.mkdirSync(path.join(src, s), { recursive: true });
      fs.writeFileSync(path.join(src, s, 'SKILL.md.tmpl'), `---\nname: ${s}\n---\nx\n`);
    }
    fs.mkdirSync(host);
    for (const s of live) {
      const g = `gstack-${s}`;
      fs.mkdirSync(path.join(gen, g), { recursive: true });
      fs.writeFileSync(path.join(gen, g, 'SKILL.md'), `<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n# ${g}\n`);
      fs.symlinkSync(path.join(gen, g) + '/', path.join(host, g));
    }
    return { src, gen, host };
  };

  test('a retired skill whose source still exists loses its render and host link, live skills stay', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-prune-'));
    try {
      const { src, gen, host } = pruneFixture(t, ['old-review', 'autoplan']);
      const r = spawnSync('bash', ['-c', pruneScript(src, gen, host, 'old-review investigate')], { encoding: 'utf-8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('pruned retired skill: gstack-old-review');
      expect(fs.readdirSync(gen)).toEqual(['gstack-autoplan']);
      expect(fs.readdirSync(host)).toEqual(['gstack-autoplan']);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('the gstack-plan-eng-review render and its host link stay now that the skill is back (GST-2726)', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-prune-back-'));
    try {
      const { src, gen, host } = pruneFixture(t, [PLAN_ENG, 'autoplan']);
      const r = spawnSync('bash', ['-c', pruneScript(src, gen, host)], { encoding: 'utf-8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain('pruned retired skill');
      expect(fs.readdirSync(gen).sort()).toEqual(['gstack-autoplan', 'gstack-plan-eng-review']);
      expect(fs.readdirSync(host).sort()).toEqual(['gstack-autoplan', 'gstack-plan-eng-review']);
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

test('every host renders /plan-eng-review; external hosts also keep the same methodology beside gstack-autoplan', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-gen-'));
  try {
    const result = await runGeneration({ host: 'all', outputRoot: out });
    expect(result.diagnostics.filter(d => d.kind === 'error'), JSON.stringify(result.diagnostics.filter(d => d.kind === 'error'))).toEqual([]);
    const paths = result.artifacts.map(a => a.relativePath);
    expect(paths).toContain('plan-eng-review/SKILL.md');
    const external = result.artifacts.filter(a => a.host && a.host !== 'claude' && a.kind === 'skill');
    const hosts = new Set(external.map(a => a.host));
    expect(hosts.size).toBeGreaterThan(5);
    for (const host of hosts) {
      const standalone = external.find(a => a.host === host && a.relativePath.endsWith('/skills/gstack-plan-eng-review/SKILL.md'));
      const sibling = external.find(a => a.host === host && a.relativePath.endsWith('/skills/gstack-autoplan/plan-eng-review.md'));
      expect(standalone, host).toBeDefined();
      expect(sibling, host).toBeDefined();
      const body = fs.readFileSync(path.join(out, standalone!.relativePath), 'utf8');
      expect(body).toMatch(/^---\nname: (gstack-)?plan-eng-review\n/);
      expect(fs.readFileSync(path.join(out, sibling!.relativePath), 'utf8')).toBe(body);
    }
    const router = fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8');
    expect(router).toContain('→ invoke `/plan-eng-review`');
    expect(fs.readFileSync(path.join(out, 'gstack', 'llms.txt'), 'utf8')).toContain('[/plan-eng-review](plan-eng-review/SKILL.md)');
    expect(paths.filter(p => /(^|\/)(gstack-)?investigate\//.test(p))).toEqual([]);
    expect(router).not.toContain('/investigate');
    expect(fs.readFileSync(path.join(out, 'gstack', 'llms.txt'), 'utf8')).not.toContain('/investigate');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}, 300_000);

// Value: protects=an upgrade gives Claude Code its built-in /verify back by removing gstack's old verify entry, and only gstack's;
//   fails_when=relink leaves the renamed skill's verify or gstack-verify link behind, or deletes a user's own verify skill;
//   why_new=/verify became /build-check (#4593); seam=the real gstack-relink on a fixture install; no_claim=Claude Code's own lookup
describe('gstack-relink after /verify became /build-check (#4593)', () => {
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-verify-renamed-'));
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    fs.mkdirSync(path.join(install, 'build-check'));
    fs.writeFileSync(path.join(install, 'build-check', 'SKILL.md'), '---\nname: build-check\ndescription: test\n---\n# build-check\n');
    fs.mkdirSync(skills, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("gstack's old verify and gstack-verify entries are removed and /build-check is linked", () => {
    fs.mkdirSync(path.join(skills, 'verify'));
    fs.symlinkSync(path.join(install, 'verify', 'SKILL.md'), path.join(skills, 'verify', 'SKILL.md'));
    fs.writeFileSync(path.join(skills, 'verify', '.gstack-owned'), install + '\n');
    fs.symlinkSync(path.join(install, 'verify'), path.join(skills, 'gstack-verify'));
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, 'verify'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync(path.join(skills, 'gstack-verify'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(path.join(skills, 'build-check', 'SKILL.md'), 'utf8')).toContain('name: build-check');
  });

  test("a user's own verify skill is left alone", () => {
    fs.mkdirSync(path.join(skills, 'verify'));
    const own = '---\nname: verify\ndescription: mine\n---\nmy own end-to-end check\n';
    fs.writeFileSync(path.join(skills, 'verify', 'SKILL.md'), own);
    fs.writeFileSync(path.join(skills, 'verify', 'notes.md'), 'mine\n');
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'verify', 'SKILL.md'), 'utf8')).toBe(own);
    expect(fs.readFileSync(path.join(skills, 'verify', 'notes.md'), 'utf8')).toBe('mine\n');
  });
  test("a marked verify entry keeps the user's own files even when an old render of verify is still cached", () => {
    const render = path.join(tmp, 'state', 'render', 'claude', 'verify');
    fs.mkdirSync(render, { recursive: true });
    fs.writeFileSync(path.join(render, 'SKILL.md'), '---\nname: verify\ndescription: old render\n---\n');
    fs.mkdirSync(path.join(skills, 'verify'));
    fs.symlinkSync(path.join(render, 'SKILL.md'), path.join(skills, 'verify', 'SKILL.md'));
    fs.writeFileSync(path.join(skills, 'verify', '.gstack-owned'), install + '\n');
    fs.writeFileSync(path.join(skills, 'verify', 'runbook.md'), 'mine\n');
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(path.join(skills, 'verify'))).toEqual(['runbook.md']);
  });
});
