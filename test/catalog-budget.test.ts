import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillCensus } from './helpers/skill-census';

/**
 * Aggregate discovery-surface budget: the sum of every skill's frontmatter
 * `name` + `description` is what EVERY host loads at discovery, every session.
 *
 * This is the missing enforcement layer over the existing catalog-trim
 * mechanism: `applyCatalogTrim` in scripts/gen-skill-docs.ts (~line 865)
 * shapes each description, and the 160KB per-file warn (~line 1015) covers
 * BODY size — neither caps the aggregate frontmatter the catalog is made of.
 *
 * Import-free by design: parses skills' SKILL.md frontmatter directly. Do not
 * import gen-skill-docs internals here — this test must survive generator
 * refactors.
 *
 * Budget derivation (re-derive it, do not trust the number):
 *   ref     this commit
 *   method  for each authored skill (test/helpers/skill-census.ts
 *           authoredSkills — symlink-deduped, root router excluded) plus the
 *           root router's `_gstack-command` alias frontmatter as one separate
 *           line item, run parseFrontmatter() below and sum
 *           Buffer.byteLength(name) + Buffer.byteLength(description);
 *           token-equivalents = ceil(bytes / 4).
 *   result  53 authored skills = 4,371 bytes (1,093 token-equivalents);
 *           + root router alias 49 bytes = 4,420 bytes total
 *           = 1,105 token-equivalents (measured 2026-08-12)
 * Ceiling is 1,150 token-equivalents (4,600 bytes), so headroom is 180 bytes
 * (~4%). Dominant skill: design-consultation at 229 bytes name+description.
 */
const CATALOG_BUDGET_TOKEN_EQUIVALENTS = 1_150;

// Largest today: design-consultation at 229 bytes. A description that needs
// more than 260 bytes is a body paragraph, not a catalog entry.
const PER_SKILL_BYTE_CAP = 260;

const RATCHET_PROTOCOL =
  'Adding a skill? Re-measure with: bun test test/catalog-budget.test.ts ' +
  '(the failure prints the new total). Update CATALOG_BUDGET_TOKEN_EQUIVALENTS ' +
  'AND the derivation comment (ref/date/value/which skill moved it) in the ' +
  'SAME commit. Growing an existing description? Trim it instead — the ' +
  'catalog is what every host loads at discovery, every session.';

const ROOT = join(import.meta.dir, '..');

function parseFrontmatter(body: string): { name: string; description: string } {
  const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  // Folded block scalar (description: >-) with two-space-indented continuation
  // lines, falling back to a single-line description.
  const folded = body.match(/^description:\s*>-?\r?\n((?:  .*\r?\n)+)/m)?.[1];
  const description = folded
    ? folded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' ')
    : body.match(/^description:\s*(?!>-?\s*$)(.+)$/m)?.[1]?.trim() ?? '';
  return { name, description };
}

interface CatalogEntry {
  skill: string;
  name: string;
  description: string;
  bytes: number;
}

function catalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const skill of skillCensus(ROOT).authoredSkills) {
    const body = readFileSync(join(ROOT, skill, 'SKILL.md'), 'utf8');
    const { name, description } = parseFrontmatter(body);
    entries.push({
      skill,
      name,
      description,
      bytes: Buffer.byteLength(name) + Buffer.byteLength(description),
    });
  }
  // The root SKILL.md is a router, registered by setup as the
  // `_gstack-command` alias — not an authored skill, but its frontmatter
  // still ships in the catalog, so it counts as one line item.
  const router = parseFrontmatter(readFileSync(join(ROOT, 'SKILL.md'), 'utf8'));
  if (router.name && router.description) {
    entries.push({
      skill: '(root router)',
      name: router.name,
      description: router.description,
      bytes: Buffer.byteLength(router.name) + Buffer.byteLength(router.description),
    });
  }
  return entries;
}

describe('catalog discovery-surface budget', () => {
  test(`aggregate frontmatter stays within ${CATALOG_BUDGET_TOKEN_EQUIVALENTS} token-equivalents`, () => {
    const entries = catalogEntries();
    const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    const estimatedTokens = Math.ceil(totalBytes / 4);
    const delta = estimatedTokens - CATALOG_BUDGET_TOKEN_EQUIVALENTS;
    expect(
      estimatedTokens,
      `Catalog is ${estimatedTokens} token-equivalents (${totalBytes} bytes), ` +
        `${delta} over the ${CATALOG_BUDGET_TOKEN_EQUIVALENTS} budget. ${RATCHET_PROTOCOL}`
    ).toBeLessThanOrEqual(CATALOG_BUDGET_TOKEN_EQUIVALENTS);
  });

  test(`every skill's name + description stays under ${PER_SKILL_BYTE_CAP} bytes`, () => {
    for (const entry of catalogEntries()) {
      expect(
        entry.bytes,
        `${entry.skill}: name + description is ${entry.bytes} bytes, ` +
          `${entry.bytes - PER_SKILL_BYTE_CAP} over the ${PER_SKILL_BYTE_CAP}-byte ` +
          `per-skill cap. ${RATCHET_PROTOCOL}`
      ).toBeLessThanOrEqual(PER_SKILL_BYTE_CAP);
    }
  });

  test('every skill has a non-empty description', () => {
    for (const entry of catalogEntries()) {
      expect(entry.description, `${entry.skill}: empty or missing frontmatter description`).not.toBe('');
    }
  });
});
