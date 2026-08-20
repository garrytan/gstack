/**
 * pr-title-sync.yml is a `pull_request_target` workflow — static injection
 * tripwire (gate, free).
 *
 * The anxiety this kills: `pull_request_target` runs with a WRITE token in the
 * base-repo context, even for fork PRs. That is what lets this workflow rewrite
 * fork-PR titles (the backstop). It is also the single most dangerous workflow
 * trigger in GitHub Actions. Two classic footguns turn it into remote code
 * execution / token theft, and `actionlint` catches NEITHER:
 *
 *   1. Checking out the PR head (`actions/checkout` with a `ref:` pointing at
 *      `pull_request.head` / `head_ref`) and then running anything from it —
 *      that executes attacker-controlled fork code with the write token.
 *   2. Interpolating an attacker-controlled `${{ github.event.pull_request.* }}`
 *      field directly INSIDE a `run:` block — the title/body are attacker-
 *      controlled and the `${{ }}` is expanded into the shell before execution,
 *      so a crafted title runs as code. Those fields MUST arrive via `env:` and
 *      be referenced as `"$VAR"` (shell-quoted), never inlined.
 *
 * This tripwire reads the workflow file directly and fails CI if either pattern
 * reappears. Mirrors the static-grep invariant tests in browse/test
 * (terminal-agent-pid-identity, server-sanitize-surrogates).
 *
 * Note: `gh api ... -q '.head.sha'` inside a run block is SAFE (reading PR
 * metadata as data via a jq filter string, not `${{ }}` interpolation), so we
 * ban the interpolation form specifically, not the literal substring `head.sha`.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW = path.resolve(__dirname, '..', '.github', 'workflows', 'pr-title-sync.yml');

/** Indentation width (count of leading spaces) of a line. */
function indent(line: string): number {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

/**
 * Return the lines that live inside a `run:` block, each tagged with its 1-based
 * line number. Handles both `run: |` (multiline) and `run: <inline command>`.
 */
function runBlockLines(content: string): Array<{ n: number; text: string }> {
  const lines = content.split('\n');
  const out: Array<{ n: number; text: string }> = [];
  let inRun = false;
  let runIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    const inlineRun = line.match(/^(\s*)run:\s*(\S.*)$/); // `run: echo foo`
    const blockRun = /^(\s*)run:\s*(\|>?[+-]?)?\s*$/.test(line); // `run: |`
    if (inlineRun && !/^\|/.test(inlineRun[2])) {
      out.push({ n, text: inlineRun[2] });
      inRun = false;
      continue;
    }
    if (blockRun) {
      inRun = true;
      runIndent = indent(line);
      continue;
    }
    if (inRun) {
      if (line.trim() === '') {
        out.push({ n, text: line });
        continue;
      }
      // Block ends when a non-empty line is indented at or below the `run:` key.
      if (indent(line) <= runIndent) {
        inRun = false;
      } else {
        out.push({ n, text: line });
      }
    }
  }
  return out;
}

describe('pr-title-sync.yml pull_request_target safety', () => {
  const content = fs.readFileSync(WORKFLOW, 'utf-8');

  test('workflow file exists', () => {
    expect(fs.existsSync(WORKFLOW)).toBe(true);
  });

  test('does NOT check out the PR head ref (no fork-code execution)', () => {
    const offenders: string[] = [];
    content.split('\n').forEach((line, i) => {
      // A checkout `ref:` (or any `ref:`) pointing at the PR head is the footgun.
      if (/ref:\s*\$\{\{[^}]*(pull_request\.head|head_ref)/.test(line)) {
        offenders.push(`  L${i + 1}: ${line.trim()}`);
      }
    });
    if (offenders.length > 0) {
      throw new Error(
        `pr-title-sync.yml checks out the PR head under pull_request_target — that ` +
          `runs attacker-controlled fork code with a write token. Check out the base ` +
          `repo (no ref:) and read PR-head data via the API instead.\n` +
          offenders.join('\n'),
      );
    }
  });

  test('does NOT interpolate ${{ github.event.pull_request.* }} inside a run: block', () => {
    const offenders: string[] = [];
    for (const { n, text } of runBlockLines(content)) {
      if (/\$\{\{\s*github\.event\.pull_request/.test(text)) {
        offenders.push(`  L${n}: ${text.trim()}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `pr-title-sync.yml inlines an attacker-controlled PR field into a run: block ` +
          `— a crafted PR title/body executes as shell. Pass it via env: and ` +
          `reference "$VAR" (shell-quoted) instead.\n` +
          offenders.join('\n'),
      );
    }
  });

  test('uses pull_request_target (the hardening is actually present)', () => {
    // Positive assertion: if someone reverts to plain pull_request, the fork
    // backstop silently stops working (read-only token). Keep it intentional.
    expect(/^on:\s*$/m.test(content) || /\bpull_request_target\b/.test(content)).toBe(true);
    expect(content).toMatch(/\bpull_request_target\b/);
  });

  test('passes the PR title through env:, not raw interpolation', () => {
    // The safe pattern: OLD_TITLE: ${{ github.event.pull_request.title }} in an
    // env: mapping, consumed as "$OLD_TITLE" in script.
    expect(content).toMatch(/env:/);
    expect(content).toMatch(/github\.event\.pull_request\.title/);
  });
});
