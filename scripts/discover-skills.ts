/**
 * Shared discovery for SKILL.md and .tmpl files.
 * Scans root + one level of subdirs, skipping node_modules/.git/dist.
 */

import * as fs from 'fs';
import * as path from 'path';

const SKIP = new Set(['node_modules', '.git', 'dist']);

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
