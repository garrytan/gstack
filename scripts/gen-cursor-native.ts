#!/usr/bin/env bun
/**
 * Generate Cursor-native skills into `.cursor/skills/`.
 *
 * Unlike `gen:skill-docs --host cursor` (prefixed `gstack-*` install slice,
 * full Claude preamble), this writes unprefixed skills that Cursor Agent
 * discovers in-repo: short Cursor preamble, Claude-tool rewrites, section
 * files left in the original skill dirs for progressive disclosure.
 *
 * Usage: bun run scripts/gen-cursor-native.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { discoverTemplates } from './discover-skills';
import { RESOLVERS } from './resolvers/index';
import type { Host, HostPaths, TemplateContext } from './resolvers/types';
import type { ResolverFn } from './resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const OUT_ROOT = path.join(ROOT, '.cursor', 'skills');

const SKIP_SKILLS = new Set(['connect-chrome']);

const EXPLICIT_ONLY = new Set([
  'ship',
  'land-and-deploy',
  'careful',
  'freeze',
  'guard',
  'unfreeze',
  'gstack-upgrade',
  'pair-agent',
]);

const CURSOR_PATHS: HostPaths = {
  skillRoot: '.cursor/skills',
  localSkillRoot: '.',
  binDir: '$GSTACK_BIN',
  browseDir: '$GSTACK_BROWSE',
  designDir: '$GSTACK_DESIGN',
  makePdfDir: '$GSTACK_MAKE_PDF',
};

const CURSOR_PREAMBLE = `## Cursor runtime (run first)

You are running this gstack skill **inside Cursor**. Use Cursor tools, not Claude Code tools.

| Claude Code | Cursor |
|---|---|
| AskUserQuestion | \`AskQuestion\` |
| Bash | \`Shell\` |
| Agent | \`Task\` |
| Edit | \`StrReplace\` |
| Skill tool | Read \`.cursor/skills/<name>/SKILL.md\` and follow it |
| CLAUDE.md | \`AGENTS.md\` |
| ExitPlanMode | SwitchMode to \`agent\` |

Resolve binaries from this repo:

\`\`\`bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
export GSTACK_ROOT="\${GSTACK_ROOT:-$_ROOT}"
export GSTACK_BIN="\${GSTACK_BIN:-$GSTACK_ROOT/bin}"
export GSTACK_BROWSE="\${GSTACK_BROWSE:-$GSTACK_ROOT/browse/dist}"
export GSTACK_DESIGN="\${GSTACK_DESIGN:-$GSTACK_ROOT/design/dist}"
export GSTACK_MAKE_PDF="\${GSTACK_MAKE_PDF:-$GSTACK_ROOT/make-pdf/dist}"
B="$GSTACK_BROWSE/browse"
if [ ! -x "$B" ]; then
  B="bun --cwd $GSTACK_ROOT run browse/src/cli.ts"
fi
echo "GSTACK_ROOT=$GSTACK_ROOT"
echo "B=$B"
eval "$($GSTACK_BIN/gstack-slug 2>/dev/null)" || true
\`\`\`

If a step says to Read a Claude Code skills path, read the same relative path from \`$GSTACK_ROOT\` instead.

Browser work uses the gstack browse binary (\`$B\`), never Chrome MCP tools.

Ask the user with **AskQuestion**, one question at a time unless the skill says otherwise.
`;

const REWRITES: Array<[string, string]> = [
  ['AskUserQuestion', 'AskQuestion'],
  ['use the Bash tool', 'use the Shell tool'],
  ['the Bash tool', 'the Shell tool'],
  ['Use the Bash tool', 'Use the Shell tool'],
  ['use the Agent tool', 'use the Task tool'],
  ['the Agent tool', 'the Task tool'],
  ['Use the Agent tool', 'Use the Task tool'],
  ['ExitPlanMode', 'SwitchMode (target_mode_id: agent)'],
  ['invoke it via the Skill tool', 'read and follow the matching skill in .cursor/skills/'],
  ['Use the Skill tool', 'Read the matching skill in .cursor/skills/ and follow it'],
  ['via the Skill tool', 'by reading `.cursor/skills/<name>/SKILL.md`'],
  ['the Skill tool', 'the matching Cursor skill'],
  ['CLAUDE.md', 'AGENTS.md'],
  ['~/.claude/skills/gstack', '$GSTACK_ROOT'],
  ['.claude/skills/gstack', '$GSTACK_ROOT'],
  ['.claude/skills/review', 'review'],
  ['.claude/skills', '.cursor/skills'],
  ['mcp__claude-in-chrome__', 'browse ($B)'],
  ['.cursor/skills/gstack/', '$GSTACK_ROOT/'],
];

const SUPPRESSED = new Set([
  'GBRAIN_CONTEXT_LOAD',
  'GBRAIN_SAVE_RESULTS',
  'BRAIN_PREFLIGHT',
  'BRAIN_CACHE_REFRESH',
  'BRAIN_WRITE_BACK',
]);

function extractNameAndDescription(content: string): { name: string; description: string } {
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return { name: '', description: '' };
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return { name: '', description: '' };

  const frontmatter = content.slice(fmStart + 4, fmEnd);
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : '';

  let description = '';
  const lines = frontmatter.split('\n');
  let inDescription = false;
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.match(/^description:\s*\|?\s*$/)) {
      inDescription = true;
      continue;
    }
    if (line.match(/^description:\s*\S/)) {
      description = line.replace(/^description:\s*/, '').trim();
      break;
    }
    if (inDescription) {
      if (line === '' || line.match(/^\s/)) {
        descLines.push(line.replace(/^  /, ''));
      } else {
        break;
      }
    }
  }
  if (descLines.length > 0) {
    description = descLines.join(' ').replace(/\s+/g, ' ').trim();
  }
  description = description.replace(/\s+/g, ' ').trim();
  if (description.length > 1024) {
    description = description.slice(0, 1021).replace(/\s+\S*$/, '') + '...';
  }
  return { name, description };
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const fmEnd = content.indexOf('\n---', 4);
  if (fmEnd === -1) return content;
  return content.slice(fmEnd + 4).replace(/^\n+/, '');
}

function applyRewrites(input: string, skillName: string): string {
  let result = input;
  for (const [from, to] of REWRITES) {
    result = result.replaceAll(from, to);
  }
  result = result.replace(
    /\.cursor\/skills\/([a-z0-9-]+)\/sections\//g,
    '$1/sections/',
  );
  result = result.replace(
    /`sections\/([^`]+)`/g,
    `\`$GSTACK_ROOT/${skillName}/sections/$1\``,
  );
  result = result.replaceAll('.cursor/skills/review/', 'review/');
  result = result.replaceAll('Read, Bash, Glob', 'Read, Shell, Glob');
  result = result.replaceAll('Bash commands like', 'Shell commands like');
  return result;
}

const PREAMBLE_SENTINEL = '%%CURSOR_PREAMBLE%%';

function generateCursorPreamble(_ctx: TemplateContext): string {
  return PREAMBLE_SENTINEL;
}

const CURSOR_RESOLVERS: Record<string, ResolverFn> = {
  ...RESOLVERS,
  PREAMBLE: generateCursorPreamble,
};

const SAFETY_ACTIVATION: Record<string, string> = {
  careful: `
## Cursor activation

Project hooks in \`.cursor/hooks.json\` stay idle until this file exists. Activate them:

\`\`\`bash
eval "$($GSTACK_BIN/gstack-paths)"
mkdir -p "$GSTACK_STATE_ROOT"
touch "$GSTACK_STATE_ROOT/careful-active"
echo "careful is active (state: $GSTACK_STATE_ROOT/careful-active)"
\`\`\`

Cursor's \`beforeShellExecution\` hook then runs \`careful/bin/check-careful.sh\`. Catastrophic shapes are denied; other destructive families ask. Deactivate by deleting that file or ending the session.
`,
  freeze: `
## Cursor activation

The freeze hook (\`.cursor/hooks/freeze.sh\`) is idle until \`freeze-dir.txt\` exists. After the user picks a directory, write it as shown above. Cursor then blocks Write/StrReplace outside that path. Run \`/unfreeze\` to clear it.
`,
  guard: `
## Cursor activation

Guard is careful + freeze. After the user picks a directory:

\`\`\`bash
eval "$($GSTACK_BIN/gstack-paths)"
mkdir -p "$GSTACK_STATE_ROOT"
touch "$GSTACK_STATE_ROOT/careful-active"
FREEZE_DIR="\${FREEZE_DIR%/}/"
echo "$FREEZE_DIR" > "$GSTACK_STATE_ROOT/freeze-dir.txt"
\`\`\`
`,
  unfreeze: `
## Cursor activation

\`\`\`bash
eval "$($GSTACK_BIN/gstack-paths)"
rm -f "$GSTACK_STATE_ROOT/freeze-dir.txt"
echo "Freeze boundary cleared."
\`\`\`

\`/careful\` stays active until you delete \`$GSTACK_STATE_ROOT/careful-active\` or end the session.
`,
};

function resolvePlaceholders(tmplContent: string, ctx: TemplateContext, relTmplPath: string): string {
  const onePass = (input: string): string =>
    input.replace(/\{\{(\w+(?::[^}]+)?)\}\}/g, (_match, fullKey) => {
      const parts = String(fullKey).split(':');
      const resolverName = parts[0];
      const args = parts.slice(1);
      if (SUPPRESSED.has(resolverName)) return '';
      const resolve = CURSOR_RESOLVERS[resolverName];
      if (!resolve) throw new Error(`Unknown placeholder {{${resolverName}}} in ${relTmplPath}`);
      return args.length > 0 ? resolve(ctx, args) : resolve(ctx);
    });

  let content = tmplContent;
  for (let pass = 0; pass < 6; pass++) {
    const next = onePass(content);
    if (next === content) break;
    content = next;
  }

  const remaining = content.match(/\{\{(\w+(?::[^}]+)?)\}\}/g);
  if (remaining) {
    throw new Error(`Unresolved placeholders in ${relTmplPath}: ${remaining.join(', ')}`);
  }
  return content;
}

function yamlQuote(value: string): string {
  if (/[:#>{}[\],*&!%@`]/.test(value) || value.includes('\n') || value.includes("'") || value.includes('"')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function buildSkillMarkdown(name: string, description: string, body: string): string {
  const explicit = EXPLICIT_ONLY.has(name);
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${yamlQuote(description)}`,
    ...(explicit ? ['disable-model-invocation: true'] : []),
    '---',
    '',
  ].join('\n');
  return `${fm}<!-- Generated by scripts/gen-cursor-native.ts from ${name === 'gstack' ? 'SKILL.md.tmpl' : `${name}/SKILL.md.tmpl`} — do not edit directly -->\n\n${body.trim()}\n`;
}

function main(): void {
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const templates = discoverTemplates(ROOT);
  let written = 0;

  for (const { tmpl } of templates) {
    const skillDir = path.dirname(tmpl);
    const dirName = skillDir === '.' ? 'gstack' : skillDir;
    if (SKIP_SKILLS.has(dirName)) continue;

    const tmplPath = path.join(ROOT, tmpl);
    const tmplContent = fs.readFileSync(tmplPath, 'utf-8').replace(/\r\n/g, '\n');
    const { name: extractedName, description } = extractNameAndDescription(tmplContent);
    const skillName = dirName === 'gstack' ? 'gstack' : (extractedName || dirName);

    const benefitsMatch = tmplContent.match(/^benefits-from:\s*\[([^\]]*)\]/m);
    const benefitsFrom = benefitsMatch
      ? benefitsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    const tierMatch = tmplContent.match(/^preamble-tier:\s*(\d+)$/m);
    const preambleTier = tierMatch ? parseInt(tierMatch[1], 10) : undefined;
    const interactiveMatch = tmplContent.match(/^interactive:\s*(true|false)\s*$/m);
    const interactive = interactiveMatch ? interactiveMatch[1] === 'true' : undefined;

    const ctx: TemplateContext = {
      skillName,
      tmplPath,
      benefitsFrom,
      host: 'claude' as Host, // pointers to sections, not inlined monoliths
      paths: CURSOR_PATHS,
      preambleTier,
      interactive,
      explainLevel: 'terse',
    };

    const resolved = resolvePlaceholders(tmplContent, ctx, tmpl);
    let body = applyRewrites(stripFrontmatter(resolved), skillName);
    body = body.replaceAll(PREAMBLE_SENTINEL, CURSOR_PREAMBLE);
    const extra = SAFETY_ACTIVATION[skillName];
    if (extra) body = `${body.trim()}\n${extra}`;
    const output = buildSkillMarkdown(skillName, description, body);

    const outDir = path.join(OUT_ROOT, skillName);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'SKILL.md'), output);
    written++;
    const lines = output.split('\n').length;
    console.log(`  ${skillName.padEnd(28)} ${String(lines).padStart(5)} lines`);
  }

  console.log(`\nWrote ${written} Cursor skills to .cursor/skills/`);
}

main();
