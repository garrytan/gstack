# Eval model rules: `.gstack/eval-models.json`

A repository that has rules about which models its evals may use (for example
"Fable in smoke tests only", "no gpt-5.4-mini", "the newest model of each
family") writes them as data in `.gstack/eval-models.json`. `gstack-eval-plan`
checks every arm against them: `arms`, `dry-run`, `pilot start`, and every
call row of `price-gate`. gstack never reads these rules from prose in
`CLAUDE.md` or any other document. Plan: field list 2, W9
(`docs/designs/field-list-2-2026-10-16/PLAN.md`).

## The file

```json
{
  "schema_version": 1,
  "allow": ["claude-*", "gpt-*"],
  "deny": ["gpt-5.4-mini"],
  "scopes": { "full": { "deny": ["claude-fable-*"] } },
  "families": {
    "claude-opus": ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
    "claude-fable": ["claude-fable-5-1", "claude-fable-5"],
    "gpt-sol": ["gpt-6.1-sol", "gpt-6-sol"]
  }
}
```

| Key | Required | Meaning |
|---|---|---|
| `schema_version` | yes | `1` |
| `allow` | yes | Model ids or globs an arm may use. An id that no entry matches fails, so a misspelled or new model is never admitted by default. Use `["*"]` to allow everything not denied. |
| `deny` | no | Ids or globs no arm may use. Checked first. |
| `scopes` | no | Per eval scope (`smoke` or `full`), an extra `allow` and/or `deny` list. "Fable in smoke only" is `scopes.full.deny: ["claude-fable-*"]`. |
| `families` | no | Family name to literal ids, **newest first**. With this key present, an arm must be the newest id of its family (`EVAL_MODEL_OLD_GENERATION` otherwise), and an arm in no family fails `EVAL_MODEL_GENERATION_UNRESOLVED` instead of passing unchecked. |

Globs use `*` (any run of characters) and `?` (one character); every other
character is literal. A rule matches the id as written, the id without a
provider prefix (`openai/gpt-5.4-mini` matches `gpt-5.4-mini`), and a Claude id
without its date suffix (`claude-opus-5-5-20261001` matches `claude-opus-5-5`).
An unknown key, an unknown scope, a glob inside `families`, or an id listed in
two families makes the whole file invalid (`EVAL_MODELS_INVALID`), and then no
arm passes.

The rules apply whatever gstack's own model catalog (`lib/model-catalog.ts`)
holds: an uncatalogued model is allowed or denied by the file alone. The
catalog only checks that `families` is current. If a family lists the
catalog's current frontier or smart model after another id, the file is stale
and invalid.

## Order of checks

For each arm at its scope, the first rule that refuses decides:

1. `deny` → `EVAL_MODEL_DENIED`
2. `scopes.<scope>.deny` → `EVAL_MODEL_DENIED`
3. no `allow` entry matches → `EVAL_MODEL_DENIED` (unknown ids fail closed)
4. `scopes.<scope>.allow` is set and does not match → `EVAL_MODEL_DENIED`
5. `families` is set: in no family → `EVAL_MODEL_GENERATION_UNRESOLVED`; not the family's first id → `EVAL_MODEL_OLD_GENERATION`

## Scope

`price-gate` checks each call row at that row's `scope` (`GSTACK_EVAL_CALLS v1`,
`docs/eval-calls.md`). `arms`, `dry-run` and `pilot start` take
`--scope smoke|full`, which defaults to `full`. So a smoke-only model fails
unless the command says it is a smoke run.

## Which copy is read

By default the reviewed copy is read: `git show origin/<base>:.gstack/eval-models.json`
(`--base`, default origin/HEAD's branch unless that is the checked-out branch,
then the PR's base, `main` or `master`). A branch cannot loosen the rules it
is checked against. When the working-tree copy differs, an
`EVAL_MODELS_NOTE:` line says so. `--models-from head` lints with the working-tree copy
instead. Use it for the PR that adds or changes the file; the source label
says `head (unreviewed)`. When neither copy exists, nothing is checked and
the line says `EVAL_MODELS: none ...`. When the base cannot be resolved but a
working-tree copy exists, the command refuses (`EVAL_MODELS_INVALID`) rather
than skipping the rules.

## Output

```
EVAL_MODEL: claude-fable-5-1 scope=full denied (scopes.full.deny claude-fable-*) where=dry-run --arms
EVAL_MODEL: claude-opus-5-5 scope=full ok (allow claude-*; newest in families.claude-opus) where=dry-run --arms
EVAL_MODELS: fail refused=1/2 source=origin/main@0123456789ab:.gstack/eval-models.json
```

Each refusal also prints a result line on stderr ending in its code. `dry-run`
records the check as `checks.model_rules` in `dry-run.json` and fails
`DRY_RUN_RESULT`. `pilot start` reserves nothing. `price-gate` writes no
receipt.
