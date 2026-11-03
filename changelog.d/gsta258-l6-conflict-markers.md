- Pushes from /ship now stop on leftover merge conflict markers. A new `conflict-markers` guard reads every line the branch adds and refuses one that starts with `<<<<<<<` or `>>>>>>>`, or is exactly `=======`, even inside a template literal that still parses and passes its tests (GST-1190, seen on #3927). Markdown code blocks that show a conflict are skipped, and a fixture that shows markers on purpose declares `gstack-conflict-markers: fixture`.

### Tests
- `test/conflict-markers.test.ts`: a marker inside a template literal is refused (it failed before the guard existed); a Markdown code block that shows a marker passes while the same lines outside a fence are refused; unchanged lines, declared fixtures and uncommitted files are handled.
