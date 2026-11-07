# gstack for QM

Two gstack skills in QM's own skill format: `gstack-review` (review a branch before merge) and `gstack-plan` (review a feature plan before building it).

QM lists each skill by name and description and loads the body only when it's needed, so nothing goes into the org SOUL and nothing is installed. Each file stays under 15,000 characters so QM's `read` and `skill` tools return it whole, and every command a skill names is a POSIX utility, `git`, or a POSIX `sh` script shipped inside the skill. QM's sandbox images have no bun and no gstack checkout.

## Install as a QM deployment layer

Copy the skill folders into your QM deployment directory and sync it:

```sh
mkdir -p <deploy dir>/sandbox/skills
cp -R qm/sandbox/skills/gstack-* <deploy dir>/sandbox/skills/
qm up
```

The skills install into the org scope. Removing the folders and running `qm up` again archives them.

A git pack that points at this whole repository won't work: QM's pack fetcher stops at 32 MiB and 5,000 files, and it would pick up every other gstack `SKILL.md` too. To ship it as a git pack, put `qm/sandbox/skills/` in a small repository of its own.

## What each skill runs first

`qm/edition.json` lists each skill's first command and a regex that matches it in QM's executed commands. Evals use it to score whether the skill's first step ran.

## Change it

The skills are generated. Don't edit `qm/` by hand. The edition spec is `hosts/qm.ts` (the sections kept from each gstack skill, the QM header, the limits and the allowed commands), the review script is `hosts/qm/scripts/diff-base.sh`, and the rest comes from the gstack skill templates. Regenerate with:

```sh
bun run scripts/gen-qm-edition.ts
```

`test/qm-edition.test.ts` fails when `qm/` is stale, when a file or description is over its limit, or when a skill names a command QM's sandbox doesn't have. Generation fails as soon as a kept heading, dropped block or replaced phrase stops matching its source template, so an upstream edit gets an explicit decision.
