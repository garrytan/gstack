/**
 * Shared discovery for SKILL.md and .tmpl files.
 * Scans root + one level of subdirs, skipping node_modules/.git/dist.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostConfig } from './host-config';

const SKIP = new Set(['node_modules', '.git', 'dist']);

/**
 * Retired skills: no host registers them, and setup removes an earlier
 * install's gstack-owned entry. plan-eng-review's source stays as /autoplan's
 * eng-phase methodology (GST-1698); external hosts get it beside
 * gstack-autoplan/SKILL.md as <name>.md, since Codex and Copilot register every
 * nested SKILL.md. investigate was cut after a no-gain eval and its source is
 * gone (GST-1717). setup and gstack-relink read the same list from
 * GSTACK_RETIRED_SKILLS in bin/gstack-install-registry.sh.
 */
export const RETIRED_SKILLS = ['plan-eng-review', 'investigate'];

/**
 * The gstack-on-Capy skills (crew/README.md): registered only on a Capy
 * machine, and kept off every host elsewhere like a retired skill. Same list
 * as GSTACK_CREW_SKILLS in bin/gstack-install-registry.sh, and the same Capy
 * test as its gstack_on_capy.
 */
export const CREW_SKILLS = ['captain'];

export function onCapyMachine(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  return Boolean(env.CAPY_MACHINE_CONFIG) || fs.existsSync(path.join(home, '.capy'));
}

/** What no host registers on this machine: the retired skills, plus the crew skills off Capy. */
export function unregisteredSkills(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  return onCapyMachine(env, home) ? RETIRED_SKILLS : [...RETIRED_SKILLS, ...CREW_SKILLS];
}

/** The generator and its coverage checks use the same include-minus-skip rule. */
export function includesSkill(host: HostConfig, skillDir: string): boolean {
  const { includeSkills, skipSkills } = host.generation;
  return (!includeSkills?.length || includeSkills.includes(skillDir))
    && !skipSkills?.includes(skillDir);
}

function subdirs(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
    .map(d => d.name);
}

export function discoverTemplates(root: string): Array<{ tmpl: string; output: string }> {
  const dirs = ['', ...subdirs(root)];
  const results: Array<{ tmpl: string; output: string }> = [];
  for (const dir of dirs) {
    const rel = dir ? `${dir}/SKILL.md.tmpl` : 'SKILL.md.tmpl';
    if (fs.existsSync(path.join(root, rel))) {
      results.push({ tmpl: rel, output: rel.replace(/\.tmpl$/, '') });
    }
  }
  return results;
}

/**
 * Discover on-demand section templates: `<skill>/sections/*.md.tmpl`.
 *
 * Returns the relative tmpl path, its generated output path (`.tmpl` stripped),
 * and the owning skill directory so the generator can build a TemplateContext
 * with the PARENT skill's name (not "sections") — see processSectionTemplate.
 *
 * Scans one level of subdirs (same depth as discoverTemplates), looking only
 * inside a `sections/` child. Skills without a sections/ dir contribute nothing,
 * so this is a no-op for every skill that hasn't been carved.
 */
export function discoverSectionTemplates(
  root: string,
): Array<{ tmpl: string; output: string; skillDir: string }> {
  const results: Array<{ tmpl: string; output: string; skillDir: string }> = [];
  for (const dir of subdirs(root)) {
    const sectionsDir = path.join(root, dir, 'sections');
    if (!fs.existsSync(sectionsDir) || !fs.statSync(sectionsDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(sectionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md.tmpl')) continue;
      const rel = `${dir}/sections/${entry.name}`;
      results.push({ tmpl: rel, output: rel.replace(/\.tmpl$/, ''), skillDir: dir });
    }
  }
  // Deterministic order so CI freshness checks don't flap on FS iteration order.
  return results.sort((a, b) => a.tmpl.localeCompare(b.tmpl));
}

export function discoverSkillFiles(root: string): string[] {
  const dirs = ['', ...subdirs(root)];
  const results: string[] = [];
  for (const dir of dirs) {
    const rel = dir ? `${dir}/SKILL.md` : 'SKILL.md';
    if (fs.existsSync(path.join(root, rel))) {
      results.push(rel);
    }
  }
  return results;
}
