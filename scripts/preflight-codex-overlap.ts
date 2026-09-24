#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverTemplates, includesSkill } from './discover-skills';
import { externalSkillName, extractNameAndDescription } from './external-skill-names';
import { getHostConfig } from '../hosts';

const args = process.argv.slice(2);
const value = (flag: string): string => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1];
};
const exists = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });
const inside = (file: string, root: string) => file === root || file.startsWith(`${root}${path.sep}`);
const refuse = (operation: string, target: string) => {
  throw new Error(`Refusing: Codex ${operation} overlaps source or escapes its namespace: ${target}`);
};
const physical = (file: string): string => {
  let ancestor = path.resolve(file);
  const suffix: string[] = [];
  const visited = new Set<string>();
  while (true) {
    if (exists(ancestor)) {
      try { return path.join(fs.realpathSync(ancestor), ...suffix); }
      catch (error) {
        if (!exists(ancestor)?.isSymbolicLink() || visited.has(ancestor)) throw error;
        visited.add(ancestor);
        ancestor = path.resolve(path.dirname(ancestor), fs.readlinkSync(ancestor));
        continue;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`unresolvable path: ${file}`);
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
};
const source = fs.realpathSync(value('--source'));
const generation = path.join(source, '.agents/skills');
const namespace = value('--namespace');
const selected = value('--selected') === '1';
const windows = value('--windows') === '1';
const local = value('--local') === '1';
const runtime = path.join(namespace, 'gstack');
const runtimeStat = exists(runtime);
const migrating = selected && !local && !!runtimeStat && runtimeStat.isDirectory()
  && !runtimeStat.isSymbolicLink() && physical(runtime) === source;
const relocated = migrating ? value('--relocation') : source;

if (migrating && (exists(relocated) || inside(physical(relocated), source))) refuse('checkout relocation', relocated);
const generationRoot = physical(generation);
if (!inside(generationRoot, source) || generationRoot === source) refuse('generation namespace', generation);
const physicalNamespace = physical(namespace);
if (selected && inside(physicalNamespace, source) && (!local || physicalNamespace !== generationRoot)) refuse('host namespace', namespace);

const checkOutput = (file: string, root: string, operation: string) => {
  if (!inside(physical(file), root)) refuse(operation, file);
};
const checkAtomicCopy = (file: string, root: string, operation: string, detachesParent = false) => {
  const parent = path.dirname(file);
  const writeParent = detachesParent && exists(parent)?.isSymbolicLink() ? path.dirname(parent) : parent;
  const resolved = physical(writeParent);
  if (!inside(resolved, root) || (inside(resolved, source) && !inside(resolved, generationRoot))) {
    refuse(operation, file);
  }
};
const checkPostRelocationAlias = (file: string) => {
  if (!migrating) return;
  let entry = file;
  while (inside(entry, source) && entry !== source) {
    if (exists(entry)?.isSymbolicLink() && path.isAbsolute(fs.readlinkSync(entry)) && inside(physical(entry), source)) {
      refuse(entry === path.join(source, '.agents') || entry === generation
        ? 'post-relocation generation namespace' : 'post-relocation generated alias', entry);
    }
    entry = path.dirname(entry);
  }
};
const checkReplace = (file: string, operation: string) => {
  const stat = exists(file);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  if (inside(source, physical(file))) {
    if ((migrating || local) && file === runtime && physical(file) === source) return;
    refuse(operation, file);
  }
};
const userOwnedRoot = (root: string): boolean => {
  const stat = exists(root);
  const skill = path.join(root, 'SKILL.md');
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink()
    && !!fs.statSync(skill, { throwIfNoEntry: false })?.isFile()
    && !fs.readFileSync(skill, 'utf8').includes('<!-- AUTO-GENERATED from');
};
const linkIsOurs = (file: string): boolean => {
  try { return inside(physical(file), source); }
  catch { return false; }
};
const owned = (file: string): boolean => {
  const stat = exists(file);
  if (!stat) return false;
  if (stat.isSymbolicLink()) return linkIsOurs(file);
  if (!stat.isDirectory()) return false;
  if (exists(path.join(file, '.gstack-owned'))) return true;
  const skill = path.join(file, 'SKILL.md');
  if (exists(skill)?.isSymbolicLink() && linkIsOurs(skill)) return true;
  try { return fs.readFileSync(skill, 'utf8').includes('<!-- AUTO-GENERATED from'); }
  catch { return false; }
};

const config = getHostConfig('codex');
const names = new Set<string>();
const sourceNames = new Set<string>();
for (const template of discoverTemplates(source)) {
  const dir = path.dirname(template.tmpl);
  const name = externalSkillName(dir, extractNameAndDescription(fs.readFileSync(path.join(source, template.tmpl), 'utf8')).name);
  sourceNames.add(name);
  if (!includesSkill(config, dir)) continue;
  names.add(name);
  const skill = path.join(generation, name, 'SKILL.md');
  let loop = false;
  try {
    loop = fs.realpathSync(path.join(source, template.output)) === path.join(fs.realpathSync(path.dirname(skill)), 'SKILL.md');
  } catch {}
  if (loop) continue;
  checkPostRelocationAlias(skill);
  checkOutput(skill, generationRoot, 'generated skill write');
  if (config.generation.generateMetadata) {
    const metadata = path.join(generation, name, 'agents/openai.yaml');
    checkPostRelocationAlias(metadata);
    checkOutput(metadata, generationRoot, 'generated metadata write');
  }
}

const generatedEntries = exists(generation)?.isDirectory() ? fs.readdirSync(generation) : [];
for (const name of generatedEntries.filter(name => name.startsWith('gstack-') && !names.has(name))) {
  const entry = path.join(generation, name);
  if (exists(entry)?.isDirectory() && !exists(entry)?.isSymbolicLink()) checkReplace(entry, 'stale render pruning');
}

const hostEntries = exists(namespace)?.isDirectory() ? fs.readdirSync(namespace) : [];
for (const name of hostEntries.filter(name => name.startsWith('gstack-') && !sourceNames.has(name))) {
  const entry = path.join(namespace, name);
  const stat = exists(entry);
  if (!stat || stat.isSymbolicLink()) continue;
  if (stat.isDirectory()) {
    const skill = path.join(entry, 'SKILL.md');
    if (!fs.existsSync(skill) || !fs.readFileSync(skill, 'utf8').includes('<!-- AUTO-GENERATED from')) continue;
    if (!exists(skill)?.isSymbolicLink() && inside(physical(skill), source) && !inside(physical(skill), generationRoot)) {
      refuse('stale host cleanup', skill);
    }
  } else if (inside(physical(entry), source) && !inside(physical(entry), generationRoot)) {
    refuse('stale host cleanup', entry);
  }
}

const old = path.join(namespace, 'gstack-claude');
const nextSkill = path.join(namespace, 'gstack-claude-code');
const renameFiles = ['bin/gstack-claude-code', 'lib/claude-code.ts', 'lib/claude-code-windows-job.ts', 'lib/claude-bin.ts', 'lib/outside-review-result.ts'];
const runtimeSkill = path.join(runtime, 'SKILL.md');
const runtimeBanner = !fs.existsSync(runtimeSkill) || fs.readFileSync(runtimeSkill, 'utf8').includes('<!-- AUTO-GENERATED from');
const rename = owned(old) && (!exists(nextSkill) || owned(nextSkill))
  && (!exists(runtime)?.isSymbolicLink() || linkIsOurs(runtime))
  && runtimeBanner && renameFiles.every(rel => {
    const parent = path.join(runtime, path.dirname(rel));
    return exists(path.join(source, rel)) && (!exists(parent)?.isSymbolicLink() || linkIsOurs(parent));
  });
if (rename) {
  const next = nextSkill;
  checkReplace(runtime, 'rename runtime replacement');
  checkReplace(next, 'rename replacement');
  if (exists(next)?.isDirectory() && !exists(next)?.isSymbolicLink()) {
    for (const rel of ['SKILL.md', 'agents/openai.yaml']) checkAtomicCopy(path.join(next, rel), physicalNamespace, 'rename skill write', true);
  }
  if (exists(runtime) && physical(runtime) !== source) {
    for (const rel of renameFiles) {
      const dest = path.join(runtime, rel);
      if (exists(dest) && physical(dest) === physical(path.join(source, rel))) continue;
      checkAtomicCopy(dest, physicalNamespace, 'rename runtime write');
    }
  }
  for (const name of names) {
    if (name === 'gstack' || name === 'gstack-claude' || name === 'gstack-claude-code') continue;
    const installed = path.join(namespace, name);
    if (owned(installed) && !exists(installed)?.isSymbolicLink()) {
      checkAtomicCopy(path.join(installed, 'SKILL.md'), physicalNamespace, 'rename workflow write', true);
      if (config.generation.generateMetadata) checkAtomicCopy(path.join(installed, 'agents/openai.yaml'), physicalNamespace, 'rename metadata write', true);
    }
  }
}

if (selected) {
  checkReplace(runtime, 'runtime replacement');
  if (!local && !migrating && userOwnedRoot(runtime)) {
    throw new Error(`Refusing: global Codex runtime ${runtime} is a real user-owned skill with a handwritten SKILL.md. Move it aside or choose another CODEX_HOME; setup will not replace it.`);
  }
  if (windows) for (const name of names) {
    if (name !== 'gstack' && !(local && name === 'gstack-claude')) checkReplace(path.join(namespace, name), 'skill copy replacement');
  }

  const sidecar = path.join(generation, 'gstack');
  if (!userOwnedRoot(sidecar)) {
    checkOutput(sidecar, generationRoot, 'sidecar root write');
    for (const rel of ['bin', 'lib', 'browse', 'review', 'qa', 'ETHOS.md']) {
      const src = path.join(source, rel), dest = path.join(sidecar, rel);
      if (!exists(src) || (!windows && exists(dest) && !exists(dest)?.isSymbolicLink())) continue;
      if (exists(dest)?.isSymbolicLink()) checkOutput(path.dirname(dest), generationRoot, 'sidecar asset write');
      else {
        checkReplace(dest, 'sidecar asset replacement');
        checkOutput(dest, generationRoot, 'sidecar asset write');
      }
    }
    const configFile = path.join(source, 'supabase/config.sh');
    if (exists(configFile)) {
      const dest = path.join(sidecar, 'supabase/config.sh');
      if (exists(dest)?.isSymbolicLink()) checkOutput(path.dirname(dest), generationRoot, 'sidecar config write');
      else checkOutput(dest, generationRoot, 'sidecar config write');
    }
  }
}

if (migrating) {
  for (const entry of [path.join(source, '.agents'), generation]) {
    if (exists(entry)?.isSymbolicLink() && path.isAbsolute(fs.readlinkSync(entry)) && inside(physical(entry), source)) {
      refuse('post-relocation generation namespace', entry);
    }
  }
  for (const name of generatedEntries.filter(name => name.startsWith('gstack'))) {
    const entry = path.join(generation, name);
    if (exists(entry)?.isSymbolicLink() && path.isAbsolute(fs.readlinkSync(entry)) && inside(physical(entry), source)) {
      refuse('post-relocation generated alias', entry);
    }
  }
}
