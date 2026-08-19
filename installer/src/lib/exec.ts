import { spawn, type SpawnOptions } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stream?: boolean;
  stdinInherit?: boolean;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: opts.stream
        ? ["inherit", "inherit", "inherit"]
        : [opts.stdinInherit ? "inherit" : "ignore", "pipe", "pipe"],
    };

    const child = spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";

    if (!opts.stream) {
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
    }

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

export async function runOrThrow(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) {
    const invocation = `${cmd} ${args.join(" ")}`;
    throw new Error(
      `Command failed (${result.code}): ${invocation}\n${result.stderr || result.stdout}`.trim(),
    );
  }
  return result;
}

export async function hasCmd(cmd: string): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "which";
  const result = await run(which, [cmd]);
  return result.code === 0;
}
