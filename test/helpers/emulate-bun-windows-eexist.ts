/**
 * Bun --preload fixture that emulates bun-on-Windows fs.mkdirSync semantics
 * (see #2635): a recursive mkdir on an already-existing directory throws
 * EEXIST, where Node (and bun on Linux/macOS) treat it as a no-op success.
 *
 * Loaded into a child process with `bun --preload <this file> <script>`, it
 * lets the #2635 regression test exercise the exact Windows crash path on any
 * platform. The patch is deliberately transparent - it changes nothing except
 * throwing EEXIST where Windows bun would.
 */
const fs = require("fs");
const orig = fs.mkdirSync;
fs.mkdirSync = (p: string, opts: any) => {
  if (opts?.recursive && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const e = new Error(`EEXIST: file already exists, mkdir '${p}'`);
    (e as any).code = "EEXIST";
    throw e;
  }
  return orig(p, opts);
};
