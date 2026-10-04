#!/usr/bin/env bun
/**
 * Test-code type-debt ratchet: `bun run typecheck:test [--write-baseline]`.
 *
 * Product code must typecheck clean (`bun run typecheck`). Test code carries
 * historical diagnostics, so it is held to a committed baseline instead:
 * each diagnostic identity (file + TS code + message, line-insensitive) maps
 * to how many times it occurs. The check fails on a new identity, on a higher
 * count, and on a stale baseline (fixed diagnostics must be locked in with
 * --write-baseline in the same change, so the allowance only ever shrinks).
 * Fixing one error and adding an identical-message error in the same file is
 * the one substitution this cannot see.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BASELINE_FILE = 'scripts/typecheck-test-baseline.json';
const ROOT = path.resolve(import.meta.dir, '..');

export type DiagnosticCounts = Record<string, number>;

/**
 * tsc prints a synthesized object type's members in checker order, which
 * shifts when the program's file set changes (`{ content?: undefined; isError?: undefined; … }`
 * vs `{ isError?: undefined; content?: undefined; … }` for one unchanged
 * diagnostic). Sort the members of every `{ …; }` group so that order is not
 * part of the identity.
 */
export function sortTypeMembers(text: string): string {
  const group = (start: number): [string, number] => {
    const members: string[] = [];
    let current = '';
    let i = start;
    for (; i < text.length && text[i] !== '}'; i++) {
      if (text[i] === '{') {
        const [inner, end] = group(i + 1);
        current += inner;
        i = end;
      } else if (text[i] === ';') {
        members.push(current.trim());
        current = '';
      } else current += text[i];
    }
    if (i >= text.length) return [`{${members.map(m => ` ${m};`).join('')}${current}`, i];
    if (members.length === 0) return [`{${current}}`, i];
    return [`{ ${members.sort().map(m => `${m}; `).join('')}${current.trim() ? `${current.trim()} ` : ''}}`, i];
  };
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') { out += text[i]; continue; }
    const [inner, end] = group(i + 1);
    out += inner;
    i = end;
  }
  return out;
}

/** Parse `tsc --pretty false` output into identity → count. Continuation lines belong to the preceding diagnostic. */
export function parseDiagnostics(output: string, root = ROOT): DiagnosticCounts {
  const counts: DiagnosticCounts = {};
  // Messages can embed absolute import paths; strip the checkout root so the
  // identity is the same in every clone and CI workspace.
  const roots = [root, root.replaceAll('\\', '/')].filter(Boolean);
  const portable = (text: string) => roots.reduce((value, prefix) => value.split(prefix + '/').join('').split(prefix).join('.'), text);
  let current: string | null = null;
  const flush = () => {
    if (current !== null) {
      const identity = sortTypeMembers(current);
      counts[identity] = (counts[identity] ?? 0) + 1;
    }
    current = null;
  };
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line);
    if (match) {
      flush();
      current = `${portable(match[1]!).replaceAll('\\', '/')}\t${match[2]}\t${portable(match[3]!.trim())}`;
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ` ${portable(line.trim())}`;
    } else {
      flush();
    }
  }
  flush();
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface RatchetResult {
  added: Array<{ identity: string; baseline: number; current: number }>;
  fixed: Array<{ identity: string; baseline: number; current: number }>;
}

export function compareDiagnostics(baseline: DiagnosticCounts, current: DiagnosticCounts): RatchetResult {
  const added: RatchetResult['added'] = [], fixed: RatchetResult['fixed'] = [];
  for (const identity of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const before = baseline[identity] ?? 0, now = current[identity] ?? 0;
    if (now > before) added.push({ identity, baseline: before, current: now });
    else if (now < before) fixed.push({ identity, baseline: before, current: now });
  }
  return { added, fixed };
}

export function readBaseline(file: string): DiagnosticCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`test typecheck baseline ${file} is missing or unreadable (${(error as Error).message}). ` +
      'Regenerate it from a clean tree with: bun run typecheck:test --write-baseline');
  }
  const diagnostics = (parsed as { version?: unknown; diagnostics?: unknown })?.diagnostics;
  if ((parsed as { version?: unknown })?.version !== 1 || !diagnostics || typeof diagnostics !== 'object' ||
      !Object.values(diagnostics).every(n => Number.isSafeInteger(n) && (n as number) > 0)) {
    throw new Error(`test typecheck baseline ${file} is malformed. Regenerate it with: bun run typecheck:test --write-baseline`);
  }
  const counts: DiagnosticCounts = {};
  for (const [identity, n] of Object.entries(diagnostics as DiagnosticCounts)) {
    const key = sortTypeMembers(identity);
    counts[key] = (counts[key] ?? 0) + n;
  }
  return counts;
}

function describe(identity: string): string {
  const [file, code, message] = identity.split('\t');
  return `${file} ${code}: ${message}`;
}

function main(): number {
  const write = process.argv.includes('--write-baseline');
  const tsc = spawnSync(process.execPath, ['x', 'tsc', '-p', 'tsconfig.test.json', '--pretty', 'false'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (tsc.error || tsc.signal) {
    console.error(`test typecheck could not run tsc: ${tsc.error?.message ?? tsc.signal}`);
    return 2;
  }
  const current = parseDiagnostics(`${tsc.stdout}\n${tsc.stderr}`);
  const total = Object.values(current).reduce((sum, n) => sum + n, 0);
  if (tsc.status !== 0 && total === 0) {
    console.error(`tsc exited ${tsc.status} without parseable diagnostics:\n${tsc.stdout}${tsc.stderr}`);
    return 2;
  }
  const baselinePath = path.join(ROOT, BASELINE_FILE);
  if (write) {
    fs.writeFileSync(baselinePath, JSON.stringify({ version: 1, diagnostics: current }, null, 2) + '\n');
    console.log(`test typecheck ratchet: wrote ${BASELINE_FILE} (${total} diagnostics, ${Object.keys(current).length} identities)`);
    return 0;
  }
  let baseline: DiagnosticCounts;
  try {
    baseline = readBaseline(baselinePath);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  const { added, fixed } = compareDiagnostics(baseline, current);
  if (added.length) {
    console.error(`test typecheck ratchet: ${added.length} new or more frequent diagnostic(s). Fix them; do not add them to the baseline.`);
    for (const d of added) console.error(`  + ${describe(d.identity)} (${d.baseline} → ${d.current})`);
    console.error('Reproduce with: bunx tsc -p tsconfig.test.json --pretty false');
  }
  if (fixed.length) {
    console.error(`test typecheck ratchet: ${fixed.length} diagnostic(s) fixed. Lock the smaller allowance in with: bun run typecheck:test --write-baseline`);
    for (const d of fixed) console.error(`  - ${describe(d.identity)} (${d.baseline} → ${d.current})`);
  }
  if (added.length || fixed.length) return 1;
  console.log(`test typecheck ratchet: ${total} known diagnostics, none new.`);
  return 0;
}

if (import.meta.main) process.exit(main());
