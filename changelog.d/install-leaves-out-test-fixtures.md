---
important: blocker
---
**A gstack install no longer puts gstack's test and eval data in your home directory.** `./setup` now leaves `test/fixtures/` out of a user install with a git sparse checkout, and the next update removes it from an existing install (a fixture you edited stays). Those files held eval task material, such as real issues from other repositories and held-out prompts, which every agent session and eval run on the machine could read. Nothing an installed skill runs reads them. Contributor clones (`git config gstack.contributor true`, which `bin/dev-setup` writes), CI and clones with the dev toolchain keep the full tree.
