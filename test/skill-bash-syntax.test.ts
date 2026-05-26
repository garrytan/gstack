/**
 * Bash syntax validation for SKILL.md code blocks (gate, free).
 *
 * Extracts every ```bash...``` block from all generated SKILL.md files and
 * runs `bash -n` (parse-only, no execution) on each one. Catches unclosed
 * code fences, broken redirects (e.g. `2/dev/null` instead of `2>/dev/null`),
 * unclosed strings, and other syntactic mistakes before they reach users.
 *
 * Preprocessing: angle-bracket placeholder tokens like <branch-name> are
 * replaced with the bareword PLACEHOLDER before validation. Without this
 * substitution, `<word>` is parsed as a shell redirect (read stdin from
 * file "word>") and would produce false positive errors on intentional
 * template placeholders that agents fill in at runtime.
 *
 * Covers all 53 SKILL.md files discovered via discoverSkillFiles().
 * Runs in < 2s with no network or API calls.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

function discoverSkillFiles(root: string): string[] {
  const subdirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
    .map(d => d.name);

  const results: string[] = [];
  if (fs.existsSync(path.join(root, 'SKILL.md'))) {
    results.push('SKILL.md');
  }
  for (const dir of subdirs) {
    const rel = `${dir}/SKILL.md`;
    if (fs.existsSync(path.join(root, rel))) {
      results.push(rel);
    }
  }
  return results;
}

interface BashBlock {
  code: string;
  lineNo: number; // 1-indexed line number where the block content starts
}

function extractBashBlocks(content: string): BashBlock[] {
  const lines = content.split('\n');
  const blocks: BashBlock[] = [];
  let inBash = false;
  let blockLines: string[] = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBash && line.trimStart().startsWith('```bash')) {
      inBash = true;
      blockLines = [];
      startLine = i + 2; // +1 for 1-index, +1 to skip the fence line itself
      continue;
    }
    if (inBash && line.trimStart() === '```') {
      blocks.push({ code: blockLines.join('\n'), lineNo: startLine });
      inBash = false;
      continue;
    }
    if (inBash) {
      blockLines.push(line);
    }
  }
  return blocks;
}

// Replace <placeholder> tokens with the bareword PLACEHOLDER to prevent
// bash from interpreting them as stdin redirects, which produce false errors.
function preprocess(code: string): string {
  return code.replace(/<[A-Za-z][A-Za-z0-9_.-]*>/g, 'PLACEHOLDER');
}

function checkBashSyntax(code: string): string | null {
  const result = Bun.spawnSync(['bash', '-n'], {
    stdin: Buffer.from(code),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    return result.stderr.toString().trim();
  }
  return null;
}

describe('bash syntax validation in SKILL.md code blocks', () => {
  const skillFiles = discoverSkillFiles(ROOT);

  // Sanity: we should find at least 10 skill files
  test('discovers skill files', () => {
    expect(skillFiles.length).toBeGreaterThanOrEqual(10);
  });

  for (const relPath of skillFiles) {
    test(`${relPath} — all bash blocks pass bash -n`, () => {
      const content = fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
      const blocks = extractBashBlocks(content);

      const errors: string[] = [];
      for (const { code, lineNo } of blocks) {
        const preprocessed = preprocess(code);
        const errMsg = checkBashSyntax(preprocessed);
        if (errMsg !== null) {
          // Trim bash's "bash: line N:" prefix and replace with our own location
          const cleaned = errMsg.replace(/^bash: line \d+: /, '');
          errors.push(`  ~line ${lineNo}: ${cleaned}`);
        }
      }

      if (errors.length > 0) {
        throw new Error(
          `${relPath}: ${errors.length} bash block(s) failed syntax check:\n` +
          errors.join('\n')
        );
      }
    });
  }
});
