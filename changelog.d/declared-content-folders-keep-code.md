---
important: blocker
---
- **A folder marked as published data can no longer hide source code or agent files from /ship's review.** In a folder listed under `review_content_patterns`, source code in any language and letter case (`.java`, `.c`, `.ps1`, `Makefile` and the like, binary or not) still gets reviewed, and so do agent instruction files, config, executables and any data file that kept code names by its full path. Before this, only nine source extensions were kept, a binary `AGENTS.md` was left out, and a file named by a kept script could leave review. No base policy sets the key yet, so nothing was exposed. Details: docs/ship-policy.md#review-content-patterns.
