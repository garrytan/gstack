#!/usr/bin/env bun
/**
 * Generate agents-digest/gstack-AGENTS.md — the instruction-only tier.
 *
 * A ~2KB behavioral digest any rules-reading agent host can load (Zed, Amp,
 * Jules, Cursor side-projects, OpenClaw/Hermes methodology mode): the ETHOS
 * principles as one-liners, the reuse ladder, the voice rules, and a pointer
 * to the full install. It is a COMMITTED generated artifact (like llms.txt)
 * so the setup explainer arms can point at it before any toolchain exists.
 *
 * Delivery is print-path + user-performed copy ONLY — never write or
 * overwrite a user's own AGENTS.md (a gstack-AGENTS.md is auto-read by no
 * host; clobbering AGENTS.md destroys user content on every re-run).
 *
 * One host-neutral file, deliberately: the digest contains no host-specific
 * paths, so per-host copies would be byte-identical duplication (the exact
 * per-host rule-text sprawl gstack's generator model exists to avoid). If a
 * host ever needs rewrites, this generator gains a per-host emit then.
 *
 * Size budget: <= 2,048 bytes, enforced by test/agents-digest.test.ts. Every
 * host that loads this pays for it in every session — trim, don't grow.
 *
 * Refresh: invoked from scripts/gen-skill-docs.ts after SKILL.md generation.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
// Repo-relative with FORWARD slashes on every platform: this constant is
// compared against literals in shell scripts, host configs, and docs (the
// wiring test), where a Windows path.join backslash form would never match.
// path.join(root, DIGEST_RELPATH) at the write site normalizes it fine.
export const DIGEST_RELPATH = 'agents-digest/gstack-AGENTS.md';
export const DIGEST_BYTE_BUDGET = 2048;

export function generateAgentsDigest(opts?: { root?: string }): { content: string; bytes: number } {
  const root = opts?.root ?? ROOT;
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf-8').trim();

  const content = `# gstack digest v${version} — regenerate/re-copy after upgrading gstack

Behavioral rules from gstack (https://github.com/garrytan/gstack), compressed
for agent hosts without a full skill install. The full skills add workflows,
reviews, and evals on top of these rules.

## Ethos

- **Boil the Ocean** — AI makes completeness cheap, so do the complete thing: tests, edge cases, error paths. Shortcuts need an explicit, recorded decision.
- **Search Before Building** — know what exists before deciding what to build. Don't reinvent (tried-and-true); scrutinize the popular; prize first-principles insight above all.
- **User Sovereignty** — models recommend, the user decides. Cross-model agreement is signal, never permission. Ask before changing the user's stated direction.
- **Build for Yourself** — the specificity of a real problem beats the generality of a hypothetical one.

## The reuse ladder

Before writing new code, stop at the first rung that holds:
1. A helper, util, or pattern already in this repo.
2. The standard library.
3. A native platform feature (CSS over JS, DB constraint over app code).
4. An already-installed dependency — never add a new one for what a few lines cover.

Then build the complete version of what remains. Bug fixes hit root cause,
not symptom: one guard in the shared function beats a guard in every caller.

## Voice

Direct, concrete, builder-to-builder. Name the file, function, command, and
user-visible impact. Short paragraphs; end with what to do. No filler, no
corporate tone, no AI vocabulary.

## Full gstack

Clone https://github.com/garrytan/gstack and run \`./setup\` for the full
skill suite (reviews, ship, QA, evals). This digest is generated — edit
scripts/gen-agents-digest.ts, not this file.
`;

  return { content, bytes: Buffer.byteLength(content, 'utf-8') };
}

export function writeAgentsDigest(opts?: { root?: string; outRoot?: string }): { outPath: string; bytes: number } {
  const root = opts?.root ?? ROOT;
  const { content, bytes } = generateAgentsDigest({ root });
  // outRoot: outputs-only rule for --out-dir renders — inputs (VERSION) read
  // from root, the artifact lands wherever the caller isolates outputs.
  const outPath = path.join(opts?.outRoot ?? root, DIGEST_RELPATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
  return { outPath, bytes };
}

if (import.meta.main) {
  const { outPath, bytes } = writeAgentsDigest();
  console.log(`[gen-agents-digest] ${path.relative(ROOT, outPath)}: ${bytes} bytes (budget ${DIGEST_BYTE_BUDGET})`);
}
