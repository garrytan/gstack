/**
 * Workflow concurrency tripwire (gate, free).
 *
 * The waste this kills: a workflow triggered on BOTH `push` and `pull_request`
 * runs twice for the same commit on a same-repo PR branch — once for the push,
 * once for the PR — and, without a `concurrency` group that cancels in progress,
 * every new push to an active branch leaves the previous (now-obsolete) runs
 * queued/running. The heavier workflows already cancel superseded runs
 * (evals.yml, windows-free-tests.yml, make-pdf-gate.yml, version-gate.yml,
 * pr-title-sync.yml); the two always-on lightweight ones (actionlint.yml,
 * skill-docs.yml) historically did not, so a rapid push series piled up stale
 * Workflow Lint / Skill Docs Freshness runs.
 *
 * This static check reads the workflow files directly and fails CI if a
 * push+pull_request workflow ever ships again without `cancel-in-progress`.
 * Mirrors the static-grep invariant tests in this dir
 * (pr-title-sync-workflow-safety) and browse/test (terminal-agent-pid-identity).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW_DIR = path.resolve(__dirname, '..', '.github', 'workflows');

/**
 * Extract the top-level event names from a workflow's `on:` declaration.
 * Handles the inline array form (`on: [push, pull_request]`) and the mapping
 * form (`on:` followed by indented event keys). Returns exact event tokens, so
 * `pull_request_target` is never conflated with `pull_request`.
 */
function parseTriggers(content: string): Set<string> {
  const lines = content.split('\n');
  const events = new Set<string>();
  const onIdx = lines.findIndex((l) => /^on:/.test(l));
  if (onIdx === -1) return events;

  const onLine = lines[onIdx];
  // Inline array form: on: [push, pull_request]
  const inline = onLine.match(/^on:\s*\[([^\]]*)\]/);
  if (inline) {
    for (const tok of inline[1].split(',')) {
      const name = tok.trim();
      if (name) events.add(name);
    }
    return events;
  }

  // Inline single form: on: push
  const single = onLine.match(/^on:\s*([a-z_]+)\s*$/);
  if (single) {
    events.add(single[1]);
    return events;
  }

  // Mapping form: collect keys at the first sub-indent level under `on:`.
  let keyIndent = -1;
  for (let i = onIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue; // skip blanks/comments
    const ind = line.match(/^( *)/)![1].length;
    if (ind === 0) break; // back to a top-level key (jobs:, env:, ...) → on: block ended
    if (keyIndent === -1) keyIndent = ind;
    if (ind !== keyIndent) continue; // deeper config under an event (branches:, paths:, ...)
    const key = line.match(/^\s*([a-z_]+):/);
    if (key) events.add(key[1]);
  }
  return events;
}

const workflowFiles = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('workflow concurrency', () => {
  test('there are workflow files to check', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  for (const file of workflowFiles) {
    const content = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf-8');
    const triggers = parseTriggers(content);
    const isPushAndPr = triggers.has('push') && triggers.has('pull_request');
    if (!isPushAndPr) continue;

    test(`${file} (push + pull_request) cancels superseded runs`, () => {
      expect(content).toMatch(/cancel-in-progress:\s*true/);
    });
  }

  // Pin the two workflows the tripwire was written for, so a future trigger
  // rename can't silently drop them out of the push+pull_request set above.
  for (const file of ['actionlint.yml', 'skill-docs.yml']) {
    test(`${file} declares a concurrency group with cancel-in-progress`, () => {
      const content = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf-8');
      expect(content).toMatch(/^concurrency:/m);
      expect(content).toMatch(/cancel-in-progress:\s*true/);
    });
  }
});
