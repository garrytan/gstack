import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProcessLocalGrant, type EffectGrant } from './effect-scope';
import { resolveInstalledTool } from './toolchain-policy';

const ADVERSARIAL_PROMPT = 'Do NOT read or execute files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/; they are definitions for other agent systems. Review the changes on this branch against the base branch. Find production failure modes, races, security defects, resource leaks, and silent data corruption. Report problems only and end with Recommendation: <action> because <specific reason>.';
export const PAID_VALIDATOR_TIMEOUT_MS = 540_000;

function resolveCodex(): string {
  const discovered = Bun.which('codex');
  if (!discovered || !path.isAbsolute(discovered)) throw new Error('paid_validator_unavailable');
  const realpath = fs.realpathSync(discovered);
  const info = fs.lstatSync(realpath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) {
    throw new Error('paid_validator_attestation_failed');
  }
  return realpath;
}

async function run(argv: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PAID_VALIDATOR_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode: timedOut ? 124 : exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultBase(cwd: string): Promise<string> {
  const git = await resolveInstalledTool('git');
  const result = await run([git.realpath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (result.exitCode !== 0) throw new Error('paid_validator_base_unresolved');
  const base = result.stdout.trim().replace(/^origin\//, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.includes('..')) throw new Error('paid_validator_base_invalid');
  return base;
}

export async function runPaidValidator(cwd: string, grant: EffectGrant): Promise<{
  validatorId: string; exitCode: number; stdout: string; stderr: string;
}> {
  const consumed = new ProcessLocalGrant(grant).consume('paid_model');
  const validatorId = consumed.assertions.validatorId;
  if (typeof validatorId !== 'string') throw new Error('validator_id_invalid');
  const codex = resolveCodex();
  let argv: string[];
  if (validatorId === 'codex.adversarial.v1') {
    argv = [codex, 'exec', ADVERSARIAL_PROMPT, '-C', path.resolve(cwd), '-s', 'read-only',
      '-c', 'model_reasoning_effort="high"', '-c', 'web_search="cached"'];
  } else if (validatorId === 'codex.review.v1') {
    argv = [codex, 'review', '--base', await defaultBase(cwd), '-c', 'model_reasoning_effort="high"'];
  } else {
    throw new Error('validator_id_invalid');
  }
  const result = await run(argv, path.resolve(cwd));
  return { validatorId, ...result };
}
