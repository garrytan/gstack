---
important: blocker
---
**`gstack-upgrade` no longer refuses to run after you disable skills.** With `gstack-config set disabled_skills ...` (or `plan_mode_preamble off`), setup rewrites the router `SKILL.md` in the checkout, and the upgrade read that rewrite as your own edit and stopped with "tracked files changed: SKILL.md". The upgrade now accepts the router when its bytes are exactly what gstack renders for your current settings, puts back the committed file for the update, and renders it again afterwards, so your disabled skills stay off. Any other edit to `SKILL.md` or another tracked file still stops the upgrade as before. (#4704, GST-3542)
