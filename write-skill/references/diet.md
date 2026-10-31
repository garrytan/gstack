# Full diet

Rewrite a whole skill onto the levels, then prove agents do at least as well with it. Adapted from
nicobailon/skill-diet (MIT) at 5f41df1.

## 1. Report first (free)

Run `~/.claude/skills/gstack/bin/gstack-skill-bill <skill>` and, in a gstack checkout, `bun run scripts/skill-bin-drift.ts --skill <skill>`.
Show the user the size per level, every drift finding, and the moves you propose (what goes to `references/`, to the
tool's `--help` or errors, or out). Ask go or no-go before writing eval tasks.

## 2. Consumers

List what depends on the skill's text: skills that link it, code that embeds it, tests that assert it, prompts that
name it. In gstack also the paid E2E cases that touchfiles select for its folder.

## 3. Tool steps (skills that teach a tool)

- Prove each mismatch by running the tool or citing its source line: names it rejects, flags it ignores, operations the
  skill never mentions.
- The tool's help can replace skill text only when every operation has an entry, an unknown name or flag is an error
  that names the valid ones, and common failures say how to fix them. Fix the tool first when you own it.
- Keep a cheat sheet of the calls agents make most, one full call each, plus one example per call shape they get wrong.
  Name every other operation once.

## 4. Tasks before cuts

Write 8–15 one-line tasks while the old skill is the only version, and commit them before any cut, at
`test/fixtures/skill-evals/<skill>/tasks.json` (`{id, prompt, setup?, must?, must_not?, check?, safety?}`; `setup`
may call `$SKILL_EVAL_FIXTURES/<script>`). Cover each mode, each "don't" rule as a safety task, and each risky area.
Give each task a `check` that asserts the end state where it can.

## 5. Cut and write

Cut what the model already knows, what only a human needs (motivation, history: commit message or README), and every
word a sentence can lose without changing what the agent does. Name each rule with a short phrase; replace a list of
cases with the idea behind them and a list of don'ts with one positive test. End with one `case → where to look` line
per reference.

## 6. Verify

Lock the tasks before any paid run, and before step 5's first cut when you can: the lock preregisters the tasks and
the before copy's contract lines, and the shared eval refuses a paid run without it committed (LOCK_MISSING).

```
gstack-evals skill-eval --lock --tasks test/fixtures/skill-evals/<skill>/tasks.json
git add test/fixtures/skill-evals/<skill>/ && git commit -m "test: lock <skill> eval tasks"
```

Then run the before, after and no-skill versions through the shared skill eval
(docs/designs/SKILL_EVAL_CONTRACT.md), 3 trials each on the same model. Ship only when no task whose before panel
passed fails after, no safety task breaks, and after is not worse by more than chance. Until the shared eval is
available, run upstream skill-diet's `scripts/eval.mjs` at commit 5f41df1 (the version this text adapts) with the
same tasks and apply those rules to its per-task table;
when neither can run, write "eval: not run" and ship only the tool and drift fixes, not the cuts.

Commit with `Skill-Diet: <name>` and `Skill-Size: <before>→<after> bytes (<file>)` lines, and report tokens per run
before and after, the per-task table, and what moved where.
