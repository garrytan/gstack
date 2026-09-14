/**
 * Shared skill census — the ONE place that counts skills (C11).
 *
 * Three consumers (hermetic seeding, context-bill ground truth, catalog-budget
 * test) each need a DIFFERENT count of "the skills", and hand-rolled walks
 * encode the wrong one somewhere. The counts diverge because of two facts:
 *
 *   1. `connect-chrome/` is a directory SYMLINK to `open-gstack-browser/`.
 *      `Dirent.isDirectory()` is false for it (scripts/discover-skills.ts
 *      skips it) while setup's trailing-slash shell glob follows it.
 *   2. The root `SKILL.md` is a router, registered by `setup` under the
 *      alias name `_gstack-command`, not as an authored skill.
 *
 * So: use `physicalSkillFiles` when you mean "every SKILL.md a filesystem
 * walk can reach" (context-bill's walker), `authoredSkills` when you mean
 * "distinct skills a human maintains" (catalog budget), and
 * `registryEntries` when you mean "what a host discovers after ./setup"
 * (hermetic seeding must mirror this exactly).
 */

import * as fs from 'fs';
import * as path from 'path';

const SKIP = new Set(['node_modules', '.git', 'dist']);

export interface SkillCensus {
  /** Every reachable `<dir>/SKILL.md` (symlinked dirs INCLUDED) plus the
   * root `SKILL.md` router. Relative paths from root. */
  physicalSkillFiles: string[];
  /** Distinct authored skills: symlink-deduped by realpath, root router
   * EXCLUDED. Each entry is the canonical directory name. */
  authoredSkills: string[];
  /** What `setup` registers into `~/.claude/skills/` with prefixing off:
   * one entry per unique frontmatter `name:` (falling back to dir name),
   * plus the `_gstack-command` root alias when the root router exists.
   * Symlinked dirs collapse here because they share a frontmatter name. */
  registryEntries: string[];
}

/** First `name:` from SKILL.md frontmatter, mirroring `setup`'s
 * `grep -m1 '^name:'` (whitespace stripped). Empty string if absent. */
export function frontmatterName(skillMdPath: string): string {
  let body: string;
  try {
    body = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    return '';
  }
  const m = body.match(/^name:\s*(.+)$/m);
  return m ? m[1].replace(/\s+/g, '') : '';
}

export function skillCensus(root: string): SkillCensus {
  const physicalSkillFiles: string[] = [];
  const authoredByRealpath = new Map<string, string>();
  const registrySet = new Set<string>();

  if (fs.existsSync(path.join(root, 'SKILL.md'))) {
    physicalSkillFiles.push('SKILL.md');
    registrySet.add('_gstack-command');
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const dirPath = path.join(root, entry.name);
    // Follow directory symlinks like setup's shell glob does; Dirent alone
    // reports symlinks as non-directories.
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(dirPath).isDirectory();
      } catch {
        continue; // dangling symlink
      }
    }
    if (!isDir) continue;

    const skillMd = path.join(dirPath, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    physicalSkillFiles.push(`${entry.name}/SKILL.md`);

    const real = fs.realpathSync(dirPath);
    if (!authoredByRealpath.has(real)) {
      authoredByRealpath.set(real, path.basename(real));
    }

    registrySet.add(frontmatterName(skillMd) || entry.name);
  }

  return {
    physicalSkillFiles: physicalSkillFiles.sort(),
    authoredSkills: [...authoredByRealpath.values()].sort(),
    registryEntries: [...registrySet].sort(),
  };
}
