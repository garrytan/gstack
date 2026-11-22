---
bump: patch
---
**A `disabled_skills: verify` entry now turns off `/build-check`, and gstack no longer claims prompts that say "verify" (#4593).** gstack renamed `/verify` to `/build-check` so Claude Code's built-in `/verify` works again. If your config still says `disabled_skills: verify`, gstack now reads it as `build-check`, so the skill stays off after you upgrade. `/build-check`'s description and the prompt router no longer list "verify my change", which leaves prompts about verifying to Claude Code's own skill. When setup or an upgrade moves an edited skill file aside, each run now gets its own backup folder, so two runs in the same second can't overwrite each other's backups.
