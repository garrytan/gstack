/**
 * /land-and-deploy merge gate journeys (#2995): v1.90.2.0 gated only on
 * `gh pr checks --required`, so repos without required checks merged over red
 * or pending CI. These tests run the template's own merge blocks with the real
 * bin/gstack-ci-gate against a fake `gh` that records every `gh pr merge`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getQuestion } from '../scripts/question-registry';
import { expectMentions } from './helpers/prompt-structure';

const ROOT = join(import.meta.dir, '..');
const GATE_BIN = join(ROOT, 'bin', 'gstack-ci-gate');
const source = (name: string) => readFileSync(join(ROOT, 'land-and-deploy', name), 'utf8');
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const FAKE_GH = `#!/usr/bin/env bash
D="$FAKE_GH_DIR"
if [ "$1" = api ]; then kind=api
elif [ "$1 $2" = "pr merge" ]; then printf '%s\\n' "$*" >> "$D/merges.log"; exit 0
elif [ "$1 $2" = "pr view" ]; then kind=head
elif [ "$1 $2" = "pr checks" ]; then case " $* " in *" --required "*) kind=required ;; *) kind=all ;; esac
else echo "fake gh: unexpected $*" >&2; exit 97
fi
n=$(( $(cat "$D/count.$kind" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/count.$kind"
f="$D/$kind.$n"; [ -e "$f.code" ] || f="$D/$kind"
[ -e "$f.out" ] && cat "$f.out"
[ -e "$f.err" ] && cat "$f.err" >&2
exit "$(cat "$f.code" 2>/dev/null || echo 1)"
`;

type Reply = { out?: string; err?: string; code?: number };
const checks = (...rows: Array<[string, string]>): Reply => ({ out: JSON.stringify(rows.map(([name, bucket]) => ({ name, bucket, state: 'X', link: `https://ci.example/${name}` }))), code: 0 });
const NONE: Reply = { err: "no checks reported on the 'feature' branch", code: 1 };
const NONE_REQUIRED: Reply = { err: "no required checks reported on the 'feature' branch", code: 1 };
const head = (sha: string): Reply => ({ out: `${sha}\n`, code: 0 });

/** The two fenced blocks in Step 4 that run `gh pr merge`, keyed by mode. */
function mergeBlocks(): Record<'auto' | 'direct', string> {
  const blocks = [...source('sections/merge-and-deploy.md.tmpl').matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map(match => match[1])
    .filter(block => /\bgh pr merge /.test(block));
  expect(blocks).toHaveLength(2);
  const auto = blocks.find(block => block.includes('--auto'));
  const direct = blocks.find(block => !block.includes('--auto'));
  expect(auto && direct).toBeTruthy();
  return { auto: auto!, direct: direct! };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-gate-journey-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), FAKE_GH);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Journey {
  heads?: Reply[]; required: Reply | Reply[]; all: Reply | Reply[]; api?: Reply;
  mode: 'auto' | 'direct'; noCiApprovedHead?: string; override?: string;
}
function runJourney(j: Journey) {
  const replies: Record<string, Reply | Reply[] | undefined> = { head: j.heads ?? [head(HEAD)], required: j.required, all: j.all, api: j.api ?? { err: 'HTTP 404', code: 1 } };
  for (const [kind, reply] of Object.entries(replies)) {
    const list = Array.isArray(reply) ? reply : [reply!];
    list.forEach((r, i) => {
      const stem = join(dir, i === list.length - 1 ? kind : `${kind}.${i + 1}`);
      writeFileSync(`${stem}.out`, r.out ?? '');
      writeFileSync(`${stem}.err`, r.err ?? '');
      writeFileSync(`${stem}.code`, String(r.code ?? 0));
    });
  }
  const block = mergeBlocks()[j.mode].replaceAll('~/.claude/skills/gstack/bin/gstack-ci-gate', GATE_BIN);
  const script = `${j.override ? `CI_OVERRIDE=(${j.override})\n` : ''}${block}`;
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 30_000,
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, FAKE_GH_DIR: dir,
      REPO: 'owner/project', PR_NUMBER: '42', PR_HEAD: HEAD, MERGE_FLAG: '--squash',
      NO_CI_APPROVED_HEAD: j.noCiApprovedHead ?? '',
    },
  });
  const log = join(dir, 'merges.log');
  const merges = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  for (const name of readdirSync(dir).filter(name => name.startsWith('count.'))) rmSync(join(dir, name));
  rmSync(log, { force: true });
  return { ...result, merges };
}

describe('merge blocks never merge without a PASS for the pinned head', () => {
  const blocked: Array<[string, Omit<Journey, 'mode'>]> = [
    ['pending check, no required checks configured', { required: NONE_REQUIRED, all: checks(['build', 'pass'], ['test', 'pending']) }],
    ['failing check, no required checks configured', { required: NONE_REQUIRED, all: checks(['build', 'fail']) }],
    ['failing required check', { required: checks(['ci', 'fail']), all: checks(['ci', 'fail']) }],
    ['cancelled check', { required: NONE_REQUIRED, all: checks(['build', 'cancel']) }],
    ['unknown bucket', { required: NONE_REQUIRED, all: checks(['build', 'stale']) }],
    ['no checks and no explicit no-CI approval', { required: NONE, all: NONE }],
    ['no-CI approval recorded for another head', { required: NONE, all: NONE, noCiApprovedHead: OTHER }],
    ['malformed checks JSON', { required: NONE_REQUIRED, all: { out: '{"oops"', code: 0 } }],
    ['check without a bucket field (old gh)', { required: NONE_REQUIRED, all: { out: '[{"name":"build","state":"SUCCESS"}]', code: 0 } }],
    ['gh auth failure', { required: { err: 'HTTP 401: Bad credentials', code: 1 }, all: { err: 'HTTP 401: Bad credentials', code: 1 } }],
    ['checks registered after the no-CI approval', { required: NONE_REQUIRED, all: checks(['build', 'pending']), noCiApprovedHead: HEAD }],
    ['head moved mid-gate', { heads: [head(HEAD), head(OTHER)], required: NONE_REQUIRED, all: checks(['build', 'pass']) }],
    ['head already moved', { heads: [head(OTHER)], required: NONE_REQUIRED, all: checks(['build', 'pass']) }],
    ['required green, non-required pending', { required: checks(['ci', 'pass']), all: checks(['ci', 'pass'], ['preview', 'pending']) }],
    ['required green, non-required red', { required: checks(['ci', 'pass']), all: checks(['ci', 'pass'], ['lint', 'fail']) }],
    ['override approved for another head', { required: checks(['ci', 'pass']), all: checks(['ci', 'pass'], ['lint', 'fail']), override: `--override-head ${OTHER} --exclude lint` }],
    ['override naming a required check', { required: checks(['ci', 'fail']), all: checks(['ci', 'fail']), override: `--override-head ${HEAD} --exclude ci` }],
  ];
  for (const mode of ['auto', 'direct'] as const) {
    for (const [name, journey] of blocked) {
      test(`${mode}: ${name} → zero merges`, () => {
        const result = runJourney({ ...journey, mode });
        expect(result.merges).toEqual([]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toMatch(/^VERDICT (FAIL|PENDING|NO_CHECKS|ERROR) /);
      });
    }
  }
});

describe('positive controls: the same blocks do merge when the gate passes', () => {
  for (const mode of ['auto', 'direct'] as const) {
    test(`${mode}: all green → exactly one merge pinned to the head`, () => {
      const result = runJourney({ mode, required: checks(['ci', 'pass']), all: checks(['ci', 'pass'], ['docs', 'skipping']) });
      expect(result.status).toBe(0);
      expect(result.merges).toHaveLength(1);
      expect(result.merges[0]).toContain(`--match-head-commit ${HEAD}`);
      expect(result.merges[0].includes('--auto')).toBe(mode === 'auto');
    });

    test(`${mode}: explicit per-head override of named non-required checks → one merge`, () => {
      const result = runJourney({
        mode, required: checks(['ci', 'pass']), all: checks(['ci', 'pass'], ['lint check', 'fail']),
        override: `--override-head "$PR_HEAD" --exclude "lint check"`,
      });
      expect(result.stdout).toContain('\texcluded');
      expect(result.merges).toHaveLength(1);
    });

    test(`${mode}: no CI on the head, explicitly confirmed for this head → one merge`, () => {
      const result = runJourney({ mode, required: NONE, all: NONE, noCiApprovedHead: HEAD });
      expect(result.stdout).toStartWith(`VERDICT NO_CHECKS ${HEAD}`);
      expect(result.merges).toHaveLength(1);
    });
  }
});

describe('template wiring', () => {
  const main = source('SKILL.md.tmpl');
  const step = (title: string, next: string) => main.slice(main.indexOf(title), main.indexOf(next));

  test('Step 2 and the Step 3 CI wait call the helper, not a --required-only query', () => {
    const step2 = step('## Step 2: Pre-merge checks', '## Step 3: Wait for CI');
    const step3 = step('## Step 3: Wait for CI', '## Step 3.4');
    expect(step2).toContain('bin/gstack-ci-gate --repo "$REPO" --pr "$PR_NUMBER" --expect-head "$PR_HEAD"');
    expect(step3).toMatch(/bin\/gstack-ci-gate [^\n]*--expect-head "\$PR_HEAD" --wait \d+/);
    expect(`${step2}${step3}`).not.toMatch(/gh pr checks[^\n]*--required/);
    expect(step3).not.toContain('--watch');
    expect(step3).toContain('still-pending checks');
    expect(step2).toContain('never on the exit code');
  });

  test('both merge commands, including the direct fallback, run only after the gate', () => {
    for (const block of Object.values(mergeBlocks())) {
      const gate = block.indexOf('bin/gstack-ci-gate');
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(gate).toBeLessThan(block.indexOf('gh pr merge'));
      expect(block).toContain('"VERDICT PASS $PR_HEAD"|"VERDICT NO_CHECKS $NO_CI_APPROVED_HEAD") ;;');
      expect(block).toContain('*) exit 1 ;;');
    }
    expectMentions(source('sections/merge-and-deploy.md.tmpl'), [['only', 'check-to-merge', 'protection']], 'section');
  });

  test('readiness report carries a CI row and one-way override questions', () => {
    const readiness = source('sections/readiness-gate.md.tmpl');
    expect(readiness).toContain('CI (head <sha7>)');
    expect(readiness).toContain('land-and-deploy-ci-override');
    expect(readiness).toContain('land-and-deploy-no-ci-confirm');
    expect(readiness).toContain('never stored or reused');
  });

  test('generated skill files carry the helper calls', () => {
    expect(source('SKILL.md')).toContain('bin/gstack-ci-gate --repo "$REPO" --pr "$PR_NUMBER" --expect-head "$PR_HEAD"');
    expect(source('sections/merge-and-deploy.md').match(/bin\/gstack-ci-gate /g)).toHaveLength(2);
    expect(source('sections/readiness-gate.md')).toContain('CI (head <sha7>)');
  });
});

describe('CI override questions are one-way doors', () => {
  const ids = ['land-and-deploy-ci-override', 'land-and-deploy-no-ci-confirm'];
  const PREF = join(ROOT, 'bin', 'gstack-question-preference');
  const pref = (...args: string[]) => spawnSync(PREF, args, { encoding: 'utf8', cwd: ROOT, timeout: 30_000, env: { ...process.env, GSTACK_HOME: dir } });

  test('registered as one-way', () => {
    for (const id of ids) expect(getQuestion(id)).toMatchObject({ skill: 'land-and-deploy', door_type: 'one-way' });
  });

  test('a never-ask preference cannot be written or auto-decide the merge over red', () => {
    for (const id of ids) {
      const write = pref('--write', JSON.stringify({ question_id: id, preference: 'never-ask', source: 'plan-tune' }));
      expect(write.status).toBe(1);
      expect(write.stderr).toContain('(door_type: one-way)');
      pref('--read');
      const project = readdirSync(join(dir, 'projects'))[0];
      const file = join(dir, 'projects', project, 'question-preferences.json');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), [id]: 'never-ask' }));
      const check = pref('--check', id);
      expect(check.stdout).toContain('ASK_NORMALLY');
      expect(check.stdout).not.toContain('AUTO_DECIDE');
    }
  });
});
