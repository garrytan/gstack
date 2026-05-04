/**
 * Regression test for the `shared-checkout-branch-flip-during-review` failure mode.
 *
 * Empirical context (2026-05-04, claude-teams-bot project):
 *   Three back-to-back PR reviews observed `/security-review` (and the gstack
 *   /review and /cso skills) rendering against the WRONG branch's diff.
 *   Root cause: review skills used `git diff origin/<base>` (or `origin/HEAD...`,
 *   or `<base>..HEAD`), all of which depend on the local working tree's HEAD.
 *   When a nested subagent ran `git checkout` (e.g., to inspect a sibling branch's
 *   file) and forgot to switch back, every subsequent `git diff` silently
 *   re-rendered against the new branch, and the review reported findings on
 *   unrelated code.
 *
 * The fix (review/SKILL.md.tmpl Step 0.5, cso/SKILL.md.tmpl Step 0.5):
 *   Pin BASE_SHA and HEAD_SHA at the start of the skill via `git rev-parse` /
 *   `gh pr view`, then use those SHAs in every subsequent diff/log/show
 *   command. SHAs are immutable across worktree flips.
 *
 * This test reproduces the failure mode end-to-end in a real git repo:
 *   1. Build a repo with two divergent feature branches A and B
 *   2. Check out branch B (the "PR branch we're reviewing")
 *   3. Pin BASE_SHA and HEAD_SHA via the same logic Step 0.5 uses
 *   4. Flip the worktree to branch A (simulating a subagent's stray checkout)
 *   5. Verify three things:
 *      a) Bare `git diff main` returns A's diff (the bug — wrong branch)
 *      b) `git diff "$BASE_SHA" "$HEAD_SHA"` returns B's diff (the fix — correct)
 *      c) The two diffs are NOT equal (proves the failure mode is real, not
 *         a degenerate case)
 *
 * If this test starts failing, it means either (a) someone re-introduced the
 * bare-ref pattern in a review skill, or (b) git's behavior around symbolic
 * vs. SHA refs changed. Both are worth investigating before merging.
 *
 * Free tier. ~500ms runtime (mostly git subprocess overhead).
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const ROOT = join(import.meta.dir, '..');
const dirs: string[] = [];

interface RepoFixture {
  dir: string;
  baseSha: string; // main branch tip
  branchASha: string;
  branchBSha: string;
}

/**
 * Build a tiny fixture repo:
 *   main: README.md
 *   feature-A (off main): adds a.txt
 *   feature-B (off main): adds b.txt
 * Both branches diverge from the same base. The worktree is left checked
 * out on feature-B (the "PR branch we're reviewing").
 */
function buildFixture(): RepoFixture {
  const dir = mkdtempSync(join(tmpdir(), 'pr-diff-pin-'));
  dirs.push(dir);

  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 10000 });
    if (r.status !== 0 && cmd === 'git') {
      // Surface git failures so the test fails with a useful message instead
      // of cryptic empty SHAs downstream.
      const stderr = r.stderr?.toString() ?? '';
      throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${stderr}`);
    }
    return r;
  };
  const capture = (cmd: string, args: string[]): string => {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 10000 });
    return r.stdout.toString().trim();
  };

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  run('git', ['config', 'commit.gpgsign', 'false']);
  run('git', ['config', 'core.autocrlf', 'false']);

  // Base commit on main.
  writeFileSync(join(dir, 'README.md'), 'base\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial']);
  const baseSha = capture('git', ['rev-parse', 'HEAD']);

  // feature-A off main.
  run('git', ['checkout', '-b', 'feature-A']);
  writeFileSync(join(dir, 'a.txt'), 'A change\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'feature A']);
  const branchASha = capture('git', ['rev-parse', 'HEAD']);

  // feature-B off main (back to main, then branch).
  run('git', ['checkout', 'main']);
  run('git', ['checkout', '-b', 'feature-B']);
  writeFileSync(join(dir, 'b.txt'), 'B change\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'feature B']);
  const branchBSha = capture('git', ['rev-parse', 'HEAD']);

  // Leave the worktree on feature-B — this is "the branch the user
  // intended to review" before any subagent stomp.
  return { dir, baseSha, branchASha, branchBSha };
}

function gitDiffOutput(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['diff', ...args], {
    cwd: dir, stdio: 'pipe', timeout: 10000,
  });
  return r.stdout.toString();
}

afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('pr-diff-pin regression — shared-checkout-branch-flip-during-review', () => {
  test('the working-tree-flip failure mode is real (sanity)', () => {
    // Establishes that the bug ISN'T already fixed by some unrelated change in git.
    // If this assertion ever stops holding, the rest of this test file is moot
    // and the named failure mode no longer exists.
    const { dir } = buildFixture();

    // We're on feature-B. `git diff main` shows B's changes.
    const diffOnB = gitDiffOutput(dir, 'main');
    expect(diffOnB).toContain('b.txt');
    expect(diffOnB).not.toContain('a.txt');

    // Subagent flips us to feature-A.
    spawnSync('git', ['checkout', 'feature-A'], { cwd: dir, stdio: 'pipe' });

    // Same `git diff main` invocation — now silently re-renders against A.
    const diffAfterFlip = gitDiffOutput(dir, 'main');
    expect(diffAfterFlip).toContain('a.txt');
    expect(diffAfterFlip).not.toContain('b.txt');

    // Same command, two different answers. That IS the bug.
    expect(diffOnB).not.toEqual(diffAfterFlip);
  });

  test('SHA-pinning produces stable diff across worktree flips', () => {
    const { dir, baseSha, branchBSha } = buildFixture();

    // Pin SHAs while we're on feature-B (this is what review/SKILL.md.tmpl
    // Step 0.5 does — `git rev-parse origin/<base>` and `gh pr view --json
    // headRefOid`, both immutable refs).
    const pinnedDiffOnB = gitDiffOutput(dir, baseSha, branchBSha);

    // Subagent stomps to feature-A.
    spawnSync('git', ['checkout', 'feature-A'], { cwd: dir, stdio: 'pipe' });
    expect(spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir, stdio: 'pipe',
    }).stdout.toString().trim()).toBe('feature-A');

    // Re-run the SHA-pinned diff. Should be byte-identical.
    const pinnedDiffAfterFlip = gitDiffOutput(dir, baseSha, branchBSha);
    expect(pinnedDiffAfterFlip).toEqual(pinnedDiffOnB);
    expect(pinnedDiffAfterFlip).toContain('b.txt');
    expect(pinnedDiffAfterFlip).not.toContain('a.txt');
  });

  test('git log with pinned range is also stable', () => {
    const { dir, baseSha, branchBSha } = buildFixture();

    const log = (...args: string[]) =>
      spawnSync('git', ['log', ...args], {
        cwd: dir, stdio: 'pipe', timeout: 10000,
      }).stdout.toString();

    const before = log(`${baseSha}..${branchBSha}`, '--oneline');
    expect(before).toContain('feature B');
    expect(before).not.toContain('feature A');

    spawnSync('git', ['checkout', 'feature-A'], { cwd: dir, stdio: 'pipe' });

    const after = log(`${baseSha}..${branchBSha}`, '--oneline');
    expect(after).toEqual(before);
  });

  test('git show with pinned SHA is also stable', () => {
    const { dir, baseSha, branchBSha } = buildFixture();

    // Each branch tip writes its own files. `git show <sha>:<path>` only
    // succeeds for the path that exists in that commit.
    const showB = spawnSync('git', ['show', `${branchBSha}:b.txt`], {
      cwd: dir, stdio: 'pipe', timeout: 10000,
    });
    expect(showB.status).toBe(0);
    expect(showB.stdout.toString()).toContain('B change');

    spawnSync('git', ['checkout', 'feature-A'], { cwd: dir, stdio: 'pipe' });

    const showBAfterFlip = spawnSync('git', ['show', `${branchBSha}:b.txt`], {
      cwd: dir, stdio: 'pipe', timeout: 10000,
    });
    expect(showBAfterFlip.status).toBe(0);
    expect(showBAfterFlip.stdout.toString()).toEqual(showB.stdout.toString());
  });

  // ─── Template smell-tests ─────────────────────────────────────────────────
  //
  // Catch regressions where someone re-introduces a bare-ref pattern into
  // the /review or /cso skill templates. The PR_DIFF_PIN preamble is
  // load-bearing — if a template starts using `git diff origin/<base>`
  // again instead of `git diff "$BASE_SHA" "$HEAD_SHA"`, this test fails.

  /**
   * Pull out only **imperative** uses of `git diff` / `git log` / `git show`
   * — i.e., commands the agent will actually run. We collect both:
   *   (a) lines inside fenced bash blocks (```bash … ```), and
   *   (b) inline backtick-quoted commands in narrative prose
   *       (e.g. `Run \`git diff origin/<base>\` to get the full diff.`),
   * which are also imperative — the agent reads narrative prose and runs
   * the backtick-wrapped command verbatim. Codex's review caught a real
   * gap here: we'd flagged Step 3's bash blocks but the inline Step-1
   * directive was previously bare-ref.
   *
   * We deliberately exclude markdown table rows (don't/do comparison
   * tables that document the bad patterns) and explicit "**Don't**" /
   * "**Do**:" labels.
   */
  function imperativeBashCommands(content: string): string[] {
    const lines = content.split('\n');
    const commands: string[] = [];
    let inBash = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (/^```(\w+)?$/.test(trimmed)) {
        if (inBash) {
          inBash = false;
        } else if (trimmed === '```bash' || trimmed === '```sh') {
          inBash = true;
        }
        continue;
      }
      if (inBash) {
        if (trimmed.startsWith('#')) continue; // bash comment
        if (trimmed === '') continue;
        commands.push(line);
        continue;
      }
      // Outside a fenced block — pull out inline backtick-quoted commands
      // that look imperative (start with git/gh/bun, not narrative quotes
      // about a pattern).
      const inlineMatches = line.match(/`([^`]+)`/g) ?? [];
      for (const m of inlineMatches) {
        const cmd = m.slice(1, -1).trim();
        // Skip variable refs like `$BASE_SHA`, type names, etc.
        if (!/^(git|gh|bun)\s/.test(cmd)) continue;
        // Skip "table-row-like" lines (markdown table cells).
        if (trimmed.startsWith('|')) continue;
        // Skip lines that explicitly label the bad pattern (Don't / wrong / bug).
        if (/\*\*Don'?t\*\*|\bbad pattern\b|\bworking-tree dependent — bug\b/i.test(line)) continue;
        // Skip lines that QUOTE a bad pattern alongside its replacement — these are
        // inline "don't X, do Y" sentences, not imperatives.
        if (
          /`(git diff origin\/<base>|<base>\.\.HEAD|origin\/HEAD\.\.\.)/.test(line) &&
          /\$BASE_SHA|\$HEAD_SHA/.test(line) &&
          // and the BAD pattern is what we're currently looking at
          /^(git diff origin\/<base>|git log .*<base>\.\.HEAD|git diff --name-only origin\/HEAD\.\.\.|git diff <base>\.\.HEAD|git diff origin\/<base>\.\.\.HEAD)/.test(cmd)
        ) {
          continue;
        }
        commands.push(`(inline) ${cmd}`);
      }
    }
    return commands;
  }

  test('review/SKILL.md.tmpl uses pinned SHAs, not bare refs', () => {
    const tmpl = readFileSync(join(ROOT, 'review', 'SKILL.md.tmpl'), 'utf-8');
    const bashCommands = imperativeBashCommands(tmpl).join('\n');

    // Must include the resolver invocation.
    expect(tmpl).toContain('{{PR_DIFF_PIN}}');

    // Imperative bash commands should reference the pinned SHAs.
    expect(bashCommands).toContain('$BASE_SHA');
    expect(bashCommands).toContain('$HEAD_SHA');

    // Imperative bash commands must NOT use the working-tree-dependent forms.
    // The narrative prose can mention them (and does — to explain why we don't
    // use them); only fenced bash blocks are checked here.
    for (const bad of [
      /\bgit\s+diff\s+origin\/<base>(?!\.\.\.\$HEAD_SHA|\s*--name-only\s+"\$BASE_SHA")/,
      /\bgit\s+log\s+[^"`\n]*<base>\.\.HEAD\b/,
      /\bgit\s+diff\s+--name-only\s+origin\/HEAD\.\.\./,
    ]) {
      expect(bashCommands).not.toMatch(bad);
    }
  });

  test('cso/SKILL.md.tmpl uses pinned SHAs in diff mode', () => {
    const tmpl = readFileSync(join(ROOT, 'cso', 'SKILL.md.tmpl'), 'utf-8');

    expect(tmpl).toContain('{{PR_DIFF_PIN}}');

    // The --diff mode line is an inline backtick-quoted command in narrative
    // prose, not a fenced bash block — assert it directly on the raw template.
    expect(tmpl).toContain('"$BASE_SHA..$HEAD_SHA"');

    // And it must mention the named failure mode somewhere.
    expect(tmpl).toContain('shared-checkout-branch-flip-during-review');
  });

  test('the PR_DIFF_PIN resolver is registered (sanity)', () => {
    // If someone removes the resolver, gen-skill-docs would silently emit the
    // literal `{{PR_DIFF_PIN}}` placeholder into SKILL.md, breaking the skill.
    const indexTs = readFileSync(
      join(ROOT, 'scripts', 'resolvers', 'index.ts'),
      'utf-8',
    );
    expect(indexTs).toContain('PR_DIFF_PIN: generatePrDiffPin');
    expect(indexTs).toContain('generatePrDiffPin');

    // And the function exists in utility.ts.
    const utilityTs = readFileSync(
      join(ROOT, 'scripts', 'resolvers', 'utility.ts'),
      'utf-8',
    );
    expect(utilityTs).toContain('export function generatePrDiffPin');
  });

  test('generated SKILL.md files contain the Step 0.5 block', () => {
    // Catches the case where someone edits .tmpl but forgets to run
    // `bun run gen:skill-docs` before committing. The CI freshness check
    // (gen-skill-docs --dry-run) catches this too, but this test makes the
    // dependency explicit for the regression-test reader.
    for (const skill of ['review', 'cso']) {
      const mdPath = join(ROOT, skill, 'SKILL.md');
      if (!existsSync(mdPath)) continue;
      const md = readFileSync(mdPath, 'utf-8');
      expect(md).toContain(
        'Pin diff context to immutable SHAs',
      );
      expect(md).toContain('shared-checkout-branch-flip-during-review');
    }
  });
});
