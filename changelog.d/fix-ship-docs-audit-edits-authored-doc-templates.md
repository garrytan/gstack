---
important: regression
---
**/ship's documentation check updates your repo's own docs again, including docs written as templates.** A recent change limited the check to `README.md`, `docs/` and `bench/README.md`, gstack's own layout, so in a project whose docs live elsewhere (for example `handbook/*.md.tmpl`) the check stopped and asked for a decision instead of fixing the stale page. It now edits the docs it discovers in your project again and still leaves skill files (`SKILL.md` and `SKILL.md.tmpl`) to review.
