# How to land a fix in someone else's repository

You found a bug in a project you don't own, and you (or your agent) have a fix. Whether it
lands depends on the maintainers' rules, their CI and their reviewers, not on yours. This
guide is the order we work in: before you design, before you open the pull request, and
after each review.

## Before you design

1. **Read their rules.** Start with the root `AGENTS.md` or `CLAUDE.md`, then
   `CONTRIBUTING.md` and the pull request template. Reviewers, people and bots alike, turn
   those rules into findings, so a rule you skipped becomes a review round.
2. **Search for the same fix first.** Look at their main branch, open pull requests,
   recently merged ones and issues for your symptom, and do it again right before any
   public step, because a busy main moves daily. If someone is already fixing it, help
   that fix with a test or a repro instead of opening a second one. A closed issue can
   still be broken in a new way: link it ("Related: #N") and describe the new error.
3. **Read the history of the code you're changing.** `git log -p <file>` shows what the
   owner chose on purpose. Reuse the mechanism the code already has before adding a new
   one.
4. **Keep it small.** A short fix in the place the owner already maintains beats a large
   rewrite that also fixes the bug. When a maintainer's smaller fix lands instead of
   yours, that's a good outcome: close yours and say thanks.

## Before you open the pull request

1. **Run every guard their CI runs, on your final commit.** List them from
   `.github/workflows/`, the `scripts` in `package.json`, a `Makefile` or whatever their
   CI calls: lint, format, typecheck, size or line-count ratchets, boundary checks, and the
   tests near your change. A guard you never ran is the easiest way to fail a first
   review. Your own local review tools don't replace these; they miss repo-specific rules.
2. **Prove the fix.** Add one or two tests that fail on their main and pass with your
   change, and say so in the description with the commands you ran.
3. **Follow their format.** Title style, description sections, "Allow edits by
   maintainers" turned on. Don't edit their changelog, @-mention people or add trailers
   unless their rules ask for it.

## After each review

1. **Sort the failing checks.** For each one, decide whether your change caused it or it
   already fails on their main, and prove "already fails" by running it on main. Never
   call a failure pre-existing without that run.
2. **Answer each review point in a new commit** on the same branch, so reviewers can see
   exactly what changed. Don't force-push unless their rules ask for a squash.
3. **Rerun the proof on the new head:** the fail-then-pass test and the CI guards from
   above. Evidence from the previous commit doesn't count.
4. **Update the description** so its evidence describes the current head. Reviewers read
   the description, not the whole thread.
5. **Reply once per round,** after the push: map each point to the commit that fixes it,
   or explain with a file and line why the point doesn't apply.

These steps come from landing fixes in one outside project so far. Treat them as a
starting checklist and expect them to change as they meet more repositories.
