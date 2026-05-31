/**
 * Unit tests for catalog-trim helpers (gen-skill-docs.ts T4 functions).
 *
 * splitCatalogDescription, buildTrimmedDescription, buildWhenToInvokeSection,
 * applyCatalogTrim — these handle every skill's frontmatter rewrite at gen
 * time. Two bugs already shipped here:
 *
 *   v1.45.0.0 design-consultation: when the first sentence exceeded 200 chars,
 *   the routing-prose extraction lost the entire tail. design-consultation's
 *   "Use when asked to..." silently disappeared from the body section.
 *
 *   v1.45.0.0 CI freshness: the root-skill key leaked the checkout directory
 *   name ("seville-v3" vs "gstack") and aggregate order was filesystem-
 *   iteration order. Two machines produced two different JSON files.
 *
 * Both are regression-tested here. Future bugs in these functions surface as
 * unit-test failures before they hit CI or production.
 */

import { describe, test, expect } from 'bun:test';
import {
  splitCatalogDescription,
  buildTrimmedDescription,
  buildWhenToInvokeSection,
  applyCatalogTrim,
} from '../scripts/gen-skill-docs';

describe('splitCatalogDescription', () => {
  test('extracts lead sentence + routing prose from simple multi-line description', () => {
    const desc =
      'Pre-landing PR review. Analyzes diff against the base branch for SQL safety, LLM trust\n' +
      'boundary violations, conditional side effects, and other structural issues. Use when\n' +
      'asked to "review this PR", "code review", "pre-landing review", or "check my diff".\n' +
      'Proactively suggest when the user is about to merge or land code changes. (gstack)';

    const parts = splitCatalogDescription(desc);

    expect(parts.lead).toBe('Pre-landing PR review.');
    expect(parts.hasGstackTag).toBe(true);
    expect(parts.voiceLine).toBeNull();
    expect(parts.routingProse).toContain('Use when');
    expect(parts.routingProse).toContain('Proactively suggest');
    expect(parts.routingProse).toContain('Analyzes diff');
    // (gstack) tag stripped from routingProse
    expect(parts.routingProse).not.toContain('(gstack)');
  });

  test('REGRESSION (design-consultation v1.45.0.0): >200 char first sentence keeps routing', () => {
    // This is the exact shape that broke. First sentence (with embedded periods)
    // is 207 chars. Original bug: routing extraction ran AFTER lead truncation,
    // so collapsed.indexOf(lead) returned -1 (lead ended in "...") and the
    // entire "Use when..." + "Proactively..." tail dropped to empty string.
    const desc =
      'Design consultation: understands your product, researches the landscape, ' +
      'proposes a complete design system (aesthetic, typography, color, layout, ' +
      'spacing, motion), and generates font+color preview pages. ' +
      'Creates DESIGN.md as your project\'s design source of truth. ' +
      'For existing sites, use /plan-design-review to infer the system instead. ' +
      'Use when asked to "design system", "brand guidelines", or "create DESIGN.md". ' +
      'Proactively suggest when starting a new project\'s UI with no existing ' +
      'design system or DESIGN.md. (gstack)';

    const parts = splitCatalogDescription(desc);

    // Lead may be truncated with "..." since it exceeds 200 chars
    expect(parts.lead.length).toBeLessThanOrEqual(205);
    // Critical: routing MUST contain the "Use when..." and "Proactively..." prose
    expect(parts.routingProse).toContain('Use when asked to');
    expect(parts.routingProse).toContain('design system');
    expect(parts.routingProse).toContain('Proactively suggest');
    expect(parts.routingProse).toContain('Creates DESIGN.md');
  });

  test('extracts voice-triggers line when present', () => {
    const desc =
      'Quick fix. Use when asked to fix the bug. ' +
      'Voice triggers (speech-to-text aliases): "fix it", "patch this", "make it work". ' +
      '(gstack)';

    const parts = splitCatalogDescription(desc);

    expect(parts.lead).toBe('Quick fix.');
    expect(parts.voiceLine).toContain('Voice triggers');
    expect(parts.voiceLine).toContain('"fix it"');
    expect(parts.routingProse).toContain('Use when asked to fix');
    // Voice line should NOT leak into routing
    expect(parts.routingProse).not.toContain('speech-to-text');
  });

  test('handles description without (gstack) tag', () => {
    const desc = 'Single sentence description. With routing prose afterward.';
    const parts = splitCatalogDescription(desc);
    expect(parts.lead).toBe('Single sentence description.');
    expect(parts.hasGstackTag).toBe(false);
    expect(parts.routingProse).toBe('With routing prose afterward.');
  });

  test('embedded-period descriptions: known limitation falls back to first-20-words', () => {
    // KNOWN LIMITATION: the sentence regex `^([^.!?]*[.!?])(?:\\s|$)` stops
    // at the FIRST `.`-then-non-whitespace because [^.!?]* is greedy and
    // can't backtrack past a non-period char. For "DESIGN.md and v1.45.0.0
    // in the lead. Use when..." the regex fails entirely and the lead falls
    // back to the first 20 words (~the whole short input).
    //
    // The real-world impact is small: descriptions like "DESIGN.md" or "v1.45"
    // appearing in the middle of the FIRST sentence are rare. When they do
    // occur, the lead simply becomes the full description (no body section
    // generated) — same as a description without a period. The trim CI gate
    // still keeps the per-skill size budget honest.
    //
    // If this gap matters later, replace the regex with a sentence tokenizer
    // (compromise.js / Intl.Segmenter) — until then we accept the fallback.
    const desc =
      'Skill that mentions DESIGN.md and v1.45.0.0 in the lead. ' +
      'Use when asked to do something.';
    const parts = splitCatalogDescription(desc);
    // Actual behavior: lead absorbs the whole input via the word-count fallback.
    expect(parts.lead.length).toBeGreaterThan(0);
    // routingProse may be empty when the fallback consumes everything.
    // The test exists to detect REGRESSIONS (lead becoming oddly short like
    // "Skill that mentions DESIGN.") not to assert ideal behavior.
    expect(parts.lead).toContain('Skill that mentions');
  });

  test('description without a period uses first ~20 words as lead', () => {
    const desc = 'A long fragment with no sentence terminator drifting on and on across many words for an unusual frontmatter shape';
    const parts = splitCatalogDescription(desc);
    expect(parts.lead.length).toBeGreaterThan(0);
    expect(parts.lead.split(/\s+/).length).toBeLessThanOrEqual(21);
  });

  test('idempotent: calling on already-trimmed output returns the same parts', () => {
    const desc = 'Already trimmed. (gstack)';
    const parts1 = splitCatalogDescription(desc);
    const parts2 = splitCatalogDescription(buildTrimmedDescription(parts1));
    // Re-split of a one-line trimmed result keeps lead identical, routing empty.
    expect(parts2.lead).toBe(parts1.lead);
    expect(parts2.hasGstackTag).toBe(true);
    expect(parts2.routingProse).toBe('');
  });
});

describe('buildTrimmedDescription', () => {
  test('appends (gstack) when hasGstackTag is true', () => {
    const out = buildTrimmedDescription({
      lead: 'Some lead.',
      routingProse: 'routing',
      voiceLine: null,
      hasGstackTag: true,
    });
    expect(out).toBe('Some lead. (gstack)');
  });

  test('omits (gstack) when hasGstackTag is false', () => {
    const out = buildTrimmedDescription({
      lead: 'No tag.',
      routingProse: '',
      voiceLine: null,
      hasGstackTag: false,
    });
    expect(out).toBe('No tag.');
  });

  test('trims whitespace from lead', () => {
    const out = buildTrimmedDescription({
      lead: '   Lead with whitespace.   ',
      routingProse: '',
      voiceLine: null,
      hasGstackTag: true,
    });
    expect(out).toBe('Lead with whitespace. (gstack)');
  });
});

describe('buildWhenToInvokeSection', () => {
  test('produces markdown H2 with routing prose and voice line', () => {
    const out = buildWhenToInvokeSection({
      lead: 'Lead.',
      routingProse: 'Use when asked to ship.',
      voiceLine: 'Voice triggers (speech-to-text aliases): "ship it".',
      hasGstackTag: true,
    });
    expect(out).toContain('## When to invoke this skill');
    expect(out).toContain('Use when asked to ship.');
    expect(out).toContain('Voice triggers');
  });

  test('omits routing block when routingProse is empty', () => {
    const out = buildWhenToInvokeSection({
      lead: 'Lead.',
      routingProse: '',
      voiceLine: null,
      hasGstackTag: true,
    });
    expect(out).toContain('## When to invoke this skill');
    expect(out).not.toContain('Use when');
  });

  test('emits even when only voice line is present', () => {
    const out = buildWhenToInvokeSection({
      lead: 'Lead.',
      routingProse: '',
      voiceLine: 'Voice triggers: x.',
      hasGstackTag: true,
    });
    expect(out).toContain('Voice triggers: x.');
  });
});

describe('applyCatalogTrim', () => {
  const minimalSkill = `---
name: example
description: |
  Example skill: this is the first sentence of the description, intended to be
  the lead displayed in the catalog. Use when asked to do an example task.
  Proactively suggest when the user mentions examples. (gstack)
preamble-tier: 2
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# Example body
Original body content here.
`;

  test('rewrites multi-line description into one-line + body section', () => {
    const result = applyCatalogTrim(minimalSkill, 'example');
    expect(result).not.toBeNull();
    const { content, parts } = result!;
    // Frontmatter description is now ONE line ending with (gstack). #1778: a
    // description with an interior colon ("Example skill:") is YAML-quoted, so
    // the value is wrapped in double quotes — tolerate the optional quotes.
    expect(content).toMatch(/^description: "?Example skill:[^\n]*\(gstack\)"?\n/m);
    // Body has the When to invoke section
    expect(content).toContain('## When to invoke this skill');
    expect(content).toContain('Use when asked to do an example task.');
    expect(content).toContain('Proactively suggest when');
    // Original body still present
    expect(content).toContain('# Example body');
    expect(content).toContain('Original body content here.');
    // parts is populated for the aggregator
    expect(parts.lead).toContain('Example skill');
    expect(parts.hasGstackTag).toBe(true);
  });

  test('returns null for already-short descriptions (no-op)', () => {
    const shortSkill = minimalSkill.replace(
      /description: \|[\s\S]*?(?=preamble-tier:)/,
      'description: Already short. (gstack)\n',
    );
    const result = applyCatalogTrim(shortSkill, 'example');
    expect(result).toBeNull();
  });

  test('keeps the newline between description and next YAML field (no field collision)', () => {
    // Bug shape from v1.45.0.0 first attempt: produced
    // `description: ... (gstack)preamble-tier:` with no newline.
    const result = applyCatalogTrim(minimalSkill, 'example');
    expect(result).not.toBeNull();
    expect(result!.content).not.toMatch(/\(gstack\)preamble-tier/);
    expect(result!.content).not.toMatch(/\(gstack\)allowed-tools/);
    // #1778: optional closing quote when the description was YAML-quoted.
    expect(result!.content).toMatch(/\(gstack\)"?\n[a-z-]+:/);
  });

  test('returns null on content without proper frontmatter', () => {
    expect(applyCatalogTrim('no frontmatter here', 'whatever')).toBeNull();
    expect(applyCatalogTrim('---\nincomplete frontmatter', 'whatever')).toBeNull();
  });
});

describe('proactive-suggestions.json determinism (regression for v1.45.0.0 CI freshness fail)', () => {
  test('committed JSON keys are alphabetically sorted', () => {
    // Reads the actual committed file at scripts/proactive-suggestions.json
    // and verifies sort order. Catches regressions to non-sorted output.
    const fs = require('fs');
    const path = require('path');
    const json = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'scripts', 'proactive-suggestions.json'), 'utf-8'),
    );
    const keys = Object.keys(json.skills);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  test('root skill is keyed as "gstack" (not the checkout directory name)', () => {
    // Catches the bug where the root SKILL.md.tmpl's catalog parts get
    // registered under the directory basename ("seville-v3" in a Conductor
    // worktree, "gstack" on CI).
    const fs = require('fs');
    const path = require('path');
    const json = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'scripts', 'proactive-suggestions.json'), 'utf-8'),
    );
    expect(json.skills).toHaveProperty('gstack');
    // The directory the test runs in must NOT appear as a key.
    const repoDir = path.basename(path.resolve(__dirname, '..'));
    if (repoDir !== 'gstack') {
      expect(json.skills).not.toHaveProperty(repoDir);
    }
  });

  test('schema + catalog_mode + note fields are stable', () => {
    const fs = require('fs');
    const path = require('path');
    const json = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'scripts', 'proactive-suggestions.json'), 'utf-8'),
    );
    expect(json).toHaveProperty('$schema');
    expect(json.catalog_mode).toBe('trim');
    expect(typeof json.note).toBe('string');
    // No timestamp field — those cause flapping CI freshness checks.
    expect(json).not.toHaveProperty('generated_at');
    expect(json).not.toHaveProperty('timestamp');
  });
});
