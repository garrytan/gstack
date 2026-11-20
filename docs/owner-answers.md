# The owner's answers: check before you ask

An agent that asks its owner something the owner already answered wastes the owner's
time. On a host where every session starts on a fresh machine (Capy cloud machines), the
agent has no memory of the earlier answer. `gstack-owner-answers` keeps the owner's
answers and standing yeses in one record, kept where every session the owner runs can read it.
A Captain screens each ask against that record before sending it.

gstack ships the command and this file format. It never ships anyone's answers: the
record lives outside every repository, and the tests use made-up owners.

## How much it helps (measured before launch)

The first measurement was a sample of four days of one owner's Captain threads: 444
asks reached the owner.

- 6 were already covered by an earlier answer.
- 14 were covered but had to go to the owner anyway (spend, access, publishing and the like).
- The rest were new questions.

Only about 3 of the 6 were standing yeses this tool could ever take, so about 1% of
asks were repeats it could skip. That is small. The pilot below measures it again
after launch, and the pilot's result decides whether the tool is kept or cut.

## Where the record lives

| Host | Record |
|---|---|
| Capy (`GSTACK_CAPY=1`) | `~/.capy/drive/user-<owner>/owner-answers/`, the owner's private user-level Drive folder. It is mounted in every thread the owner owns, in every project, subagents included. |
| Anywhere else | `$GSTACK_OWNER_ANSWERS_DIR`, else `<state root>/owner-answers/` |

On Capy the record is bound to the one mounted `user-*` folder, or to the one
`--owner <name>` names. No folder (`OWNER_ANSWERS_NO_DRIVE`) or several
(`OWNER_ANSWERS_AMBIGUOUS`) stops the command. It never falls back to the machine's
thrown-away state root, and `GSTACK_OWNER_ANSWERS_DIR` is ignored there.
The record's own folders (`owner-answers/`, `rows/`, `verifications/`, `log/`) must
resolve inside that folder (elsewhere, inside the record): a link that leads out of it
is refused (`OWNER_ANSWERS_INVALID`), and the record is not read through it.
`gstack-owner-answers status` prints the path. It is the only command that does, so
ordinary output never names the owner's folder.

## File format (schema_version 1)

```text
owner-answers/
  rows/<id>.json                       one answer, created once with O_EXCL, never edited
  verifications/<row id>--<key>.json   a second actor's confirmation of a row's words
  log/<thread>.jsonl                   one thread's taken and asked decisions (that thread is its only writer)
```

A row:

| Field | Meaning |
|---|---|
| `id` | `oa-` plus 16 hex characters: a hash of owner, kind, action, target, scope, source thread, source event and supersedes. The same answer recorded twice is one file. |
| `owner` | The folder's owner. Rows for another owner make the record uncertain. |
| `kind` | `standing-yes` (may be taken), or `decision`, `preference`, `ruling-ref` (context only), or `revoke` |
| `action`, `target` | One lower-case token each, such as `merge-when-green` / `pull-request`. A take needs exact equality with the ask's tags. |
| `scope` | `all`, `repo:<owner>/<name>` or `captain:<name>`. A row's scope covers an ask with the same scope; `all` covers every scope. Record a Captain's grant with its `captain:` scope, never a wider one. |
| `limits` | Free text. A row with limits is context only, because the tool cannot check them. |
| `words` | The owner's exact words, secret-scanned, at most 2,000 characters |
| `words_by` | `owner` when these are the owner's own words at the source, else `agent:<id>` (the default) |
| `source` | `{ "thread": <code>, "event": <id> }`: where the owner said it |
| `rule` | Optional rule id (`R6`) when the answer is a ruling kept in a rules file. The rules file stays the ruling's home, and the record only points at it. |
| `asked` | The question it answered, when there was one |
| `supersedes` | The row this one replaces (`supersede`) or cancels (`revoke`) |
| `recorded_by`, `recorded_at` | Who wrote the row, and when |

A verification is `{ schema_version, row, verified_by, verified_at, words_sha256 }`.
The verifier reads the cited source event itself, and names it with `--event`, which
must equal the row's source event. It then confirms that the owner wrote those words
there, granting that action, target and scope.
The recorder can't verify its own row (`OWNER_ANSWERS_SELF_VERIFY`). A
verification only counts while the row's words still hash to `words_sha256`.

### When a row can be taken

Every one of these must hold:

1. The record reads cleanly (state `present`).
2. The row is a `standing-yes` with `words_by: owner` and no limits.
3. No row supersedes or revokes it.
4. Someone other than its recorder has verified its words.

Everything else is shown as context, and the ask still goes to the owner.

### Fail closed

`readStore` marks the whole record `uncertain` in any of these cases, and then
nothing can be taken:

- a row file is malformed, misnamed or not a regular file;
- a row's id doesn't match its fields;
- a row belongs to another owner;
- a row supersedes an id that is missing;
- two rows supersede the same id.

A second `add` for the same source, action, target and scope with different words,
author or limits is refused (`OWNER_ANSWERS_CONFLICT`). It is never silently kept.
So is a `supersede` or `revoke` of a row that another row already replaces: supersede
the current row instead. Two such rows can still appear when two machines write at once
before their Drives sync, and then the record reads `uncertain` until one row file is removed.

A write that fails after its file is created removes the file
(`OWNER_ANSWERS_WRITE_FAILED`), so it leaves no row and the same command can be rerun.
A crash in the middle of a write can still leave an empty file; the record then reads
`uncertain` and keeps every ask until that file is removed.

`status` lists each problem.

## Commands

```bash
gstack-owner-answers add --action merge-when-green --target pull-request --scope all \
  --words "yes merge when green" --words-by owner --thread CAPT-1 --event evt_123 --by "Example Captain"
gstack-owner-answers verify oa-0123456789abcdef --event evt_123 --by "second reader"
gstack-owner-answers screen --ask-file ask.json
gstack-owner-answers log --thread CAPT-1 --line A --decision taken --row oa-0123456789abcdef --by "Example Captain"
gstack-owner-answers revoke oa-0123456789abcdef --words "ask me again about merges" --words-by owner --thread CAPT-1 --event evt_456 --by "Example Captain"
```

`check --ask-file` lists the related rows for each ask line, ranked by shared words.
The ranking is advisory: a high score never makes a row takeable.

### The ask file

The ask file is JSON, one entry per lettered line:

```json
{ "asks": [
  { "line": "A", "origin": "captain", "text": "Merge #12 now that it is green?",
    "action": "merge-when-green", "target": "pull-request", "scope": "repo:example/widgets" },
  { "line": "B", "origin": "captain", "text": "Spend $400 on the eval rerun?", "classes": ["spend-over-cap"] }
] }
```

A plain-text file with one ask per line also works. Its lines are untyped, so
`screen` keeps all of them, and only `check` is useful on it.

`screen` keeps a line (`KEEP <reason>`) when any of these holds:

- `origin` isn't `captain`. An autoplan gate item is answered at its gate and is never screened out, because dropping it would change what "do it" approves.
- `compound` is true, or the ask carries `limits` (an amount, a count, a deadline).
- It carries a fresh-ask class, or its words trip the fresh-ask keyword net.
- Its action, target or scope is missing.
- No takeable row matches it exactly.
- A matching row that can't be taken is newer than the takeable one, or narrower in scope (a
  `repo:` or `captain:` row beside an `all` row). A later "no" or a scoped exception wins over an
  older blanket yes.

Otherwise it prints `PROPOSE_TAKE <line> <row id>` and the line the Captain adds to
its message, for example `Not asked, you already said: "yes merge when green" (2026-10-16, CAPT-1, R6).`

`screen` never edits the ask. The Captain confirms each proposal, sends the rest, and
logs both outcomes.

### Fresh-ask classes

Fresh-ask classes are never taken from the record. They are the "Always a fresh ask" list in
[capy/skill/gstack/captain.md](../capy/skill/gstack/captain.md), with these tags:

| Tag | Covers |
|---|---|
| `product-decision` | Product and behaviour decisions |
| `spend-over-cap` | Spend over a stated cap |
| `access` | Access and credentials |
| `publish` | Anything published outside the repository |
| `threshold-change` | Thresholds, budgets, trial counts and test kinds |
| `close-contribution` | Closing someone's contribution without landing it |
| `destructive` | Anything destructive or irreversible |

An unknown tag keeps the line too.

## The pilot

The first version runs as a pilot on one Captain's own asks for two weeks:

1. Before each ask to the owner, the Captain writes the ask file and runs `screen`.
2. The Captain reads every `PROPOSE_TAKE` itself before leaving that line out. A wrong proposal stops the pilot and gets corrected; it is never averaged away.
3. The Captain logs every line as `taken` or `asked`.

The pilot's numbers are counted against a baseline taken before launch:

- asks the owner received that an earlier answer of theirs already covered;
- wrong takes, from an audit of taken rows.

Only after a keep decision does gstack's shared factory guidance tell every Captain to screen.

**Known limit.** A Drive that hasn't finished syncing a newer supersede or revoke
looks exactly like a record without one. The tool can't detect that lag, which is
one reason the pilot Captain reads every proposal before leaving an ask out.

## Export to a knowledge base (format only)

Each current row maps to one page:

- title: `<action> <target> (<scope>)`;
- body: the words, quoted, with the source thread and date;
- tags: `owner-answer` and the kind.

Nothing in gstack writes such an export yet.
