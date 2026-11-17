# Writing pull requests and the commits they land as

People outside a project read its pull requests, its commit log and its release
notes to decide whether the project is worth using. So everything gstack writes
there, and everything you write there with gstack, follows the same few rules.
`/ship` writes it this way for you, and the checks below catch what slips through.

## The title

The title says what changed for someone using the project, in everyday words:
"Stop gstack from hitting GitHub's rate limit while it waits on PRs". One group
of issue references may close it, such as `(GST-1713)` or `(#4122)`. No
`fix(module):` prefix, no tracker code in the front, no in-house words.

## The body

A reader sees at most **three lines** (and 600 characters) before anything
collapsed:

1. what changed for a user;
2. why it matters: the project goal it serves or the problem it fixes;
3. anything the reader has to do, or "Nothing to do".

Everything else goes under a `## ` heading. `gstack-post` turns each heading
into a collapsed section (a `<details>` fold) when it posts, so you never write
HTML by hand. Say each thing once. Link long logs and review output instead of
pasting them.

The last section is **Agent notes**, which `/ship` adds. It holds the lines
gstack's tools read: issue links, approvals, review counts and the `/ship`
record. Nothing comes after it except a bot's badge.

Here is how a body looks on GitHub before anyone clicks:

```
/ship's reviewers now end their reply with one count line, and gstack checks it against the findings it read.

Why: the findings reader misread free-form review prose, so a real problem could be lost.

Nothing to do: replies without the line are read exactly as before.

▸ What changed
▸ Tests
▸ Agent notes
```

To see a body folded without posting it, run
`gstack-post fold --body-file body.md`. Use its output whenever you post a body
some other way, such as a web editor or another tool.

## Words to keep out of the front

Some words mean something only inside the team that uses gstack. Keep them out
of the title, the commit subject and everything above the Agent notes section,
and say what the thing does instead:

| Instead of | Write |
|------------|-------|
| outside voice | second-model review |
| pregate | the checks that run before a PR opens |
| receipt, ledger | the record of what was checked |
| fix-check | the re-check of a fix |
| carry | reuse a result from an earlier commit |
| stamp, restamp | set the version |
| train, lane, soak | merge several PRs together; the job that runs one part of the work; the wait before a release goes out to everyone |

gstack ships that list as the default. A project adds its own words in
`.gstack/plain-titles.json` (`terms`), and gstack's own file adds its team names.
Code spans, code blocks, links and quotes are never checked, and the Agent
notes section may use any word.

<a id="the-commit-on-main"></a>
## The commit on main

Every gstack merge (`gstack-ship-queue land`, in each of its forms) lands a PR
as **one commit**:

- the subject is the PR title with GitHub's number, `<title> (#1234)`;
- the body is the PR body's opening lines (at most three, links reduced to their
  text), then every trailer the branch's commits carry (`Co-authored-by:`,
  `Removed-test:` and any other `Key: value` line), each once, plus a
  `Co-authored-by:` for every other commit author.

So `git log --oneline` reads as a list of changes, with no "Merge pull request"
lines and none of the branch's housekeeping commits. A release PR's commit body
is its release notes instead, one plain line per change with the PR that made it.
Commits from a stacked PR that already landed are left out.

`gstack-ship-queue land --dry-run` prints the `METHOD:`, `SUBJECT:` and `BODY:`
lines before anything merges, and `--body-file <file>` replaces the opening lines
when the PR body's opening does not suit a commit. Land checks the whole message
for secrets first: a key or token refuses the land, and anything that only looks
private drops the opening and keeps the trailers.

These settings keep a merge commit instead of a squash, with the same subject and
body ([ship-policy.md](ship-policy.md)):

- `history: merge-only`, for a repository whose branch rules allow only merge
  commits;
- `land.merge_commit_paths`, for PRs that change matching paths, such as an
  eval results PR whose run records point to commits on its own branch;
- a merge train whose `train.land.merge_method` is `merge`.

`history: no-rewrite` is the setting for a repository that wants squash
landings but never a rebased or force-pushed branch:
`gstack-ship-policy check-history --plan rebase` refuses there.

## Comments and release notes

GitHub comments and release notes follow the same rules: plain words, the short
version first, details linked. `gstack-post` warns about listed words in a
comment but never refuses one. A published release carries real notes, one
plain line per change, never just a link to the CHANGELOG.

## When a check refuses

In a repository with `.gstack/plain-titles.json`, `gstack-post` refuses a body
that breaks these rules (exit 4, `PLAIN_BODY:` lines, nothing posted), and so
does the **Plain title** CI check for PRs opened on or after the policy's
`body_since` date. Each line says what to change; see
[troubleshooting](troubleshooting.md#plain-body-refused). Without the file,
the same findings are warnings only.
