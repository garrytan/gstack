# Commit-clock upgrades (`UPGRADE_COMMITS`)

Read this only when `gstack-update-check` emitted
`UPGRADE_COMMITS <version> <local_sha7> <remote_sha7>`. It replaces the
`{old}` / `{new}` wording in Steps 1 and 6 of `SKILL.md`. Every other step
applies unchanged.

Deliberately a separate file: this verdict fires only in the window where a
merge reached `main` without a VERSION bump, so its instructions must not be
loaded on every skill invocation (`test/context-budget-ratchet.test.ts`
enforces the eager ceiling that would otherwise pay for it).

## Why the version does not change

`UPGRADE_AVAILABLE <old> <new>` means a newer release exists. `UPGRADE_COMMITS`
means the opposite half of #2378: the VERSION strings agree, and `main` has
moved past this install anyway. So:

- `{version}` is the same before and after the upgrade. There is no `{new}`.
- `CHANGELOG.md` is keyed by released version headings, so it has **no
  entries** between the two points. Do not read it for this verdict.
- Never render this as "v{version} is available (you're on v{version})". It
  reads as a bug, and the rational answer to a broken prompt is "Never ask
  again" — which disables update checks permanently.

## Step 1 replacement — the prompt

Auto-upgrade log line: `Auto-upgrading gstack v{version} to main {remote_sha7}...`

AskUserQuestion:

- Question: "gstack main has moved past your install (**{local_sha7} →
  {remote_sha7}**), with no version bump since v{version}. Upgrade now?"
- Options: unchanged — ["Yes, upgrade now", "Always keep me up to date",
  "Not now", "Never ask again"]

Snooze ("Not now"): use `{version}` as `_REMOTE_VER`. The snooze is keyed on
the version string for both verdicts, which is what `gstack-update-check`
compares it against.

## Step 6 replacement — Show What's New

Summarize the commit range instead of the changelog:

```bash
git -C "$INSTALL_DIR" log --oneline --no-merges {local_sha7}..HEAD | head -40
```

Up to 7 bullets grouped by theme. Say plainly when the range is small ("3
commits since your install"). If it comes back empty, say the install was
already current — do not invent entries.

Format:

```
gstack v{version} — now on main {remote_sha7} (was {local_sha7})

What landed:
- [bullet 1]
- ...

Happy shipping!
```
