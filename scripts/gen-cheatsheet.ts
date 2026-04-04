#!/usr/bin/env bun
/**
 * Generate a printable HTML cheatsheet from SKILL.md frontmatter.
 *
 * Reads all SKILL.md files, extracts name + description, groups by category,
 * and outputs a styled HTML page matching the gstack cheatsheet aesthetic.
 *
 * Usage:
 *   bun run gen:cheatsheet                          # generate docs/cheatsheet.html
 *   bun run gen:cheatsheet --dry-run                # check freshness without writing
 *   bun run gen:cheatsheet --hide safety,meta       # hide specific groups
 */

import * as fs from 'fs';
import * as path from 'path';
import { discoverSkillFiles } from './discover-skills';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const OUTPUT = path.join(ROOT, 'docs', 'cheatsheet.html');

// ─── --hide flag ───────────────────────────────────────────
// Parse --hide safety,meta or --hide "safety, meta"
const hideArg = process.argv.find(a => a === '--hide' || a.startsWith('--hide='));
const HIDDEN_GROUPS = new Set(
  (() => {
    if (!hideArg) return [];
    const val = hideArg.includes('=')
      ? hideArg.split('=')[1]
      : process.argv[process.argv.indexOf(hideArg) + 1];
    if (!val) return [];
    return val.split(',').map(s => s.trim().toUpperCase());
  })(),
);

// ─── Frontmatter Parsing ───────────────────────────────────

function extractFrontmatter(content: string): { name: string; description: string } {
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

  return { name, description };
}

// ─── Short Descriptions ────────────────────────────────────
// Hand-crafted one-liners for the cheatsheet. Falls back to auto-condensed
// first sentence from SKILL.md if a skill is missing here.

const SHORT_DESCRIPTIONS: Record<string, string> = {
  'office-hours':          'YC brainstorming & idea validation \u2014 Startup and Builder modes',
  'autoplan':              'Auto-review pipeline \u2014 runs CEO, design, and eng reviews sequentially',
  'plan-ceo-review':       'Strategy review \u2014 scope expand, selective, hold, or reduce',
  'plan-eng-review':       'Architecture, data flow, edge cases, test coverage',
  'plan-design-review':    'Rate each dimension 0\u201310, then fix to reach 10',
  'design-consultation':   'Full design system \u2014 typography, color, layout \u2192 DESIGN.md',
  'design-shotgun':        'Generate multiple AI design variants, compare, and iterate',
  'browse':                'Headless browser \u2014 navigate, click, fill forms, screenshot, verify',
  'connect-chrome':        'Launch real Chrome with gstack side panel for live browsing',
  'investigate':           'Root cause debugging \u2014 Iron Law: no fix without root cause',
  'design-html':           'Convert approved AI mockup to production HTML/CSS',
  'learn':                 'Review, search, prune, and export cross-session learnings',
  'freeze':                'Lock edits to one directory for the session',
  'unfreeze':              'Remove edit restrictions, allow changes everywhere',
  'qa':                    'Find bugs, fix, commit, re-verify \u2014 Quick / Standard / Exhaustive',
  'qa-only':               'Report-only QA \u2014 health score, screenshots, repro steps',
  'design-review':         'Visual QA \u2014 spacing, hierarchy, AI slop. Before/after screenshots',
  'benchmark':             'Performance regression detection \u2014 Core Web Vitals, load times',
  'cso':                   'Security audit \u2014 OWASP Top 10, STRIDE, secrets, supply chain',
  'setup-browser-cookies': 'Import real browser cookies for testing auth pages',
  'review':                'Pre-merge PR review \u2014 SQL safety, trust boundaries, structure',
  'codex':                 'Adversarial 2nd opinion \u2014 review / challenge / consult modes',
  'ship':                  'Merge base, tests, review, version bump, changelog, PR',
  'land-and-deploy':       'Merge PR, wait for CI/deploy, canary verify production',
  'canary':                'Post-deploy monitoring \u2014 errors, regressions, screenshots',
  'setup-deploy':          'One-time deploy platform config (Fly, Vercel, Render, etc.)',
  'document-release':      'Post-ship \u2014 sync README, ARCHITECTURE, CONTRIBUTING, CHANGELOG',
  'retro':                 'Weekly eng retro \u2014 commit analysis, work patterns, team breakdown',
  'careful':               'Safety warnings before rm -rf, DROP TABLE, force-push, etc.',
  'guard':                 'Maximum safety \u2014 destructive command warnings + directory lock',
  'gstack-upgrade':        'Upgrade gstack to the latest version',
};

/** Auto-condense: first sentence, strip boilerplate, truncate to 80 chars */
function autoCondense(desc: string): string {
  const collapsed = desc.replace(/\s+/g, ' ').trim();
  const first = collapsed.split(/(?<=\.)\s+/)[0] || collapsed;
  const clean = first
    .replace(/\s*\(gstack\)\s*$/, '')
    .replace(/\s*Use when.*$/, '')
    .replace(/\s*Proactively.*$/, '');
  if (clean.length <= 80) return clean;
  const truncated = clean.slice(0, 77);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + '\u2026';
}

// ─── Category Definitions ──────────────────────────────────

interface Category {
  title: string;
  skills: string[];
}

const CATEGORIES: Category[] = [
  {
    title: 'IDEATION & PLANNING',
    skills: ['office-hours', 'autoplan', 'plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'design-consultation', 'design-shotgun'],
  },
  {
    title: 'DEVELOPMENT',
    skills: ['browse', 'connect-chrome', 'investigate', 'design-html', 'learn', 'freeze', 'unfreeze'],
  },
  {
    title: 'TESTING & QA',
    skills: ['qa', 'qa-only', 'design-review', 'benchmark', 'cso', 'setup-browser-cookies'],
  },
  {
    title: 'SHIP & REVIEW',
    skills: ['review', 'codex', 'ship', 'land-and-deploy', 'canary', 'setup-deploy', 'document-release', 'retro'],
  },
  {
    title: 'SAFETY',
    skills: ['careful', 'guard'],
  },
  {
    title: 'META',
    skills: ['gstack-upgrade'],
  },
];

// ─── HTML Generation ───────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDescription(name: string, fullDesc: string): string {
  return SHORT_DESCRIPTIONS[name] || autoCondense(fullDesc);
}

// ─── Main ──────────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

// Discover all skills and parse frontmatter
const skillMap = new Map<string, { name: string; description: string }>();

for (const relPath of discoverSkillFiles(ROOT)) {
  const fullPath = path.join(ROOT, relPath);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const { name, description } = extractFrontmatter(content);
  // Skip root gstack skill (it's the browse binary, not a user command)
  if (name && name !== 'gstack') {
    skillMap.set(name, { name, description });
  }
}

// Validate: warn about skills in categories that don't exist
for (const cat of CATEGORIES) {
  for (const s of cat.skills) {
    if (!skillMap.has(s)) {
      console.warn(`WARNING: skill "${s}" in category "${cat.title}" not found in SKILL.md files`);
    }
  }
}

// Warn about discovered skills not in any category
const categorized = new Set(CATEGORIES.flatMap(c => c.skills));
for (const name of skillMap.keys()) {
  if (!categorized.has(name)) {
    console.warn(`WARNING: skill "${name}" found in SKILL.md but not assigned to any category`);
  }
}

// Build category HTML sections
function renderCategory(cat: Category): string {
  const rows = cat.skills
    .filter(s => skillMap.has(s))
    .map(s => {
      const skill = skillMap.get(s)!;
      const displayName = `/${s}`;
      const argHint = s === 'freeze' ? ' &lt;dir&gt;' : '';
      const desc = escapeHtml(getDescription(s, skill.description));
      return `      <div class="row"><span class="cmd">${escapeHtml(displayName)}${argHint}</span> ${desc}</div>`;
    })
    .join('\n');

  return `    <section class="cat">
      <h2>${escapeHtml(cat.title)}</h2>
${rows}
    </section>`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>gstack cheatsheet</title>
<!-- AUTO-GENERATED from SKILL.md frontmatter — do not edit directly -->
<!-- Regenerate: bun run gen:cheatsheet -->
<style>
:root {
  --fg: #1a1a1a;
  --muted: #999;
  --border: #ccc;
  --cmd-bg: #f0f0f0;
}
@media (prefers-color-scheme: dark) {
  :root { --fg: #e5e5e5; --muted: #666; --border: #444; --cmd-bg: #222; }
  body { background: #111; }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font: 13px/1.55 'Geist Mono', 'SF Mono', 'Fira Code', ui-monospace, monospace;
  color: var(--fg);
  padding: 28px 32px;
  max-width: 820px;
  margin: 0 auto;
}
.cat {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px 18px;
  margin-bottom: 10px;
}
.cat h2 {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}
.wf-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}
.wf-head h2 { padding-bottom: 0; border-bottom: none; margin-bottom: 0; }
.ver { font-size: 12px; color: var(--muted); font-weight: 400; }
.pipes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0 2px 16px;
}
.pipe {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.n {
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 7px;
  font-size: 12px;
  white-space: nowrap;
}
.a { color: var(--muted); font-size: 12px; }
.row { padding: 2px 0; }
.cmd {
  font-weight: 700;
  background: var(--cmd-bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.foot {
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  margin-top: 14px;
}
@media print {
  body { padding: 12px; font-size: 11px; }
  .cat { page-break-inside: avoid; margin-bottom: 6px; padding: 8px 12px; }
}
</style>
</head>
<body>
    <section class="cat">
      <div class="wf-head">
        <h2>WORKFLOW</h2>
        <span class="ver">v${escapeHtml(VERSION)}</span>
      </div>
      <div class="pipes">
        <div class="pipe">
          <span class="n">/office-hours</span>
          <span class="a">&rarr;</span>
          <span class="n">/plan-ceo-review</span>
          <span class="a">&rarr;</span>
          <span class="n">/plan-eng-review</span>
          <span class="a">&rarr;</span>
          <span class="n">/plan-design-review</span>
        </div>
        <div class="pipe">
          <span class="n">build</span>
          <span class="a">&rarr;</span>
          <span class="n">/qa</span>
          <span class="a">&rarr;</span>
          <span class="n">/design-review</span>
          <span class="a">&rarr;</span>
          <span class="n">/review</span>
          <span class="a">&rarr;</span>
          <span class="n">/ship</span>
          <span class="a">&rarr;</span>
          <span class="n">/land-and-deploy</span>
          <span class="a">&rarr;</span>
          <span class="n">/retro</span>
        </div>
      </div>
    </section>

${CATEGORIES.filter(c => !HIDDEN_GROUPS.has(c.title)).map(renderCategory).join('\n\n')}

    <div class="foot">Generated from SKILL.md frontmatter &middot; <code>bun run gen:cheatsheet</code></div>
</body>
</html>
`;

// Write or dry-run check
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

if (DRY_RUN) {
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf-8') : '';
  if (existing !== html) {
    console.log(`STALE: ${path.relative(ROOT, OUTPUT)}`);
    process.exit(1);
  }
  console.log(`FRESH: ${path.relative(ROOT, OUTPUT)}`);
} else {
  fs.writeFileSync(OUTPUT, html);
  const visible = CATEGORIES.filter(c => !HIDDEN_GROUPS.has(c.title));
  const skillCount = visible.reduce((n, c) => n + c.skills.filter(s => skillMap.has(s)).length, 0);
  console.log(`GENERATED: ${path.relative(ROOT, OUTPUT)}`);
  console.log(`  Skills: ${skillCount} (${skillMap.size} discovered, ${skillMap.size - categorized.size} uncategorized)`);
  console.log(`  Categories: ${visible.length}/${CATEGORIES.length}`);
  console.log(`  Version: v${VERSION}`);
  if (HIDDEN_GROUPS.size > 0) {
    console.log(`  Hidden: ${[...HIDDEN_GROUPS].join(', ')}`);
  }
  console.log('');
  const groupNames = CATEGORIES.map(c => c.title.toLowerCase().replace(/ & /g, '-').replace(/ /g, '-'));
  console.log(`Tip: hide groups you don't need with --hide ${groupNames.slice(-2).join(',')}`);
  console.log(`  Available groups: ${groupNames.join(', ')}`);
}
