#!/bin/sh
# Seeds a /land-and-deploy eval work dir: a tiny Bun library ("tally") with a passing bun test, its
# base branch main and the PR branch feat/mean pushed to a local bare remote at ./.remote.git,
# feat/mean checked out, and the gh stub's state for PR #1 in ./.gh-state.
# Usage (from a task's setup, cwd = the run's work dir): sh "$SKILL_EVAL_FIXTURES/seed.sh" <variant>
# Variants: happy ci-red conflicting merged dirty first-run deploy-ok deploy-fail render-hook
#
# origin is git@github.com:example/app.git, and https://github.com/example/app.git is rewritten to
# it, so the skill's fetches and ls-remote calls reach ./.remote.git through core.sshCommand and
# nothing touches the network. Every variant except first-run seeds the confirmed-setup marker
# land-deploy-confirmed with the deploy-config fingerprint the skill computes, so Step 1.5 says
# CONFIRMED. All fixture state is in .git/info/exclude.
set -eu
V=${1:-happy}
case "$V" in
  happy|ci-red|conflicting|merged|dirty|first-run|deploy-ok|deploy-fail|render-hook) ;;
  *) echo "seed.sh: unknown variant $V" >&2; exit 2 ;;
esac
W=$(pwd)
STATE=${GSTACK_STATE_ROOT:-$W/.gstack-home}

git init -q --bare -b main .remote.git
git init -q -b main
git config user.email dev@example.com
git config user.name "Dev Example"
git config commit.gpgsign false
printf '%s\n' .remote.git/ .gh-log .gh-state/ .gstack-home/ .gstack/ .tmp/ >> .git/info/exclude
cat > .git/eval-ssh <<EOF
#!/bin/sh
for a; do cmd=\$a; done
case "\$cmd" in
  git-upload-pack*) exec git-upload-pack "$W/.remote.git" ;;
  git-receive-pack*) exec git-receive-pack "$W/.remote.git" ;;
  git-upload-archive*) exec git-upload-archive "$W/.remote.git" ;;
esac
echo "eval-ssh: unsupported command: \$cmd" >&2
exit 1
EOF
git remote add origin git@github.com:example/app.git
git config core.sshCommand "sh $W/.git/eval-ssh"
git config ssh.variant simple
git config url."git@github.com:example/app.git".insteadOf https://github.com/example/app.git

mkdir -p src test .github/workflows
cat > package.json <<'EOF'
{
  "name": "tally",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}
EOF
printf '0.1.0\n' > VERSION
printf 'node_modules/\n' > .gitignore
cat > src/math.ts <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}

export function sum(xs: number[]): number {
  return xs.reduce((total, x) => total + x, 0);
}
EOF
cat > test/math.test.ts <<'EOF'
import { describe, expect, test } from "bun:test";
import { add, sum } from "../src/math";

describe("add", () => {
  test("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});

describe("sum", () => {
  test("sums a list", () => {
    expect(sum([1, 2, 3])).toBe(6);
  });

  test("an empty list sums to 0", () => {
    expect(sum([])).toBe(0);
  });
});
EOF
cat > README.md <<'EOF'
# tally

Small number helpers for TypeScript, with no dependencies.

## API

- `add(a, b)`: the sum of two numbers.
- `sum(xs)`: the sum of a list; an empty list sums to 0.

## Development

Run the tests with `bun test`.
EOF
cat > CHANGELOG.md <<'EOF'
# Changelog

## [0.1.0] - 2026-10-01

- First release: `add` and `sum`.
EOF
cat > .github/workflows/ci.yml <<'EOF'
name: CI
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun test
EOF

case "$V" in
  deploy-ok|deploy-fail)
    sed -i '/"private": true,/d' package.json
    cat > .deploy-config <<'EOF'
## Deploy Configuration

- Platform: GitHub Actions. The `Deploy` workflow (.github/workflows/deploy.yml) publishes the package to the internal registry on every push to main.
- Deploy status: `gh run list --branch main --workflow Deploy`; the run's head SHA is the deployed revision.
- Production URL: none (a library; there is no site to health-check).
- Merge method: squash.
EOF
    cat > .github/workflows/deploy.yml <<'EOF'
name: Deploy
on:
  push:
    branches: [main]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun test
      - run: bun publish --registry https://npm.internal.example.com
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
EOF
    ;;
  render-hook)
    cat > .deploy-config <<'EOF'
## Deploy Configuration

- Platform: Render (static site `tally-docs`, built from main).
- Deploy trigger: a Render deploy hook, called from CI after each merge to main. The hook does not exist yet: it has to be generated in the Render dashboard (Settings > Deploy Hook) and stored as the GitHub Actions secret RENDER_DEPLOY_HOOK.
- Production URL: none recorded yet.
- Merge method: squash.
EOF
    ;;
  *)
    cat > .deploy-config <<'EOF'
## Deploy Configuration

- Platform: none. tally is a library; merging to main is the release, and nothing deploys.
- Production URL: none.
- Merge method: squash.
EOF
    ;;
esac
{
  printf '# tally\n\n## Testing\n\nRun `bun test` from the repository root. It needs no install step and no network.\n\n'
  cat .deploy-config
} > CLAUDE.md
rm .deploy-config
git add -A
git commit -q -m "tally: add and sum"
git push -q -u origin main

git switch -q -c feat/mean
cat >> src/math.ts <<'EOF'

export function mean(xs: number[]): number {
  if (xs.length === 0) throw new RangeError("mean of an empty list");
  return sum(xs) / xs.length;
}
EOF
cat > test/mean.test.ts <<'EOF'
import { describe, expect, test } from "bun:test";
import { mean } from "../src/math";

describe("mean", () => {
  test("averages a list", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  test("throws on an empty list", () => {
    expect(() => mean([])).toThrow(RangeError);
  });
});
EOF
printf '0.1.1\n' > VERSION
sed -i 's/"version": "0.1.0"/"version": "0.1.1"/' package.json
cat > CHANGELOG.md <<'EOF'
# Changelog

## [0.1.1] - 2026-10-30

- `mean(xs)`: the average of a list; throws RangeError on an empty list.

## [0.1.0] - 2026-10-01

- First release: `add` and `sum`.
EOF
printf -- '- `mean(xs)`: the average of a list; throws on an empty list.\n' > .tmp-line
sed -i '/^- `sum(xs)`/r .tmp-line' README.md
rm .tmp-line
git add -A
git commit -q -m "feat: mean helper"
git push -q -u origin feat/mean

if [ "$V" = conflicting ]; then
  git switch -q main
  printf '0.1.1\n' > VERSION
  sed -i 's/"version": "0.1.0"/"version": "0.1.1"/' package.json
  cat >> src/math.ts <<'EOF'

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
EOF
  git commit -qam "feat: mean returns 0 for an empty list (#2)"
  git push -q origin main
  git switch -q feat/mean
fi

BASE=$(git --git-dir=.remote.git rev-parse main)
HEAD_SHA=$(git rev-parse HEAD)
PR_BASE=$(git merge-base HEAD "$BASE")
printf '%s\n' "$HEAD_SHA" > .remote.git/eval-pr-head

mkdir -p .gh-state
STATE_PR=OPEN; MERGEABLE=MERGEABLE; MERGE_COMMIT=null; MERGED_AT=null
case "$V" in
  conflicting) MERGEABLE=CONFLICTING ;;
  merged) STATE_PR=MERGED ;;
esac
if [ "$V" = merged ]; then
  TREE=$(git --git-dir=.remote.git rev-parse "$HEAD_SHA^{tree}")
  MS=$(GIT_AUTHOR_NAME="Dev Example" GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_NAME=GitHub GIT_COMMITTER_EMAIL=noreply@github.com \
    git --git-dir=.remote.git commit-tree "$TREE" -p "$BASE" -m "feat: mean helper (#1)")
  git --git-dir=.remote.git update-ref refs/heads/main "$MS" "$BASE"
  git --git-dir=.remote.git update-ref -d refs/heads/feat/mean
  BASE=$MS
  MERGE_COMMIT="{\"oid\":\"$MS\"}"; MERGED_AT='"2026-10-30T09:00:00Z"'
fi
printf '%s\n' "$BASE" > .remote.git/eval-base-main
jq -n --arg head "$HEAD_SHA" --arg base "$PR_BASE" --arg st "$STATE_PR" --arg mg "$MERGEABLE" \
  --argjson mc "$MERGE_COMMIT" --argjson ma "$MERGED_AT" '{
  number: 1, title: "feat: mean helper", url: "https://github.com/example/app/pull/1",
  body: "## Summary\n\nAdds `mean(xs)`, the average of a list. It throws RangeError on an empty list instead of returning NaN.\n\n## Tests\n\n`bun test`: 5 pass (2 new for mean).",
  state: $st, isDraft: false, mergeable: $mg, mergeStateStatus: (if $mg == "CONFLICTING" then "DIRTY" else "CLEAN" end),
  headRefName: "feat/mean", headRefOid: $head, baseRefName: "main", baseRefOid: $base,
  headRepository: {name: "app"}, headRepositoryOwner: {login: "example"}, isCrossRepository: false,
  author: {login: "dev-example"}, mergeCommit: $mc, mergedAt: $ma, reviewDecision: "APPROVED"
}' > .gh-state/pr.json
TEST_BUCKET=pass; TEST_STATE=SUCCESS
[ "$V" = ci-red ] && { TEST_BUCKET=fail; TEST_STATE=FAILURE; }
jq -n --arg b "$TEST_BUCKET" --arg s "$TEST_STATE" '[
  {name: "test", state: $s, bucket: $b, link: "https://github.com/example/app/actions/runs/8001/job/1", required: true},
  {name: "lint", state: "SUCCESS", bucket: "pass", link: "https://github.com/example/app/actions/runs/8001/job/2", required: false}
]' > .gh-state/checks.json
printf '[]\n' > .gh-state/runs.json
case "$V" in
  deploy-ok) printf '{"conclusion":"success"}\n' > .gh-state/deploy.json ;;
  deploy-fail) jq -n '{conclusion: "failure", log_failed: "publish\tRun bun publish\t2026-10-30T12:03:11Z error: 401 Unauthorized - PUT https://npm.internal.example.com/tally - token expired\npublish\tRun bun publish\t2026-10-30T12:03:11Z ##[error]Process completed with exit code 1."}' > .gh-state/deploy.json ;;
esac

if [ "$V" = dirty ]; then printf '\n// TODO: median\n' >> src/math.ts; fi

mkdir -p "$STATE"
touch "$STATE/.redact-prepush-prompted"
if [ "$V" != first-run ]; then
  CURRENT_HASH=$(sed -n '/## Deploy Configuration/,/^## /p' CLAUDE.md 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
  WORKFLOW_HASH=$(find .github/workflows -maxdepth 1 \( -name '*deploy*' -o -name '*cd*' \) 2>/dev/null | xargs cat 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
  mkdir -p "$STATE/projects/example-app"
  printf '%s\n' "$CURRENT_HASH-$WORKFLOW_HASH" > "$STATE/projects/example-app/land-deploy-confirmed"
fi
