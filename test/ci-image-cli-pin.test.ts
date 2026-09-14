/**
 * Provider CLIs baked into the CI image must be pinned to EXACT versions.
 *
 * The PTY harness (test/helpers/claude-pty-runner.ts) screen-scrapes the
 * claude CLI's TUI — trust dialog, input-prompt ready marker, spinner glyphs.
 * The image used to install `npm i -g @anthropic-ai/claude-code` UNPINNED and
 * rebuild weekly "to pick up CLI updates", while bun sat carefully pinned at
 * 1.3.13 two RUN lines above — the exact drift class the bun pin exists for.
 * Receipts: TUI drift broke the harness three separate times (welcome-screen
 * wedge vs CLI 2.1.233, skillify HOME discovery on 2.1.237, guard/freeze
 * hooks on 2.1.162), each debugged as a "flake" before being traced to an
 * unpinned weekly-latest CLI.
 *
 * This tripwire fails the free suite when any globally-installed npm package
 * in Dockerfile.ci lacks an exact `@X.Y.Z` pin. Bumps are deliberate: edit
 * the pin in a PR and run the PTY gate against the new TUI before merging.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = path.join(ROOT, '.github', 'docker', 'Dockerfile.ci');

/** Package specs from every `npm i -g` / `npm install -g` in the Dockerfile. */
export function globalNpmInstallSpecs(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(/npm\s+(?:i|install)\s+(?:-g|--global)\s+([^\n\\&|;]+)/g)) {
    for (const spec of match[1].trim().split(/\s+/)) {
      if (spec.startsWith('-')) continue; // flags like --no-fund
      specs.push(spec);
    }
  }
  return specs;
}

/** Exact pin = a trailing @<semver> with no range operator (no ^ ~ x *). */
export function isExactlyPinned(spec: string): boolean {
  // Scoped (@scope/name@1.2.3) or bare (name@1.2.3); version must be exact.
  const at = spec.lastIndexOf('@');
  if (at <= 0) return false; // no version at all (or a bare scope)
  const version = spec.slice(at + 1);
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version);
}

describe('ci image provider-CLI pins', () => {
  const source = fs.readFileSync(DOCKERFILE, 'utf-8');
  const specs = globalNpmInstallSpecs(source);

  test('the image installs at least the claude CLI globally (scan must not rot)', () => {
    expect(
      specs.some((s) => s.startsWith('@anthropic-ai/claude-code@')),
      `expected a pinned @anthropic-ai/claude-code install in ${path.relative(ROOT, DOCKERFILE)}; found: ${specs.join(', ') || '(none)'}`,
    ).toBe(true);
  });

  test('every global npm install carries an exact @X.Y.Z pin', () => {
    const unpinned = specs.filter((s) => !isExactlyPinned(s));
    expect(
      unpinned,
      `unpinned global npm installs in Dockerfile.ci: ${unpinned.join(', ')}\n`
      + 'Pin the exact version (name@X.Y.Z) and bump via a PR that runs the '
      + 'PTY gate against the new TUI — weekly-latest CLI drift broke the '
      + 'harness three times before this tripwire existed.',
    ).toHaveLength(0);
  });
});
