**Every ask to the owner now uses one lettered format (R41): the Captain's name, then one line per decision with the problem, the options and the recommendation, so the owner can answer "do it" or a letter like "B2" from a phone.**

### Changed
- **The plan ask lists each gate choice as a lettered line** (`lib/captain-brief.ts`, `gstack-owner-brief render --captain`): "What we need from you" prints one line per choice with the recommended option first and the plan approval as the last letter. The header and the closing line invite **do it** or a named option, and a new `--captain-name <name>` heads the list. The relaying agent's last line maps every letter to its gate token next to `rec resolves to …` and says a named option answers as `rec except <token>`, so a reply like "B2" translates exactly. A plan that is missing a section still invites no reply.
- **docs/captain.md has a new section, The ask format**, and the plan ask, the controller's relay and the digest's Needs you point to it. The captain templates (`plan-ask.md`, `DIGEST.md`, `merge-ask.md`, `AGENTS.md`, `report.md`), `captain/SKILL.md`, the Capy gstack skill (`SKILL.md`, `captain.md`, `factory.md`) and `docs/recommended-harness.md` state the same format.

### Tests
- `test/captain-brief.test.ts`: lettered lines with the recommendation first and "A1 to take recommendation", the letter-to-token map, the `--captain-name` heading, carried answers in the lettered lines, and no reply invitation on a plan that is missing a section.
