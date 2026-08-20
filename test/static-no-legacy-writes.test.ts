/**
 * Static invariant test for #1671: nothing in production code should
 * append directly to ~/.gstack/builder-profile.jsonl. All session writes
 * must go through `gstack-developer-profile --log-session`. The legacy
 * file is now read-only — populated only by the pre-existing migration
 * and reconcile paths in bin/gstack-developer-profile.
 *
 * Prevents future regressions onto the legacy file that would re-create
 * the original bug (writer and reader disagreeing on storage location).
 *
 * Mirrors `test/setup-windows-fallback.test.ts`'s style — static invariant
 * via grep, resilient to line-number drift.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// Paths allowed to mention builder-profile.jsonl. These read the file
// or document its existence — they do not write to it.
const ALLOWED_FILES = new Set<string>([
  // The binary that reads + reconciles the legacy file.
  'bin/gstack-developer-profile',
  // The legacy-shim binary that delegates reads.
  'bin/gstack-builder-profile',
  // Memory-ingest reads the legacy file during reconcile period.
  'bin/gstack-memory-ingest.ts',
  // The artifacts-init template registers the legacy file in
  // .brain-allowlist/.brain-privacy-map for users with pre-existing data.
  'bin/gstack-artifacts-init',
  // Documentation files mention the path.
  'CHANGELOG.md',
  'TODOS.md',
  'README.md',
  'office-hours/SKILL.md.tmpl',
  'office-hours/SKILL.md',
  'setup-gbrain/memory.md',
  'docs/designs/FIX_1671_PROFILE_MIGRATION.md',
  'docs/designs/PLAN_TUNING_V0.md',
  'docs/designs/PLAN_TUNING_V1.md',
]);

// Directories to skip when walking the repo. Everything else is in scope —
// any skill dir, migration script, resolver, or new top-level dir gets
// covered automatically as the repo grows. Catches the "future contributor
// adds the legacy write in retro/SKILL.md.tmpl" regression class.
const SKIP_DIRS = new Set<string>([
  'node_modules', '.git', '.github', 'dist', 'test', 'docs',
  // Vendored binaries / build outputs.
  'browse/dist', 'design/dist', 'extension/node_modules',
  // The plan file's directory was already in ALLOWED_FILES; skip docs/ entirely.
]);

function listSearchDirs(): string[] {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name) && !d.name.startsWith('.'))
    .map((d) => d.name);
}

const SEARCH_DIRS = listSearchDirs();

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(p);
    } else if (entry.isFile()) {
      yield p;
    }
  }
}

// Match any literal-path append/write pattern targeting builder-profile.jsonl.
// Captures: `>> .../builder-profile.jsonl`, `writeFileSync(...builder-profile.jsonl...)`,
// `> .../builder-profile.jsonl`. NOTE: this only catches LITERAL-PATH writes —
// variable-indirected writes (`FILE=...builder-profile.jsonl; echo >> "$FILE"`)
// are not detected. The SKILL.md.tmpl assertions below pin the exact #1671
// regression class directly; this regex is a backstop against the obvious
// pattern, not a comprehensive variable-flow analyzer.
const WRITE_PATTERN = /(>>?\s*["']?[^"'\s]*builder-profile\.jsonl|writeFileSync\([^)]*builder-profile\.jsonl|appendFileSync\([^)]*builder-profile\.jsonl)/;

describe('#1671 invariant: no production code writes to builder-profile.jsonl', () => {
  test('only allowlisted files mention writes to builder-profile.jsonl', () => {
    const offending: { file: string; line: number; content: string }[] = [];

    for (const searchDir of SEARCH_DIRS) {
      const fullDir = path.join(ROOT, searchDir);
      if (!fs.existsSync(fullDir)) continue;

      for (const filePath of walk(fullDir)) {
        const rel = path.relative(ROOT, filePath);

        // Skip allowlisted files.
        if (ALLOWED_FILES.has(rel)) continue;

        // Only check text-like extensions to avoid binary files.
        if (!/\.(sh|ts|js|md|tmpl)$/.test(rel) && !rel.startsWith('bin/')) continue;

        let content: string;
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          continue;
        }

        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (WRITE_PATTERN.test(line)) {
            offending.push({ file: rel, line: idx + 1, content: line.trim() });
          }
        });
      }
    }

    if (offending.length > 0) {
      const msg = offending
        .map((o) => `  ${o.file}:${o.line}  ${o.content}`)
        .join('\n');
      throw new Error(
        `Found production writes to builder-profile.jsonl outside the allowlist.\n` +
          `These would re-create #1671 (writer/reader file mismatch).\n` +
          `Use \`gstack-developer-profile --log-session\` instead.\n${msg}`,
      );
    }
    expect(offending).toEqual([]);
  });

  test('office-hours/SKILL.md uses --log-session, not raw echo append', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'office-hours/SKILL.md'), 'utf-8');
    // The two known writer call-sites must use the new subcommand.
    expect(skill).toContain('gstack-developer-profile --log-session');
    // And must NOT contain the old echo-append pattern.
    expect(skill).not.toMatch(/echo\s+['"][^'"]*['"]?\s*>>\s*["'][^"']*builder-profile\.jsonl/);
  });

  test('office-hours/SKILL.md.tmpl uses --log-session, not raw echo append', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'office-hours/SKILL.md.tmpl'), 'utf-8');
    expect(tmpl).toContain('gstack-developer-profile --log-session');
    expect(tmpl).not.toMatch(/echo\s+['"][^'"]*['"]?\s*>>\s*["'][^"']*builder-profile\.jsonl/);
  });
});
