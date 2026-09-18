<!-- AUTO-GENERATED from detector-install-offer.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
<!-- Derived in part from nothing third-party: gstack's own consent flow for downloading impeccable's engine (Apache-2.0, see NOTICE.md). -->
# Design detector: the one-time install offer

Read this only when the Setup probe printed `DESIGN_DETECTOR_INSTALL_OFFER`. It is the same question `/design-review` asks; whichever design skill runs first asks it, and the answer is remembered.

**Install offer (one question, asked once).** If the probe printed `DESIGN_DETECTOR_INSTALL_OFFER: version=<v> platform=<p> bytes=<n> dest=<path>`, the user has never answered this. Ask now, before any other step, in an interactive session only: with `SESSION_KIND: spawned` or a headless run, never install and never ask; continue as if the answer were "not now". In Conductor, render the brief as prose and STOP. Use this skill's AskUserQuestion format:

```
D<N> — Install impeccable's design detector engine?
Project/branch/task: <one line from the current work>
ELI10: impeccable is a separate Apache-2.0 tool (Paul Bakaus). Its engine is one <n>-byte program that checks pages and CSS for 61 mechanical design mistakes. gstack can download that one file (version <v>, from github.com/pbakaus/impeccable releases) into <dest>, check it against a checksum recorded in gstack, and log the download in ~/.gstack/security/egress.jsonl. No impeccable skill, no editor hook; the engine never touches the network when gstack runs it. Without it this skill works as it does today.
Stakes if we pick wrong: yes puts a third-party binary on this machine; no leaves machine-catchable design mistakes to judgment alone.
Recommendation: A because the download is pinned, logged, and reversible (delete <dest>).
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) Install the engine now (recommended)
  ✅ Every design review opens with 61 deterministic checks, tagged by rule id
  ✅ One checksum-verified file under your home directory, logged, removable with rm
  ❌ A third-party binary you did not build runs over your project files in scans
B) Not now
  ✅ Nothing changes on this machine; the question returns next time a design skill runs
  ❌ Design reviews keep relying on judgment alone for mistakes a machine can catch
C) Never ask again
  ✅ Design skills stay silent about impeccable (reversible: gstack-config set design_detector_install_prompted false)
  ❌ An engine you install later is still used, but gstack never reminds you
D) Turn the detector off
  ✅ No probe, scan, or handoff line in any design skill (gstack-config set design_detector off)
  ❌ An engine installed later is ignored until design_detector is back to auto
Net: a pinned, logged 16 MB download for machine-checked findings, versus every design check staying a judgment call.
```

On **A**, run the install and read its first line (`IMPECCABLE_INSTALLED: <path>` then the fresh probe lines, or `IMPECCABLE_INSTALL_REFUSED: <reason>`, after which this skill continues without scans):

```bash
bun --no-env-file run $HOME/.claude/skills/gstack/bin/gstack-design-detect.ts install --host claude
```

On **B**, continue without scans. On **C**, run `~/.claude/skills/gstack/bin/gstack-config set design_detector_install_prompted true`. On **D**, run `~/.claude/skills/gstack/bin/gstack-config set design_detector off`. Never pass `--sha256` or `--base` yourself: they exist for maintainers and mirrors. If the user also wants the `/impeccable` skill and its hook, they run `npx impeccable install` themselves; gstack never does.
