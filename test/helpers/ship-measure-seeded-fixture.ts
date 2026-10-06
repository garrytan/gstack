/**
 * Fixture project for the seeded-flake measure-loop case (A6, CEO-3, ENG-13).
 *
 * A tiny repo with no remote whose CLAUDE.md documents a free test command
 * (`./test.sh`, passes instantly), a single-case eval command
 * (`./evals.sh case <id>`) and a gate command (`./evals.sh gate`), all local
 * stubs that cost nothing. The rule case `queue-priorities` reads a task list
 * that storage returns in seed-dependent order and compares it to the sorted
 * expectation. Each `case` invocation claims the lowest free trial slot with
 * an atomic `mkdir` (slots reset per ship-measure round, keyed on the round
 * directory), and the slot is the seed: while src/priorities.js leaves the
 * list unsorted, slots whose number mod 10 is 2, 5 or 9 fail (3 of 10). The
 * failure prints `failure_cause` and `failure_detail` naming the line. The
 * deterministic fix sorts the list; an unrelated edit still measures 7 of 10.
 * The gate runs every case once at a seed that fails while unsorted, so the
 * first gate run is red. Every invocation appends one line to
 * SEEDED_FLAKE_LOG, which the case reads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SEEDED_CASE = 'queue-priorities';
export const STABLE_CASE = 'queue-empty';
/** The line of src/priorities.js that returns the list unsorted. */
export const SEEDED_LINE = 6;

const PRIORITIES = `const { loadTasks } = require('./tasks');

// Dashboard order: highest priority first.
function priorities(seed) {
  const tasks = loadTasks(seed);
  return tasks.map(task => task.priority);
}

// Label shown above the list.
const TITLE = 'Queue';

module.exports = { priorities, TITLE };
`;

const TASKS = `// Storage returns tasks in no guaranteed order; the seed models that order.
const STORED = [9, 7, 5, 3, 1].map(priority => ({ priority }));

function loadTasks(seed) {
  if ([2, 5, 9].includes(seed % 10)) return [...STORED.slice(2), ...STORED.slice(0, 2)];
  return [...STORED];
}

module.exports = { loadTasks };
`;

const CHECK = `// Eval case ${SEEDED_CASE}: the dashboard list is sorted, highest first.
const { priorities } = require('../src/priorities');
const seed = Number(process.argv[2] || 0);
const sortedDesc = list => [...list].sort((a, b) => b - a);
const got = priorities(seed);
const want = sortedDesc(got);
console.log('fixture_sorted: ' + (JSON.stringify(priorities(2)) === JSON.stringify(sortedDesc(priorities(2))) ? 1 : 0));
console.log('cost_usd: 0');
if (JSON.stringify(got) !== JSON.stringify(want)) {
  console.log('failure_cause: assertion');
  console.log('failure_detail: src/priorities.js:${SEEDED_LINE} returns loadTasks(seed) in storage order, which seed ' + seed + ' shuffles; expected ' + JSON.stringify(want) + ' received ' + JSON.stringify(got));
  process.exit(1);
}
console.log('PASS ${SEEDED_CASE} (seed ' + seed + ')');
`;

const EVALS = `#!/usr/bin/env bash
# Local eval stub. ./evals.sh case <id> runs one trial of one case;
# ./evals.sh gate runs every case once (the full gate).
set -u
here=$(cd "$(dirname "$0")" && pwd)
log="\${SEEDED_FLAKE_LOG:-$here/.evals/runs.log}"
mkdir -p "$here/.evals" "$(dirname "$log")"
run() { # case-id seed
  if [ "$1" = ${STABLE_CASE} ]; then echo "cost_usd: 0"; echo "PASS ${STABLE_CASE}"; echo "fixture_sorted: -"; return 0; fi
  node "$here/test/priorities.check.js" "$2"
}
sorted_of() { sed -n 's/^fixture_sorted: //p' <<<"$1" | head -1; }
case "\${1:-}" in
  case)
    id="\${2:-}"
    case "$id" in ${SEEDED_CASE}|${STABLE_CASE}) ;; *) echo "unknown case: $id (cases: ${SEEDED_CASE}, ${STABLE_CASE})" >&2; exit 2 ;; esac
    if [ -n "\${GSTACK_SHIP_MEASURE_DIR:-}" ]; then slots="$(dirname "$GSTACK_SHIP_MEASURE_DIR")/slots"; else slots="$here/.evals/slots"; fi
    mkdir -p "$slots"
    n=1; until mkdir "$slots/$n" 2>/dev/null; do n=$((n + 1)); done
    out=$(run "$id" "$n" 2>&1); rc=$?
    printf '%s\\n' "$out"
    echo "case id=$id slot=$n sorted=$(sorted_of "$out") result=$([ $rc = 0 ] && echo pass || echo fail) measure_dir=\${GSTACK_SHIP_MEASURE_DIR:--}" >>"$log"
    exit $rc ;;
  gate)
    rc=0; sorted=-
    for id in ${SEEDED_CASE} ${STABLE_CASE}; do
      out=$(run "$id" 5 2>&1); r=$?
      [ "$id" = ${SEEDED_CASE} ] && sorted=$(sorted_of "$out")
      echo "[$id] $([ $r = 0 ] && echo PASS || echo FAIL)"
      [ $r = 0 ] || { printf '%s\\n' "$out" | sed 's/^/  /'; rc=1; }
    done
    echo "gate: $([ $rc = 0 ] && echo green || echo red)"
    echo "gate sorted=$sorted result=$([ $rc = 0 ] && echo pass || echo fail)" >>"$log"
    exit $rc ;;
  *) echo "usage: ./evals.sh case <id> | ./evals.sh gate" >&2; exit 2 ;;
esac
`;

const CLAUDE_MD = `# queue-dash

Dashboard that lists queued tasks, highest priority first.

## Commands

- Tests (free, fast): \`./test.sh\`
- Evals (local stubs in this repo; each run prints cost_usd):
  - One case alone: \`./evals.sh case <id>\`
  - Full gate: \`./evals.sh gate\`

Eval cases: \`${SEEDED_CASE}\` (kind: rule), \`${STABLE_CASE}\` (kind: rule).
`;

export interface SeededFixture { repo: string; log: string }

export interface FixtureRun { kind: 'case' | 'gate'; id?: string; slot?: number; sorted: string; result: 'pass' | 'fail'; measureDir?: string }

/** Create the fixture repo at <root>/queue-dash, committed and clean. */
export function createSeededFixture(root: string, log = path.join(root, 'runs.log')): SeededFixture {
  const repo = path.join(root, 'queue-dash');
  for (const dir of ['src', 'test']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/priorities.js'), PRIORITIES.replace(/\n\/\/ Label shown above the list\.\nconst TITLE = 'Queue';\n/, '').replace('{ priorities, TITLE }', '{ priorities }'));
  fs.writeFileSync(path.join(repo, 'src/tasks.js'), TASKS);
  fs.writeFileSync(path.join(repo, 'test/priorities.check.js'), CHECK);
  fs.writeFileSync(path.join(repo, 'evals.sh'), EVALS, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'test.sh'), '#!/usr/bin/env bash\necho "unit: 3 passed"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), CLAUDE_MD);
  fs.writeFileSync(path.join(repo, 'VERSION'), '0.3.1\n');
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args], { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '.evals/\n.context/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'queue dashboard');
  git('checkout', '-q', '-b', 'feature/queue-title');
  fs.writeFileSync(path.join(repo, 'src/priorities.js'), PRIORITIES);
  git('commit', '-q', '-am', 'show a title above the queue');
  return { repo, log };
}

export function readFixtureRuns(log: string): FixtureRun[] {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => {
    const field = (name: string) => new RegExp(`(?:^| )${name}=(\\S+)`).exec(line)?.[1];
    const kind = line.startsWith('gate ') ? 'gate' : 'case';
    return {
      kind, sorted: field('sorted') ?? '-', result: field('result') === 'pass' ? 'pass' : 'fail',
      ...(kind === 'case' ? { id: field('id'), slot: Number(field('slot')), measureDir: field('measure_dir') } : {}),
    } as FixtureRun;
  });
}

/** The repaired source: the deterministic fix sorts the list. */
export const SORTED_FIX = PRIORITIES.replace('return tasks.map(task => task.priority);', 'return tasks.map(task => task.priority).sort((a, b) => b - a);');
/** A negative-control "fix" that edits an unrelated line. */
export const UNRELATED_EDIT = PRIORITIES.replace("const TITLE = 'Queue';", "const TITLE = 'Task queue';");
