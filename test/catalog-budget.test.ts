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
 *   ref     deslop-shared-libs addition on base a6b3a575 (2026-09-16)
 *   result  pre-addition aggregate 4,593 bytes; deslop-shared-libs adds
 *           82 bytes (name + concise description), yielding 4,675 bytes
 *           = 1,169 token-equivalents including the root router alias.
 * New-skill ratchet: previous ceiling 1,150 + ceil(82 / 4) = 1,171
 * token-equivalents (4,684 bytes), leaving 9 bytes. Existing descriptions
 * are unchanged. Dominant skill: design-consultation at 229 bytes.
 *   ref     test-audit addition on base 943105f1 (2026-09-29)
 *   result  pre-addition aggregate 4,680 bytes; test-audit adds 92 bytes
 *           (name + concise description), yielding 4,772 bytes = 1,193
 *           token-equivalents including the root router alias.
 * New-skill ratchet: previous ceiling 1,171 + ceil(92 / 4) = 1,194
 * token-equivalents (4,776 bytes), leaving 4 bytes. Existing descriptions
 * are unchanged.
 *   ref     eval-plan addition on base 7552362 (2026-10-10)
 *   result  pre-addition aggregate 4,776 bytes; eval-plan adds 10 bytes
 *           (its description is a `|` block scalar, counted as the other
 *           block-scalar skills are), yielding 4,786 bytes = 1,197
 *           token-equivalents including the root router alias.
 * New-skill ratchet: previous ceiling 1,194 + ceil(10 / 4) = 1,197
 * token-equivalents (4,788 bytes), leaving 2 bytes. Existing descriptions
 * are unchanged.
 *   ref     captain addition on base ab9a854b (2026-10-26)
 *   result  pre-addition aggregate 4,786 bytes; captain adds 214 bytes (name
 *           plus the one-sentence catalog lead naming the /crew alias),
 *           yielding 5,000 bytes = 1,250 token-equivalents including the root
 *           router alias.
 * New-skill ratchet: previous ceiling 1,197 + ceil(214 / 4) = 1,251
 * token-equivalents (5,004 bytes), leaving 4 bytes. Existing descriptions
 * are unchanged.
 *   ref     ubicloud addition on base 4d48d39e (2026-10-26)
 *   result  pre-addition aggregate 5,000 bytes; ubicloud adds 150 bytes
 *           (name + the generator's catalog-trimmed one-line description),
 *           yielding 5,150 bytes = 1,288 token-equivalents including the
 *           root router alias.
 * New-skill ratchet: previous ceiling 1,251 + ceil(150 / 4) = 1,289
 * token-equivalents (5,156 bytes), leaving 6 bytes. Existing descriptions
 * are unchanged.
 *   ref     design-motion addition on base 6c5b2d46 (2026-10-27), Garry
 *           2026-10-25 'Do it' (GSTA-92 plan item 15)
 *   result  pre-addition aggregate 5,150 bytes; design-motion adds 99 bytes
 *           (name + the trimmed lead "animate an approved design into a
 *           seamless MP4 and GIF loop"), yielding 5,249 bytes = 1,313
 *           token-equivalents including the root router alias.
 * New-skill ratchet: previous ceiling 1,289 + ceil(99 / 4) = 1,314
 * token-equivalents (5,256 bytes), leaving 7 bytes. Existing descriptions
 * are unchanged.
 *   ref     modernize addition on base d9b0d600 (2026-10-27), Garry
 *           2026-10-26 'Do it, send' (plans/absorb-tstack.md item 3)
 *   result  pre-addition aggregate 5,249 bytes; modernize adds 178 bytes
 *           (name plus the one-sentence catalog lead naming the three
 *           verdicts), yielding 5,427 bytes = 1,357 token-equivalents
 *           including the root router alias.
 * New-skill ratchet: previous ceiling 1,314 + ceil(178 / 4) = 1,359
 * token-equivalents (5,436 bytes), leaving 9 bytes. Existing descriptions
 * are unchanged.
 *   ref     write-skill addition on base 10b77de (2026-10-27), Garry
 *           2026-10-27 'Rec' (GSTA-133 plan, autoplan-20261027230116)
 *   result  pre-addition aggregate 5,427 bytes; write-skill adds 135 bytes
 *           (name plus the one-sentence catalog lead), yielding 5,562 bytes
 *           = 1,391 token-equivalents including the root router alias.
 * New-skill ratchet: previous ceiling 1,359 + ceil(135 / 4) = 1,393
 * token-equivalents (5,572 bytes), leaving 10 bytes. Existing descriptions
 * are unchanged.
 *   ref     verify addition on base a77fae2 (2026-10-31), GST-116 plan v3
 *           (autoplan-20261029160221, APPROVED gate_rev 3)
 *   result  pre-addition aggregate 5,564 bytes; verify adds 118 bytes
 *           (name plus the one-sentence catalog lead), yielding 5,682 bytes
 *           = 1,421 token-equivalents including the root router alias.
 * New-skill ratchet: previous ceiling 1,393 + ceil(118 / 4) = 1,423
 * token-equivalents (5,692 bytes), leaving 10 bytes. Existing descriptions
 * are unchanged.
 */
const CATALOG_BUDGET_TOKEN_EQUIVALENTS = 1_423;

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
