/**
 * Git-ref fixture tripwire: no test or helper may pin repo content to a raw
 * commit SHA (the `git show <sha>:path` fixture pattern).
 *
 * The class: test/helpers/auq-sdk-capture.ts defaulted verboseSkill() to
 * `git show ab66193e^:plan-ceo-review/SKILL.md` — a BRANCH-LOCAL ref. That
 * fixture dies the day the branch is pruned, and already failed on shallow
 * clones (CI executors fetch-depth-0 exists precisely because self-derived
 * selection crashed on shallow checkouts). The v1.75 precedent is to VENDOR
 * the frozen content under test/fixtures/ instead — content-addressed by the
 * repo itself, immune to ref pruning and clone depth.
 *
 * Scans test trees + helpers for two shapes:
 *   - a quoted `<hex>{7,40}[^]?:` rev-path (the `git show SHA:path` form)
 *   - a gitRef-style default parameter carrying a raw hex SHA
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCAN_ROOTS = ['test', 'browse/test', 'design/test', 'make-pdf/test'];
const SELF = path.join('test', 'git-ref-fixture-tripwire.test.ts');

// Quoted `SHA:` rev-path (7-40 hex chars, optional ^/~ suffix, then colon) —
// requires >= 2 digits among the hex so ordinary words ('deadbeef' aside)
// and pure-alpha identifiers don't false-positive.
const REV_PATH = /['"`]([0-9a-f]{7,40})[\^~]?:/g;
const GIT_REF_DEFAULT = /gitRef\s*=\s*['"`][0-9a-f]{7,40}/;

const looksLikeSha = (s: string): boolean => /[0-9]/.test(s) && /[a-f]/.test(s);

describe('git-ref fixture tripwire', () => {
  test('no raw-SHA fixture refs in the test trees (vendor the content instead)', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS) {
      const abs = path.join(ROOT, root);
      if (!fs.existsSync(abs)) continue;
      const stack = [abs];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { stack.push(full); continue; }
          if (!/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) continue;
          const rel = path.relative(ROOT, full);
          if (rel === SELF) continue;
          const src = fs.readFileSync(full, 'utf-8');
          src.split('\n').forEach((line, i) => {
            for (const m of line.matchAll(REV_PATH)) {
              if (looksLikeSha(m[1])) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
            }
            if (GIT_REF_DEFAULT.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
          });
        }
      }
    }
    expect(
      hits,
      `raw-SHA fixture reference(s) — these die on branch prune and fail on shallow clones. `
      + `Vendor the frozen content under test/fixtures/ instead (v1.75 precedent):\n  ${hits.join('\n  ')}`,
    ).toEqual([]);
  });
});
