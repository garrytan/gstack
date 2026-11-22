# gstack for QM

One gstack skill in QM's own skill format: `gstack-plan` (review a feature plan before building it).

The edition no longer ships `gstack-review`. A benchmark of the edition in QM found that it flagged too many problems without making the reviewed work any better, so it was cut. gstack's own `/review` skill is unchanged.

QM lists each skill by name and description and loads the body only when it's needed, so nothing goes into the org SOUL and nothing is installed. Each file stays under 15,000 characters so QM's `read` and `skill` tools return it whole, and every command a skill names is a POSIX utility, `git`, or a POSIX `sh` script shipped inside the skill. QM's sandbox images have no bun and no gstack checkout.

## Install as a QM deployment layer

Copy the skill folder into your QM deployment directory and sync it:

```sh
mkdir -p <deploy dir>/sandbox/skills
cp -R qm/sandbox/skills/gstack-* <deploy dir>/sandbox/skills/
qm up
```

The skill installs into the org scope. Removing the folder and running `qm up` again archives it.

A git pack that points at this whole repository won't work: QM's pack fetcher stops at 32 MiB and 5,000 files, and it would pick up every other gstack `SKILL.md` too. To ship it as a git pack, put `qm/sandbox/skills/` in a small repository of its own.

## What each skill runs first

`qm/edition.json` lists each skill's first command and a regex that matches it in QM's executed commands. Evals use it to score whether the skill's first step ran.

## Change it

The skill is generated. Don't edit `qm/` by hand. The edition spec is `hosts/qm.ts` (the sections kept from each gstack skill, the QM header, the limits and the allowed commands), and the rest comes from the gstack skill templates. Regenerate with:

```sh
bun run scripts/gen-qm-edition.ts
```

`test/qm-edition.test.ts` fails when `qm/` is stale, when a file or description is over its limit, or when a skill names a command QM's sandbox doesn't have. Generation fails as soon as a kept heading, dropped block or replaced phrase stops matching its source template, so an upstream edit gets an explicit decision.
