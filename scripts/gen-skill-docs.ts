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

import { COMMAND_DESCRIPTIONS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import { discoverTemplates, discoverSectionTemplates } from './discover-skills';
import { writeLlmsTxt } from './gen-llms-txt';
import * as fs from 'fs';
import * as path from 'path';
import type { Host, TemplateContext } from './resolvers/types';
import { HOST_PATHS, unwrapResolver } from './resolvers/types';
import { RESOLVERS } from './resolvers/index';
import { externalSkillName, extractHookSafetyProse as _extractHookSafetyProse, extractNameAndDescription as _extractNameAndDescription, condenseOpenAIShortDescription as _condenseOpenAIShortDescription, generateOpenAIYaml as _generateOpenAIYaml } from './resolvers/codex-helpers';
import { generatePlanCompletionAuditShip, generatePlanCompletionAuditReview, generatePlanVerificationExec } from './resolvers/review';
import { ALL_HOST_CONFIGS, ALL_HOST_NAMES, resolveHostArg, getHostConfig } from '../hosts/index';
import type { HostConfig } from './host-config';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── GBrain Detection Override ──────────────────────────────
// When --respect-detection is passed, read ~/.gstack/gbrain-detection.json
// and un-suppress GBRAIN_CONTEXT_LOAD + GBRAIN_SAVE_RESULTS for hosts that
// statically suppress them (claude, codex, slate, factory, opencode,
// openclaw, cursor, kiro). Detection state is produced by
// bin/gstack-gbrain-detect and persisted by `gstack-config gbrain-refresh`
// or by ./setup.
//
// Default (no flag): static suppressedResolvers honored as-is. Used by
// `bun run gen:skill-docs` (CI + canonical checked-in SKILL.md files) so
// the committed output is reproducible regardless of any developer's
// local gbrain installation state. Use `bun run gen:skill-docs:user`
// (which adds --respect-detection) for user-local installs.
const RESPECT_DETECTION = process.argv.includes('--respect-detection');

function loadGbrainOverride(): { detected: boolean } {
  if (!RESPECT_DETECTION) return { detected: false };
  const stateDir = process.env.GSTACK_HOME || path.join(process.env.HOME || '', '.gstack');
  const detectionPath = path.join(stateDir, 'gbrain-detection.json');
  try {
    const json = JSON.parse(fs.readFileSync(detectionPath, 'utf-8')) as { gbrain_local_status?: string };
    return { detected: json.gbrain_local_status === 'ok' };
  } catch {
    return { detected: false };
  }
}

const GBRAIN_OVERRIDE = loadGbrainOverride();

/**
 * Compute effective suppressedResolvers for a host, applying the gbrain
 * detection override when enabled. When the override fires, GBRAIN_*
 * resolvers are removed from the suppression set so they render in the
 * generated SKILL.md.
 */
function effectiveSuppressedResolvers(hostConfig: HostConfig): Set<string> {
  let list = hostConfig.suppressedResolvers || [];
  if (GBRAIN_OVERRIDE.detected) {
    list = list.filter(r => r !== 'GBRAIN_CONTEXT_LOAD' && r !== 'GBRAIN_SAVE_RESULTS');
  }
  return new Set(list);
}

// ─── Host Detection (config-driven) ─────────────────────────

const HOST_ARG = process.argv.find(a => a.startsWith('--host'));
type HostArg = Host | 'all';
const HOST_ARG_VAL: HostArg = (() => {
  if (!HOST_ARG) return 'claude';
  const val = HOST_ARG.includes('=') ? HOST_ARG.split('=')[1] : process.argv[process.argv.indexOf(HOST_ARG) + 1];
  if (val === 'all') return 'all';
  try {
    return resolveHostArg(val) as Host;
  } catch {
    throw new Error(`Unknown host: ${val}. Use ${ALL_HOST_NAMES.join(', ')}, or all.`);
  }
})();

// For single-host mode, HOST is the host. For --host all, it's set per iteration below.
let HOST: Host = HOST_ARG_VAL === 'all' ? 'claude' : HOST_ARG_VAL;

// ─── Model Overlay Selection ────────────────────────────────
// --model is explicit. We do NOT auto-detect from host (host ≠ model).
// Default is 'claude'. Missing overlay file → empty string (graceful).
import { ALL_MODEL_NAMES, resolveModel, type Model } from './models';
const MODEL_ARG = process.argv.find(a => a.startsWith('--model'));
const MODEL_ARG_VAL: Model = (() => {
  if (!MODEL_ARG) return 'claude';
  const val = MODEL_ARG.includes('=') ? MODEL_ARG.split('=')[1] : process.argv[process.argv.indexOf(MODEL_ARG) + 1];
  const resolved = resolveModel(val);
  if (!resolved) {
    throw new Error(`Unknown model: ${val}. Use ${ALL_MODEL_NAMES.join(', ')}, or a family variant (e.g., claude-opus-4-7, gpt-5.4-mini, o3).`);
  }
  return resolved;
})();

// ─── Catalog Mode (v1.45.0.0 T4) ────────────────────────────
// 'trim' (default): shorten frontmatter description to lead sentence,
// move routing/voice prose into a "## When to invoke" body section, and
// emit scripts/proactive-suggestions.json (single file across all skills).
// 'full': legacy v1.44 behavior — full description stays in frontmatter.
const CATALOG_MODE_ARG = process.argv.find(a => a.startsWith('--catalog-mode'));
const CATALOG_MODE: 'trim' | 'full' = (() => {
  if (!CATALOG_MODE_ARG) return 'trim';
  const val = CATALOG_MODE_ARG.includes('=')
    ? CATALOG_MODE_ARG.split('=')[1]
    : process.argv[process.argv.indexOf(CATALOG_MODE_ARG) + 1];
  if (val !== 'trim' && val !== 'full') {
    throw new Error(`Unknown catalog mode: ${val}. Use 'trim' (default) or 'full'.`);
  }
  return val;
})();

// ─── Explain-level Overlay ──────────────────────────────────
// --explain-level=terse compresses preamble prose (writing-style, completeness,
// confusion-protocol, context-health) to a single pointer line at gen time.
// Default keeps the runtime-conditional behavior (sections render unconditionally,
// the model skips them when EXPLAIN_LEVEL: terse appears in the preamble echo).
// Opt-in via the build flag so most users get the runtime-flexible default.
const EXPLAIN_LEVEL_ARG = process.argv.find(a => a.startsWith('--explain-level'));
const EXPLAIN_LEVEL: 'default' | 'terse' = (() => {
  if (!EXPLAIN_LEVEL_ARG) return 'default';
  const val = EXPLAIN_LEVEL_ARG.includes('=')
    ? EXPLAIN_LEVEL_ARG.split('=')[1]
    : process.argv[process.argv.indexOf(EXPLAIN_LEVEL_ARG) + 1];
  if (val !== 'default' && val !== 'terse') {
    throw new Error(`Unknown explain level: ${val}. Use 'default' or 'terse'.`);
  }
  return val;
})();

// ─── Out-dir (dev workspace render isolation) ───────────────
// --out-dir <abs-dir> redirects Claude SKILL.md + section output to a separate
// (untracked) directory instead of writing in place, AND rewrites the literal
// section-base path (`~/.claude/skills/gstack/<skill>/sections/`) inside the
// generated content to point at the out-dir, so section Reads resolve to the
// rendered copy rather than the global install. Used by bin/dev-setup to render
// the gbrain `:user` variant for a Conductor workspace without dirtying tracked
// source. Default (unset) = in-place, behavior unchanged. Claude host only.
const OUT_DIR_ARG = process.argv.find(a => a.startsWith('--out-dir'));
const OUT_DIR: string | null = (() => {
  if (!OUT_DIR_ARG) return null;
  const val = OUT_DIR_ARG.includes('=')
    ? OUT_DIR_ARG.split('=')[1]
    : process.argv[process.argv.indexOf(OUT_DIR_ARG) + 1];
  if (!val) throw new Error('--out-dir requires a directory path');
  return path.resolve(val);
})();

/**
 * When rendering to an out-dir, repoint the literal section-base path at the
 * out-dir so section Reads resolve to the rendered copy, not the global install.
 * Surgical: ONLY paths containing `/sections/` are rewritten — bin/, browse/,
 * docs/ references keep pointing at `~/.claude/skills/gstack` (the global
 * install, which still works). No-op when --out-dir is unset.
 */
function rewriteSectionBase(content: string): string {
  if (!OUT_DIR) return content;
  return content.replace(
    /~\/\.claude\/skills\/gstack\/([^\s)`"'*]+\/sections\/)/g,
    `${OUT_DIR}/$1`,
  );
}

// HostPaths, HOST_PATHS, and TemplateContext imported from ./resolvers/types (line 7-8)
// Design constants (AI_SLOP_BLACKLIST, OPENAI_HARD_REJECTIONS, OPENAI_LITMUS_CHECKS)
// live in ./resolvers/constants and are consumed by resolvers directly.

// ─── External Host Helpers ───────────────────────────────────

// Re-export local copy for use in this file (matches codex-helpers.ts)
// Accepts optional frontmatter name to support directory/invocation name divergence
function externalSkillName(skillDir: string, frontmatterName?: string): string {
  // Root skill (skillDir === '' or '.') always maps to 'gstack' regardless of frontmatter
  if (skillDir === '.' || skillDir === '') return 'gstack';
  // Use frontmatter name when it differs from directory name (e.g., run-tests/ with name: test)
  const baseName = frontmatterName && frontmatterName !== skillDir ? frontmatterName : skillDir;
  // Don't double-prefix: gstack-upgrade → gstack-upgrade (not gstack-gstack-upgrade)
  if (baseName.startsWith('gstack-')) return baseName;
  return `gstack-${baseName}`;
}

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
    description = descLines.join('\n').trim();
  }

  return { name, description };
}

// ─── Voice Trigger Processing ────────────────────────────────

/**
 * Extract voice-triggers YAML list from frontmatter.
 * Returns an array of trigger strings, or [] if no voice-triggers field.
 */
function extractVoiceTriggers(content: string): string[] {
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return [];
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return [];
  const frontmatter = content.slice(fmStart + 4, fmEnd);

  const triggers: string[] = [];
  let inVoice = false;
  for (const line of frontmatter.split('\n')) {
    if (/^voice-triggers:/.test(line)) { inVoice = true; continue; }
    if (inVoice) {
      const m = line.match(/^\s+-\s+"(.+)"$/);
      if (m) triggers.push(m[1]);
      else if (!/^\s/.test(line)) break;
    }
  }
  return triggers;
}

/**
 * Preprocess voice triggers: fold voice-triggers YAML field into description,
 * then strip the field from frontmatter. Must run BEFORE transformFrontmatter
 * and extractNameAndDescription so all hosts see the updated description.
 */
function processVoiceTriggers(content: string): string {
  const triggers = extractVoiceTriggers(content);
  if (triggers.length === 0) return content;

  // Strip voice-triggers block from frontmatter
  content = content.replace(/^voice-triggers:\n(?:\s+-\s+"[^"]*"\n?)*/m, '');

  // Get current description (after stripping voice-triggers, so it's clean)
  const { description } = extractNameAndDescription(content);
  if (!description) return content;

  // Build new description with voice triggers appended
  const voiceLine = `Voice triggers (speech-to-text aliases): ${triggers.map(t => `"${t}"`).join(', ')}.`;
  const newDescription = description + '\n' + voiceLine;

  // Replace old indented description with new in frontmatter
  const oldIndented = description.split('\n').map(l => `  ${l}`).join('\n');
  const newIndented = newDescription.split('\n').map(l => `  ${l}`).join('\n');
  content = content.replace(oldIndented, newIndented);

  return content;
}

// Export for testing
export { extractVoiceTriggers, processVoiceTriggers };

// ─── Catalog Trim (v1.45.0.0 T4) ─────────────────────────────
//
// Frontmatter `description:` blocks today pack: a one-line outcome, "Use when
// asked to..." voice triggers, "Proactively..." routing guidance, and a
// "(gstack)" tag. This pile is the always-loaded catalog surface — every
// session pays for the full text. The catalog trim splits the description
// into a one-line catalog entry (lead sentence + "(gstack)") that stays in
// the frontmatter, and a "## When to invoke" body section that holds the
// routing/voice triggers prose for in-skill discovery. A registry written
// to scripts/proactive-suggestions.json (one entry per skill) makes routing
// available to agents that need it without paying the always-loaded cost.
//
// Opt-out: `--catalog-mode=full` keeps v1.44 behavior (no trim, full
// description in frontmatter). Use when debugging routing regressions or
// when shipping skills to hosts that depend on the legacy fat catalog.

export interface CatalogParts {
  lead: string;            // First sentence — kept in catalog
  routingProse: string;    // "Use when asked to...", "Proactively..." paragraphs
  voiceLine: string | null; // "Voice triggers (speech-to-text aliases): ..." line if present
  hasGstackTag: boolean;
}

export function splitCatalogDescription(description: string): CatalogParts {
  // Voice triggers line (folded in by processVoiceTriggers earlier)
  const voiceMatch = description.match(/Voice triggers \(speech-to-text aliases\):[^\n]+/);
  const voiceLine = voiceMatch ? voiceMatch[0] : null;
  let working = voiceLine ? description.replace(voiceLine, '').trim() : description.trim();

  const hasGstackTag = /\(gstack\)/.test(working);
  if (hasGstackTag) working = working.replace(/\(gstack\)/, '').trim();

  // Lead = first sentence (up to first period followed by space or end of string).
  // We tolerate sentences with embedded periods (URLs, "v1.45.0.0") by requiring
  // the period to be followed by whitespace OR end-of-text.
  // First normalize to single-line for sentence detection, then back out.
  const collapsed = working.replace(/\s+/g, ' ').trim();
  const sentenceMatch = collapsed.match(/^([^.!?]*[.!?])(?:\s|$)/);
  // sentenceLead is the FULL first sentence (no truncation). We compute routing
  // from this position, then optionally truncate the displayed lead afterwards.
  // Truncating first then computing routing was the v1.45.0.0 bug — when the
  // first sentence exceeded 200 chars, the routing extraction would lose the
  // entire tail of the description (design-consultation's "Use when..."
  // routing prose silently dropped).
  const sentenceLead = sentenceMatch ? sentenceMatch[1].trim() : collapsed.split(/\s/).slice(0, 20).join(' ');

  // Routing prose: everything AFTER the first sentence boundary in the collapsed view.
  const leadInCollapsed = collapsed.indexOf(sentenceLead);
  const routingCollapsed = leadInCollapsed >= 0
    ? collapsed.slice(leadInCollapsed + sentenceLead.length).trim()
    : '';

  // Now produce the displayed lead — truncated if too long. The original
  // sentenceLead is preserved for routing extraction below.
  let lead = sentenceLead;
  if (lead.length > 200) {
    const trunc = lead.slice(0, 197);
    const lastSpace = trunc.lastIndexOf(' ');
    lead = (lastSpace > 60 ? trunc.slice(0, lastSpace) : trunc) + '...';
  }
  // Restore line breaks for routing prose by mapping back to original layout.
  // Use original whitespace structure where possible; fall back to collapsed.
  // Anchor recovery on sentenceLead (the untruncated first sentence) — not
  // `lead` (which may have a "..." suffix and won't substring-match `working`).
  let routingProse = routingCollapsed;
  const collapsedLeadIdx = working.replace(/\s+/g, ' ').indexOf(sentenceLead);
  if (collapsedLeadIdx >= 0) {
    let consumed = 0;
    let cut = 0;
    for (let i = 0; i < working.length && consumed < collapsedLeadIdx + sentenceLead.length; i++) {
      if (/\s/.test(working[i])) {
        if (i === 0 || /\s/.test(working[i - 1])) continue;
        consumed += 1;
      } else {
        consumed += 1;
      }
      cut = i + 1;
    }
    const tail = working.slice(cut).trim();
    if (tail.length > 0) routingProse = tail;
  }

  return { lead, routingProse, voiceLine, hasGstackTag };
}

/** Build the catalog-trimmed `description:` block. */
export function buildTrimmedDescription(parts: CatalogParts): string {
  const lead = parts.lead.trim();
  const suffix = parts.hasGstackTag ? ' (gstack)' : '';
  return `${lead}${suffix}`;
}

/** Build the body section that holds the routing/voice prose. */
export function buildWhenToInvokeSection(parts: CatalogParts): string {
  const lines: string[] = ['## When to invoke this skill', ''];
  if (parts.routingProse) {
    lines.push(parts.routingProse);
    lines.push('');
  }
  if (parts.voiceLine) {
    lines.push(parts.voiceLine);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render a string as a YAML inline scalar value (the text after `key: `),
 * quoting only when a plain scalar would be invalid or ambiguous.
 *
 * The bug this guards (#1778): a description like "Ship workflow: detect..."
 * emitted as a plain scalar has an interior ": " that a strict YAML parser
 * (Codex/OpenAI skill loading) reads as a nested mapping and rejects with
 * "mapping values are not allowed in this context". When quoting is needed we
 * fall back to JSON.stringify, which produces a double-quoted scalar that YAML
 * accepts verbatim (YAML is a superset of JSON for flow scalars). Strings that
 * are already valid plain scalars pass through unchanged to keep regen diffs small.
 */
export function toYamlInlineScalar(s: string): string {
  const needsQuote =
    s.length === 0 ||
    s !== s.trim() ||                       // leading/trailing whitespace
    /:(\s|$)/.test(s) ||                    // "foo: bar" / trailing colon → mapping ambiguity
    /\s#/.test(s) ||                        // " #" → inline comment
    /^[\s>|&*!%@`"'#,\[\]{}?-]/.test(s);    // leading YAML indicator char
  return needsQuote ? JSON.stringify(s) : s;
}

/**
 * Apply catalog trim to a SKILL.md body:
 *  - shorten frontmatter `description:` to lead + (gstack)
 *  - insert "## When to invoke" body section AFTER the generated header
 *    (so it lands near the top of body content, where routing guidance
 *    belongs)
 *
 * Returns the rewritten content plus the parts (used for proactive-suggestions
 * JSON aggregation at the end of the run).
 */
export function applyCatalogTrim(content: string, skillName: string): { content: string; parts: CatalogParts } | null {
  // Locate description block in frontmatter
  if (!content.startsWith('---\n')) return null;
  const fmEnd = content.indexOf('\n---', 4);
  if (fmEnd === -1) return null;
  const frontmatter = content.slice(4, fmEnd);

  // Match `description: |` block + indented body lines
  const descMatch = frontmatter.match(/^description:\s*\|?\s*\n((?:\s{2,}.*(?:\n|$))+)/m)
                    || frontmatter.match(/^description:\s+(.+)$/m);
  if (!descMatch) return null;

  // Extract full description text
  let descText: string;
  if (descMatch[0].startsWith('description: |') || /^description:\s*\|/.test(descMatch[0])) {
    descText = descMatch[1].split('\n').map(l => l.replace(/^\s{2}/, '')).join('\n').trim();
  } else {
    descText = descMatch[1].trim();
  }

  // Skip skills with very short descriptions (already trimmed or no routing prose).
  // Below ~120 chars, splitting adds no value.
  if (descText.length < 120) return null;

  const parts = splitCatalogDescription(descText);
  // If lead + (gstack) is already most of the text, no trim needed.
  const trimmedLen = buildTrimmedDescription(parts).length;
  if (trimmedLen >= descText.length - 20) return null;

  // Replace description in frontmatter — keep trailing newline so the next
  // YAML field doesn't collide on the same line as the description value.
  // Quote the value when it would be an invalid YAML plain scalar (the common
  // case: an interior ": " like "Ship workflow: detect..." which a strict YAML
  // parser reads as a nested mapping and rejects — #1778). toYamlInlineScalar
  // only quotes when needed, so descriptions without special chars stay plain.
  const newDesc = buildTrimmedDescription(parts);
  // Function replacer (not a string) so a `$` in the description — e.g. a future
  // skill referencing `$B`/`$D` — can't be interpreted as a `$&`/`$1` replacement
  // pattern and silently corrupt the frontmatter.
  const newDescLine = `description: ${toYamlInlineScalar(newDesc)}\n`;
  const newFrontmatter = frontmatter.replace(descMatch[0], () => newDescLine);
  let newContent = '---\n' + newFrontmatter + content.slice(fmEnd);

  // Insert body section after frontmatter (after the closing ---\n and any
  // existing GENERATED header). We insert before the first non-comment line.
  const bodyStart = newContent.indexOf('\n---\n') + 5;
  const whenToInvoke = '\n' + buildWhenToInvokeSection(parts).trim() + '\n';
  // Skip past the generated header if present (it lives after frontmatter close)
  const headerMatch = newContent.slice(bodyStart).match(/^(<!--[^>]*-->\s*\n)+/);
  const insertAt = bodyStart + (headerMatch ? headerMatch[0].length : 0);
  newContent = newContent.slice(0, insertAt) + whenToInvoke + '\n' + newContent.slice(insertAt);

  return { content: newContent, parts };
}

const OPENAI_SHORT_DESCRIPTION_LIMIT = 120;

function condenseOpenAIShortDescription(description: string): string {
  const firstParagraph = description.split(/\n\s*\n/)[0] || description;
  const collapsed = firstParagraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= OPENAI_SHORT_DESCRIPTION_LIMIT) return collapsed;

  const truncated = collapsed.slice(0, OPENAI_SHORT_DESCRIPTION_LIMIT - 3);
  const lastSpace = truncated.lastIndexOf(' ');
  const safe = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  return `${safe}...`;
}

function generateOpenAIYaml(displayName: string, shortDescription: string): string {
  return `interface:
  display_name: ${JSON.stringify(displayName)}
  short_description: ${JSON.stringify(shortDescription)}
  default_prompt: ${JSON.stringify(`Use ${displayName} for this task.`)}
policy:
  allow_implicit_invocation: true
`;
}

/**
 * Transform frontmatter for external hosts.
 * Claude: strips `sensitive:` field (only Factory uses it).
 * Codex: keeps name + description only, enforces 1024-char limit.
 * Factory: keeps name + description + user-invocable, conditionally adds disable-model-invocation.
 */
function transformFrontmatter(content: string, host: Host): string {
  const hostConfig = getHostConfig(host);
  const fm = hostConfig.frontmatter;

  if (fm.mode === 'denylist') {
    // Denylist mode: strip listed fields, keep everything else
    for (const field of fm.stripFields || []) {
      if (field === 'voice-triggers') {
        content = content.replace(/^voice-triggers:\n(?:\s+-\s+"[^"]*"\n?)*/m, '');
      } else {
        content = content.replace(new RegExp(`^${field}:\\s*.*\\n`, 'm'), '');
      }
    }
    return content;
  }

  // Allowlist mode: reconstruct frontmatter with only allowed fields
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return content;
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return content;
  const frontmatter = content.slice(fmStart + 4, fmEnd);
  const body = content.slice(fmEnd + 4);
  const { name, description } = extractNameAndDescription(content);

  // Description limit enforcement
  if (fm.descriptionLimit) {
    const behavior = fm.descriptionLimitBehavior || 'error';
    if (description.length > fm.descriptionLimit) {
      if (behavior === 'error') {
        throw new Error(
          `${hostConfig.displayName} description for "${name}" is ${description.length} chars (max ${fm.descriptionLimit}). ` +
          `Compress the description in the .tmpl file.`
        );
      } else if (behavior === 'warn') {
        console.warn(`WARNING: ${hostConfig.displayName} description for "${name}" exceeds ${fm.descriptionLimit} chars`);
      }
      // 'truncate' — silently proceed
    }
  }

  // Build frontmatter with allowed fields
  const indentedDesc = description.split('\n').map(l => `  ${l}`).join('\n');
  let newFm = `---\nname: ${name}\ndescription: |\n${indentedDesc}\n`;

  // Add extra fields (host-wide)
  if (fm.extraFields) {
    for (const [key, value] of Object.entries(fm.extraFields)) {
      if (key !== 'name' && key !== 'description') {
        newFm += `${key}: ${value}\n`;
      }
    }
  }

  // Add conditional fields
  if (fm.conditionalFields) {
    for (const rule of fm.conditionalFields) {
      const match = Object.entries(rule.if).every(([k, v]) =>
        new RegExp(`^${k}:\\s*${v}`, 'm').test(frontmatter)
      );
      if (match) {
        for (const [key, value] of Object.entries(rule.add)) {
          newFm += `${key}: ${value}\n`;
        }
      }
    }
  }

  // Preserve additional keepFields beyond name and description
  if (fm.keepFields) {
    for (const field of fm.keepFields) {
      if (field === 'name' || field === 'description') continue;
      // Match YAML field with possible multi-line/array value (indented lines after colon)
      const fieldMatch = frontmatter.match(new RegExp(`^${field}:(.*(?:\\n(?:[ \\t]+.+))*)`, 'm'));
      if (fieldMatch) {
        newFm += `${field}:${fieldMatch[1]}\n`;
      }
    }
  }

  // Rename fields (copy values from template frontmatter with new keys)
  if (fm.renameFields) {
    for (const [oldName, newName] of Object.entries(fm.renameFields)) {
      const fieldMatch = frontmatter.match(new RegExp(`^${oldName}:(.+(?:\\n(?:\\s+.+)*)?)`, 'm'));
      if (fieldMatch) {
        newFm += `${newName}:${fieldMatch[1]}\n`;
      }
    }
  }

  newFm += '---';
  return newFm + body;
}

/**
 * Extract hook descriptions from frontmatter for inline safety prose.
 * Returns a description of what the hooks do, or null if no hooks.
 */
function extractHookSafetyProse(tmplContent: string): string | null {
  if (!tmplContent.match(/^hooks:/m)) return null;

  // Parse the hook matchers to build a human-readable safety description
  const matchers: string[] = [];
  const matcherRegex = /matcher:\s*"(\w+)"/g;
  let m;
  while ((m = matcherRegex.exec(tmplContent)) !== null) {
    if (!matchers.includes(m[1])) matchers.push(m[1]);
  }

  if (matchers.length === 0) return null;

  // Build safety prose based on what tools are hooked
  const toolDescriptions: Record<string, string> = {
    Bash: 'check bash commands for destructive operations (rm -rf, DROP TABLE, force-push, git reset --hard, etc.) before execution',
    Edit: 'verify file edits are within the allowed scope boundary before applying',
    Write: 'verify file writes are within the allowed scope boundary before applying',
  };

  const safetyChecks = matchers
    .map(t => toolDescriptions[t] || `check ${t} operations for safety`)
    .join(', and ');

  return `> **Safety Advisory:** This skill includes safety checks that ${safetyChecks}. When using this skill, always pause and verify before executing potentially destructive operations. If uncertain about a command's safety, ask the user for confirmation before proceeding.`;
}

// ─── External Host Config (now derived from hosts/*.ts) ──────
// EXTERNAL_HOST_CONFIG replaced by getHostConfig() from hosts/index.ts

// ─── Template Processing ────────────────────────────────────

const GENERATED_HEADER = `<!-- AUTO-GENERATED from {{SOURCE}} — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n`;

/**
 * Apply a host's configured path + tool rewrites. Extracted so both SKILL.md
 * (via processExternalHost) and section files (via processSectionTemplate) get
 * identical per-host treatment — a section's cross-references must rewrite the
 * same way the parent skill's do, or external hosts get wrong paths.
 */
function applyHostRewrites(content: string, hostConfig: HostConfig): string {
  let result = content;
  for (const rewrite of hostConfig.pathRewrites) {
    result = result.replaceAll(rewrite.from, rewrite.to);
  }
  if (hostConfig.toolRewrites) {
    for (const [from, to] of Object.entries(hostConfig.toolRewrites)) {
      result = result.replaceAll(from, to);
    }
  }
  return result;
}

/**
 * Resolve {{PLACEHOLDER}} / {{NAME:arg}} tokens against the RESOLVERS registry,
 * honoring host suppression and appliesTo gating, then assert nothing is left
 * unresolved. Extracted so SKILL.md and section templates resolve through the
 * exact same path — a security/sanitization fix to one can't miss the other.
 */
function resolvePlaceholders(
  tmplContent: string,
  ctx: TemplateContext,
  hostConfig: HostConfig,
  relTmplPath: string,
): string {
  // effectiveSuppressedResolvers() honors --respect-detection: when gbrain is
  // detected locally, GBRAIN_* resolvers un-suppress. Shared by SKILL.md and
  // section generation so both paths get the same gbrain-aware behavior.
  const suppressed = effectiveSuppressedResolvers(hostConfig);
  const onePass = (input: string): string =>
    input.replace(/\{\{(\w+(?::[^}]+)?)\}\}/g, (_match, fullKey) => {
      const parts = fullKey.split(':');
      const resolverName = parts[0];
      const args = parts.slice(1);
      if (suppressed.has(resolverName)) return '';
      const entry = RESOLVERS[resolverName];
      if (!entry) throw new Error(`Unknown placeholder {{${resolverName}}} in ${relTmplPath}`);
      const { resolve, appliesTo } = unwrapResolver(entry);
      if (appliesTo && !appliesTo(ctx)) return '';
      return args.length > 0 ? resolve(ctx, args) : resolve(ctx);
    });

  // Multi-pass: a resolver may emit content that itself contains {{TOKENS}} — the
  // {{SECTION:id}} resolver inlines a section template (with its own resolvers)
  // for non-Claude hosts. .replace() doesn't re-scan inserted text, so loop until
  // the output stabilizes. Bounded to avoid an infinite loop if a resolver ever
  // emits its own placeholder; 6 passes is far more nesting than any skill needs.
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

/**
 * Build the TemplateContext from a template's frontmatter. Shared by SKILL.md
 * and section generation so sections inherit the SAME context the parent skill
 * resolves with (skillName, tier, benefitsFrom, interactive) — enforced by
 * test/template-context-parity.test.ts. skillNameOverride lets section
 * generation pin the parent skill's name instead of deriving "sections".
 */
function buildContext(
  tmplContent: string,
  tmplPath: string,
  host: Host,
  skillNameOverride?: string,
): TemplateContext {
  const { name: extractedName } = extractNameAndDescription(tmplContent);
  const skillName = skillNameOverride || extractedName || path.basename(path.dirname(tmplPath));
  const benefitsMatch = tmplContent.match(/^benefits-from:\s*\[([^\]]*)\]/m);
  const benefitsFrom = benefitsMatch
    ? benefitsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const tierMatch = tmplContent.match(/^preamble-tier:\s*(\d+)$/m);
  const preambleTier = tierMatch ? parseInt(tierMatch[1], 10) : undefined;
  const interactiveMatch = tmplContent.match(/^interactive:\s*(true|false)\s*$/m);
  const interactive = interactiveMatch ? interactiveMatch[1] === 'true' : undefined;
  return {
    skillName, tmplPath, benefitsFrom, host, paths: HOST_PATHS[host],
    preambleTier, model: MODEL_ARG_VAL, interactive, explainLevel: EXPLAIN_LEVEL,
  };
}

/**
 * Process external host output: routing, frontmatter, path rewrites, metadata.
 * Shared between Codex and Factory (and future external hosts).
 */
function processExternalHost(
  content: string,
  tmplContent: string,
  host: Host,
  skillDir: string,
  extractedDescription: string,
  ctx: TemplateContext,
  frontmatterName?: string,
): { content: string; outputPath: string; outputDir: string; symlinkLoop: boolean } {
  const hostConfig = getHostConfig(host);

  const name = externalSkillName(skillDir === '.' ? '' : skillDir, frontmatterName);
  const outputDir = path.join(ROOT, hostConfig.hostSubdir, 'skills', name);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'SKILL.md');

  // Guard against symlink loops
  let symlinkLoop = false;
  const claudePath = ctx.tmplPath.replace(/\.tmpl$/, '');
  try {
    const resolvedClaude = fs.realpathSync(claudePath);
    const resolvedExternal = fs.realpathSync(path.dirname(outputPath)) + '/' + path.basename(outputPath);
    if (resolvedClaude === resolvedExternal) {
      symlinkLoop = true;
    }
  } catch {
    // realpathSync fails if file doesn't exist yet — no symlink loop
  }

  // Extract hook safety prose BEFORE transforming frontmatter (which strips hooks)
  const safetyProse = extractHookSafetyProse(tmplContent);

  // Transform frontmatter (host-aware)
  let result = transformFrontmatter(content, host);

  // Insert safety advisory at the top of the body (after frontmatter)
  if (safetyProse) {
    const bodyStart = result.indexOf('\n---') + 4;
    result = result.slice(0, bodyStart) + '\n' + safetyProse + '\n' + result.slice(bodyStart);
  }

  // Config-driven path + tool rewrites (shared with processSectionTemplate so
  // section cross-references get the same per-host treatment as SKILL.md).
  result = applyHostRewrites(result, hostConfig);

  // Config-driven: generate metadata (e.g., openai.yaml for Codex)
  if (hostConfig.generation.generateMetadata && !symlinkLoop) {
    const agentsDir = path.join(outputDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const shortDescription = condenseOpenAIShortDescription(extractedDescription);
    fs.writeFileSync(path.join(agentsDir, 'openai.yaml'), generateOpenAIYaml(name, shortDescription));
  }

  return { content: result, outputPath, outputDir, symlinkLoop };
}

function processTemplate(tmplPath: string, host: Host = 'claude'): { outputPath: string; content: string; symlinkLoop?: boolean; catalogParts?: CatalogParts | null } {
  const tmplContent = fs.readFileSync(tmplPath, 'utf-8');
  const relTmplPath = path.relative(ROOT, tmplPath);
  let outputPath = tmplPath.replace(/\.tmpl$/, '');

  // Determine skill directory relative to ROOT
  const skillDir = path.relative(ROOT, path.dirname(tmplPath));

  // --out-dir (Claude only): mirror the skill tree into the out-dir instead of
  // writing in place. External hosts compute their own paths below.
  if (OUT_DIR && host === 'claude') {
    outputPath = path.join(OUT_DIR, skillDir, path.basename(tmplPath).replace(/\.tmpl$/, ''));
  }

  // Extract name/description: name drives external skill naming + setup symlinks
  // (and TemplateContext.skillName via buildContext); description feeds external
  // host metadata. When frontmatter name: differs from directory name (e.g.
  // run-tests/ with name: test), the frontmatter name wins.
  const { name: extractedName, description: extractedDescription } = extractNameAndDescription(tmplContent);

  const currentHostConfig = getHostConfig(host);
  const ctx = buildContext(tmplContent, tmplPath, host);
  const skillName = ctx.skillName;

  // Replace placeholders + assert none remain (shared path with section generation).
  let content = resolvePlaceholders(tmplContent, ctx, currentHostConfig, relTmplPath);

  // Preprocess voice triggers: fold into description, strip field from frontmatter.
  // Must run BEFORE transformFrontmatter so all hosts see the updated description,
  // and BEFORE extractedDescription is used by external host metadata.
  content = processVoiceTriggers(content);

  // Re-extract description AFTER voice trigger preprocessing so Codex openai.yaml
  // metadata gets the updated description with voice triggers included.
  const postProcessDescription = extractNameAndDescription(content).description;

  // For Claude: strip sensitive: field (only Factory uses it)
  // For external hosts: route output, transform frontmatter, rewrite paths
  let symlinkLoop = false;
  if (host === 'claude') {
    content = transformFrontmatter(content, host);
  } else {
    const result = processExternalHost(content, tmplContent, host, skillDir, postProcessDescription, ctx, extractedName || undefined);
    content = result.content;
    outputPath = result.outputPath;
    symlinkLoop = result.symlinkLoop;
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

  // Catalog trim (Claude only — external hosts have their own frontmatter shapes)
  let catalogParts: CatalogParts | null = null;
  if (host === 'claude' && CATALOG_MODE === 'trim') {
    const trimmed = applyCatalogTrim(content, skillName);
    if (trimmed) {
      content = trimmed.content;
      catalogParts = trimmed.parts;
    }
  }

  // --out-dir: repoint section-base paths to the out-dir (no-op otherwise).
  if (host === 'claude') content = rewriteSectionBase(content);

  return { outputPath, content, symlinkLoop, catalogParts };
}

/**
 * Generate one on-demand section file (`<skill>/sections/<name>.md.tmpl` →
 * `<name>.md`). Sections are BODY FRAGMENTS — no frontmatter, no catalog trim,
 * no voice triggers. They resolve placeholders through the SAME path as
 * SKILL.md (resolvePlaceholders) using the PARENT skill's TemplateContext
 * (so appliesTo gating + tier behave identically — a section's {{PREAMBLE}}-
 * style resolver renders the same content it would in the parent, not empty).
 *
 * Output routing mirrors SKILL.md: Claude writes in-tree at
 * `<skill>/sections/<name>.md`; external hosts write to
 * `<hostSubdir>/skills/<externalName>/sections/<name>.md`. External hosts get
 * applyHostRewrites so cross-references resolve per host.
 */
function processSectionTemplate(
  sectionTmplPath: string,
  skillDir: string,
  host: Host = 'claude',
): { outputPath: string; content: string } {
  const tmplContent = fs.readFileSync(sectionTmplPath, 'utf-8');
  const relTmplPath = path.relative(ROOT, sectionTmplPath);
  const hostConfig = getHostConfig(host);

  // Read the owning SKILL.md.tmpl so the section inherits the parent's name +
  // tier + benefits-from (TemplateContext parity). Fall back to the dir name.
  const parentTmplPath = path.join(ROOT, skillDir, 'SKILL.md.tmpl');
  const parentContent = fs.existsSync(parentTmplPath) ? fs.readFileSync(parentTmplPath, 'utf-8') : '';
  const parentName = (parentContent && extractNameAndDescription(parentContent).name) || skillDir;
  const ctx = buildContext(parentContent || tmplContent, parentTmplPath, host, parentName);

  // Resolve placeholders against the section body (shared guard catches stragglers).
  let content = resolvePlaceholders(tmplContent, ctx, hostConfig, relTmplPath);

  // External hosts: rewrite cross-reference paths/tools (no frontmatter to transform).
  if (host !== 'claude') {
    content = applyHostRewrites(content, hostConfig);
  } else {
    // --out-dir: a section may cross-reference another section by absolute path;
    // repoint those to the out-dir too (no-op when --out-dir is unset).
    content = rewriteSectionBase(content);
  }

  // Plain generated header (no frontmatter to insert after).
  content = GENERATED_HEADER.replace('{{SOURCE}}', path.basename(sectionTmplPath)) + content;

  const fileName = path.basename(sectionTmplPath).replace(/\.tmpl$/, '');
  let outputPath: string;
  if (host === 'claude') {
    outputPath = path.join(OUT_DIR || ROOT, skillDir, 'sections', fileName);
  } else {
    const externalName = externalSkillName(skillDir, parentName);
    outputPath = path.join(ROOT, hostConfig.hostSubdir, 'skills', externalName, 'sections', fileName);
  }
  if (!DRY_RUN) fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  return { outputPath, content };
}

// ─── Main ───────────────────────────────────────────────────

function findTemplates(): string[] {
  return discoverTemplates(ROOT).map(t => path.join(ROOT, t.tmpl));
}

const ALL_HOSTS: Host[] = ALL_HOST_NAMES as Host[];
const hostsToRun: Host[] = HOST_ARG_VAL === 'all' ? ALL_HOSTS : [HOST];
const failures: { host: string; error: Error }[] = [];

for (const currentHost of hostsToRun) {
  HOST = currentHost;

  try {
    let hasChanges = false;
    const tokenBudget: Array<{ skill: string; lines: number; tokens: number }> = [];

    // T4 catalog trim: collect routing/voice parts across all Claude skills,
    // then write scripts/proactive-suggestions.json once per gen-skill-docs run.
    const proactiveAggregate: Record<string, {
      lead: string;
      routing: string;
      voice_line: string | null;
    }> = {};

    const currentHostConfig = getHostConfig(currentHost);
    for (const tmplPath of findTemplates()) {
      const dir = path.basename(path.dirname(tmplPath));

      // includeSkills allowlist (union logic: include minus skip)
      if (currentHostConfig.generation.includeSkills?.length) {
        if (!currentHostConfig.generation.includeSkills.includes(dir)) continue;
      }
      // skipSkills denylist (subtracts from includeSkills or full set)
      if (currentHostConfig.generation.skipSkills?.length) {
        if (currentHostConfig.generation.skipSkills.includes(dir)) continue;
      }

      const { outputPath, content, symlinkLoop, catalogParts } = processTemplate(tmplPath, currentHost);
      if (catalogParts) {
        // Root-skill detection: when the template lives at ROOT/SKILL.md.tmpl,
        // path.basename(path.dirname(tmplPath)) returns the repo's directory
        // name (e.g. "seville-v3" in a Conductor worktree, "gstack" on CI).
        // That's non-deterministic across machines and breaks CI freshness
        // checks. Use the frontmatter `name` field as the registry key — the
        // root SKILL.md.tmpl declares `name: gstack` explicitly. For all other
        // skills, `dir` matches the directory name which matches the
        // frontmatter name by convention.
        const isRoot = path.dirname(tmplPath) === ROOT;
        const key = isRoot ? 'gstack' : dir;
        proactiveAggregate[key] = {
          lead: catalogParts.lead,
          routing: catalogParts.routingProse,
          voice_line: catalogParts.voiceLine,
        };
      }
      const relOutput = path.relative(OUT_DIR || ROOT, outputPath);

      if (symlinkLoop) {
        console.log(`SKIPPED (symlink loop): ${relOutput}`);
      } else if (DRY_RUN) {
        const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
        if (existing !== content) {
          console.log(`STALE: ${relOutput}`);
          hasChanges = true;
        } else {
          console.log(`FRESH: ${relOutput}`);
        }
      } else {
        // In-place writes land in existing dirs; --out-dir needs the mirrored
        // skill dir created first.
        if (OUT_DIR) fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, content);
        console.log(`GENERATED: ${relOutput}`);
      }

      // Track token budget
      const lines = content.split('\n').length;
      const tokens = Math.round(content.length / 4); // ~4 chars per token
      tokenBudget.push({ skill: relOutput, lines, tokens });

      // Token ceiling check: warn if any generated SKILL.md exceeds ~40K tokens (160KB).
      // The ceiling is a "watch for feature bloat" guardrail, not a hard gate. Modern
      // flagship models have 200K-1M context windows, so 40K (4-20% of window) is fine.
      // Prompt caching further reduces the marginal cost of larger skills. This ceiling
      // exists to catch a runaway preamble or resolver that's grown by 10K+ tokens in
      // a release, not to force compression on carefully-tuned big skills (ship,
      // plan-ceo-review, office-hours all legitimately pack 25-35K tokens of behavior).
      const TOKEN_CEILING_BYTES = 160_000;
      if (content.length > TOKEN_CEILING_BYTES) {
        console.warn(`⚠️  TOKEN CEILING: ${relOutput} is ${content.length} bytes (~${tokens} tokens), exceeds ${TOKEN_CEILING_BYTES} byte ceiling (~40K tokens)`);
      }
    }

    // ─── Section generation (v2 plan T9, Claude-first carve) ───
    // On-demand sections/*.md for carved skills. Generated for CLAUDE ONLY:
    // every other host inlines section content via the {{SECTION:id}} resolver
    // (keeping the full monolith skill), so they need no section files and we
    // sidestep host-portable section paths until that plumbing lands. No-op for
    // any skill without a sections/ dir. Mirrors the SKILL.md DRY_RUN handling so
    // sections participate in the freshness gate.
    for (const sec of currentHost === 'claude' ? discoverSectionTemplates(ROOT) : []) {
      if (currentHostConfig.generation.includeSkills?.length &&
          !currentHostConfig.generation.includeSkills.includes(sec.skillDir)) continue;
      if (currentHostConfig.generation.skipSkills?.length &&
          currentHostConfig.generation.skipSkills.includes(sec.skillDir)) continue;

      const { outputPath, content } = processSectionTemplate(path.join(ROOT, sec.tmpl), sec.skillDir, currentHost);
      const relOutput = path.relative(OUT_DIR || ROOT, outputPath);

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

      tokenBudget.push({
        skill: relOutput,
        lines: content.split('\n').length,
        tokens: Math.round(content.length / 4),
      });
    }

    // Generate gstack-lite and gstack-full for OpenClaw host
    if (currentHost === 'openclaw' && !DRY_RUN) {
      const openclawDir = path.join(ROOT, 'openclaw');
      if (!fs.existsSync(openclawDir)) fs.mkdirSync(openclawDir, { recursive: true });

      const gstackLite = `# gstack-lite Planning Discipline

Injected by the orchestrator into spawned Claude Code sessions. Append to existing CLAUDE.md.

## Planning Discipline
1. Read every file you will modify. Understand existing patterns first.
2. Before writing code, state your plan: what, why, which files, test case, risk.
3. When ambiguous, prefer: completeness over shortcuts, existing patterns over new ones,
   reversible choices over irreversible ones, safe defaults over clever ones.
4. Self-review your changes before reporting done. Check for: missed files, broken
   imports, untested paths, style inconsistencies.
5. Report when done: what shipped, what decisions you made, anything uncertain.
`;
      fs.writeFileSync(path.join(openclawDir, 'gstack-lite-CLAUDE.md'), gstackLite);
      console.log('GENERATED: openclaw/gstack-lite-CLAUDE.md');

      const gstackFull = `# gstack-full Pipeline

Injected by the orchestrator for complete feature builds. Append to existing CLAUDE.md.

## Full Pipeline
1. Read CLAUDE.md and understand the project context.
2. Run /autoplan to review your approach (CEO + eng + design review pipeline).
3. Implement the approved plan. Follow the planning discipline above.
4. Run /ship to create a PR with tests, changelog, and version bump.
5. Report back: PR URL, what shipped, decisions made, anything uncertain.

Do not ask for human input until the PR is ready for review.
`;
      fs.writeFileSync(path.join(openclawDir, 'gstack-full-CLAUDE.md'), gstackFull);
      console.log('GENERATED: openclaw/gstack-full-CLAUDE.md');

      const gstackPlan = `# gstack-plan: Full Review Gauntlet

Injected by the orchestrator when the user wants to plan a Claude Code project.
Append to existing CLAUDE.md.

## Planning Pipeline
1. Read CLAUDE.md and understand the project context.
2. Run /office-hours to produce a design doc (problem statement, premises, alternatives).
3. Run /autoplan to review the design (CEO + eng + design + DX reviews + codex adversarial).
4. Save the final reviewed plan to a file the orchestrator can reference later.
   Write it to: plans/<project-slug>-plan-<date>.md in the current repo.
   Include the design doc, all review decisions, and the implementation sequence.
5. Report back to the orchestrator:
   - Plan file path
   - One-paragraph summary of what was designed and the key decisions
   - List of accepted scope expansions (if any)
   - Recommended next step (usually: spawn a new session with gstack-full to implement)

Do not implement anything. This is planning only.
The orchestrator will persist the plan link to its own memory/knowledge store.
`;
      fs.writeFileSync(path.join(openclawDir, 'gstack-plan-CLAUDE.md'), gstackPlan);
      console.log('GENERATED: openclaw/gstack-plan-CLAUDE.md');
    }

    if (DRY_RUN && hasChanges) {
      console.error(`\nGenerated SKILL.md files are stale (${currentHost} host). Run: bun run gen:skill-docs --host ${currentHost}`);
      if (HOST_ARG_VAL !== 'all') process.exit(1);
      failures.push({ host: currentHost, error: new Error('Stale files detected') });
    }

    // T4 catalog trim: write aggregated proactive-suggestions.json (Claude only).
    // The JSON registry lets agents pull voice triggers / routing prose for any
    // skill on demand instead of paying for it always-loaded in the catalog.
    //
    // No timestamp field — keeps the file content-deterministic across runs so
    // CI dry-run freshness checks don't flap on regen. If a per-run timestamp
    // is ever needed for debugging, write it to a separate `.gen-stamp` file.
    // Skip the global proactive-suggestions.json in --out-dir mode: it lives at
    // a repo path (scripts/) and the dev workspace render doesn't need it.
    if (currentHost === 'claude' && CATALOG_MODE === 'trim' && Object.keys(proactiveAggregate).length > 0 && !DRY_RUN && !OUT_DIR) {
      const proactivePath = path.join(ROOT, 'scripts', 'proactive-suggestions.json');
      // Sort keys alphabetically so the serialized JSON is identical across
      // machines regardless of filesystem-iteration order. Without this, CI
      // freshness checks fail when the local dev machine and CI runner
      // discover templates in different orders.
      const sortedSkills: typeof proactiveAggregate = {};
      for (const key of Object.keys(proactiveAggregate).sort()) {
        sortedSkills[key] = proactiveAggregate[key];
      }
      const payload = {
        $schema: 'https://gstack.dev/schemas/proactive-suggestions.json',
        catalog_mode: 'trim',
        note: 'Routing / voice-trigger prose extracted from SKILL.md frontmatter descriptions during catalog trim. Loaded on demand when routing guidance is needed.',
        skills: sortedSkills,
      };
      const serialized = JSON.stringify(payload, null, 2) + '\n';
      // Only write if content actually changed — prevents needless touches that
      // would flap CI freshness checks. Read existing file, compare, skip write
      // when identical.
      let existing = '';
      try { existing = fs.readFileSync(proactivePath, 'utf-8'); } catch { /* first run */ }
      if (existing !== serialized) {
        fs.writeFileSync(proactivePath, serialized);
      }
    }

    // Print token budget summary
    if (!DRY_RUN && tokenBudget.length > 0) {
      tokenBudget.sort((a, b) => b.lines - a.lines);
      const totalLines = tokenBudget.reduce((s, t) => s + t.lines, 0);
      const totalTokens = tokenBudget.reduce((s, t) => s + t.tokens, 0);

      console.log('');
      console.log(`Token Budget (${currentHost} host)`);
      console.log('═'.repeat(60));
      for (const t of tokenBudget) {
        const hostSubdirs = ALL_HOST_CONFIGS.map(c => c.hostSubdir.replace('.', '\\.')).join('|');
        const name = t.skill.replace(/\/SKILL\.md$/, '').replace(new RegExp(`^\\.(${hostSubdirs})\\/skills\\/`), '');
        console.log(`  ${name.padEnd(30)} ${String(t.lines).padStart(5)} lines  ~${String(t.tokens).padStart(6)} tokens`);
      }
      console.log('─'.repeat(60));
      console.log(`  ${'TOTAL'.padEnd(30)} ${String(totalLines).padStart(5)} lines  ~${String(totalTokens).padStart(6)} tokens`);
      console.log('');
    }
  } catch (e) {
    failures.push({ host: currentHost, error: e as Error });
    console.error(`WARNING: ${currentHost} generation failed: ${(e as Error).message}`);
  }
}

// --host all: any host failure fails the build. Previously only claude failures
// exited nonzero, which let a stale or broken external-host output (e.g. a
// section that failed to generate for Factory) slip through the freshness gate
// silently. With sections fanned out across every host, "all hosts regenerated
// in the same commit" is only a real gate if every host failure is fatal here.
if (failures.length > 0 && HOST_ARG_VAL === 'all') {
  console.error(`\n${failures.length} host(s) failed: ${failures.map(f => f.host).join(', ')}`);
  process.exit(1);
}
// Single host dry-run failure already handled above

// After all hosts processed, warn if prefix patches may need re-applying
if (!DRY_RUN) {
  try {
    const configPath = path.join(process.env.HOME || '', '.gstack', 'config.yaml');
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf-8');
      if (/^skill_prefix:\s*true/m.test(config)) {
        console.log('\nNote: skill_prefix is true. Run gstack-relink to re-apply name: patches.');
      }
    }
  } catch { /* non-fatal */ }
}

// Regenerate gstack/llms.txt — single-file capability index for AI agents.
// Runs after SKILL.md generation so it sees current skill descriptions and
// browse command list. Wrapped in an IIFE so the await-import doesn't make
// this module async (test/gen-skill-docs.test.ts uses require() to pull
// extractVoiceTriggers/processVoiceTriggers, which fails on async modules).
// Freshness is asserted in test/llms-txt-shape.test.ts.
if (!DRY_RUN) {
  void (async () => {
    try {
      const result = await writeLlmsTxt();
      if (result.warnings.length > 0) {
        for (const w of result.warnings) console.error(`[gen-llms-txt] WARN: ${w}`);
      } else {
        console.log(`[gen-llms-txt] gstack/llms.txt: ${result.skills.length} skills, ${result.browseCommands.length} browse commands`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gen-llms-txt] FAILED: ${msg}`);
    }
  })();
}
