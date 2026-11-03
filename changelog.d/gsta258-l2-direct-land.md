---
bump: minor
---
### Added

- **Merge each PR at its own green head (`merge: direct`).** `gstack-ship-queue land --pr <n> --pin <sha>` merges one READY PR with `--squash --match-head-commit`, with no train, no stamp commit and no extra CI round. It refuses unless the /ship receipt and the READY note are bound to the pin, every check there is green with none pending, GitHub reports the PR mergeable and clean, and the PR leaves VERSION, the `package.json` version and the CHANGELOG to the release. After the merge it checks that main's tree is the pin merged onto its parent and writes a land note. A new ship-policy key, `merge: train | direct`, turns it on; gstack now sets `direct`, and `train build` refuses under it. Each refusal has its own code and fix in docs/troubleshooting.md, and docs/captain.md has the new runbook.
