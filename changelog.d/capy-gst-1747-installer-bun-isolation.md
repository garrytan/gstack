---
important: security
---
- **The Capy installer reads project pins with an isolated Bun.** `bin/gstack-capy-install` runs `bin/gstack-runtime-pins.ts` from the caller's project directory to read its Bun and Node pins. Those three calls now pass `--no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}"` like every other Bun gstack starts, so a project's `bunfig.toml` and `.env` no longer load into the installer. `test/bun-entry-isolation.test.ts` now also checks Bun runners held in a variable (`"$RUNNER" x.ts`, and any variable whose name says Bun running `-e` or a script) in shipped shell files. (GST-1747)
