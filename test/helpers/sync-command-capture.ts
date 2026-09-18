/** File-backed stdio avoids Bun's sync pipe-drain stall after child exit/EOF. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface CaptureOptions {
  timeout: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  captureStdout?: boolean;
}

export function runCapturedCommand(command: string, args: string[], opts: CaptureOptions): {
  status: number | null; stdout: string; stderr: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-command-capture-'));
  const fds: number[] = [];
  const open = (name: string) => {
    const fd = fs.openSync(path.join(dir, name), 'wx', 0o600);
    fds.push(fd);
    return fd;
  };
  try {
    let stdin: number | 'ignore' = 'ignore';
    if (opts.input !== undefined) {
      const file = path.join(dir, 'stdin');
      fs.writeFileSync(file, opts.input, { flag: 'wx', mode: 0o600 });
      stdin = fs.openSync(file, 'r');
      fds.push(stdin);
    }
    const stdout = opts.captureStdout ? open('stdout') : 'ignore';
    const stderr = open('stderr');
    const result = spawnSync(command, args, {
      cwd: opts.cwd, env: opts.env, timeout: opts.timeout, stdio: [stdin, stdout, stderr],
    });
    return {
      status: result.status ?? null,
      stdout: opts.captureStdout ? fs.readFileSync(path.join(dir, 'stdout'), 'utf8') : '',
      stderr: fs.readFileSync(path.join(dir, 'stderr'), 'utf8') +
        (result.error ? `\n[spawn] ${result.error.message}` : ''),
    };
  } finally {
    try {
      for (const fd of fds.reverse()) fs.closeSync(fd);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
