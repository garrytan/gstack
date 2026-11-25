/**
 * docs/unattended.md#what-an-unattended-session-may-do: the grant a parent
 * gives an unattended run, and the pointer /ship's handoff section carries so a
 * lane reads it where it reports done.
 *
 * Value: protects=the handoff pointer resolves to the grant section, and the grant states merge-never, the pinned-lease push form and the /modernize disposition; fails_when=the heading is renamed or moved, the pointer is dropped from the template or its render, or the grant loses a rule; why_new=no test reads the new section or the handoff pointer; seam=none; no_claim=that a run obeys the grant (eval-side)
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POINTER = 'docs/unattended.md#what-an-unattended-session-may-do';
const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');

describe('the unattended grant and the /ship handoff pointer to it', () => {
  const docs = read('docs/unattended.md');
  const grantStart = docs.indexOf('\n## What an unattended session may do\n');
  const grant = docs.slice(grantStart + 1, (i => i === -1 ? docs.length : i)(docs.indexOf('\n## ', grantStart + 1)));

  test('the handoff section points at a heading that exists, in the template and its render', () => {
    expect(grantStart).toBeGreaterThan(0);
    const heading = grant.slice(3, grant.indexOf('\n'));
    expect(`docs/unattended.md#${slug(heading)}`).toBe(POINTER);
    expect(read('ship/sections/handoff.md.tmpl')).toContain(`What an\nunattended run may do is ${POINTER}.`);
    expect(read('ship/sections/handoff.md')).toContain(POINTER);
    expect(grant).toContain('`/gstack-ship`\'s handoff section (`ship/sections/handoff.md`) points here');
  });

  test('the grant names each rule once: merge never, a pinned-lease force-push on its own branch, named test methods, own-eyes proof', () => {
    const flat = grant.replace(/\s+/g, ' ');
    expect(flat).toContain('- **Merge: never.**');
    expect(flat).toContain('- **Force-push: its own branch only, after a rebase the plan named, with a pinned lease.**');
    expect(flat).toContain('- **Tests: the methods the repository\'s instructions name, without asking first.**');
    expect(flat).toContain('- **Proof is what the run saw itself.**');
    expect(flat).toContain('`git push --force-with-lease=<branch>:<sha observed before the rebase> origin <branch>`');
    expect(flat).toContain('a plain `--force` is never allowed');
    expect(flat).toContain('`git range-diff <old base>..<old head> <new base>..<new head>` runs before the push');
    expect(flat).toContain('a `/modernize` disposition names before it happens');
    expect(flat).toContain('enabling auto-merge, adding the PR to a merge queue, or `gh pr ready` on a PR the run did not open');
    expect(flat).toContain('appended to `decisions.jsonl` with `kind: "approval"` and `status: "pending"`');
  });
});
