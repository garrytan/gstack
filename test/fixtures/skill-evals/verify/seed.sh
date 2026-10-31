#!/bin/sh
# Seeds a /verify eval work dir: a tiny Bun library ("tally") on main, pushed to a local bare remote at
# ./.remote.git, and the branch feat/stats checked out with the variant's change committed on it.
# Its checks are what the repo declares: package.json scripts build (bun build), lint (scripts/lint.ts)
# and test (bun test), plus a .gstack/pregate.json so gstack-checks selects tests the way /ship's
# pregate does. Bun only: no install and no network.
# Usage (from a task's setup, cwd = the run's work dir): sh "$SKILL_EVAL_FIXTURES/seed.sh" <variant>
# Variants: build-error focused-test lint-only needs-service no-checks green
# The seed commit is in .git/eval-seed; check.sh compares tests, scripts and configs against it.
set -eu
V=${1:-green}
case "$V" in
  build-error|focused-test|lint-only|needs-service|no-checks|green) ;;
  *) echo "seed.sh: unknown variant $V" >&2; exit 2 ;;
esac
W=$(pwd)

git init -q --bare -b main .remote.git
git init -q -b main
git config user.email dev@example.com
git config user.name "Dev Example"
git config commit.gpgsign false
printf '%s\n' .remote.git/ .gstack-home/ .tmp/ >> .git/info/exclude
git remote add origin "$W/.remote.git"

if [ "$V" = no-checks ]; then
  mkdir -p scripts
  printf '# notes\n\nShell helpers for the release notes.\n' > README.md
  printf '#!/bin/sh\necho "notes for $1"\n' > scripts/notes.sh
  git add -A && git commit -q -m base && git push -q origin main
  git checkout -q -b feat/stats
  printf '#!/bin/sh\necho "release notes for ${1:?version}"\n' > scripts/notes.sh
  git commit -q -am "notes: require a version"
  git rev-parse HEAD > .git/eval-seed
  exit 0
fi

mkdir -p src test scripts .gstack
cat > package.json <<'EOF'
{
  "name": "tally",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "bun build src/index.ts --target=bun --outdir .tmp/build",
    "lint": "bun scripts/lint.ts",
    "test": "bun test"
  }
}
EOF
cat > scripts/lint.ts <<'EOF'
import { readdirSync, readFileSync } from 'node:fs';
let bad = 0;
for (const f of readdirSync('src')) {
  readFileSync(`src/${f}`, 'utf8').split('\n').forEach((line, i) => {
    if (/\bconsole\.log\(/.test(line)) { console.error(`src/${f}:${i + 1}: no console.log in library code`); bad++; }
  });
}
process.exit(bad ? 1 : 0);
EOF
cat > .gstack/pregate.json <<'EOF'
{
  "runner": "bun test {files}",
  "dependencies": { "README.md": [], "scripts/**": [], "package.json": [] }
}
EOF
cat > src/math.ts <<'EOF'
export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: number[]): number {
  if (xs.length === 0) throw new Error('mean of an empty list');
  return sum(xs) / xs.length;
}
EOF
cat > src/index.ts <<'EOF'
export { sum, mean } from './math';
EOF
cat > test/math.test.ts <<'EOF'
import { expect, test } from 'bun:test';
import { mean, sum } from '../src/math';

test('sum', () => expect(sum([1, 2, 3])).toBe(6));
test('mean', () => expect(mean([2, 4, 6])).toBe(4));
test('mean of nothing throws', () => expect(() => mean([])).toThrow());
EOF
cat > test/index.test.ts <<'EOF'
import { expect, test } from 'bun:test';
import * as tally from '../src/index';

test('the package entry exports sum and mean', () => expect([typeof tally.sum, typeof tally.mean]).toEqual(['function', 'function']));
EOF
printf '# tally\n\nSmall number helpers.\n' > README.md
git add -A && git commit -q -m base && git push -q origin main
git checkout -q -b feat/stats

cat > src/stats.ts <<'EOF'
import { mean } from './math';

export function variance(xs: number[]): number {
  const m = mean(xs);
  return mean(xs.map(x => (x - m) ** 2));
}
EOF
cat > test/stats.test.ts <<'EOF'
import { expect, test } from 'bun:test';
import { variance } from '../src/stats';

test('variance', () => expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBe(4));
EOF
printf "export { sum, mean } from './math';\nexport { variance } from './stats';\n" > src/index.ts
case "$V" in
  build-error) sed -i.bak "s/import { mean } from/import { meen as mean } from/" src/stats.ts ;;
  focused-test) sed -i.bak 's|return sum(xs) / xs.length;|return sum(xs) / (xs.length - 1);|' src/math.ts ;;
  lint-only) sed -i.bak 's|  const m = mean(xs);|  const m = mean(xs);\n  console.log("variance", m);|' src/stats.ts ;;
  needs-service)
    cat > src/store.ts <<'EOF'
export async function saveStats(url: string | undefined, value: number): Promise<number> {
  if (!url) throw new Error('STATS_DB_URL is not set: start the stats database (docker compose up stats-db) and export STATS_DB_URL');
  const res = await fetch(`${url}/stats`, { method: 'POST', body: JSON.stringify({ value }) });
  return res.status;
}
EOF
    cat > test/store.test.ts <<'EOF'
import { expect, test } from 'bun:test';
import { saveStats } from '../src/store';

test('saves to the stats database', async () => expect(await saveStats(process.env.STATS_DB_URL, 4)).toBe(201));
EOF
    ;;
esac
rm -f src/*.bak
git add -A && git commit -q -m "stats: add variance"
git rev-parse HEAD > .git/eval-seed
