/**
 * E2E: real gbrain CLI round-trip against a local PGLite engine.
 *
 * Replaces the manual local probe documented in earlier drafts of
 * docs/gbrain-write-surfaces.md. The matched-pair check the user asked
 * for v1.50.0.0: "is the data we hope to save actually being saved?"
 *
 * What this proves:
 *   - The gbrain CLI subcommand shape gstack ships (`gbrain put <slug>
 *     --content "<markdown with frontmatter>"`) actually persists to a
 *     real PGLite store.
 *   - The page is retrievable via `gbrain get <slug>` with body + title
 *     intact (frontmatter is allowed to be reformatted by gbrain — we
 *     check semantic fields, not byte-exact YAML).
 *   - The `office-hours/<slug>` slug namespace works (no rejection,
 *     no auto-rewrite).
 *
 * What this does NOT prove (out of scope, owned elsewhere):
 *   - Agent obedience to the resolver instructions — that's the
 *     fake-CLI E2E (test/skill-e2e-office-hours-brain-writeback.test.ts).
 *   - Remote-MCP persistence — that's the write-shape E2E
 *     (test/skill-e2e-gbrain-roundtrip-remote.test.ts).
 *   - gbrain's own internal correctness — gbrain has its own test suite;
 *     this is a contract smoke test, not gbrain validation.
 *
 * Periodic tier. Real gbrain init + put triggers one Voyage embedding
 * call (~$0.001/run). Skips when VOYAGE_API_KEY is unset OR gbrain is
 * not on PATH, so CI without secrets degrades gracefully.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  describeIfSelected,
  testConcurrentIfSelected,
  runId,
  createEvalCollector,
} from './helpers/e2e-helpers';

const evalCollector = createEvalCollector('e2e-gbrain-roundtrip-local');

function gbrainOnPath(): boolean {
  try {
    execFileSync('gbrain', ['--version'], { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const SHOULD_RUN_GUARDS_OK =
  gbrainOnPath() && !!process.env.VOYAGE_API_KEY;

describeIfSelected(
  'GBrain local PGLite round-trip E2E',
  ['gbrain-roundtrip-local'],
  () => {
    let tmpHome: string;
    const slug = `office-hours/roundtrip-test-${Date.now()}`;
    const body = `# Roundtrip test

This is a deterministic round-trip test page used by the gstack v1.50.0.0
brain-writeback verification. Generated at ${new Date().toISOString()}.

If gbrain persisted this correctly, you should see this exact body when
you run \`gbrain get "${slug}"\`.`;

    beforeAll(() => {
      if (!SHOULD_RUN_GUARDS_OK) {
        // Will skip via testConcurrentIfSelected gate; nothing to set up.
        tmpHome = '';
        return;
      }
      tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-roundtrip-'));

      // Initialize a real PGLite gbrain in the isolated temp HOME. Explicit
      // --embedding-model required because the local env has multiple
      // providers ready (voyage + zeroentropyai); gbrain refuses to guess.
      execFileSync(
        'gbrain',
        ['init', '--pglite', '--embedding-model', 'voyage:voyage-code-3'],
        {
          env: { ...process.env, HOME: tmpHome },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        },
      );
    });

    afterAll(() => {
      if (tmpHome) {
        try {
          rmSync(tmpHome, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    });

    testConcurrentIfSelected(
      'gbrain-roundtrip-local',
      async () => {
        if (!SHOULD_RUN_GUARDS_OK) {
          console.log(
            '[skip] gbrain CLI not on PATH or VOYAGE_API_KEY unset; ' +
              'this E2E proves the gbrain CLI persistence contract gstack relies on. ' +
              'Run locally with `VOYAGE_API_KEY=... bun test ...` to verify before shipping.',
          );
          return;
        }

        const content = `---
title: "Office Hours: Roundtrip Test"
tags: [design-doc, roundtrip-test]
---
${body}`;

        // PUT the page.
        execFileSync('gbrain', ['put', slug, '--content', content], {
          env: { ...process.env, HOME: tmpHome },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        });

        // GET it back.
        const retrieved = execFileSync('gbrain', ['get', slug], {
          env: { ...process.env, HOME: tmpHome },
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        });

        // The body MUST survive verbatim — every line of what we wrote
        // must appear in what we got back. (Frontmatter reformatting is
        // gbrain's prerogative; body text is data we own.)
        for (const line of body.split('\n')) {
          if (line.trim()) {
            expect(retrieved).toContain(line);
          }
        }

        // Title is in the frontmatter — assert it's present (gbrain
        // strips the constant prefix "title: " quote handling can vary).
        expect(retrieved).toContain('Roundtrip Test');

        // Tag survived.
        expect(retrieved).toContain('design-doc');
        expect(retrieved).toContain('roundtrip-test');

        // Sanity: the doc isn't empty or a 404 error.
        expect(retrieved.length).toBeGreaterThan(body.length);
        expect(retrieved).not.toContain('page_not_found');
        expect(retrieved).not.toContain('Page not found');
      },
      120_000,
    );
  },
);
