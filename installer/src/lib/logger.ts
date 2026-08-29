import pc from "picocolors";

export interface Logger {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  dim(msg: string): void;
  bullet(msg: string): void;
  plain(msg: string): void;
}

export function createLogger(quiet = false): Logger {
  const print = (s: string) => {
    if (!quiet) process.stdout.write(s + "\n");
  };
  return {
    info: (msg) => print(pc.cyan("i ") + msg),
    success: (msg) => print(pc.green("✓ ") + msg),
    warn: (msg) => print(pc.yellow("! ") + msg),
    error: (msg) => process.stderr.write(pc.red("✗ ") + msg + "\n"),
    dim: (msg) => print(pc.dim(msg)),
    bullet: (msg) => print(pc.dim("  • ") + msg),
    plain: (msg) => print(msg),
  };
}

export const colors = pc;
