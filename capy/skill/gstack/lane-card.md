# Lane start card

For a crew lane (a thread working for a Captain). Read this once `gstack: ok <revision> for=<skill>` is in hand from this machine's install check, instead of the rest of [SKILL.md](SKILL.md). It keeps what a lane needs between the check and /ship. Before you run /ship, read SKILL.md § "Unattended runs for a parent agent" and § "Plan, approve, ship". For anything else (an upgrade that fails, driving /autoplan, loading another workflow, maintenance), read the matching SKILL.md section.

## After the check

- Report the trailer verbatim in your first report, `floor=` and `behind=` notes included. The trailer's `fix:` command runs once before the next workflow whenever it carries `behind=1` or more, `floor=` or `stale=`, and a thread older than a day reruns the check before its next workflow (§ "Session start: check, then install only when needed", step 2, which names what holds the checkout); a `floor=` note that says `no release meets this floor yet` runs nothing and goes to your Captain.
- Read `capy/skill/gstack/factory.md` in the checkout once per session.
- Start every shell that runs a gstack command with `. <GSTACK_LAUNCH_FILE>`. Never re-type the assignments as `export $(...)`, and never run `env`, `printenv`, a bare `set` or a bare `export`: they print API keys into the transcript. Hand a child agent the file path, never the values. Write a launch or env file with your file-write tool or a quoted heredoc (`<<'EOF'`), because an unquoted heredoc expands `$(...)` as it writes; check a variable by its exact name, never by a prefix, which can match a secret's name.
- Every subagent runs its own `--check` and puts its trailer in its first report; a read-only reviewer uses `--for review-voice`. One machine's install never covers another.
- A workflow that prints `INSTALL: fail …` and exits 3 refuses this install: run its fix and start again. A planning-only install does not admit `review`, `ship` or `qa`; run `--for <that skill>` first.
- Run directories and scratch live under `~/.capy/work/<name>`, never `/tmp`, which Capy wipes when a machine sleeps.
- A write into a drive mount can succeed locally while the drive never keeps it: before you delete a source because the copy is in the drive, find that copy in the drive's version history (`tools.drive.history`).

## Plan, approve, ship

- New functionality gets a lean `/autoplan` (`--kind feature`) right after the check. Bug fixes skip plan review (`--kind fix`) but carry a repro on current main or a failing test written first. Exempt: read-only work, the daily flaky pass's repairs, slot stamps, CHANGELOG-only resolves, cap re-pins under a written grant, S1 emergencies and fixes from an already-diagnosed, audited problem list.
- Send the gate to the Captain as `gstack-owner-brief render --captain --out <run dir>`, whole. Build only after the owner's word is answered into the run and it reports `APPROVED`, then `gstack-approvals import --autoplan <run dir> --by "<owner>"`.
- /ship runs at the final pushed head before any READY; `SHIP_RECEIPT: pr=<n> head=<head>` names that head, and a later push needs a new /ship.
- Run /ship in this thread (`ship/DRIVER.md`), with its reviewers as your subagents, never in a subagent of its own. After the receipt, read the PR's checks and comments once and run `gstack-ship-queue ready`.
- Never merge. The controller merges on a recorded standing approval.
- A first version (an app, a Mac helper, a new route on the owner's box): the plan quotes the owner's messages under `### Owner's words` with a line each, and the build clears `gstack-first-use` (`docs/first-use-check.md`) before any ask to try it or "v1 is ready" report.
- UI work (recommended, never a READY prerequisite): once the change renders, run `install.sh --check --for design-review` and `gstack-browser-ensure`, launch with the printed `GSTACK_LAUNCH` line, then `/design-review --build <preview url>`, and paste its one `DESIGN_BUILD:` line in READY. A start that prints `GSTACK_RESULT: skill=design-review status=refused` is `DESIGN_BUILD: unrendered code=INSTALL` (`gstack-design-build admit <saved start output>` prints it). `incomplete` does not count as having run it.

## Under a Captain

- Asks go to the Captain as a needs-you report, never to the person. Cite a standing approval instead of asking again.
- A fresh ask is always needed for a product or behaviour decision, spend over a stated cap, anything published outside the repository, a change to a threshold, budget or trial count, closing someone's contribution without landing it, and anything destructive.
- Record every answer with `gstack-approvals add` or `gstack-approvals import`; `gstack-approvals render` prints the table for your report and the PR body. Full guide: [captain.md](captain.md).

## Keep context cheap

- Batch independent reads in one parallel program. Return 4k characters or less per call; write long output to a file under `~/.capy/work` and read the part you need.
- Never write a file back from a read that came back cut off: a file-read tool can return only the start of a long file, or cut long lines, without saying so. Edit in place (the exact-string edit tool, `sed` or a script) and compare `wc -l` and the last lines before and after; an unplanned shrink is a blocker.
- A wait you expect to last under about 30 minutes checks in every 240 s: `wait` on the operation with `duration_seconds: 240`, then re-issue it silently on a wake that brings nothing new. After about 30 minutes, or past the expected end, stop re-issuing and sleep on the operation or pull request watch. A longer wait sleeps on its operations. While /ship runs, follow the waits in `ship/DRIVER.md`.
- Past twice the crew's median lane spend, write `handoffs/<code>/next.md` and tell the Captain in one line; it decides whether you continue, rotate or park.
- Keep your PR until it merges or closes; never hand off mid-PR on a token count. Past 500M own tokens, check in with the Captain once, then carry on unless told otherwise. Capy's token counts read about half what they did before 2026-11-15, so every token line here is half its old figure.
- Start a subagent only for parallel work whose context can be thrown away, a fresh-eyes review or a model from another family, never to run a step of your own procedure. Its brief names the compact result it returns (a verdict line, a file path, a short list), and nothing else comes back. /ship runs in your thread; only its reviewers are subagents. Stop and look at any subagent past 50M tokens.

## Before a push

In a repository with a `sealed` key in `.gstack/pregate.json`, run `~/.local/share/gstack/bin/gstack-pregate sealed` before every push and every pull request (§ "Before any push or pull request").

## Capy adaptations

An instruction to invoke `Skill` means read that SKILL.md. Messages and questions go through Capy's tools; plain assistant text reaches nobody. Hooks are advisory here; report a missing capability instead of claiming an equivalent. Selecting a model in Capy installs no Codex or Claude Code CLI; a subagent on another model family is a full outside voice. Installing gstack authorizes no merge, deploy or destructive step (§ "Adapt host-specific instructions to Capy").
