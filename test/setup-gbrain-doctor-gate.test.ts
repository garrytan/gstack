/**
 * /setup-gbrain Step 5 and gstack-gbrain-detect judge brain health from brain
 * checks only (#3790).
 *
 * gbrain doctor's skill checks (category "skill": resolver_health,
 * skill_conformance, ...) grade whatever skills dir gbrain auto-detects, which
 * can be another agent's workspace such as ~/.openclaw/workspace. A failure
 * there made a working brain read "unhealthy", Step 5 stopped, and the agent
 * proposed editing the other agent's workspace. Real brain failures
 * (connection, schema_version, pgvector) must still stop Step 5.
 *
 * A stub gbrain on PATH serves canned doctor JSON; no real gbrain runs.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const DETECT = path.join(ROOT, 'bin', 'gstack-gbrain-detect');
const SKILL_MD = path.join(ROOT, 'setup-gbrain', 'SKILL.md');

const check = (name: string, category: string, status = 'ok') => ({ name, category, status, message: '' });
const BRAIN_OK = [
  check('connection', 'ops'), check('pgvector', 'ops'), check('schema_version', 'meta'), check('embeddings', 'brain'),
];
const SKILL_FAIL = check('resolver_health', 'skill', 'fail');
const report = (checks: ReturnType<typeof check>[]) => ({
  schema_version: 2,
  status: checks.some((c) => c.status === 'fail') ? 'unhealthy' : checks.some((c) => c.status === 'warn') ? 'warnings' : 'healthy',
  checks,
});
const withFailure = (name: string) => BRAIN_OK.map((c) => (c.name === name ? { ...c, status: 'fail' } : c));

type Case = { full: object; scoped: object };
const CASES: Record<string, Case> = {
  // gbrain >= v0.41.20: --scope=brain drops the skill group.
  'skill-only failure': {
    full: report([...BRAIN_OK, SKILL_FAIL]),
    scoped: report([...BRAIN_OK, check('harness_wiring', 'ops', 'warn')]),
  },
  // Older gbrain ignores --scope=brain and still runs the skill group.
  'skill-only failure, gbrain without --scope': {
    full: report([...BRAIN_OK, SKILL_FAIL]),
    scoped: report([...BRAIN_OK, SKILL_FAIL]),
  },
  'all checks pass': { full: report(BRAIN_OK), scoped: report(BRAIN_OK) },
  'connection failure': { full: report([...withFailure('connection'), SKILL_FAIL]), scoped: report(withFailure('connection')) },
  'schema_version failure': { full: report([...withFailure('schema_version'), SKILL_FAIL]), scoped: report(withFailure('schema_version')) },
  'pgvector failure': { full: report([...withFailure('pgvector'), SKILL_FAIL]), scoped: report(withFailure('pgvector')) },
  'pgvector failure, gbrain without --scope': {
    full: report([...withFailure('pgvector'), SKILL_FAIL]),
    scoped: report([...withFailure('pgvector'), SKILL_FAIL]),
  },
};
const HEALTHY = ['skill-only failure', 'skill-only failure, gbrain without --scope', 'all checks pass'];

let tmp: string;
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-doctor-gate-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.symlinkSync(process.execPath, path.join(tmp, 'bin', 'bun'));
  // gbrain doctor exits 1 when any check fails and prints the report anyway.
  fs.writeFileSync(path.join(tmp, 'bin', 'gbrain'), `#!/bin/sh
case "$1" in
  --version) echo "gbrain 0.60.537.0"; exit 0 ;;
  doctor) ;;
  *) exit 2 ;;
esac
f="$FAKE_DOCTOR_DIR/full.json"
for a in "$@"; do [ "$a" = "--scope=brain" ] && f="$FAKE_DOCTOR_DIR/scoped.json"; done
cat "$f"
grep -q '"status":"unhealthy"' "$f" && exit 1
exit 0
`, { mode: 0o755 });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function caseEnv(name: string) {
  const dir = path.join(tmp, name.replace(/[^a-z0-9]+/gi, '-'));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'full.json'), JSON.stringify(CASES[name]!.full));
  fs.writeFileSync(path.join(dir, 'scoped.json'), JSON.stringify(CASES[name]!.scoped));
  return {
    ...process.env,
    PATH: `${path.join(tmp, 'bin')}:${SAFE_PATH}`,
    HOME: path.join(dir, 'home'),
    GSTACK_HOME: path.join(dir, 'state'),
    GSTACK_DETECT_NO_CACHE: '1',
    FAKE_DOCTOR_DIR: dir,
  };
}

function step5Fence(): string {
  const md = fs.readFileSync(SKILL_MD, 'utf-8');
  const start = md.indexOf('## Step 5: Verify gbrain doctor');
  const end = md.indexOf('\n## ', start + 1);
  expect(start).toBeGreaterThan(-1);
  const fence = md.slice(start, end).match(/\`\`\`bash\n([\s\S]*?)\`\`\`/);
  expect(fence).not.toBeNull();
  return fence![1]!.replaceAll('~/.claude/skills/gstack/bin/', `${ROOT}/bin/`);
}

describe('/setup-gbrain Step 5 doctor gate', () => {
  for (const name of Object.keys(CASES)) {
    const healthy = HEALTHY.includes(name);
    test(`${name}: Step 5 ${healthy ? 'proceeds' : 'stops'}`, () => {
      const r = spawnSync('bash', ['-c', `${step5Fence()}\necho "BRAIN_OK=\${BRAIN_OK:-unset} status=\${status:-unset}"`], {
        env: caseEnv(name), encoding: 'utf-8', timeout: 30_000,
      });
      const verdict = r.stdout.trim().split('\n').pop();
      expect(verdict).toStartWith(`BRAIN_OK=${healthy}`);
    });
  }
});

describe('gstack-gbrain-detect gbrain_doctor_ok', () => {
  for (const name of Object.keys(CASES)) {
    const healthy = HEALTHY.includes(name);
    test(`${name}: gbrain_doctor_ok is ${healthy}`, () => {
      const r = spawnSync(DETECT, [], { env: caseEnv(name), encoding: 'utf-8', timeout: 30_000 });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).gbrain_doctor_ok).toBe(healthy);
    });
  }
});
