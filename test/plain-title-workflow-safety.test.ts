/**
 * plain-title.yml runs on pull_request_target, so it is held to the same static
 * tripwire as pr-title-sync.yml (test/pr-title-sync-workflow-safety.test.ts):
 * the job checks out the base repo only (no ref:), every PR field reaches the
 * shell through env:, never as an inlined ${{ github.event.pull_request.* }}
 * inside run:, the token is read-only, and every action is pinned to a commit.
 * The job name "Plain title" is what ship-policy's required_checks will name.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW = path.resolve(import.meta.dir, '..', '.github/workflows/plain-title.yml');
const content = fs.readFileSync(WORKFLOW, 'utf8');

const indent = (line: string) => line.match(/^( *)/)![1]!.length;

/** The lines inside every run: block (inline or block scalar), with 1-based line numbers. */
function runBlockLines(text: string): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let runIndent = -1;
  text.split('\n').forEach((line, i) => {
    const inline = line.match(/^\s*(?:-\s*)?run:\s*(\S.*)$/);
    if (runIndent >= 0 && line.trim() !== '' && indent(line) <= runIndent) runIndent = -1;
    if (runIndent >= 0) { out.push({ n: i + 1, text: line }); return; }
    if (inline && !/^[|>]/.test(inline[1]!)) { out.push({ n: i + 1, text: inline[1]! }); return; }
    if (/^\s*(?:-\s*)?run:\s*[|>][+-]?\s*$/.test(line)) runIndent = indent(line);
  });
  return out;
}

describe('plain-title.yml pull_request_target safety', () => {
  test('runs on pull_request_target for the PR events that change a title, body or head', () => {
    expect(content).toMatch(/^on:\s*\n\s+pull_request_target:/m);
    expect(content).toMatch(/types:\s*\[opened, edited, synchronize, reopened, ready_for_review\]/);
  });

  test('the job is named "Plain title" and cancels older runs for the same PR', () => {
    expect(content).toMatch(/^\s+name: Plain title\s*$/m);
    expect(content).toMatch(/group: plain-title-\$\{\{ github\.event\.pull_request\.number \}\}/);
    expect(content).toMatch(/cancel-in-progress: true/);
  });

  test('checks out the base repo only: no ref: anywhere', () => {
    expect(content.split('\n').filter(l => /^\s*ref:/.test(l))).toEqual([]);
    expect(content).toMatch(/uses: actions\/checkout@/);
  });

  test('no ${{ github.event.pull_request.* }} inside any run: block', () => {
    const lines = runBlockLines(content);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.filter(l => /\$\{\{\s*github\.event\.pull_request/.test(l.text)).map(l => `L${l.n}: ${l.text.trim()}`)).toEqual([]);
  });

  test('the tripwire itself catches an inlined PR field', () => {
    const planted = 'steps:\n  - name: x\n    run: |\n      echo "${{ github.event.pull_request.title }}"\n  - run: echo ${{ github.event.pull_request.body }}\n';
    expect(runBlockLines(planted).filter(l => /\$\{\{\s*github\.event\.pull_request/.test(l.text)).length).toBe(2);
  });

  test('PR text reaches files through env: and printf, or straight from the event file, and is never echoed', () => {
    expect(content).toMatch(/PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
    expect(content).toMatch(/printf '%s' "\$PR_TITLE" >/);
    const run = runBlockLines(content).map(l => l.text).join('\n');
    expect(run).not.toMatch(/\becho\b[^\n]*\$\{?PR_/);
    expect(run).not.toMatch(/\bcat\b/);
  });

  // Value: protects=a PR body larger than one environment string (about 128 KiB) still reaches the checker, so a good
  // title never fails on E2BIG; fails_when=the body travels through env:; why_new=review finding plain-title.yml:58;
  // seam=the workflow text; no_claim=the runner's exact limit
  test('the body is read from the event file, never through env:', () => {
    expect(content).not.toMatch(/github\.event\.pull_request\.body/);
    expect(content).toMatch(/jq -j '\.pull_request\.body \/\/ ""' "\$GITHUB_EVENT_PATH" > "\$RUNNER_TEMP\/pr-body\.txt"/);
  });

  test('permissions are read-only', () => {
    const perms = content.match(/^permissions:\n((?:\s+.+\n)+)/m)?.[1] ?? '';
    expect(perms).toMatch(/contents: read/);
    expect(perms).toMatch(/pull-requests: read/);
    expect(content).not.toMatch(/:\s*write\b/);
  });

  test('the title is refused against created_at; branch, opening and commits only warn', () => {
    expect(content).toMatch(/--title-file "\$RUNNER_TEMP\/pr-title\.txt" --created-at "\$PR_CREATED_AT" --mode refuse/);
    expect(content).toMatch(/--commits-file "\$RUNNER_TEMP\/pr-commits\.txt" --created-at "\$PR_CREATED_AT" --mode warn/);
  });

  test('every action runs at a reviewed commit SHA, not a movable tag', () => {
    const uses = [...content.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map(m => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  // Value: protects=a base-only edit reruns the title check and never posts a skipped "Plain title" run that ciAtHead and
  // branch protection count as passing over an earlier refusal; fails_when=a job-level if: can skip the whole job;
  // why_new=review finding plain-title.yml:34 (fail-open); seam=the workflow text; no_claim=GitHub's check ranking
  test('the job has no job-level if:, so a skipped run never replaces a refused title', () => {
    const job = content.split(/^  plain-title:\s*$/m)[1]!.split(/^    steps:\s*$/m)[0]!;
    expect(job).toMatch(/name: Plain title/);
    expect(job).not.toMatch(/^    if:/m);
  });
});
