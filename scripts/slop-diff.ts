#!/usr/bin/env bun
/**
 * slop-diff: show NEW slop-scan findings introduced on this branch.
 *
 * Runs slop-scan on HEAD and on the merge-base, then diffs the results
 * to show only findings that were added. Line-number-insensitive comparison
 * so shifting code doesn't create false positives.
 *
 * Usage:
 *   bun run slop:diff              # diff against main
 *   bun run slop:diff origin/release  # diff against another base
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const base = process.argv[2] || 'main';

// 1. Find changed files
const diffResult = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], {
  encoding: 'utf-8', timeout: 10000,
});
const changedFiles = new Set(
  (diffResult.stdout || '').trim().split('\n').filter(Boolean)
);
if (changedFiles.size === 0) {
  console.log('No files changed vs', base, '— nothing to check.');
  process.exit(0);
}

// 2. Run slop-scan on HEAD
const scanHead = spawnSync('npx', ['slop-scan', 'scan', '.', '--json'], {
  encoding: 'utf-8', timeout: 120000, shell: true,
});
if (!scanHead.stdout) {
  console.log('slop-scan not available. Install: npm i -g slop-scan');
  process.exit(0);
}
let headReport: any;
try { headReport = JSON.parse(scanHead.stdout); } catch {
  console.log('slop-scan returned invalid JSON.'); process.exit(0);
}

// 3. Get base branch findings using git stash approach
//    Check out base versions of changed files, scan, then restore
const mergeBase = spawnSync('git', ['merge-base', base, 'HEAD'], {
  encoding: 'utf-8', timeout: 5000,
}).stdout?.trim();

// Fingerprint: strip line numbers so shifting code doesn't create false positives
// "line 142: empty catch, boundary=none" -> "empty catch, boundary=none"
function stripLineNum(evidence: string): string {
  return evidence.replace(/^line \d+: /, '').replace(/ at line \d+ /, ' ');
}

// Count evidence items per (rule, file, stripped-evidence) for the base
const baseCounts = new Map<string, number>();

if (mergeBase) {
  // Create temp worktree for base scan
  const tmpWorktree = path.join(os.tmpdir(), `slop-base-${Date.now()}`);
  const wtResult = spawnSync('git', ['worktree', 'add', '--detach', tmpWorktree, mergeBase], {
    encoding: 'utf-8', timeout: 30000,
  });

  if (wtResult.status === 0) {
    // Copy slop-scan config if it exists
    const configFile = 'slop-scan.config.json';
    if (fs.existsSync(configFile)) {
      try { fs.copyFileSync(configFile, path.join(tmpWorktree, configFile)); } catch {}
    }

    const scanBase = spawnSync('npx', ['slop-scan', 'scan', tmpWorktree, '--json'], {
      encoding: 'utf-8', timeout: 120000, shell: true,
    });

    if (scanBase.stdout) {
      try {
        const baseReport = JSON.parse(scanBase.stdout);
        for (const f of baseReport.findings) {
          // Remap worktree paths back to repo-relative
          const realPath = f.path.replace(tmpWorktree + '/', '');
          if (!changedFiles.has(realPath)) continue;
          for (const ev of f.evidence || []) {
            const key = `${f.ruleId}|${realPath}|${stripLineNum(ev)}`;
            baseCounts.set(key, (baseCounts.get(key) || 0) + 1);
          }
        }
      } catch {}
    }

    // Clean up worktree
    spawnSync('git', ['worktree', 'remove', '--force', tmpWorktree], {
      timeout: 10000,
    });
  }
}

// 4. Find genuinely new findings
//    For each evidence item on HEAD, check if the base had the same (rule, file, stripped-evidence).
//    Use counts to handle duplicates: if base had 2 and HEAD has 3, that's 1 new.
const headCounts = new Map<string, { count: number; evidence: string[] }>();
const headFindings = headReport.findings.filter((f: any) => changedFiles.has(f.path));

for (const f of headFindings) {
  for (const ev of f.evidence || []) {
    const key = `${f.ruleId}|${f.path}|${stripLineNum(ev)}`;
    const entry = headCounts.get(key) || { count: 0, evidence: [] };
    entry.count++;
    entry.evidence.push(ev);
    headCounts.set(key, entry);
  }
}

// Compute net new
type NewFinding = { ruleId: string; filePath: string; evidence: string };
const newFindings: NewFinding[] = [];
let removedCount = 0;

for (const [key, entry] of headCounts) {
  const baseCount = baseCounts.get(key) || 0;
  const netNew = entry.count - baseCount;
  if (netNew > 0) {
    const [ruleId, filePath] = key.split('|');
    // Take the last N evidence items as the "new" ones
    for (const ev of entry.evidence.slice(-netNew)) {
      newFindings.push({ ruleId, filePath, evidence: ev });
    }
  }
}

for (const [key, baseCount] of baseCounts) {
  const headCount = headCounts.get(key)?.count || 0;
  if (headCount < baseCount) removedCount += baseCount - headCount;
}

// 5. Print results
if (newFindings.length === 0) {
  if (removedCount > 0) {
    console.log(`\n  slop-scan: no new findings. Removed ${removedCount} pre-existing findings.\n`);
  } else {
    console.log(`\n  slop-scan: no new findings in ${changedFiles.size} changed files.\n`);
  }
  process.exit(0);
}

console.log(`\n── slop-scan: ${newFindings.length} new findings (+${newFindings.length} / -${removedCount}) ──\n`);

// Group by file, then by rule
const grouped = new Map<string, Map<string, string[]>>();
for (const { ruleId, filePath, evidence } of newFindings) {
  if (!grouped.has(filePath)) grouped.set(filePath, new Map());
  const rules = grouped.get(filePath)!;
  if (!rules.has(ruleId)) rules.set(ruleId, []);
  rules.get(ruleId)!.push(evidence);
}

for (const [filePath, rules] of grouped) {
  console.log(`  ${filePath}`);
  for (const [ruleId, evidence] of rules) {
    console.log(`    ${ruleId}:`);
    for (const ev of evidence) {
      console.log(`      ${ev}`);
    }
  }
}

console.log(`\n  Net: +${newFindings.length} new, -${removedCount} removed\n`);
