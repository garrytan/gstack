import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Wiring scanner: every tracker-TEXT read (PR/issue bodies, comment bodies,
 * issue titles judged by the model) in skill templates, resolvers, and runtime
 * reference docs must flow through bin/gstack-issue-guard. Same posture as
 * test/egress-receipt-wiring.test.ts: a regex tripwire behind a centralized
 * helper — it catches drift, it is not the enforcement itself.
 *
 * A line is compliant when it mentions gstack-issue-guard, or when the
 * (file, reason) pair is enumerated in SCANNER_EXEMPT below. Exemptions are
 * REASONED — a new raw read needs either the guard or an entry here explaining
 * why it is not model-context ingress.
 */

const ROOT = path.resolve(import.meta.dir, '..');

// Tracker-TEXT read shapes. Field-list/state-routing fetches (e.g.
// `--json number,state,title` used to route on state) are deliberately not
// matched — see the pattern notes.
const READ_PATTERNS: { name: string; re: RegExp }[] = [
  // The field list must contain `body` immediately after --json (comma list),
  // so `--json number` followed by unrelated prose mentioning "body" (e.g.
  // ship's REST write fallback `-F body=@file`) does not over-match.
  { name: 'gh pr body read', re: /gh pr view[^\n|]*--json[\s"']*[a-z,]*\bbody\b/ },
  { name: 'gh issue body read', re: /gh issue view[^\n|]*--json[\s"']*[a-z,]*\bbody\b/ },
  { name: 'gh comment-body api read', re: /gh api[^\n]*\/(pulls|issues)\/[^\n]*comments/ },
  // Titles are tracker text when the MODEL judges them (dedupe similarity);
  // `gh issue list` with a title field is matched, `gh pr view --json title`
  // (mechanical title-prefix rewrite) is not.
  { name: 'gh issue-list title read', re: /gh issue list[^\n]*--json[\s"']*[a-z,]*\btitle\b/ },
  { name: 'glab body/description read', re: /glab mr view[^\n]*(description|--json[\s"']*[a-z,]*\bbody\b)/ },
  // Flagless `gh pr view` / `gh issue view <n>` print the FULL body in their
  // default human output — a raw read without --json is still a body read.
  // (?![`/]) excludes prose mentions like "If `gh pr view` / `glab mr view` fails".
  { name: 'gh flagless body read', re: /gh (pr|issue) view(?![`/])(?![^\n]*--json)(?![^\n]*-q )[^\n]*/ },
];

// (file, pattern-name) exemptions with reasons. Keep every entry REASONED.
const SCANNER_EXEMPT: { file: string; pattern: string; reason: string }[] = [
  {
    file: 'review/greptile-triage.md',
    pattern: 'gh comment-body api read',
    reason:
      'raw fetch lands in /tmp json FILES (metadata/body split); body text is read into context only via the gstack-issue-guard --stdin pipes documented in the same file',
  },
  {
    file: 'document-release/sections/release-body.md.tmpl',
    pattern: 'gh pr body read',
    reason:
      'two-artifact flow: this is the RAW write-back tempfile fetch; the context read is enveloped at step 1b and a banner tripwire guards the write side',
  },
  {
    file: 'document-release/sections/release-body.md.tmpl',
    pattern: 'glab body/description read',
    reason: 'two-artifact flow (GitLab twin of the raw write-back fetch); context read enveloped at step 1b',
  },
];

function trackedFiles(): string[] {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(
      (f) =>
        // Sources of truth only: templates, template sections, resolvers, and
        // runtime reference docs inside skill dirs. Generated SKILL.md files
        // are derived from these and would double-report.
        (f.endsWith('.md.tmpl') ||
          f.endsWith('SKILL.md.tmpl') ||
          /^scripts\/resolvers\/.*\.ts$/.test(f) ||
          /^review\/[^/]+\.md$/.test(f)) &&
        !f.endsWith('SKILL.md'),
    );
}

describe('tracker-text wiring scanner', () => {
  test('every tracker-text read flows through gstack-issue-guard (or carries a reasoned exemption)', () => {
    const violations: string[] = [];
    for (const rel of trackedFiles()) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const lines = fs.readFileSync(abs, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        for (const { name, re } of READ_PATTERNS) {
          if (!re.test(line)) continue;
          if (line.includes('gstack-issue-guard')) continue;
          // Multi-line shell pipeline: a read whose continuation lines pipe
          // into the guard is compliant (spec's dedupe block ends in `\`).
          if (line.trimEnd().endsWith('\\')) {
            const continuation = lines.slice(i + 1, i + 4).join('\n');
            if (continuation.includes('gstack-issue-guard')) continue;
          }
          const exempt = SCANNER_EXEMPT.some((e) => e.file === rel && e.pattern === name);
          if (exempt) continue;
          violations.push(`${rel}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(
        `Raw tracker-text read(s) outside gstack-issue-guard:\n  ${violations.join('\n  ')}\n\n` +
          `Fix: pipe the read through bin/gstack-issue-guard (--stdin for pre-fetched text), or — ` +
          `if this is genuinely not model-context ingress (mechanical rewrite, state routing, raw ` +
          `write-back artifact) — add a REASONED entry to SCANNER_EXEMPT in this file.`,
      );
    }
    expect(violations).toEqual([]);
  });

  test('exemption entries stay live (a stale exemption means the site moved — re-audit it)', () => {
    for (const e of SCANNER_EXEMPT) {
      const abs = path.join(ROOT, e.file);
      expect(fs.existsSync(abs)).toBe(true);
      const content = fs.readFileSync(abs, 'utf-8');
      const pat = READ_PATTERNS.find((p) => p.name === e.pattern)!;
      const hasMatch = content.split('\n').some((l) => pat.re.test(l) && !l.includes('gstack-issue-guard'));
      expect(hasMatch).toBe(true);
    }
  });

  test('the guarded sites actually mention the guard (wiring, not just lib existence)', () => {
    const mustMention = [
      'review/greptile-triage.md',
      'document-release/sections/release-body.md.tmpl',
      'spec/SKILL.md.tmpl',
      'land-and-deploy/SKILL.md.tmpl',
      'scripts/resolvers/review.ts',
    ];
    for (const rel of mustMention) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(content).toContain('gstack-issue-guard');
    }
  });
});
