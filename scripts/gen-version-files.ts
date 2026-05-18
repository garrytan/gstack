#!/usr/bin/env bun
// gen-version-files — stamp the current git SHA into each dist/.version file.
//
// This exists because Bun's shell (which runs npm scripts on Windows, where
// there is no /bin/sh) cannot parse `( cmd ) > file`: it errors with
// "Subshells with redirections are currently not supported" on every Bun
// version (oven-sh/bun#11124, open). The build script previously stamped the
// three .version files with `( git rev-parse HEAD 2>/dev/null || true ) >
// path`, so `bun run build` aborted at parse time on Windows and blocked
// `/gstack-upgrade` for every Windows user (gstack#1537). Doing the writes
// from a Bun script sidesteps the shell entirely and is platform-agnostic.
//
// Semantics preserved from the old shell form: on success each file holds
// the HEAD SHA, newline-terminated, byte-identical to `git rev-parse HEAD`;
// if git is absent or this is not a repo, the file is created empty (the
// old `2>/dev/null || true` discarded the error and produced an empty file).

const TARGETS = [
  "browse/dist/.version",
  "design/dist/.version",
  "make-pdf/dist/.version",
];

function gitHead(): string {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

const sha = gitHead();
const content = sha ? `${sha}\n` : "";

await Promise.all(TARGETS.map((target) => Bun.write(target, content)));
