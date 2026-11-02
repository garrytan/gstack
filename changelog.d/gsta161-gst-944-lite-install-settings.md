**The Opus 5.5 `lite` skills now keep the install's gbrain blocks, disabled skills and the Claims Need Evidence rule (GST-944).** The lite tree Capy publishes was rendered without the install's settings. On a machine with gbrain detected, Opus 5.5 sessions lost the brain context-load and save-results blocks that the full install serves, and skills turned off with `disabled_skills` showed up again in the lite router. `./setup --loadout lite` was not affected.

### Fixed
- **`gstack-modules install`** renders lite with the state root's gbrain detection and `gstack-config` `disabled_skills`, and both are part of the folder's identity. A change in either publishes a new folder instead of reusing a stale one.

### Changed
- **`preamble:evidence` is pinned**, so `lite` drops ten coaching pieces instead of eleven. The honest-work design (W4) never retires the Claims Need Evidence rule while gstack reports evidence. It adds 804 bytes back to lite's shared preamble (16,175 → 16,979 bytes; full is 22,396).

### Tests
- `test/module-loadouts-install.test.ts`: with gbrain detected and `disabled_skills: qa`, the lite office-hours file carries the brain blocks, the router lists `/qa` as disabled, and the folder differs from the one published without those settings.
- `test/module-loadouts.test.ts`: `preamble:evidence` is pinned and lite excludes the other ten pieces.
