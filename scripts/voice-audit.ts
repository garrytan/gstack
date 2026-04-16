#!/usr/bin/env bun
/**
 * voice-audit: density checker for cave voice compliance in SKILL.md.tmpl files.
 *
 * Reads .tmpl files, splits by ## headers, auto-detects floor-protected sections,
 * computes density metrics (articles, fillers, hedges per 100 words), and reports
 * verbose violations with line numbers.
 *
 * Exit codes: 0 = pass, 1 = density violations found, 2 = config error
 *
 * Usage:
 *   bun run voice:audit                    # audit all templates
 *   bun run voice:audit:diff               # audit only branch-changed templates
 *   bun run voice:audit cso/SKILL.md.tmpl  # audit single file
 *   bun run voice:audit --json             # machine-readable output
 *   bun run voice:audit --fix              # auto-apply verbose phrase substitutions
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

// ─── Types ──────────────────────────────────────────────────

interface Section {
  title: string;
  content: string;
  startLine: number;
  isFloor: boolean;
  isCode: boolean;
  floorReason?: string;
}

interface DensityMetrics {
  wordCount: number;
  articlesPerHundred: number;
  fillersPerHundred: number;
  hedgesPerHundred: number;
  verbosePhraseCount: number;
  flaggedItems: FlaggedItem[];
}

interface FlaggedItem {
  line: number;
  type: 'article' | 'filler' | 'hedge' | 'verbose-phrase';
  match: string;
  context: string;
}

interface TemplateResult {
  file: string;
  wordCount: number;
  sections: number;
  floorSections: number;
  codeSections: number;
  status: 'PASS' | 'WARN' | 'FAIL';
  violations: SectionViolation[];
  fixesApplied?: number;
}

interface SectionViolation {
  section: string;
  startLine: number;
  metrics: DensityMetrics;
  reasons: string[];
}

// ─── Default Thresholds (calibrated in Step 5) ──────────────

// Calibrated from 14 already-compressed templates (commit 6c16229).
// Set at 90th percentile of compressed results to avoid false positives.
const DEFAULT_THRESHOLDS = {
  articlesPerHundred: 4.5,
  fillersPerHundred: 2.0,
  hedgesPerHundred: 2.0,
  verbosePhraseMax: 5,
};

// ─── Verbose Phrase Table (30+ pairs) ───────────────────────

export const VERBOSE_PHRASES: [string, string][] = [
  ['in order to', 'to'],
  ['it is important to note', 'note:'],
  ['it is worth noting', 'note:'],
  ['please note that', 'note:'],
  ['the purpose of', 'why:'],
  ['this approach allows', 'this lets'],
  ['this ensures that', 'ensures'],
  ['this will allow', 'lets'],
  ['as mentioned earlier', '(remove)'],
  ['as mentioned above', '(remove)'],
  ['in this section', '(remove)'],
  ['implement a solution for', 'fix'],
  ['I would recommend', 'recommend:'],
  ['it is recommended that', 'recommend:'],
  ['you can use', 'use'],
  ['we will', 'will'],
  ['we can', 'can'],
  ['the following', 'these'],
  ['comprehensive', 'full'],
  ['straightforward', 'simple'],
  ['leverage', 'use'],
  ['utilize', 'use'],
  ['facilitate', 'enable'],
  ['robust', 'solid'],
  ['crucial', 'key'],
  ['nuanced', 'subtle'],
  ['delve', 'dig'],
  ['in the event that', 'if'],
  ['prior to', 'before'],
  ['subsequent to', 'after'],
  ['at this point in time', 'now'],
  ['due to the fact that', 'because'],
  ['for the purpose of', 'for'],
  ['in the context of', 'in'],
  ['with respect to', 'about'],
  ['on a regular basis', 'regularly'],
  ['take into consideration', 'consider'],
  ['a significant number of', 'many'],
];

// ─── Word Lists ─────────────────────────────────────────────

// Match articles but not CLI flags like -a, -o, or backtick-wrapped code
const ARTICLES = /(?<![-`])\b(a|an|the)\b(?![-`])/gi;
const FILLERS = /\b(just|really|basically|actually|simply|very|quite|rather|somewhat|perhaps|certainly|sure|of course|happy to|I'd be happy)\b/gi;
const HEDGES = /\b(might|could|perhaps|consider|may want to|you might want|it is possible|potentially)\b/gi;

// ─── Floor Detection ────────────────────────────────────────

/**
 * Determine if a section is floor-protected (must stay verbose).
 * Returns the reason string if floor, null otherwise.
 */
export function detectFloor(content: string): string | null {
  // Explicit markers take priority
  if (content.includes('<!-- voice:floor -->') || content.includes('<!-- voice:endfloor -->')) return 'explicit-marker';

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // AskUserQuestion blocks
    if (/\bAskUserQuestion\b/.test(trimmed)) return 'AskUserQuestion';

    // STOP instructions (line starts with STOP or **STOP**)
    if (/^\*?\*?STOP\*?\*?\b/.test(trimmed)) return 'STOP-instruction';

    // Security warnings (line starts with WARNING/CRITICAL/DANGER or bold variants)
    if (/^\*?\*?(WARNING|CRITICAL|DANGER)\*?\*?\b/.test(trimmed)) return 'security-warning';
  }

  // Conditional logic: lines starting with "If " followed by action verbs
  const conditionalPattern = /^(?:[-*]\s+)?If\s+.+(?:\bdo\b|\bthen\b|→|:$)/m;
  if (conditionalPattern.test(content)) return 'conditional-logic';

  return null;
}

// ─── Section Splitting ──────────────────────────────────────

/**
 * Split template content into sections by ## headers.
 * Tracks line numbers and identifies code blocks and floor sections.
 */
export function splitSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let currentTitle = '(preamble)';
  let currentLines: string[] = [];
  let currentStart = 1;
  let inCodeBlock = false;
  let codeBlockDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code blocks
    if (/^```/.test(line.trim())) {
      if (inCodeBlock) {
        codeBlockDepth--;
        if (codeBlockDepth <= 0) inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBlockDepth = 1;
      }
    }

    // New section at ## headers (not inside code blocks)
    if (!inCodeBlock && /^##\s+/.test(line)) {
      if (currentLines.length > 0) {
        const sectionContent = currentLines.join('\n');
        const floorReason = detectFloor(sectionContent);
        sections.push({
          title: currentTitle,
          content: sectionContent,
          startLine: currentStart,
          isFloor: floorReason !== null,
          isCode: false,
          floorReason: floorReason ?? undefined,
        });
      }
      currentTitle = line.replace(/^##\s+/, '').trim();
      currentLines = [];
      currentStart = i + 1;
    } else {
      currentLines.push(line);
    }
  }

  // Last section
  if (currentLines.length > 0) {
    const sectionContent = currentLines.join('\n');
    const floorReason = detectFloor(sectionContent);
    sections.push({
      title: currentTitle,
      content: sectionContent,
      startLine: currentStart,
      isFloor: floorReason !== null,
      isCode: false,
      floorReason: floorReason ?? undefined,
    });
  }

  return sections;
}

// ─── Prose Extraction ───────────────────────────────────────

/**
 * Extract prose from a section, stripping code blocks, YAML frontmatter,
 * markdown tables, and HTML comments.
 */
function extractProse(content: string): { prose: string; lineMap: Map<number, number> } {
  const lines = content.split('\n');
  const proseLines: string[] = [];
  const lineMap = new Map<number, number>(); // prose line -> original line
  let inCode = false;
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // YAML frontmatter
    if (i === 0 && trimmed === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (trimmed === '---') { inFrontmatter = false; }
      continue;
    }

    // Code blocks
    if (/^```/.test(trimmed)) { inCode = !inCode; continue; }
    if (inCode) continue;

    // HTML comments
    if (/^<!--/.test(trimmed)) continue;

    // Markdown tables (pipe-delimited)
    if (/^\|/.test(trimmed)) continue;

    // Headers (already split by)
    if (/^#+\s/.test(trimmed)) continue;

    // Empty lines
    if (trimmed === '') continue;

    // Bullet list markers: strip the marker, keep content
    const stripped = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
    if (stripped.length > 0) {
      lineMap.set(proseLines.length, i);
      proseLines.push(stripped);
    }
  }

  return { prose: proseLines.join('\n'), lineMap };
}

// ─── Density Computation ────────────────────────────────────

/**
 * Compute density metrics for a section's prose content.
 */
export function computeDensity(
  prose: string,
  sectionStartLine: number,
  lineMap: Map<number, number>,
): DensityMetrics {
  const words = prose.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  if (wordCount === 0) {
    return {
      wordCount: 0,
      articlesPerHundred: 0,
      fillersPerHundred: 0,
      hedgesPerHundred: 0,
      verbosePhraseCount: 0,
      flaggedItems: [],
    };
  }

  const flagged: FlaggedItem[] = [];
  const proseLines = prose.split('\n');

  // Count articles
  let articleCount = 0;
  for (let i = 0; i < proseLines.length; i++) {
    const matches = proseLines[i].match(ARTICLES) || [];
    articleCount += matches.length;
    for (const m of matches) {
      flagged.push({
        line: sectionStartLine + (lineMap.get(i) ?? i),
        type: 'article',
        match: m,
        context: proseLines[i].trim().substring(0, 80),
      });
    }
  }

  // Count fillers
  let fillerCount = 0;
  for (let i = 0; i < proseLines.length; i++) {
    const matches = proseLines[i].match(FILLERS) || [];
    fillerCount += matches.length;
    for (const m of matches) {
      flagged.push({
        line: sectionStartLine + (lineMap.get(i) ?? i),
        type: 'filler',
        match: m,
        context: proseLines[i].trim().substring(0, 80),
      });
    }
  }

  // Count hedges
  let hedgeCount = 0;
  for (let i = 0; i < proseLines.length; i++) {
    const matches = proseLines[i].match(HEDGES) || [];
    hedgeCount += matches.length;
    for (const m of matches) {
      flagged.push({
        line: sectionStartLine + (lineMap.get(i) ?? i),
        type: 'hedge',
        match: m,
        context: proseLines[i].trim().substring(0, 80),
      });
    }
  }

  // Count verbose phrases
  let verboseCount = 0;
  const lowerProse = prose.toLowerCase();
  for (const [verbose] of VERBOSE_PHRASES) {
    const regex = new RegExp(verbose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = lowerProse.match(regex) || [];
    verboseCount += matches.length;
    if (matches.length > 0) {
      // Find which line contains the match
      for (let i = 0; i < proseLines.length; i++) {
        if (proseLines[i].toLowerCase().includes(verbose)) {
          flagged.push({
            line: sectionStartLine + (lineMap.get(i) ?? i),
            type: 'verbose-phrase',
            match: verbose,
            context: proseLines[i].trim().substring(0, 80),
          });
        }
      }
    }
  }

  const per100 = (count: number) => (count / wordCount) * 100;

  return {
    wordCount,
    articlesPerHundred: per100(articleCount),
    fillersPerHundred: per100(fillerCount),
    hedgesPerHundred: per100(hedgeCount),
    verbosePhraseCount: verboseCount,
    flaggedItems: flagged,
  };
}

// ─── Fix Mode ───────────────────────────────────────────────

/**
 * Apply deterministic verbose phrase substitutions to content.
 * Only applies outside code blocks and floor sections.
 */
export function applyFixes(content: string): { fixed: string; count: number } {
  const sections = splitSections(content);
  let fixed = content;
  let totalFixes = 0;

  for (const section of sections) {
    if (section.isFloor) continue;

    // Apply verbose phrase substitutions (case-insensitive, preserve surrounding)
    for (const [verbose, replacement] of VERBOSE_PHRASES) {
      if (replacement === '(remove)') {
        const regex = new RegExp(verbose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'gi');
        const before = fixed;
        fixed = fixed.replace(regex, '');
        if (fixed !== before) totalFixes++;
      } else {
        const regex = new RegExp(verbose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const before = fixed;
        fixed = fixed.replace(regex, replacement);
        if (fixed !== before) totalFixes++;
      }
    }

    // Drop standalone articles at start of sentences/bullets (crude but effective)
    // "The template" -> "Template", "A new file" -> "New file"
    fixed = fixed.replace(/^(\s*[-*+]?\s*)(?:The|A|An)\s+/gm, (match, prefix) => {
      totalFixes++;
      return prefix;
    });
  }

  return { fixed, count: totalFixes };
}

// ─── Audit a Single Template ────────────────────────────────

export function auditTemplate(
  filePath: string,
  thresholds = DEFAULT_THRESHOLDS,
): TemplateResult {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Check for voice:skip marker
  if (content.includes('<!-- voice:skip -->')) {
    return {
      file: filePath,
      wordCount: content.split(/\s+/).length,
      sections: 0,
      floorSections: 0,
      codeSections: 0,
      status: 'PASS',
      violations: [],
    };
  }

  const sections = splitSections(content);
  const violations: SectionViolation[] = [];
  let totalWords = 0;

  for (const section of sections) {
    if (section.isFloor || section.isCode) continue;

    const { prose, lineMap } = extractProse(section.content);
    if (prose.trim().length === 0) continue;

    const metrics = computeDensity(prose, section.startLine, lineMap);
    totalWords += metrics.wordCount;

    const reasons: string[] = [];
    if (metrics.articlesPerHundred > thresholds.articlesPerHundred) {
      reasons.push(`articles: ${metrics.articlesPerHundred.toFixed(1)}/100w (max ${thresholds.articlesPerHundred})`);
    }
    if (metrics.fillersPerHundred > thresholds.fillersPerHundred) {
      reasons.push(`fillers: ${metrics.fillersPerHundred.toFixed(1)}/100w (max ${thresholds.fillersPerHundred})`);
    }
    if (metrics.hedgesPerHundred > thresholds.hedgesPerHundred) {
      reasons.push(`hedges: ${metrics.hedgesPerHundred.toFixed(1)}/100w (max ${thresholds.hedgesPerHundred})`);
    }
    if (metrics.verbosePhraseCount > thresholds.verbosePhraseMax) {
      reasons.push(`verbose phrases: ${metrics.verbosePhraseCount} (max ${thresholds.verbosePhraseMax})`);
    }

    if (reasons.length > 0) {
      violations.push({
        section: section.title,
        startLine: section.startLine,
        metrics,
        reasons,
      });
    }
  }

  const floorSections = sections.filter(s => s.isFloor).length;
  const codeSections = sections.filter(s => s.isCode).length;

  return {
    file: filePath,
    wordCount: totalWords,
    sections: sections.length,
    floorSections,
    codeSections,
    status: violations.length > 0 ? 'FAIL' : 'PASS',
    violations,
  };
}

// ─── Find Templates ─────────────────────────────────────────

function findTemplates(root: string, diffOnly: boolean): string[] {
  if (diffOnly) {
    const result = spawnSync('git', ['diff', '--name-only', 'main...HEAD'], {
      encoding: 'utf-8', cwd: root, timeout: 10000,
    });
    const changed = (result.stdout || '').trim().split('\n').filter(Boolean);
    return changed
      .filter(f => f.endsWith('.tmpl'))
      .map(f => path.join(root, f))
      .filter(f => fs.existsSync(f));
  }

  const templates: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'SKILL.md.tmpl') templates.push(full);
    }
  }
  walk(root);
  return templates.sort();
}

// ─── CLI ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fixMode = args.includes('--fix');
  const diffOnly = args.includes('--diff');
  const cleanArgs = args.filter(a => !a.startsWith('--'));

  const root = path.resolve(import.meta.dir, '..');
  let templates: string[];

  if (cleanArgs.length > 0) {
    // Single file mode
    templates = cleanArgs.map(f => path.resolve(f));
    for (const t of templates) {
      if (!fs.existsSync(t)) {
        console.error(`File not found: ${t}`);
        process.exit(2);
      }
    }
  } else {
    templates = findTemplates(root, diffOnly);
  }

  if (templates.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ templates: [], totalWords: 0, status: 'PASS' }));
    } else {
      console.log('No templates found.');
    }
    process.exit(0);
  }

  // Fix mode: apply substitutions, write back, then audit
  if (fixMode) {
    let totalFixes = 0;
    for (const tmpl of templates) {
      const content = fs.readFileSync(tmpl, 'utf-8');
      if (content.includes('<!-- voice:skip -->')) continue;
      const { fixed, count } = applyFixes(content);
      if (count > 0) {
        fs.writeFileSync(tmpl, fixed, 'utf-8');
        const rel = path.relative(root, tmpl);
        console.log(`  ${rel}: ${count} substitutions applied`);
        totalFixes += count;
      }
    }
    console.log(`\n  Total: ${totalFixes} fixes applied across ${templates.length} templates.\n`);
    if (totalFixes === 0) {
      console.log('  No verbose phrases found to fix.\n');
    }
    // Re-audit after fixes
  }

  // Audit all templates
  const results: TemplateResult[] = [];
  let totalWords = 0;
  let failCount = 0;

  for (const tmpl of templates) {
    const result = auditTemplate(tmpl);
    results.push(result);
    totalWords += result.wordCount;
    if (result.status === 'FAIL') failCount++;
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      templates: results.map(r => ({
        file: path.relative(root, r.file),
        wordCount: r.wordCount,
        sections: r.sections,
        floorSections: r.floorSections,
        status: r.status,
        violations: r.violations.map(v => ({
          section: v.section,
          line: v.startLine,
          reasons: v.reasons,
          flagged: v.metrics.flaggedItems.map(f => ({
            line: f.line,
            type: f.type,
            match: f.match,
          })),
        })),
      })),
      totalWords,
      totalTemplates: results.length,
      passing: results.filter(r => r.status === 'PASS').length,
      failing: failCount,
      status: failCount > 0 ? 'FAIL' : 'PASS',
    }, null, 2));
  } else {
    // Human-readable output
    console.log(`\n  voice-audit: ${results.length} templates, ${totalWords} words\n`);
    console.log(`  ${'TEMPLATE'.padEnd(42)} ${'WORDS'.padStart(6)} ${'SECT'.padStart(5)} ${'FLOOR'.padStart(6)} ${'STATUS'.padStart(7)}`);
    console.log(`  ${'─'.repeat(42)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)}`);

    for (const r of results) {
      const rel = path.relative(root, r.file);
      const status = r.status === 'PASS' ? 'PASS' : 'FAIL';
      console.log(`  ${rel.padEnd(42)} ${String(r.wordCount).padStart(6)} ${String(r.sections).padStart(5)} ${String(r.floorSections).padStart(6)} ${status.padStart(7)}`);

      // Show violations with offending lines
      if (r.violations.length > 0) {
        for (const v of r.violations) {
          console.log(`    └─ ${v.section} (line ${v.startLine}): ${v.reasons.join(', ')}`);
          // Show top 3 flagged items per violation
          const top = v.metrics.flaggedItems.slice(0, 3);
          for (const f of top) {
            console.log(`       line ${f.line}: [${f.type}] "${f.match}" in "${f.context}"`);
          }
          if (v.metrics.flaggedItems.length > 3) {
            console.log(`       ... and ${v.metrics.flaggedItems.length - 3} more`);
          }
        }
      }
    }

    console.log(`\n  Total: ${totalWords} words across ${results.length} templates`);
    console.log(`  Passing: ${results.filter(r => r.status === 'PASS').length}/${results.length}`);
    if (failCount > 0) {
      console.log(`  FAILING: ${failCount} templates need compression\n`);
    } else {
      console.log(`  All templates pass voice density check.\n`);
    }
  }

  process.exit(failCount > 0 ? 1 : 0);
}

// Run if executed directly
if (import.meta.main) {
  main();
}
