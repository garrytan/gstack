/** Read a carved skill as one bundle that preserves source-file boundaries. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { markerIndex } from './workflow-excerpt';
import { SHARED_PREAMBLE_FILE, readSkillStartup } from './skill-startup';

export interface WorkflowJudgeFile {
  path: string;
  kind: 'entrypoint' | 'section' | 'reference';
  content: string;
  startLine: number;
  endLine: number;
}

export interface WorkflowJudgeInput {
  files: WorkflowJudgeFile[];
  text: string;
}

export function readWorkflowJudgeInput(opts: {
  root: string;
  skillPath: string;
  startMarker: string;
  endMarker: string | RegExp | null;
  references?: readonly string[];
}): WorkflowJudgeInput {
  const sources = [{
    path: opts.skillPath,
    kind: 'entrypoint' as const,
    content: readSkillStartup(path.join(opts.root, opts.skillPath)),
  }];
  const sectionDir = path.posix.join(path.posix.dirname(opts.skillPath), 'sections');
  const sectionRoot = path.join(opts.root, sectionDir);
  // Runner-profile sections (manifest `runner_only`, plan B4) are read by
  // bin/gstack-autoplan alone; the bundle holds the interactive workflow.
  const manifestPath = path.join(sectionRoot, 'manifest.json');
  const manifestSections: Array<{ file: string; runner_only?: boolean }> = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).sections ?? [] : [];
  const runnerOnly = new Set(manifestSections.filter(section => section.runner_only).map(section => section.file));
  const sections = fs.existsSync(sectionRoot)
    ? fs.readdirSync(sectionRoot).sort().filter(name => name.endsWith('.md') && !runnerOnly.has(name) && name !== SHARED_PREAMBLE_FILE)
      .map(name => ({
        path: path.posix.join(sectionDir, name),
        kind: 'section' as const,
        content: fs.readFileSync(path.join(sectionRoot, name), 'utf8'),
      }))
    : [];
  const references = [...new Set(opts.references ?? [])].map(file => {
    const resolved = path.resolve(opts.root, file);
    if (!resolved.startsWith(path.resolve(opts.root) + path.sep)) throw new Error(`Reference outside root: ${file}`);
    return { path: file, kind: 'reference' as const, content: fs.readFileSync(resolved, 'utf8') };
  }).filter(file => ![...sources, ...sections].some(source => source.path === file.path));
  const allSources = [...sources, ...sections, ...references];

  // Preserve the existing marker window, including markers that moved into
  // section files. Offsets identify the source of each slice; prose prefixes
  // cannot reliably identify a file after its generated header was sliced off.
  const union = allSources.map(file => file.content).join('\n');
  const start = union.indexOf(opts.startMarker);
  if (start < 0) throw new Error(`Start marker not found in ${opts.skillPath}: "${opts.startMarker}"`);
  const end = opts.endMarker === null ? union.length : markerIndex(union, opts.endMarker, start);
  if (end < 0) throw new Error(`End marker not found in ${opts.skillPath}: "${opts.endMarker}"`);

  const files: WorkflowJudgeFile[] = [];
  let offset = 0;
  for (const file of allSources) {
    // Every section is supplied in full. Include each file once even when the marker window
    // also covers part of it. Only the entrypoint retains the requested slice.
    const from = file.kind !== 'entrypoint' ? 0 : Math.max(0, start - offset);
    const to = file.kind !== 'entrypoint' ? file.content.length : Math.min(file.content.length, end - offset);
    if (from < to) {
      files.push({
        ...file,
        path: file.path.split(path.sep).join('/'),
        content: file.content.slice(from, to),
        startLine: file.content.slice(0, from).split('\n').length,
        endLine: file.content.slice(0, to - 1).split('\n').length,
      });
    }
    offset += file.content.length + 1;
  }

  const context = [
    'The material below is a bundle of source-file excerpts, with each original file and line range labeled.',
    'SKILL.md is the entry point; the labeled ranges identify which excerpts are supplied.',
    ...(sections.length + references.length > 0 ? [
      'The section files remain separate on disk and are read at the points and conditions specified by the skill\'s Read directives.',
      'They are supplied here as on-demand references; their order in this bundle is not execution order.',
    ] : []),
  ].join('\n');
  return {
    files,
    text: context + '\n\n' + files.map(file => [
      `--- BEGIN FILE ${JSON.stringify(file.path)} (lines ${file.startLine}-${file.endLine}; ${file.kind}) ---`,
      file.content,
      `--- END FILE ${JSON.stringify(file.path)} ---`,
    ].join('\n')).join('\n\n'),
  };
}
