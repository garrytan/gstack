// Post-rename doc-regen regression: after `bun run gen:skill-docs`, no
// `gstack-brain-init` or `gbrain_sync_mode` strings appear in any of the
// generated SKILL.md files (the cross-product blind spot codex
// Finding #12 flagged).
//
// The check runs against the canonical claude-host output already on
// disk. We don't shell out to gen-skill-docs again; the existing
// freshness check in gen-skill-docs.test.ts covers that. This test
// just verifies the rename actually propagated to the generated
// artifacts that users see.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const FORBIDDEN_PATTERNS = [
  // Bare identifier — should NEVER appear in generated docs (if it does,
  // a template still has the old call site).
  /^.*\bgstack-brain-init\b.*$/m,
  /^.*\bgbrain_sync_mode\b.*$/m,
];

// Per the preamble resolver: generated docs DO contain the
// "~/.gstack-brain-remote.txt" string in the migration-window fallback. We
// don't grep for that — it's intentional. We grep for the call-site
// identifiers only.

function findSkillMdFiles(): string[] {
  const skillMd = path.join(ROOT, 'SKILL.md');
  const files: string[] = [skillMd];
  // Top-level skill directories with their own SKILL.md.
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'test'].includes(e.name)) {
      const inner = path.join(ROOT, e.name, 'SKILL.md');
      if (fs.existsSync(inner)) files.push(inner);
    }
  }
  return files;
}

describe('post-rename doc-regen regression (codex Finding #12)', () => {
  test('no generated SKILL.md contains "gstack-brain-init"', () => {
    const offenders: string[] = [];
    for (const file of findSkillMdFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      const m = content.match(/^.*\bgstack-brain-init\b.*$/m);
      if (m) offenders.push(`${path.relative(ROOT, file)}: ${m[0].slice(0, 100)}`);
    }
    if (offenders.length > 0) {
      console.error(`Stale "gstack-brain-init" in generated SKILL.md files:\n${offenders.map((o) => '  ' + o).join('\n')}`);
    }
    expect(offenders).toEqual([]);
  });

  test('no generated SKILL.md contains "gbrain_sync_mode"', () => {
    const offenders: string[] = [];
    for (const file of findSkillMdFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      const m = content.match(/^.*\bgbrain_sync_mode\b.*$/m);
      if (m) offenders.push(`${path.relative(ROOT, file)}: ${m[0].slice(0, 100)}`);
    }
    if (offenders.length > 0) {
      console.error(`Stale "gbrain_sync_mode" in generated SKILL.md files:\n${offenders.map((o) => '  ' + o).join('\n')}`);
    }
    expect(offenders).toEqual([]);
  });

  test('top-level SKILL.md exists and is regenerated', () => {
    expect(fs.existsSync(path.join(ROOT, 'SKILL.md'))).toBe(true);
  });
});
