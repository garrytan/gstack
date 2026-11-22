**The docs link check and the prose check no longer read a line that starts with inline code as the start of a code block.** In docs/troubleshooting.md, a line opening with an inline code span hid every heading after it, so valid links to those sections were refused and the prose check skipped half the file. Fences now follow CommonMark. Reported by @Davmunrey (#4391, #4393).

**/learn prune checks every learning, not just the first 100.** `gstack-learnings-search` gains `--all`, and prune uses it, so old entries that pointed at deleted files were being skipped without notice on larger projects. Reported by @exGeni (#4215).

**/retro counts a test runner in `tests/` that has no test-style name, and stops counting game-engine sidecar files as tests.** On a Godot repo whose suite is `tests/run.gd`, the test file total read 0 while Godot's `.uid` sidecar counted as a changed test. Unity `.meta` and Godot `.import` files are skipped too. Contributed by @huongtran84 (#4306).

**The bootstrap retention tests skip the five cases that cannot happen when the free suite runs as root**, instead of failing them. Reported by @Davmunrey (#4425).
