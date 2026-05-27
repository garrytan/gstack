#!/usr/bin/env bun
/**
 * Validate YAML frontmatter for generated SKILL.md files.
 *
 * This is intentionally narrower than skill:check so CI can run it after
 * regenerating only the host outputs relevant to a workflow.
 */

import { discoverSkillFiles } from './discover-skills';
import { validateSkillFrontmatter } from '../test/helpers/skill-parser';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

function walkSkillFiles(dir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSkillFiles(fullPath, acc);
      continue;
    }
    if (entry.name === 'SKILL.md') {
      acc.push(path.relative(ROOT, fullPath));
    }
  }
}

const files = new Set(discoverSkillFiles(ROOT));
for (const hostDir of ['.agents', '.factory']) {
  const fullPath = path.join(ROOT, hostDir);
  if (fs.existsSync(fullPath)) {
    const hostFiles: string[] = [];
    walkSkillFiles(fullPath, hostFiles);
    for (const file of hostFiles) files.add(file);
  }
}

const errors: string[] = [];
for (const file of [...files].sort()) {
  const fullPath = path.join(ROOT, file);
  for (const error of validateSkillFrontmatter(fullPath)) {
    errors.push(`${file}:${error.line}: ${error.message}`);
  }
}

if (errors.length > 0) {
  console.error('Invalid SKILL.md frontmatter:');
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`Validated frontmatter for ${files.size} SKILL.md files.`);
