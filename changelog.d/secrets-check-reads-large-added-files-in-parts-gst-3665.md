---
important: blocker
---
### Fixed

- **The pre-merge secrets check now scans an added file over 16 MiB instead of failing it unread.** gstack-redact refuses any input over 16 MiB, so a branch that added a large data file, such as a 60 MB `trials.jsonl` of eval results, failed the check as HIGH with nothing to fix. The check now scans such a file in parts cut at line ends, each repeating at least 64K characters of the text before it (more when a credential environment value is longer), and reports every finding at its line in the file. A single line too long to scan whole, or too long to share a part with that much context, still fails and names the line, and a scanner run that prints no report is an incomplete scan, never a pass. (#4796)
