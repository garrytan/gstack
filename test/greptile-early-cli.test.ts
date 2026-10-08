/**
 * gstack-greptile-early open, end to end: the real helper and the real
 * gstack-post against a stub gh in fixture repos (B2, CEO-8). Whether the
 * `@greptileai` trigger comment reaches gh depends on triggerOnDrafts in the
 * root .greptile/ folder or greptile.json. POSIX only (shebang stubs);
 * test/greptile-early.test.ts covers the logic on Windows.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const EARLY = path.join(ROOT, "bin", "gstack-greptile-early");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "greptile-early-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function repo(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
  const stubs = path.join(dir, ".stubs");
  const log = path.join(dir, ".log");
  fs.mkdirSync(stubs);
  fs.mkdirSync(log);
  fs.writeFileSync(path.join(tmp, "gitconfig"), "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GSTACK_HOME: path.join(dir, ".state"), PATH: `${stubs}${path.delimiter}${process.env.PATH}` };
  for (const args of [["init", "-q", "-b", "feature/x"], ["remote", "add", "origin", "https://github.com/acme/widget.git"]]) {
    spawnSync("git", args, { cwd: dir, env, timeout: 10_000 });
  }
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  fs.writeFileSync(path.join(stubs, "gh"), `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo PRIVATE; exit 0 ;;
  "pr list") echo '[]'; exit 0 ;;
esac
n=$(ls "${log}" | grep -c args)
for a in "$@"; do printf '%s\\0' "$a"; done > "${log}/$n.args"
cat > "${log}/$n.stdin"
[ "$1 $2" = "pr create" ] && echo "https://github.com/acme/widget/pull/12"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, ".title"), "v1.2.3 feat: early review\n");
  const r = spawnSync(process.execPath, [EARLY, "open", "--base", "main", "--title-file", path.join(dir, ".title")], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
  const calls = fs.readdirSync(log).filter(f => f.endsWith(".args")).sort((a, b) => parseInt(a) - parseInt(b)).map(f => ({
    args: fs.readFileSync(path.join(log, f), "utf8").split("\0").slice(0, -1),
    stdin: fs.readFileSync(path.join(log, f.replace(".args", ".stdin")), "utf8"),
  }));
  return { r, calls };
}

describe("gstack-greptile-early open", () => {
  test("greptile.json without triggerOnDrafts: draft PR, then one @greptileai comment", () => {
    const { r, calls } = repo({ "greptile.json": "{}" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("EARLY_PR: 12");
    expect(calls.map(c => c.args)).toEqual([
      ["pr", "create", "--base=main", "--title=v1.2.3 feat: early review", "--body-file=-", "--draft"],
      ["pr", "comment", "12", "--body-file=-"],
    ]);
    expect(calls[0]!.stdin).toContain("/ship opened this pull request early");
    expect(calls[1]!.stdin).toBe("@greptileai\n");
  });

  test(".greptile/config.json with triggerOnDrafts: true: draft PR and no comment", () => {
    const { r, calls } = repo({ ".greptile/config.json": '{"triggerOnDrafts": true}', "greptile.json": "{}" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("GREPTILE_TRIGGER: not needed (triggerOnDrafts: true)");
    expect(calls.map(c => c.args[1])).toEqual(["create"]);
  });
});
