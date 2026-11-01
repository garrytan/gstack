/**
 * gstack-review-dispatch pass takes its readers' DIFF_BASE from origin/<base> (GST-716, GSTA-226): with a local <base>
 * that lags origin/<base>, the plan scored the origin diff while every brief named the stale local merge base, so the
 * readers reviewed upstream commits the branch only inherited.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DISPATCH = path.join(import.meta.dir, '..', 'bin', 'gstack-review-dispatch');
const BIN = path.dirname(DISPATCH);
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-origin-')));
  dirs.push(root);
  const work = path.join(root, 'work');
  const env = { ...process.env, PATH: BIN + path.delimiter + process.env.PATH, GSTACK_STATE_ROOT: path.join(root, 'state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n');
  const sh = (cwd: string, c: string) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git work && git clone -q origin.git other 2>/dev/null || true');
  sh(work, "echo '{}' > package.json && mkdir src && echo 'export const a = 1;' > src/a.ts && git add -A && git commit -qm base && git push -q origin main");
  sh(root, 'rm -rf other && git clone -q origin.git other');
  sh(path.join(root, 'other'), 'mkdir -p up && for i in $(seq 1 12); do echo "export const u$i = $i;" > up/u$i.ts; done && git add -A && git commit -qm upstream && git push -q origin main');
  sh(work, 'git fetch -q origin && git checkout -qb feat origin/main && for i in $(seq 1 60); do echo "export const v$i = $i;" >> src/a.ts; done && git commit -qam feat');
  return { work, env, sh };
}

describe('pass reads DIFF_BASE from origin/<base> (GST-716)', () => {
  // Value: protects=a stale local <base> never widens what the readers review past what the plan scored;
  //   fails_when=pass sets the manifest diff_base from `git merge-base <base> HEAD` on the local ref while origin/<base> is ahead;
  //   why_new=GSTA-226 paid ~12,400 credits for readers reviewing 78 upstream files; seam=gstack-review-dispatch pass; no_claim=--diff-base overrides
  test('local main behind origin/main: the manifest and every brief name the origin merge base', () => {
    const { work, env, sh } = fixture();
    const originBase = sh(work, 'git merge-base origin/main HEAD');
    expect(originBase).not.toBe(sh(work, 'git merge-base main HEAD'));
    const out = path.join(work, '.state-run');
    const r = spawnSync(DISPATCH, ['pass', '--base', 'main', '--out', out, '--pass', 'origin-p1'], { cwd: work, env, encoding: 'utf8', timeout: 180_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'pass-manifest.json'), 'utf8')) as { diff_base: string };
    expect(m.diff_base).toBe(originBase);
    const briefs = fs.readdirSync(path.join(out, 'briefs')).filter(f => f.endsWith('.prompt.md')).map(f => fs.readFileSync(path.join(out, 'briefs', f), 'utf8'));
    expect(briefs.length).toBeGreaterThan(0);
    for (const b of briefs) expect(b).toContain(originBase);
  }, 240_000);
});
