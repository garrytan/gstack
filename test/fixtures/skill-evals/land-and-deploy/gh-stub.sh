#!/bin/sh
# gh stub for the /land-and-deploy skill evals (installed at /usr/local/bin/gh in every arm image).
# Logs each call's argv as one JSON array line to $GH_STUB_DIR/.gh-log and fakes one repository
# (example/app, default branch main) with one PR, #1, whose state lives in $GH_STUB_DIR/.gh-state:
# pr.json (the PR), checks.json (its checks, each with a required flag), deploy.json (optional: the
# conclusion of the deploy workflow run a merge triggers) and runs.json (workflow runs on main).
# pr merge really merges: it squashes the PR head onto main in $GH_STUB_DIR/.remote.git, marks the
# PR MERGED and records a deploy run for the merge commit when deploy.json exists.
D=${GH_STUB_DIR:-/work}
ST=$D/.gh-state
PR=$ST/pr.json
REMOTE=$D/.remote.git
jq -cn '$ARGS.positional' --args -- "$@" >> "$D/.gh-log" 2>/dev/null || printf '%s\n' "$*" >> "$D/.gh-log"

cmd="${1:-} ${2:-}"
[ $# -ge 2 ] && shift 2 || shift $#
case "$cmd" in api\ *) apipath=${cmd#api }; cmd=api ;; esac
fields= expr= target= required= auto= delbranch= matchhead= nameonly= logfailed=
while [ $# -gt 0 ]; do
  a=$1; shift
  case "$a" in
    --json=*) fields=${a#--json=} ;;
    --json) fields=${1:-}; shift ;;
    --jq=*) expr=${a#--jq=} ;;
    -q|--jq) expr=${1:-}; shift ;;
    --required) required=1 ;;
    --squash|--merge|--rebase) ;;
    --auto) auto=1 ;;
    --delete-branch|-d) delbranch=1 ;;
    --match-head-commit=*) matchhead=${a#--match-head-commit=} ;;
    --match-head-commit) matchhead=${1:-}; shift ;;
    --name-only) nameonly=1 ;;
    --log-failed) logfailed=1 ;;
    -f|-F|--field|--raw-field) shift ;;
    --repo=*|--branch=*|--limit=*|--state=*|--method=*|--workflow=*) ;;
    -R|--repo|-b|--branch|-L|--limit|-s|--state|-X|--method|-H|--head|-B|--base|-t|--title|-w|--workflow) shift ;;
    -*) ;;
    *) [ -z "$target" ] && target=$a ;;
  esac
done
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

out() {
  json=$1
  if [ -n "$fields" ]; then
    pick="{$fields}"
    json=$(printf '%s' "$json" | jq -c "if type == \"array\" then map($pick) else $pick end")
  fi
  if [ -n "$expr" ]; then printf '%s' "$json" | jq -r "$expr"; else printf '%s\n' "$json"; fi
}
prset() { jq "$@" "$PR" > "$PR.tmp" && mv "$PR.tmp" "$PR"; }
pr_matches() { # <target>: true when the target names PR #1, or names nothing and the branch is its head
  [ -f "$PR" ] || return 1
  case "$1" in
    1|\#1|https://github.com/example/app/pull/1) return 0 ;;
    "") jq -e --arg b "$branch" '.headRefName == $b' "$PR" >/dev/null ;;
    *) jq -e --arg b "$1" '.headRefName == $b' "$PR" >/dev/null ;;
  esac
}

case "$cmd" in
  "auth status")
    printf 'github.com\n  ✓ Logged in to github.com account eval-bot (keyring)\n  - Git operations protocol: ssh\n  - Token scopes: repo, read:org, workflow\n'
    ;;
  "repo view")
    out '{"name":"app","nameWithOwner":"example/app","owner":{"login":"example"},"url":"https://github.com/example/app","defaultBranchRef":{"name":"main"},"visibility":"PRIVATE","isPrivate":true,"description":"tally: small number helpers"}'
    ;;
  "pr view")
    if ! pr_matches "$target"; then
      printf 'no pull requests found for branch "%s"\n' "${target:-$branch}" >&2
      exit 1
    fi
    if [ -n "$fields" ] || [ -n "$expr" ]; then out "$(cat "$PR")"; else jq -r '"\(.title) #\(.number)\n\(.state)\n\n\(.body)\n\n\(.url)"' "$PR"; fi
    ;;
  "pr list")
    if [ -f "$PR" ] && jq -e '.state == "OPEN"' "$PR" >/dev/null; then out "[$(cat "$PR")]"; else out '[]'; fi
    ;;
  "pr diff")
    b=$(jq -r .baseRefOid "$PR"); h=$(jq -r .headRefOid "$PR")
    if [ -n "$nameonly" ]; then git --git-dir="$REMOTE" diff --name-only "$b" "$h"; else git --git-dir="$REMOTE" diff "$b" "$h"; fi
    ;;
  "pr checks")
    rows=$(jq -c --arg r "$required" 'if $r == "1" then map(select(.required)) else . end | map(del(.required))' "$ST/checks.json" 2>/dev/null || echo '[]')
    if [ "$rows" = "[]" ]; then
      if [ -n "$required" ]; then printf "no required checks reported on the '%s' branch\n" "$branch" >&2; else printf "no checks reported on the '%s' branch\n" "$branch" >&2; fi
      exit 1
    fi
    if [ -n "$fields" ] || [ -n "$expr" ]; then out "$rows"; else printf '%s' "$rows" | jq -r '.[] | "\(.name)\t\(.bucket)\t\(.link)"'; fi
    printf '%s' "$rows" | jq -e 'any(.bucket == "fail" or .bucket == "cancel")' >/dev/null && exit 1
    printf '%s' "$rows" | jq -e 'any(.bucket == "pending")' >/dev/null && exit 8
    ;;
  "pr merge")
    state=$(jq -r .state "$PR")
    head=$(jq -r .headRefOid "$PR")
    if [ "$state" != OPEN ]; then printf 'X Pull request example/app#1 is not open (%s)\n' "$state" >&2; exit 1; fi
    if [ -n "$matchhead" ] && [ "$matchhead" != "$head" ]; then printf 'X Head branch was modified. Review and try the merge again.\n' >&2; exit 1; fi
    if [ "$(jq -r .mergeable "$PR")" = CONFLICTING ]; then printf 'X Pull request example/app#1 is not mergeable: the merge commit cannot be cleanly created.\n' >&2; exit 1; fi
    base=$(git --git-dir="$REMOTE" rev-parse refs/heads/main)
    tree=$(git --git-dir="$REMOTE" rev-parse "$head^{tree}")
    title=$(jq -r .title "$PR")
    sha=$(GIT_AUTHOR_NAME="Dev Example" GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_NAME=GitHub GIT_COMMITTER_EMAIL=noreply@github.com \
      git --git-dir="$REMOTE" commit-tree "$tree" -p "$base" -m "$title (#1)")
    git --git-dir="$REMOTE" update-ref refs/heads/main "$sha" "$base"
    hb=$(jq -r .headRefName "$PR")
    [ -n "$delbranch" ] && git --git-dir="$REMOTE" update-ref -d "refs/heads/$hb" 2>/dev/null
    prset --arg s "$sha" '.state = "MERGED" | .mergedAt = "2026-10-30T12:00:00Z" | .mergeCommit = {oid: $s} | .mergeStateStatus = "UNKNOWN"'
    if [ -f "$ST/deploy.json" ]; then
      runs=$(cat "$ST/runs.json" 2>/dev/null || echo '[]')
      printf '%s' "$runs" | jq --arg s "$sha" --slurpfile d "$ST/deploy.json" \
        '[{databaseId: 9001, name: "Deploy", workflowName: "Deploy", headSha: $s, headBranch: "main", event: "push", status: "completed", conclusion: $d[0].conclusion, url: "https://github.com/example/app/actions/runs/9001"}] + .' > "$ST/runs.json.tmp" && mv "$ST/runs.json.tmp" "$ST/runs.json"
    fi
    printf '✓ Squashed and merged pull request example/app#1 (%s)\n' "$title"
    [ -n "$delbranch" ] && printf '✓ Deleted remote branch %s\n' "$hb"
    ;;
  "run list")
    out "$(cat "$ST/runs.json" 2>/dev/null || echo '[]')"
    ;;
  "run view")
    run=$(jq -c --arg id "$target" 'map(select((.databaseId|tostring) == $id)) | .[0] // empty' "$ST/runs.json" 2>/dev/null)
    if [ -z "$run" ]; then printf 'could not find any workflow run with ID %s\n' "$target" >&2; exit 1; fi
    if [ -n "$logfailed" ]; then
      jq -r '.log_failed // empty' "$ST/deploy.json" 2>/dev/null
    elif [ -n "$fields" ] || [ -n "$expr" ]; then out "$run"
    else printf '%s' "$run" | jq -r '"\(.conclusion // .status) \(.workflowName) · \(.databaseId)\nTriggered via push on main"'; fi
    ;;
  "pr edit"|"pr comment"|"pr ready")
    printf 'https://github.com/example/app/pull/1\n'
    ;;
  api)
    case "$apipath" in
      graphql)
        out "$(jq -c '{data: {repository: {pullRequest: {number, state, headRefOid, baseRefName, mergedAt: (.mergedAt // null), mergeCommit: (.mergeCommit // null), autoMergeRequest: null, mergeQueueEntry: null, mergeable, title, url}}}}' "$PR")" ;;
      repos/example/app)
        out '{"full_name":"example/app","default_branch":"main","allow_squash_merge":true,"allow_merge_commit":true,"allow_rebase_merge":true,"delete_branch_on_merge":false}' ;;
      repos/example/app/contents/.github/workflows*)
        ref=$(printf '%s' "$apipath" | sed -n 's/.*[?&]ref=\([^&]*\).*/\1/p')
        names=$(git --git-dir="$REMOTE" ls-tree --name-only "${ref:-main}:.github/workflows" 2>/dev/null)
        if [ -z "$names" ]; then printf '{"message":"Not Found","status":"404"}\n'; printf 'gh: Not Found (HTTP 404)\n' >&2; exit 1; fi
        out "$(printf '%s\n' "$names" | jq -R -s -c 'split("\n") | map(select(. != "")) | map({name: ., path: (".github/workflows/" + .), type: "file"})')" ;;
      *) out '[]' ;;
    esac
    ;;
esac
exit 0
