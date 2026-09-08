/** Preserve source-file boundaries when a workflow judge reads carved skills. */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkflowJudgeFile {
  path: string;
  kind: 'entrypoint' | 'section';
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
  endMarker: string | null;
}): WorkflowJudgeInput {
  const sources = [{
    path: opts.skillPath,
    kind: 'entrypoint' as const,
    content: fs.readFileSync(path.join(opts.root, opts.skillPath), 'utf8'),
  }];
  const sectionDir = path.join(path.dirname(opts.skillPath), 'sections');
  const sectionRoot = path.join(opts.root, sectionDir);
  const sections = fs.existsSync(sectionRoot)
    ? fs.readdirSync(sectionRoot).sort().filter(name => name.endsWith('.md'))
      .map(name => ({
        path: path.join(sectionDir, name),
        kind: 'section' as const,
        content: fs.readFileSync(path.join(sectionRoot, name), 'utf8'),
      }))
    : [];
  const allSources = [...sources, ...sections];

  // Preserve the existing marker window, including markers that moved into
  // section files. Offsets identify the source of each slice; prose prefixes
  // cannot reliably identify a file after its generated header was sliced off.
  const union = allSources.map(file => file.content).join('\n');
  const start = union.indexOf(opts.startMarker);
  if (start < 0) throw new Error(`Start marker not found in ${opts.skillPath}: "${opts.startMarker}"`);
  const end = opts.endMarker === null ? union.length : union.indexOf(opts.endMarker, start);
  if (end < 0) throw new Error(`End marker not found in ${opts.skillPath}: "${opts.endMarker}"`);

  const files: WorkflowJudgeFile[] = [];
  let offset = 0;
  for (const file of allSources) {
    // Every section was already supplied in full by the old judge input. Keep
    // that coverage, but include each file once even when the marker window
    // also covers part of it. Only the entrypoint retains the requested slice.
    const from = file.kind === 'section' ? 0 : Math.max(0, start - offset);
    const to = file.kind === 'section' ? file.content.length : Math.min(file.content.length, end - offset);
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
    ...(sections.length > 0 ? [
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
