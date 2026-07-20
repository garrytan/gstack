import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { main } from '../runtime/cli.js';

const temporaryRoots: string[] = [];
const execFile = promisify(execFileCallback);

function sink() {
  let value = '';
  return {
    write(chunk: unknown) { value += Buffer.from(chunk as any).toString('utf8'); },
    value() { return value; },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gstack effect cli '));
  temporaryRoots.push(root);
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  await fs.mkdir(cwd);
  return { root, cwd, home, env: { ...process.env, GSTACK_HOME: home } };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

describe('gstack state external-effect CLI', () => {
  test('an actual local git push ship effect is executed at most once', async () => {
    const { root, cwd, env } = await fixture();
    const remote = path.join(root, 'origin.git');
    const git = async (args: string[], workingDirectory = cwd) => (await execFile('git', args, {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: 15_000,
    })).stdout.trim();
    await git(['init']);
    await git(['config', 'user.name', 'GStack Test']);
    await git(['config', 'user.email', 'gstack@example.invalid']);
    await fs.writeFile(path.join(cwd, 'release.txt'), 'first\n');
    await git(['add', 'release.txt']);
    await git(['commit', '-m', 'first release']);
    await git(['init', '--bare', remote], root);
    await git(['remote', 'add', 'origin', remote]);

    const out = sink();
    const err = sink();
    expect(await main(['state', 'begin', 'ship', '--run-id', 'run_ship_once'], { cwd, env, stdout: out, stderr: err })).toBe(0);

    const command = [
      'state', 'effect', 'run_ship_once', 'git.push.origin', '--',
      'git', 'push', 'origin', 'HEAD:refs/heads/main',
    ];
    expect(await main(command, { cwd, env, stdout: out, stderr: err })).toBe(0);
    const firstCommit = await git(['rev-parse', 'HEAD']);
    expect(await git(['rev-parse', 'refs/heads/main'], remote)).toBe(firstCommit);

    // A wrongly repeated push would advance the remote to this second commit.
    await fs.writeFile(path.join(cwd, 'release.txt'), 'second\n');
    await git(['add', 'release.txt']);
    await git(['commit', '-m', 'second release']);
    expect(await git(['rev-parse', 'HEAD'])).not.toBe(firstCommit);
    expect(await main(command, { cwd, env, stdout: out, stderr: err })).toBe(0);
    expect(await git(['rev-parse', 'refs/heads/main'], remote)).toBe(firstCommit);
    expect(await main(['state', 'complete', 'run_ship_once'], { cwd, env, stdout: out, stderr: err })).toBe(0);
  });

  test('resume refuses to repeat an effect whose command may already have happened', async () => {
    const { cwd, env } = await fixture();
    const marker = path.join(cwd, 'deploys.txt');
    const out = sink();
    const err = sink();
    await main(['state', 'begin', 'ship', '--run-id', 'run_ship_crash'], { cwd, env, stdout: out, stderr: err });
    const command = [
      'state', 'effect', 'run_ship_crash', 'deploy.production', '--',
      process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'deploy\\n');process.exit(7)`,
    ];
    expect(await main(command, { cwd, env, stdout: out, stderr: err })).toBe(1);
    expect(await main(['state', 'resume', 'run_ship_crash'], { cwd, env, stdout: out, stderr: err })).toBe(0);
    expect(await main(command, { cwd, env, stdout: out, stderr: err })).toBe(1);
    expect((await fs.readFile(marker, 'utf8')).trim().split('\n')).toEqual(['deploy']);
    expect(err.value()).toContain('was already claimed');
    expect(await main(
      ['state', 'reconcile-not-applied', 'run_ship_crash', 'deploy.production'],
      { cwd, env, stdout: out, stderr: err },
    )).toBe(2);
  });

  test('an empty exit-zero tool result is uncertain, never successful', async () => {
    const { cwd, env } = await fixture();
    const out = sink();
    const err = sink();
    await main(['state', 'begin', 'ship', '--run-id', 'run_empty'], { cwd, env, stdout: out, stderr: err });
    const silent = path.join(cwd, 'silent.sh');
    await fs.writeFile(silent, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const code = await main([
      'state', 'effect', 'run_empty', 'silent.tool', '--', silent,
    ], { cwd, env, stdout: out, stderr: err });
    expect(code).toBe(1);
    expect(err.value()).toContain('may have occurred');
    expect(out.value()).not.toContain('"status":"success"');
    expect(await main([
      'state', 'effect', 'run_empty', 'silent.tool', '--', silent,
    ], { cwd, env, stdout: out, stderr: err })).toBe(1);
    expect(err.value()).toContain('was already claimed');
  });
});
