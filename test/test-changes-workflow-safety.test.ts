/**
 * test-changes.yml runs on pull_request_target, so it is held to the same static
 * tripwire as plain-title.yml: the job checks out the base repo only (no ref:),
 * fetches the pull request's commits as git objects, passes every PR field through
 * env:, never inlines ${{ github.event.pull_request.* }} into run:, holds a
 * read-only token it does not persist, uses no secrets, and pins every action.
 *
 * Value: protects=a pull request can never run its own code with the base repo's token or edit the checker that
 * reports on it; fails_when=a ref: checkout, an inlined PR field, a write permission, a secret or an unpinned action
 * appears; why_new=the workflow is new (GST-3386); seam=the workflow text; no_claim=GitHub's runtime behaviour
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const content = fs.readFileSync(path.resolve(import.meta.dir, '..', '.github/workflows/test-changes.yml'), 'utf8');
const indent = (line: string) => line.match(/^( *)/)![1]!.length;

function runBlockLines(text: string): string[] {
  const out: string[] = [];
  let runIndent = -1;
  for (const line of text.split('\n')) {
    const inline = line.match(/^\s*(?:-\s*)?run:\s*(\S.*)$/);
    if (runIndent >= 0 && line.trim() !== '' && indent(line) <= runIndent) runIndent = -1;
    if (runIndent >= 0) { out.push(line); continue; }
    if (inline && !/^[|>]/.test(inline[1]!)) { out.push(inline[1]!); continue; }
    if (/^\s*(?:-\s*)?run:\s*[|>][+-]?\s*$/.test(line)) runIndent = indent(line);
  }
  return out;
}

describe('test-changes.yml pull_request_target safety', () => {
  test('runs on pull_request_target when a pull request opens or its head moves', () => {
    expect(content).toMatch(/^on:\s*\n\s+pull_request_target:\s*\n\s+types:\s*\[opened, synchronize, reopened\]/m);
  });

  test('checks out the base repo only, full history, without persisting the token', () => {
    expect(content.split('\n').filter((l) => /^\s*ref:/.test(l))).toEqual([]);
    expect(content).toMatch(/fetch-depth: 0\n\s+filter: blob:none/);
    expect(content).toMatch(/persist-credentials[:] false/);
  });

  test('the pull request arrives as git objects and the report reads it with --head', () => {
    const run = runBlockLines(content).join('\n');
    expect(run).toContain('git fetch --no-tags --quiet origin "+refs/pull/$PR_NUM/head:refs/remotes/pr/head"');
    expect(run).toContain('git cat-file -e "$PR_HEAD_SHA^{commit}"');
    expect(run).toMatch(/scripts\/test-changes-report\.ts \\\n\s+--base "\$\(git rev-parse HEAD\)" --head "\$PR_HEAD_SHA" --summary-file "\$GITHUB_STEP_SUMMARY"/);
    expect(run).not.toMatch(/git (?:checkout|switch|worktree|merge|reset)\b/);
    expect(run).not.toMatch(/\bbun (?:install|run)\b|\bnpm\b|\bnpx\b|\bbunx\b/);
  });

  test('no ${{ github.event.pull_request.* }} inside any run: block, and the tripwire catches one', () => {
    const lines = runBlockLines(content);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.filter((l) => /\$\{\{\s*github\.event/.test(l))).toEqual([]);
    const planted = 'steps:\n  - run: |\n      echo "${{ github.event.pull_request.title }}"\n  - run: echo ${{ github.event.pull_request.body }}\n';
    expect(runBlockLines(planted).filter((l) => /\$\{\{\s*github\.event/.test(l)).length).toBe(2);
  });

  test('read-only token, no secrets, every action pinned to a commit', () => {
    expect(content).toMatch(/^permissions:\n  contents: read\n\n/m);
    expect(content).not.toMatch(/:\s*write\b/);
    expect(content).not.toMatch(/\$\{\{\s*secrets\./);
    const uses = [...content.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBe(2);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
