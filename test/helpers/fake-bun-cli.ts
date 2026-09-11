import * as fs from 'node:fs';

/** Keep fixture CLIs native on Windows, where an executable shebang is unsupported. */
export function createFakeBunCli(file: string, source: string, native = process.platform === 'win32'): string {
  const script = native ? `${file}.ts` : file;
  fs.writeFileSync(script, `#!${process.execPath}\n` + source.replace(/^#![^\n]*\n/, ''), { mode: 0o755 });
  if (!native) return script;
  const executable = `${file}.exe`;
  const built = Bun.spawnSync([process.execPath, 'build', '--compile', script, '--outfile', executable], {
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  if (built.exitCode !== 0) throw new Error(`Could not compile fake CLI: ${built.stderr.toString()}`);
  return executable;
}
