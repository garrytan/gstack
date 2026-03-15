#!/usr/bin/env bun
/**
 * Generate SKILL.md files from .tmpl templates.
 *
 * Pipeline:
 *   read .tmpl → find {{PLACEHOLDERS}} → resolve from source → format → write .md
 *
 * Supports --dry-run: generate to memory, exit 1 if different from committed file.
 * Used by skill:check and CI freshness checks.
 */

import { COMMAND_DESCRIPTIONS } from '../lib/agent-browser-commands';
import { SNAPSHOT_FLAGS } from '../lib/snapshot-flags';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Placeholder Resolvers ──────────────────────────────────

function generateCommandReference(): string {
  // Group commands by category
  const groups = new Map<string, Array<{ command: string; description: string; usage?: string }>>();
  for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const list = groups.get(meta.category) || [];
    list.push({ command: cmd, description: meta.description, usage: meta.usage });
    groups.set(meta.category, list);
  }

  // Category display order
  const categoryOrder = [
    'Navigation', 'Reading', 'Interaction', 'Inspection',
    'Storage', 'Network', 'Config', 'Dialog',
    'Visual', 'Snapshot', 'Find', 'Tabs', 'Frames', 'Lifecycle',
  ];

  const sections: string[] = [];
  for (const category of categoryOrder) {
    const commands = groups.get(category);
    if (!commands || commands.length === 0) continue;

    // Sort alphabetically within category
    commands.sort((a, b) => a.command.localeCompare(b.command));

    sections.push(`### ${category}`);
    sections.push('| Command | Description |');
    sections.push('|---------|-------------|');
    for (const cmd of commands) {
      const display = cmd.usage ? `\`${cmd.usage}\`` : `\`${cmd.command}\``;
      sections.push(`| ${display} | ${cmd.description} |`);
    }
    sections.push('');
  }

  return sections.join('\n').trimEnd();
}

function generateSnapshotFlags(): string {
  const lines: string[] = [
    'The snapshot is your primary tool for understanding and interacting with pages.',
    '`agent-browser snapshot` returns the full accessibility tree of the current page.',
    '',
    '### Flags',
    '',
    '| Flag | Long | Description |',
    '|------|------|-------------|',
  ];

  for (const flag of SNAPSHOT_FLAGS) {
    const shortCol = flag.valueHint ? `\`${flag.short} ${flag.valueHint}\`` : `\`${flag.short}\``;
    lines.push(`| ${shortCol} | \`${flag.long}\` | ${flag.description} |`);
  }

  lines.push('');
  lines.push('All flags combine freely: `agent-browser snapshot -i -c` returns only interactive elements, with empty containers removed.');
  lines.push('');
  lines.push('**Flag details:**');
  lines.push('- **`-i` (interactive):** Returns only elements that accept user input: buttons, links, textboxes, checkboxes, selects, and other focusable elements. Each gets an @e ref for use in subsequent commands.');
  lines.push('- **`-c` (compact):** Removes structural nodes (div, section, nav, etc.) that have no text content and serve only as layout containers. Reduces output noise.');
  lines.push('- **`-s <sel>` (selector):** Scopes the tree to a subtree matching the CSS selector or @ref. Example: `snapshot -s "#sidebar"` or `snapshot -s @e5`.');
  lines.push('');
  lines.push('### Related commands');
  lines.push('');
  lines.push('| Command | Description |');
  lines.push('|---------|-------------|');
  lines.push('| `agent-browser diff snapshot` | Unified diff of current tree vs previous snapshot. Shows +added/-removed lines. Run snapshot → act → diff snapshot. |');
  lines.push('| `agent-browser screenshot --annotate [path]` | Screenshot with numbered ref labels overlaid on each interactive element. Default path: /tmp/screenshot.png |');
  lines.push('');
  lines.push('### @e refs');
  lines.push('');
  lines.push('Refs are assigned sequentially (@e1, @e2, ...) in DOM tree order.');
  lines.push('After snapshot, use @refs as selectors in any command:');
  lines.push('');
  lines.push('```bash');
  lines.push('agent-browser click @e3       agent-browser fill @e4 "value"     agent-browser hover @e1');
  lines.push('agent-browser get html @e2    agent-browser get styles @e5');
  lines.push('```');
  lines.push('');
  lines.push('**Output format:** indented accessibility tree — role in brackets, text in quotes, attributes in brackets.');
  lines.push('```');
  lines.push('  @e1 [heading] "Welcome" [level=1]       ← [level=N] = heading level');
  lines.push('  @e2 [textbox] "Email"                    ← label text in quotes');
  lines.push('  @e3 [button] "Submit"');
  lines.push('    @e4 [link] "Learn more" [href=/docs]   ← indentation shows nesting');
  lines.push('```');
  lines.push('');
  lines.push('**Important:** Refs are invalidated on navigation — run `snapshot` again after `open` or any action that causes a page load.');

  return lines.join('\n');
}

function generateUpdateCheck(): string {
  return `## Update Check (run first)

\`\`\`bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
\`\`\`

If output shows \`UPGRADE_AVAILABLE <old> <new>\`: read \`~/.claude/skills/gstack/gstack-upgrade/SKILL.md\` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If \`JUST_UPGRADED <from> <to>\`: tell user "Running gstack v{to} (just updated!)" and continue.`;
}

function generateBrowseSetup(): string {
  return `## SETUP (run this check BEFORE any browser command)

\`\`\`bash
if command -v agent-browser &>/dev/null; then
  echo "READY: $(which agent-browser)"
else
  echo "NEEDS_SETUP"
fi
\`\`\`

If \`NEEDS_SETUP\`:
1. Tell the user: "agent-browser needs a one-time install (~30 seconds). OK to proceed?" Then STOP and wait.
2. Run: \`npm install -g agent-browser && agent-browser install\``;
}

const RESOLVERS: Record<string, () => string> = {
  COMMAND_REFERENCE: generateCommandReference,
  SNAPSHOT_FLAGS: generateSnapshotFlags,
  UPDATE_CHECK: generateUpdateCheck,
  BROWSE_SETUP: generateBrowseSetup,
};

// ─── Template Processing ────────────────────────────────────

const GENERATED_HEADER = `<!-- AUTO-GENERATED from {{SOURCE}} — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n`;

function processTemplate(tmplPath: string): { outputPath: string; content: string } {
  const tmplContent = fs.readFileSync(tmplPath, 'utf-8');
  const relTmplPath = path.relative(ROOT, tmplPath);
  const outputPath = tmplPath.replace(/\.tmpl$/, '');

  // Replace placeholders
  let content = tmplContent.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const resolver = RESOLVERS[name];
    if (!resolver) throw new Error(`Unknown placeholder {{${name}}} in ${relTmplPath}`);
    return resolver();
  });

  // Check for any remaining unresolved placeholders
  const remaining = content.match(/\{\{(\w+)\}\}/g);
  if (remaining) {
    throw new Error(`Unresolved placeholders in ${relTmplPath}: ${remaining.join(', ')}`);
  }

  // Prepend generated header (after frontmatter)
  const header = GENERATED_HEADER.replace('{{SOURCE}}', path.basename(tmplPath));
  const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (fmEnd !== -1) {
    const insertAt = content.indexOf('\n', fmEnd) + 1;
    content = content.slice(0, insertAt) + header + content.slice(insertAt);
  } else {
    content = header + content;
  }

  return { outputPath, content };
}

// ─── Main ───────────────────────────────────────────────────

function findTemplates(): string[] {
  const templates: string[] = [];
  const candidates = [
    path.join(ROOT, 'SKILL.md.tmpl'),
    path.join(ROOT, 'qa', 'SKILL.md.tmpl'),
    path.join(ROOT, 'setup-browser-cookies', 'SKILL.md.tmpl'),
    path.join(ROOT, 'ship', 'SKILL.md.tmpl'),
    path.join(ROOT, 'review', 'SKILL.md.tmpl'),
    path.join(ROOT, 'plan-ceo-review', 'SKILL.md.tmpl'),
    path.join(ROOT, 'plan-eng-review', 'SKILL.md.tmpl'),
    path.join(ROOT, 'retro', 'SKILL.md.tmpl'),
    path.join(ROOT, 'gstack-upgrade', 'SKILL.md.tmpl'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) templates.push(p);
  }
  return templates;
}

let hasChanges = false;

for (const tmplPath of findTemplates()) {
  const { outputPath, content } = processTemplate(tmplPath);
  const relOutput = path.relative(ROOT, outputPath);

  if (DRY_RUN) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
    if (existing !== content) {
      console.log(`STALE: ${relOutput}`);
      hasChanges = true;
    } else {
      console.log(`FRESH: ${relOutput}`);
    }
  } else {
    fs.writeFileSync(outputPath, content);
    console.log(`GENERATED: ${relOutput}`);
  }
}

if (DRY_RUN && hasChanges) {
  console.error('\nGenerated SKILL.md files are stale. Run: bun run gen:skill-docs');
  process.exit(1);
}
