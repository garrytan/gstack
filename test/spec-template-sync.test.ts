/**
 * spec-template-sync: verify /spec templates ↔ generated docs stay in sync.
 *
 * Per codex T8 / eng plan: regen and assert no drift. Catches commits that
 * edit a template but forget to run `bun run gen:skill-docs`, or vice versa.
 *
 * /spec is carved (skeleton + sections/gate-and-file.md), so BOTH generated
 * artifacts are checked: a stale section is the same drift bug as a stale
 * skeleton — the on-demand file is what the agent executes at Phase 4.5.
 *
 * The regen renders into an isolated --out-dir and compares the rendered
 * bytes against the TRACKED files — the working tree is only ever read.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

const GENERATED_PATHS = [
  path.join(ROOT, 'spec', 'SKILL.md'),
  path.join(ROOT, 'spec', 'sections', 'gate-and-file.md'),
];

describe('/spec template/generated sync', () => {
  test('regenerating spec/SKILL.md + sections produces byte-identical output', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-spec-sync-'));

    const res = spawnSync('bun', ['run', 'gen:skill-docs', '--out-dir', outDir], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
      // Scrubbed env: bun test runs a shard's files serially in ONE process,
      // so an earlier test's env mutations (GSTACK_*/GBRAIN_* detection vars)
      // leak into inherited process.env and change generator output — this
      // test failed in-suite while passing solo on an identical tree. The
      // generator's output must be a function of the templates, not of
      // whichever test ran before this one.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
      },
    });
    try {
      expect(res.status).toBe(0);

      for (const trackedPath of GENERATED_PATHS) {
        const rel = path.relative(ROOT, trackedPath);
        const rendered = fs.readFileSync(path.join(outDir, rel), 'utf-8');
        // --out-dir repoints the literal section-base paths
        // (~/.claude/skills/gstack/<skill>/sections/ → <outDir>/<skill>/sections/)
        // so section Reads resolve inside the render. Undo that single
        // documented rewrite before comparing; every OTHER byte must match
        // the tracked file exactly.
        const normalized = rendered.replaceAll(`${outDir}/`, '~/.claude/skills/gstack/');
        const tracked = fs.readFileSync(trackedPath, 'utf-8');
        expect({ file: rel, identical: normalized === tracked })
          .toEqual({ file: rel, identical: true });
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 130_000);

  test('generated /spec docs carry the auto-generated header', () => {
    for (const p of GENERATED_PATHS) {
      const generated = fs.readFileSync(p, 'utf-8');
      expect(generated).toMatch(/AUTO-GENERATED|do not edit directly/i);
    }
  });
});
