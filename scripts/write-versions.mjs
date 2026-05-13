#!/usr/bin/env node
// Write the current git HEAD SHA into the .version files for browse/design/
// make-pdf compiled binaries. Replaces three `{ git rev-parse HEAD || true; }
// > FILE` brace-group + redirect constructs that bun-on-Windows can't parse.
//
// If git isn't available (rev-parse fails for any reason), write an empty
// .version — the file still needs to exist, but the SHA is best-effort.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let sha = "";
const root = fileURLToPath(new URL("..", import.meta.url));

try {
  sha = execSync("git rev-parse HEAD", {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
} catch {
  // Not in a git repo or git not on PATH. Leave sha empty.
}

const dirs = ["browse/dist", "design/dist", "make-pdf/dist"];
for (const dir of dirs) {
  const full = path.join(root, dir);
  try {
    mkdirSync(full, { recursive: true });
  } catch {
    // Directory probably exists; writeFileSync below will succeed.
  }
  writeFileSync(path.join(full, ".version"), sha + "\n");
}
