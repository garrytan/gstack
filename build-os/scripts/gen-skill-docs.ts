#!/usr/bin/env bun
/**
 * build-os skill docs generator.
 * Reads SKILL.md.tmpl, replaces {{PLACEHOLDER}} tokens, writes SKILL.md.
 * Claude-only — no multi-host complexity needed.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { RESOLVERS } from './resolvers/index.ts';
import type { BuildContext } from './resolvers/types.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_DIRS = new Set(['node_modules', 'scripts', 'bin', '.git']);

function findTemplates(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTemplates(full));
    } else if (entry === 'SKILL.md.tmpl') {
      results.push(full);
    }
  }
  return results;
}

function parseFrontmatter(src: string): { preambleTier: number; body: string } {
  const match = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { preambleTier: 4, body: src };
  const [, yaml, body] = match;
  const tierMatch = yaml.match(/^preamble-tier:\s*(\d)/m);
  return { preambleTier: tierMatch ? Number(tierMatch[1]) : 4, body };
}

function processTemplate(tmplPath: string): { name: string; changed: boolean } {
  const src = readFileSync(tmplPath, 'utf-8');
  const { preambleTier, body } = parseFrontmatter(src);
  const skillName = basename(dirname(tmplPath));

  const ctx: BuildContext = { skillName, tmplPath, skillDir: dirname(tmplPath), preambleTier };

  const resolved = body.replace(/\{\{([A-Z0-9_]+(?::[^}]*)?)\}\}/g, (match, token) => {
    const [name, ...args] = token.split(':');
    const resolver = RESOLVERS[name];
    if (!resolver) {
      process.stderr.write(`[build-os] Unknown resolver: ${name} in ${tmplPath}\n`);
      return match;
    }
    return resolver(ctx, args.length ? args : undefined);
  });

  const outPath = join(dirname(tmplPath), 'SKILL.md');

  if (DRY_RUN) {
    try {
      const existing = readFileSync(outPath, 'utf-8');
      if (existing !== resolved) {
        process.stderr.write(`[dry-run] STALE: ${outPath}\n`);
        process.exit(1);
      }
    } catch {
      process.stderr.write(`[dry-run] MISSING: ${outPath}\n`);
      process.exit(1);
    }
    return { name: skillName, changed: false };
  }

  let changed = true;
  try {
    changed = readFileSync(outPath, 'utf-8') !== resolved;
  } catch { /* new file */ }

  writeFileSync(outPath, resolved);
  return { name: skillName, changed };
}

console.log('build-os: generating skill docs...\n');
const templates = findTemplates(ROOT);
let updated = 0;
for (const tmpl of templates) {
  const { name, changed } = processTemplate(tmpl);
  const marker = changed ? '✓' : '·';
  console.log(`  ${marker} ${name}/SKILL.md (tier ${parseFrontmatter(readFileSync(tmpl, 'utf-8')).preambleTier})`);
  if (changed) updated++;
}
console.log(`\n${templates.length} skills processed, ${updated} updated.`);
