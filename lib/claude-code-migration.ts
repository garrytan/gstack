/** One rename, shared by setup and the v1.82 upgrade migration. No model calls. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const OLD = 'gstack-claude';
const NEXT = 'gstack-claude-code';
const BANNER = '<!-- AUTO-GENERATED from';
const RUNTIME_FILES = ['bin/gstack-claude-code', 'lib/claude-code.ts', 'lib/claude-code-windows-job.ts', 'lib/claude-bin.ts', 'lib/outside-review-result.ts'];

export interface RenameOptions {
  installDir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  copy?: boolean;
  /** The source checkout can itself live inside a repo-local skills directory. */
  skillsDir?: string;
  log?: (line: string) => void;
  /** Tests render fixtures here; production invokes only gen-skill-docs. */
  render?: (host: string, output: string) => void;
}

function exists(file: string): boolean { return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined; }
function generated(file: string): boolean {
  try {
    const header = fs.readFileSync(file, 'utf8').slice(0, 8192);
    return header.includes(BANNER) && header.includes('<!-- Regenerate: bun run gen:skill-docs -->');
  } catch { return false; }
}
function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function linkIsOurs(file: string, root: string): boolean {
  try {
    const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
    // Resolve every existing component before accepting ownership: a path
    // lexically inside the checkout can still escape through a directory link.
    // Missing suffixes cover dangling links after standalone generation prunes.
    let existing = target;
    const missing: string[] = [];
    while (!exists(existing)) {
      missing.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    return inside(path.join(fs.realpathSync(existing), ...missing), root);
  } catch { return false; }
}
function owned(entry: string, root: string): boolean {
  const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink()) return linkIsOurs(entry, root);
  if (!stat.isDirectory()) return false;
  if (fs.lstatSync(path.join(entry, 'SKILL.md'), { throwIfNoEntry: false })?.isSymbolicLink()) {
    return linkIsOurs(path.join(entry, 'SKILL.md'), root);
  }
  return generated(path.join(entry, 'SKILL.md')) || fs.existsSync(path.join(entry, '.gstack-owned'));
}
function atomicCopy(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.rename-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.copyFileSync(source, tmp);
    fs.chmodSync(tmp, fs.statSync(source).mode);
    fs.renameSync(tmp, target);
  } finally { fs.rmSync(tmp, { force: true }); }
}
function preserveCopy(file: string): void {
  let backup = `${file}.before-claude-code`;
  for (let n = 1; exists(backup); n++) backup = `${file}.before-claude-code.${n}`;
  fs.renameSync(file, backup);
}
function copySkill(source: string, target: string, root: string, preserve = false): void {
  fs.mkdirSync(target, { recursive: true });
  const files = ['SKILL.md', 'agents/openai.yaml'];
  if (fs.existsSync(path.join(source, 'sections'))) {
    for (const name of fs.readdirSync(path.join(source, 'sections'))) {
      if (fs.statSync(path.join(source, 'sections', name)).isFile()) files.push(`sections/${name}`);
    }
  }
  for (const rel of files) {
    const src = path.join(source, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(target, rel);
    // Never traverse a user-owned metadata directory link.
    const parent = path.dirname(dest);
    if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
      if (!linkIsOurs(parent, root)) throw new Error(`foreign metadata directory: ${parent}`);
      if (preserve) {
        // A copied host can carry legacy section links into another host's
        // render. Replace our link before writing, never mutate that source.
        fs.unlinkSync(parent);
        fs.mkdirSync(parent, { recursive: true });
      }
    }
    if (preserve && fs.lstatSync(dest, { throwIfNoEntry: false })?.isFile() && !fs.readFileSync(src).equals(fs.readFileSync(dest))) {
      preserveCopy(dest);
    }
    atomicCopy(src, dest);
  }
}
function retire(entry: string, root: string, oldSources: string[]): void {
  if (!owned(entry, root)) return;
  if (fs.lstatSync(entry).isSymbolicLink()) { fs.unlinkSync(entry); return; }
  // Weak ownership proves the skill file, never the user's adjacent notes/assets.
  // A customized copy (or one whose old render is already gone) is saved beside
  // the old skill, without a SKILL.md that could keep the retired command alive.
  const file = path.join(entry, 'SKILL.md');
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() && !oldSources.some(source => {
    try { return fs.readFileSync(source).equals(fs.readFileSync(file)); } catch { return false; }
  })) {
    preserveCopy(file);
  } else {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(path.join(entry, '.gstack-owned'), { force: true });
  for (const name of fs.readdirSync(entry)) {
    const file = path.join(entry, name);
    if (fs.lstatSync(file).isSymbolicLink() && linkIsOurs(file, root)) fs.unlinkSync(file);
  }
  try { fs.rmdirSync(entry); } catch { /* user files and metadata stay */ }
}

export function migrateClaudeCodeSkills(opts: RenameOptions): { migrated: number; pending: string[] } {
  const root = fs.realpathSync(opts.installDir);
  const env = { ...process.env, ...opts.env };
  const home = opts.home ?? env.HOME ?? os.homedir();
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const targets = [
    { host: 'codex', subdir: '.agents', dir: path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'skills') },
    { host: 'kiro', subdir: '.kiro', dir: path.join(home, '.kiro', 'skills') },
    { host: 'factory', subdir: '.factory', dir: path.join(home, '.factory', 'skills') },
    { host: 'opencode', subdir: '.opencode', dir: path.join(home, '.config', 'opencode', 'skills') },
    { host: 'cursor', subdir: '.cursor', dir: path.join(home, '.cursor', 'skills') },
  ];
  if (opts.skillsDir) {
    const local = targets.find(t => t.subdir === path.basename(path.dirname(opts.skillsDir!)));
    if (local && !targets.some(t => path.resolve(t.dir) === path.resolve(opts.skillsDir!))) {
      targets.push({ ...local, dir: path.resolve(opts.skillsDir) });
    }
  }
  // Capture before generation: a build can otherwise erase a symlink's source.
  const candidates = targets.filter(t => owned(path.join(t.dir, OLD), root));
  const oldSources = targets.map(t => path.join(root, t.subdir, 'skills', OLD, 'SKILL.md'));
  const result = { migrated: 0, pending: [] as string[] };
  const render = opts.render ?? ((host: string, output: string) => {
    const args = ['run', 'scripts/gen-skill-docs.ts', '--host', host, '--out-dir', output];
    if (host === 'codex') {
      let model = env.GSTACK_CODEX_GENERATION_MODEL;
      if (!model) {
        const probe = spawnSync(process.execPath, ['run', 'scripts/resolve-codex-generation-model.ts'], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
        if (probe.status !== 0) throw new Error('could not resolve the Codex model profile');
        model = probe.stdout.trim().split('\t')[0];
      }
      if (model) args.push('--model', model);
    }
    const rendered = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
    if (rendered.status !== 0) throw new Error(`replacement generation failed for ${host}: ${rendered.stderr.trim().slice(-500)}`);
  });
  for (const target of candidates) {
    const old = path.join(target.dir, OLD);
    const next = path.join(target.dir, NEXT);
    let temporary: string | undefined;
    try {
      if (exists(next) && !owned(next, root)) throw new Error(`replacement is a foreign skill: ${next}`);
      const runtime = path.join(target.dir, 'gstack');
      if (exists(runtime) && (
        (fs.lstatSync(runtime).isSymbolicLink() && !linkIsOurs(runtime, root)) ||
        (fs.existsSync(path.join(runtime, 'SKILL.md')) && !generated(path.join(runtime, 'SKILL.md')))
      )) throw new Error(`runtime root is not gstack-managed: ${runtime}`);
      for (const rel of RUNTIME_FILES) {
        if (!fs.existsSync(path.join(root, rel))) throw new Error(`replacement runtime is missing ${rel}`);
        const parent = path.join(runtime, path.dirname(rel));
        if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink() && !linkIsOurs(parent, root)) {
          throw new Error(`runtime asset directory is foreign: ${parent}`);
        }
      }
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-claude-rename-'));
      render(target.host, temporary);
      const skill = path.join(temporary, target.subdir, 'skills', NEXT);
      const content = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
      if (!generated(path.join(skill, 'SKILL.md')) || !/^name:\s*(?:gstack-)?claude-code\s*$/m.test(content)) {
        throw new Error('replacement render has an unexpected skill name or no generated banner');
      }
      const canonical = path.join(root, target.subdir, 'skills', NEXT);
      if (exists(canonical) && (fs.lstatSync(canonical).isSymbolicLink() || !owned(canonical, root))) {
        throw new Error(`replacement render is not a managed directory: ${canonical}`);
      }
      copySkill(skill, canonical, root);
      for (const rel of RUNTIME_FILES) {
        const src = path.join(root, rel);
        const dst = path.join(runtime, rel);
        if (fs.existsSync(dst) && fs.realpathSync(dst) === fs.realpathSync(src)) continue;
        atomicCopy(src, dst);
      }
      if (exists(next) && fs.lstatSync(next).isSymbolicLink()) fs.unlinkSync(next);
      if (opts.copy || process.platform === 'win32' || exists(next)) {
        copySkill(skill, next, root, true);
      } else {
        fs.mkdirSync(target.dir, { recursive: true });
        fs.symlinkSync(canonical, next, 'dir');
      }
      if (!/^name:\s*(?:gstack-)?claude-code\s*$/m.test(fs.readFileSync(path.join(next, 'SKILL.md'), 'utf8'))) {
        throw new Error('installed replacement could not be verified');
      }
      for (const rel of RUNTIME_FILES) fs.accessSync(path.join(runtime, rel), fs.constants.R_OK);
      // Existing copied workflows must receive the same native host routing as
      // the new wrapper, including when setup selected a different host. Only
      // refresh installed managed entries; this never installs another host or
      // a skill the user has removed. Links use the newly published render.
      const renderedSkills = path.join(temporary, target.subdir, 'skills');
      for (const name of fs.readdirSync(renderedSkills)) {
        if (name === NEXT || name === OLD) continue;
        const installed = path.join(target.dir, name);
        if (!owned(installed, root) && !(name === 'gstack' && !fs.existsSync(path.join(installed, 'SKILL.md')))) continue;
        const rendered = path.join(renderedSkills, name);
        if (!generated(path.join(rendered, 'SKILL.md'))) continue;
        // The root sidecar mixes runtime assets with SKILL.md; it is not a
        // generated skill directory and must never be replaced as a whole.
        if (name === 'gstack') {
          // Legacy whole-repository runtime links share the tracked source
          // SKILL.md. A host render must never replace that shared source file.
          if (fs.realpathSync(installed) !== root) copySkill(rendered, installed, root, true);
          continue;
        }
        const live = path.join(root, target.subdir, 'skills', name);
        if (exists(live) && (fs.lstatSync(live).isSymbolicLink() || !owned(live, root))) {
          throw new Error(`workflow render is not a managed directory: ${live}`);
        }
        copySkill(rendered, live, root);
        if (!fs.lstatSync(installed).isSymbolicLink()) copySkill(rendered, installed, root, true);
      }
      if (fs.realpathSync(runtime) !== root) {
        for (const [name, alias] of [['gstack-office-hours', 'office-hours'], ['gstack-upgrade', 'gstack-upgrade']]) {
          const rendered = path.join(renderedSkills, name);
          const installed = path.join(runtime, alias);
          if (owned(installed, root) && generated(path.join(rendered, 'SKILL.md'))) copySkill(rendered, installed, root, true);
        }
      }
      retire(old, root, oldSources);
      result.migrated++;
    } catch (error) {
      result.pending.push(target.dir);
      log(`  kept ${old}: ${error instanceof Error ? error.message : String(error)}. Re-run ./setup to retry the rename.`);
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  // A failed/colliding host can still depend on a shared old render. Keep all
  // old renders until every known dependent installation has its replacement.
  if (result.pending.length === 0 && candidates.length > 0) {
    for (const subdir of new Set(targets.map(t => t.subdir))) {
      const oldRender = path.join(root, subdir, 'skills', OLD);
      if (fs.lstatSync(oldRender, { throwIfNoEntry: false })?.isDirectory() && generated(path.join(oldRender, 'SKILL.md'))) {
        fs.rmSync(oldRender, { recursive: true, force: true });
      }
    }
  }
  if (result.migrated) log(`  /claude is now /claude-code: migrated ${result.migrated} installed skill${result.migrated === 1 ? '' : 's'}. Consult sessions are preserved.`);
  return result;
}
