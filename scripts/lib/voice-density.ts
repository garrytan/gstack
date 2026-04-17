/**
 * voice-density — shared density math for voice-audit (build-time)
 * and caveman-voice-verify Stop hook (runtime).
 *
 * Template audit path: extractProse(template) → computeDensity → checkThresholds
 * Runtime verify path: extractNonFloorText(assistant msg) → computeDensity → checkThresholds
 *
 * Single source of truth for regex patterns, verbose phrase table, and metric math.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────

export interface FlaggedItem {
  line: number;
  type: 'article' | 'filler' | 'hedge' | 'verbose-phrase';
  match: string;
  context: string;
}

export interface DensityMetrics {
  wordCount: number;
  articlesPerHundred: number;
  fillersPerHundred: number;
  hedgesPerHundred: number;
  verbosePhraseCount: number;
  flaggedItems: FlaggedItem[];
}

export interface DensityThresholds {
  articlesPerHundred: number;
  fillersPerHundred: number;
  hedgesPerHundred: number;
  verbosePhraseMax: number;
}

export interface VoiceProfile {
  name: string;
  description?: string;
  directive: { compact: string; full: string };
  priority_instruction?: string;
  density_thresholds?: DensityThresholds;
  verbose_phrases?: [string, string][];
}

export interface ThresholdCheckResult {
  pass: boolean;
  failedMetrics: Array<{ metric: string; actual: number; floor: number }>;
}

// ─── Default Thresholds (template-level, calibrated for voice-audit) ──

/**
 * Template-level defaults. Calibrated from 14 already-compressed templates
 * (commit 6c16229) at 90th percentile to avoid false positives.
 *
 * Runtime thresholds per caveman voice profile are stricter — read from
 * voices/<name>.json density_thresholds object.
 */
export const DEFAULT_THRESHOLDS: DensityThresholds = {
  articlesPerHundred: 4.5,
  fillersPerHundred: 2.0,
  hedgesPerHundred: 2.0,
  verbosePhraseMax: 5,
};

// ─── Verbose Phrase Table ───────────────────────────────────

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
export const ARTICLES = /(?<![-`])\b(a|an|the)\b(?![-`])/gi;
export const FILLERS = /\b(just|really|basically|actually|simply|very|quite|rather|somewhat|perhaps|certainly|sure|of course|happy to|I'd be happy)\b/gi;
export const HEDGES = /\b(might|could|perhaps|consider|may want to|you might want|it is possible|potentially)\b/gi;

// ─── Core Density Computation ───────────────────────────────

/**
 * Compute density metrics for prose text.
 *
 * @param prose — text to score. Caller must strip code blocks, tables, YAML
 *   before passing. Use extractNonFloorText() for runtime (assistant messages)
 *   or voice-audit's extractProse() for templates.
 * @param startLine — optional origin line number for flaggedItems.line
 *   (default 0 for runtime use, section start for template use).
 * @param lineMap — optional mapping from prose line index → original line
 *   (only template audit uses this).
 */
export function computeDensity(
  prose: string,
  startLine: number = 0,
  lineMap: Map<number, number> = new Map(),
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

  const scan = (pattern: RegExp, type: FlaggedItem['type']): number => {
    let count = 0;
    for (let i = 0; i < proseLines.length; i++) {
      const matches = proseLines[i].match(pattern) || [];
      count += matches.length;
      for (const m of matches) {
        flagged.push({
          line: startLine + (lineMap.get(i) ?? i),
          type,
          match: m,
          context: proseLines[i].trim().substring(0, 80),
        });
      }
    }
    return count;
  };

  const articleCount = scan(ARTICLES, 'article');
  const fillerCount = scan(FILLERS, 'filler');
  const hedgeCount = scan(HEDGES, 'hedge');

  // Verbose phrases — substring scan, case-insensitive
  let verboseCount = 0;
  const lowerProse = prose.toLowerCase();
  for (const [verbose] of VERBOSE_PHRASES) {
    const regex = new RegExp(verbose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = lowerProse.match(regex) || [];
    verboseCount += matches.length;
    if (matches.length > 0) {
      for (let i = 0; i < proseLines.length; i++) {
        if (proseLines[i].toLowerCase().includes(verbose)) {
          flagged.push({
            line: startLine + (lineMap.get(i) ?? i),
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

// ─── Threshold Check ────────────────────────────────────────

/**
 * Compare metrics against thresholds. Returns pass=false if ANY metric exceeds.
 */
export function checkThresholds(
  metrics: DensityMetrics,
  thresholds: DensityThresholds,
): ThresholdCheckResult {
  const failed: Array<{ metric: string; actual: number; floor: number }> = [];

  if (metrics.articlesPerHundred > thresholds.articlesPerHundred) {
    failed.push({ metric: 'articlesPerHundred', actual: metrics.articlesPerHundred, floor: thresholds.articlesPerHundred });
  }
  if (metrics.fillersPerHundred > thresholds.fillersPerHundred) {
    failed.push({ metric: 'fillersPerHundred', actual: metrics.fillersPerHundred, floor: thresholds.fillersPerHundred });
  }
  if (metrics.hedgesPerHundred > thresholds.hedgesPerHundred) {
    failed.push({ metric: 'hedgesPerHundred', actual: metrics.hedgesPerHundred, floor: thresholds.hedgesPerHundred });
  }
  if (metrics.verbosePhraseCount > thresholds.verbosePhraseMax) {
    failed.push({ metric: 'verbosePhraseCount', actual: metrics.verbosePhraseCount, floor: thresholds.verbosePhraseMax });
  }

  return { pass: failed.length === 0, failedMetrics: failed };
}

// ─── Runtime Non-Floor Text Extraction ──────────────────────

/**
 * Strip code/tables/frontmatter from assistant output for runtime density scoring.
 *
 * Strips:
 *   - Fenced code blocks (```...```)
 *   - Inline code (backtick-wrapped spans)
 *   - GitHub markdown tables with separator row (|---|---|)
 *   - YAML frontmatter (leading --- ... ---)
 *   - HTML comments
 *
 * Does NOT strip bulleted lists containing `|` (inline pipes in prose).
 * Accepts false-positive risk on 2-line pseudo-tables without separator row.
 */
export function extractNonFloorText(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inCode = false;
  let inFrontmatter = false;

  // Detect table ranges (lines bracketing a |---|---| separator)
  const tableLines = new Set<number>();
  for (let i = 1; i < lines.length - 1; i++) {
    const sep = lines[i].trim();
    if (/^\|[\s\-:|]+\|$/.test(sep) && /-/.test(sep)) {
      // Table detected. Mark header row (i-1), separator (i), and all
      // subsequent contiguous pipe-starting rows as table lines.
      tableLines.add(i - 1);
      tableLines.add(i);
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\|/.test(lines[j])) tableLines.add(j);
        else break;
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // YAML frontmatter (must be at file start)
    if (i === 0 && trimmed === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (trimmed === '---') inFrontmatter = false;
      continue;
    }

    // Fenced code
    if (/^```/.test(trimmed)) { inCode = !inCode; continue; }
    if (inCode) continue;

    // HTML comments (single-line only — multi-line rare in assistant prose)
    if (/^<!--.*-->$/.test(trimmed)) continue;

    // Tables
    if (tableLines.has(i)) continue;

    // Keep the line, but strip inline backtick-wrapped code spans
    kept.push(line.replace(/`[^`]*`/g, ''));
  }

  return kept.join('\n');
}

// ─── Voice Profile Loader ───────────────────────────────────

/**
 * Load a voice profile JSON. Returns null if profile file missing or invalid.
 *
 * @param name — profile name (e.g. "caveman-full"), no .json extension
 * @param cavestackRoot — absolute path to cavestack root (contains voices/ dir)
 */
export function loadProfile(name: string, cavestackRoot: string): VoiceProfile | null {
  try {
    const profilePath = path.join(cavestackRoot, 'voices', `${name}.json`);
    if (!fs.existsSync(profilePath)) return null;
    const content = fs.readFileSync(profilePath, 'utf-8');
    const parsed = JSON.parse(content) as VoiceProfile;
    if (!parsed.name || !parsed.directive) return null;
    return parsed;
  } catch {
    return null;
  }
}
