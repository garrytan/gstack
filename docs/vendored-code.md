# Vendored upstream code

Some repos copy open-source files in on purpose, unchanged: an eval that runs a
project's own tests, a fixture built from a real library. Those files are
someone else's code, and reading ten megabytes of them in review checks very
little. What matters is whether they really are that project's files, at the
commit you say, from the project you think.

`review_vendored` lets a repo make that claim in a form gstack can check, and
`gstack-vendored-verify` checks it.

## What a check proves

A file passes when all of these hold:

1. Its upstream repository is listed in `review_vendored.upstreams` in the
   **base branch's** `.gstack/ship-policy.json`. A branch cannot add an
   upstream for itself; that takes its own PR on the base.
2. The pinned commit is on the upstream's default branch, one of its tags, or a
   branch the base policy names for that upstream. A commit that only a fork, a
   pull request (`refs/pull/*`) or a merge-queue branch holds fails, even
   though GitHub serves those through the original repository's URL. A branch
   glob never admits a merge-queue branch (`gh-readonly-queue/*`), not even
   `*`, and a named branch the upstream doesn't have is skipped instead of
   failing the other pins.
3. The file's git blob id and the upstream file's blob id are equal, and both
   are plain files (mode `100644`). A blob id is git's hash of the exact bytes,
   so equal ids mean byte-identical files.
4. The file keeps its path relative to the upstream root (a prefix map), so a
   file cannot be renamed on the way in, for example into a `conftest.py` that
   pytest runs automatically.

It does **not** prove that the upstream code is safe, that the pinned commit is
the right version, that the code is safe to run where you run it, or anything
about licences. Keep each upstream's licence notice in the repo. Review moves to
the pin: which repository, which commit, which files, and where they land.

| Attack or mistake | Result |
|---|---|
| Pin to an attacker's repository or a fork | `VENDORED_NOT_ALLOWLISTED` |
| Fork commit fetched through the original URL, a pull request head, a merge-queue branch | `VENDORED_UNREACHABLE` |
| Upstream force-pushed so the commit left every branch and tag | `VENDORED_UNREACHABLE` |
| Upstream deleted, renamed (redirects are not followed), made private; network down | `VENDORED_FETCH_FAILED` |
| A local edit to a vendored file | `VENDORED_MISMATCH` |
| A file renamed under its prefix | `VENDORED_ABSENT_UPSTREAM` |
| An executable or symlink | `VENDORED_MODE` |

Every failure fails closed: the file is simply not vendored.

## Set it up

1. On the base branch, declare the upstreams and the manifest:

   ```json
   {
     "review_vendored": {
       "upstreams": [
         "https://github.com/pallets/click",
         { "url": "https://github.com/example/lib", "branches": ["release/*"] }
       ],
       "manifests": ["tasks/VENDORED.json"]
     },
     "min_gstack_version": "<the release that introduced review_vendored>"
   }
   ```

   `gstack-ship-policy validate --policy-from base --base main` checks it.

2. Have your build write the manifest beside the files it copies (below).

3. Run `gstack-vendored-verify --base main` locally and add it to CI as a
   required check.

## The manifest

`gstack-vendored/v1` JSON, one pin per upstream commit and local folder:

```json
{
  "schema": "gstack-vendored/v1",
  "pins": [
    {
      "upstream": "https://github.com/pallets/click",
      "commit": "04ef3a6f473deb2499721a8d11f92a7d2c0912f2",
      "local_prefix": "tasks/rf-01/verifier/protected/",
      "upstream_prefix": "",
      "files": ["tests/test_basic.py", "tests/conftest.py"]
    }
  ]
}
```

- `commit` is the full 40-character id.
- `local_prefix` is a folder ending in `/`; `upstream_prefix` is `""` or a
  folder ending in `/`. Each file lands at `local_prefix + file` and comes from
  `upstream_prefix + file`.
- Paths are repo-relative, with no `..`, `.` or empty segment, no backslash,
  and no two entries that differ only in letter case.
- A file listed here and edited locally fails the check. Remove it from the
  manifest to have it reviewed as your own code instead. Putting the upstream
  bytes back later passes the check, but review still reads that change, as
  below.

## The command

```
gstack-vendored-verify --base <branch> [--all] [--offline] [--json]
```

By default it checks the entries a branch changes: files added, modified or
deleted since the merge base, and entries whose pin the manifest diff changes. `--all`
checks every entry. Output is one `VENDORED_PIN:` line per pin (with the branch
or tag that holds it), one line per failure with its reason code and fix, and a
summary:

```
VENDORED_PIN: https://github.com/Textualize/rich@12eeb42c96a7 reachable_from=heads/main files=71 verified=71
VENDORED_VERIFY: checked=1056 verified=1054 failed=2 pins=71 manifests=1 scope=all digest=<sha256>
```

Exit 0 means every checked entry verified (or the base declares no
`review_vendored`), 1 means a manifest claims something untrue, 2 is a usage
error and 3 means the base branch, its policy or the checkout could not be read
(or the base policy does not validate).

Fetches go straight to each upstream over https, anonymously: no credential
helper, extra header or URL rewrite from your git configuration, no prompt, no
redirect, and a timeout (`GSTACK_VENDORED_FETCH_TIMEOUT_MS`, default 180,000).
That way a check that passes on your machine passes in CI. Each upstream's
commit history (no file contents) and each pin's file listing are cached under
the gstack state root, so a rerun is quick and `--offline` answers from the
cache without the network. On harness-evals#504 (1,056 files from 11 Python
projects, 71 pinned commits), a cold run took 19 seconds and a 15 MB cache.

## In CI

```yaml
- name: Vendored files match their upstream pins
  env:
    GSTACK_TAG: v1.103.0.0  # any release at or above your policy's min_gstack_version
  run: |
    git fetch --no-tags origin main
    git clone --depth 1 --branch "$GSTACK_TAG" https://github.com/garrytan/gstack.git "$RUNNER_TEMP/gstack"
    bun --no-env-file --config=/dev/null "$RUNNER_TEMP/gstack/bin/gstack-vendored-verify" --base main
```

The check
runs from the head's workflow file, so it is a backstop for honest mistakes; a
workflow edit is itself reviewed like any other `.github/` change.

## What review leaves out

When the base policy also lists `review_exclude_paths`, a file one of those
patterns matches that verifies byte for byte counts as vendored content, so
`/ship`'s reviewers can leave it out. Nothing else about the keep rules
changes: a vendored file stays in review when it is agent prose (`AGENTS.md`,
`CLAUDE.md`), config, executable, a link, under `.github/` or `.gstack/`, on a
gate path, holds a credential value, or carries a gate tag. A file kept only
for a credential line is shown as an excerpt, as any data file would be. A
gate-tagged file is excerpted only off the gate floor, so a gate-tagged
upstream test file (anything under `tests/`, `test/` or `spec/`) stays in
review whole. When a re-pin deletes files, a deleted file that verifies at the
base's pin can be left out too; a file the branch drops from the manifest but
keeps stays in review. A file the branch modifies counts as vendored only when
the merge base's manifests already pinned it and its base copy verified too.
So a branch that replaces your own file with upstream bytes, or drops a local
patch from a vendored file, keeps that file in review as your code, and
readers see your lines leave. A file new on the branch needs only its own
check. A file that does not verify keeps the reason it had before. Keep the manifest outside every `review_exclude_paths` pattern: when a
pattern matches it, nothing counts as verified and the plan prints
`REVIEW_VENDORED: unavailable`.

`gstack-review-plan` fetches the upstreams into the cache first and prints one
summary line, one line per pin and up to 20 files that did not verify:

```text
REVIEW_VENDORED: verified=1054 unverified=2 pins=71 digest=<sha256>
REVIEW_VENDORED_PIN: https://github.com/pallets/click@<commit> reachable_from=tags/8.1.7 files=40 verified=40
REVIEW_VENDORED_KEPT: mode tasks/.../tests/test_rr.py (head 100755, upstream 100755)
```

Every later step (the review dispatch, the receipt write and carry) reads the
same cache without the network, and the verified list is part of the
selection digest the receipt binds. A machine with an empty cache verifies
nothing, so its selection differs and the receipt says so; run
`gstack-vendored-verify --base <base>` there first. It also caches the merge
base's pins for the files the branch changes or deletes (its `VENDORED_BASE:`
line, which never fails the run), since a modified or re-pinned file needs
them. A fetch that fails fails its own run but leaves the cache's earlier good
answers in place, so a later `gstack-vendored-verify --offline` still answers.
Review keeps those files until a fetch succeeds, so the plan and the receipt's
offline check select the same files. Reviewers still read
the manifest, every pin change and all of the repo's own code. When manifest
entries that don't count as vendored make a pattern keep too many files, the
refusal counts them and points at `gstack-vendored-verify`.

How much this saves depends on the gate tags. On harness-evals#504 (1,056
upstream test files), 877 files and 4.47 MB leave review, but 161 gate-tagged
upstream test files (5.83 MB, mostly skip markers) stay whole, so that PR
stays over the 2 MB reader limit; 5 gate-tagged `pyproject.toml` files are
shown as excerpts.
