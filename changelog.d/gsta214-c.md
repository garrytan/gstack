**`/retro global` now sees Kimi Code, OMP and Antigravity sessions (#2917, #1977).** `gstack-global-discover` scanned only Claude Code, Codex and Gemini. A week spent in other agent CLIs went uncounted, and nothing showed a zero to notice.

### Added
- **Kimi Code** (`~/.kimi-code/session_index.jsonl`, window by `state.json` updatedAt, repo by workDir) and **OMP** (`~/.omp/agent/sessions/*/*.jsonl`, window by file mtime, repo by the cwd in the session file; `~/.omp/logs` is never counted) are counted per repo.
- **Antigravity** (`~/.gemini/antigravity-cli/conversations/*.db`) is counted by the later of each database's and its `-wal` file's mtime. Its sessions count in `total_sessions` but belong to no repo, because the CLI stores the working directory inside an undocumented blob.

### Changed
- **One scanner registry** drives the JSON, the summary and the stderr line. Every registered tool appears in `tools`, zeros included, with a `label`. Antigravity's entry carries `unattributed: true`. Existing keys (`claude_code`, `codex`, `gemini`) keep their paths, and each repo's `sessions` lists every attributed tool.
- **/retro global** builds its session counts and Tool Usage Analysis from that list. A tool missing from an older saved retro counts as 0.

Thanks to @richardiitse (#2917) and @Akagilnc (#1977) for the reports and the store layouts.
